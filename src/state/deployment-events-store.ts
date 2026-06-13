/**
 * Deployment-events store (issue #808) — persists the structured
 * deployment events emitted by the deploy engine / destroy runner as
 * JSONL to the state bucket, plus a small per-stack run index:
 *
 * - Events: `{prefix}/{stackName}/{region}/deployments/{runId}.jsonl`
 * - Index:  `{prefix}/{stackName}/{region}/deployments/index.json`
 *
 * Design constraints (all load-bearing):
 *
 * - **Best-effort, never blocking**: `record()` is synchronous and only
 *   buffers in memory; flushes run asynchronously (debounced timer +
 *   size threshold) and are serialized on a write chain. A failed S3
 *   write warns once and degrades to debug-level afterwards — it can
 *   NEVER fail or block the deploy/destroy itself.
 * - **No locking**: each run writes to its own unique `{runId}.jsonl`
 *   key (no concurrent writer by construction). `index.json` is
 *   last-writer-wins — acceptable for a derived view; the `.jsonl`
 *   files are the source of truth and `cdkd events` can read a run
 *   directly by id even if the index lost the race.
 * - **No resource properties** in events — errors + metadata only
 *   (properties may contain secrets and already live in state.json).
 * - **Separate keys from state.json** — no state schema bump; event
 *   files survive `cdkd destroy` (state deletion does not touch
 *   `deployments/`), preserving post-mortem context.
 */

import { randomUUID } from 'node:crypto';
import { getLogger } from '../utils/logger.js';
import type { S3StateBackend } from './s3-state-backend.js';
import {
  DEPLOYMENT_EVENTS_INDEX_VERSION,
  type DeploymentEvent,
  type DeploymentEventRecorder,
  type DeploymentRunCommand,
  type DeploymentRunIndexFile,
  type DeploymentRunResult,
  type DeploymentRunSummary,
} from '../types/deployment-events.js';

/** Max runs retained in `deployments/index.json` (newest first). */
export const DEPLOYMENT_EVENTS_MAX_INDEX_RUNS = 20;

/** Debounce window between buffered events and the async S3 flush. */
const FLUSH_INTERVAL_MS = 2_000;

/** Flush immediately once this many events are buffered. */
const FLUSH_EVENT_THRESHOLD = 50;

// Injected at build time by tsdown `define` from package.json (same
// mechanism as src/cli/index.ts). Undefined under vitest — the typeof
// guard in getCdkdVersion() falls back to a dev sentinel.
declare const __CDKD_VERSION__: string;

/** Build-time cdkd version, with a dev fallback for non-built contexts. */
export function getCdkdVersion(): string {
  return typeof __CDKD_VERSION__ !== 'undefined' ? __CDKD_VERSION__ : '0.0.0-dev';
}

/**
 * Generate a time-sortable unique run id, e.g.
 * `20260613T012345678Z-1a2b3c4d`. The timestamp prefix keeps S3 listings
 * and `cdkd events` output chronologically meaningful; the random suffix
 * guarantees uniqueness across concurrent runs.
 */
export function newDeploymentRunId(now: Date = new Date()): string {
  const compact = now.toISOString().replace(/[-:.]/g, '');
  return `${compact}-${randomUUID().slice(0, 8)}`;
}

/** S3 key of a run's JSONL event stream. */
export function deploymentEventsKey(
  prefix: string,
  stackName: string,
  region: string,
  runId: string
): string {
  return `${prefix}/${stackName}/${region}/deployments/${runId}.jsonl`;
}

/** S3 key of a stack's run index. */
export function deploymentEventsIndexKey(
  prefix: string,
  stackName: string,
  region: string
): string {
  return `${prefix}/${stackName}/${region}/deployments/index.json`;
}

export interface DeploymentEventsStoreOptions {
  stackName: string;
  region: string;
  command: DeploymentRunCommand;
  /** Override for tests; defaults to a fresh time-sortable id. */
  runId?: string;
  /** Override for tests; defaults to the build-time cdkd version. */
  cdkdVersion?: string;
}

/**
 * Buffering JSONL writer for one deployment run. Implements the
 * {@link DeploymentEventRecorder} seam the deploy engine / destroy
 * runner emit through.
 */
export class DeploymentEventsStore implements DeploymentEventRecorder {
  private logger = getLogger().child('DeploymentEvents');
  private backend: S3StateBackend;
  readonly stackName: string;
  readonly region: string;
  readonly command: DeploymentRunCommand;
  readonly runId: string;
  readonly cdkdVersion: string;
  private startedAt: string;

  /** All events recorded so far (the full JSONL body is re-PUT per flush —
   * S3 has no append, and metadata-only events are small). */
  private events: DeploymentEvent[] = [];
  /** Number of events already persisted by the last successful flush. */
  private persistedCount = 0;
  private flushTimer: NodeJS.Timeout | undefined;
  /** Serializes S3 writes so flushes never interleave. */
  private writeChain: Promise<void> = Promise.resolve();
  private warnedOnce = false;
  private finalized = false;

  constructor(backend: S3StateBackend, options: DeploymentEventsStoreOptions) {
    this.backend = backend;
    this.stackName = options.stackName;
    this.region = options.region;
    this.command = options.command;
    this.runId = options.runId ?? newDeploymentRunId();
    this.cdkdVersion = options.cdkdVersion ?? getCdkdVersion();
    this.startedAt = new Date().toISOString();
  }

  /**
   * Buffer one event (synchronous, never throws). The timestamp is
   * stamped here so emitters don't need to.
   */
  record(event: Omit<DeploymentEvent, 'timestamp'>): void {
    try {
      if (this.finalized) return;
      this.events.push({ timestamp: new Date().toISOString(), ...event });
      if (this.events.length - this.persistedCount >= FLUSH_EVENT_THRESHOLD) {
        this.scheduleFlush(0);
      } else {
        this.scheduleFlush(FLUSH_INTERVAL_MS);
      }
    } catch {
      // record() must never throw into the deploy critical path.
    }
  }

  /**
   * Final flush + index update. Called by the owner (deploy CLI per-stack
   * finally / destroy runner finally) after the run reaches a terminal
   * state. Best-effort: never throws.
   */
  async finalize(result: DeploymentRunResult): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    // Nothing recorded — don't create empty run artifacts (e.g. a destroy
    // cancelled before any event was emitted).
    if (this.events.length === 0) return;
    await this.enqueueWrite(async () => {
      await this.doFlush();
      await this.updateIndex(result);
    });
  }

  /** Await any in-flight async flushes (used by tests). */
  async drain(): Promise<void> {
    await this.writeChain;
  }

  // ---------- internals ----------

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) {
      if (delayMs > 0) return; // a timer is already pending
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.enqueueWrite(() => this.doFlush());
    }, delayMs);
    // Never keep the process alive just for an event flush.
    this.flushTimer.unref?.();
  }

  private enqueueWrite(op: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(op).catch((err: unknown) => {
      this.warnOnce(
        `Failed to persist deployment events for run ${this.runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    this.writeChain = next;
    return next;
  }

  private async doFlush(): Promise<void> {
    if (this.events.length === 0 || this.events.length === this.persistedCount) return;
    const snapshotCount = this.events.length;
    const body = this.events
      .slice(0, snapshotCount)
      .map((e) => JSON.stringify(e))
      .join('\n');
    await this.backend.putRawObject(
      deploymentEventsKey(this.backend.prefix, this.stackName, this.region, this.runId),
      body + '\n',
      'application/x-ndjson'
    );
    this.persistedCount = snapshotCount;
  }

  /**
   * Prepend this run's summary to `deployments/index.json`, truncated to
   * the last {@link DEPLOYMENT_EVENTS_MAX_INDEX_RUNS} runs. Read-modify-
   * write WITHOUT optimistic locking — last-writer-wins (documented
   * trade-off; the per-run `.jsonl` files are the source of truth).
   */
  private async updateIndex(result: DeploymentRunResult): Promise<void> {
    const key = deploymentEventsIndexKey(this.backend.prefix, this.stackName, this.region);
    let existingRuns: DeploymentRunSummary[] = [];
    try {
      const raw = await this.backend.getRawObject(key);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as Partial<DeploymentRunIndexFile>;
        if (Array.isArray(parsed.runs)) existingRuns = parsed.runs;
      }
    } catch (err) {
      // Corrupt / unreadable index — rebuild from this run alone. The
      // .jsonl files remain readable directly via `cdkd events --run`.
      this.logger.debug(
        `Deployment-events index unreadable, rewriting: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const summary: DeploymentRunSummary = {
      runId: this.runId,
      command: this.command,
      cdkdVersion: this.cdkdVersion,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      result,
      eventCount: this.persistedCount,
    };
    const runs = [summary, ...existingRuns.filter((r) => r.runId !== this.runId)].slice(
      0,
      DEPLOYMENT_EVENTS_MAX_INDEX_RUNS
    );
    const file: DeploymentRunIndexFile = {
      indexVersion: DEPLOYMENT_EVENTS_INDEX_VERSION,
      stackName: this.stackName,
      region: this.region,
      runs,
      lastModified: Date.now(),
    };
    await this.backend.putRawObject(key, JSON.stringify(file, null, 2));
  }

  private warnOnce(message: string): void {
    if (this.warnedOnce) {
      this.logger.debug(message);
      return;
    }
    this.warnedOnce = true;
    this.logger.warn(
      `${message} — continuing; deployment events are best-effort and never block the run.`
    );
  }
}

/**
 * Read side for `cdkd events`: discovers regions / runs / event streams
 * under `{prefix}/{stackName}/{region}/deployments/`. Region discovery
 * deliberately does NOT rely on state.json — event files survive
 * `cdkd destroy`, so a destroyed stack's runs stay readable.
 */
export class DeploymentEventsReader {
  private backend: S3StateBackend;

  constructor(backend: S3StateBackend) {
    this.backend = backend;
  }

  /**
   * Regions that have a `deployments/` index or event stream for the
   * stack. Derived from the raw key listing under `{prefix}/{stackName}/`.
   */
  async listRegions(stackName: string): Promise<string[]> {
    const prefix = `${this.backend.prefix}/${stackName}/`;
    const keys = await this.backend.listRawKeys(prefix);
    const regions = new Set<string>();
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const segments = rest.split('/');
      // {region}/deployments/<file>
      if (segments.length === 3 && segments[1] === 'deployments' && segments[0]) {
        regions.add(segments[0]);
      }
    }
    return [...regions].sort();
  }

  /**
   * Run summaries for `(stackName, region)`, newest first. Returns the
   * index file's `runs` (already newest-first); when the index is missing
   * or unreadable, falls back to enumerating `{runId}.jsonl` keys (sorted
   * descending — runIds are time-prefixed) with `null` summaries elided.
   */
  async listRuns(stackName: string, region: string): Promise<DeploymentRunSummary[]> {
    const key = deploymentEventsIndexKey(this.backend.prefix, stackName, region);
    try {
      const raw = await this.backend.getRawObject(key);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as Partial<DeploymentRunIndexFile>;
        if (Array.isArray(parsed.runs)) return parsed.runs;
      }
    } catch {
      // fall through to key enumeration
    }
    const dirPrefix = `${this.backend.prefix}/${stackName}/${region}/deployments/`;
    const keys = await this.backend.listRawKeys(dirPrefix);
    return keys
      .filter((k) => k.endsWith('.jsonl'))
      .map((k) => k.slice(dirPrefix.length, -'.jsonl'.length))
      .sort()
      .reverse()
      .map((runId) => ({
        runId,
        command: 'deploy' as DeploymentRunCommand,
        cdkdVersion: 'unknown',
        startedAt: '',
        finishedAt: '',
        result: 'FAILED' as DeploymentRunResult,
        eventCount: 0,
      }));
  }

  /**
   * Parse one run's JSONL event stream. Returns `null` when the run file
   * does not exist. Malformed lines are skipped (a torn final line from
   * an interrupted flush must not hide the rest of the stream).
   */
  async readRunEvents(
    stackName: string,
    region: string,
    runId: string
  ): Promise<DeploymentEvent[] | null> {
    const key = deploymentEventsKey(this.backend.prefix, stackName, region, runId);
    const raw = await this.backend.getRawObject(key);
    if (raw === null) return null;
    const events: DeploymentEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as DeploymentEvent);
      } catch {
        // skip torn / malformed line
      }
    }
    return events;
  }
}
