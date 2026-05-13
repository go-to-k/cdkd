/**
 * Export index store — persistent global index of `Fn::ImportValue`
 * resolvable exports across all cdkd-managed stacks in a region.
 *
 * Concept: CFn's `cloudformation:ListExports` API is internally backed by
 * an index that lets the producer's Output be looked up by export name in
 * O(1) regardless of how many stacks exist. cdkd mirrors that pattern via
 * `s3://{bucket}/{prefix}/_index/{region}/exports.json` so the resolver
 * doesn't pay the O(N) state-bucket scan on every `Fn::ImportValue`.
 *
 * Roles:
 * - **state.json** (per-stack) is the canonical source of truth for a
 *   stack's outputs + imports. Always written / read with optimistic
 *   locking.
 * - **exports.json** (per-region, in this module) is a DERIVED VIEW used
 *   only as a perf hint. It can be rebuilt from state.json at any time
 *   and is allowed to drift briefly. Strong-reference safety checks
 *   never trust the index — they always re-scan state.json.
 *
 * Failure mode summary:
 * - Index missing → auto-rebuild from state.json on first access.
 * - Index corrupt → log warning, auto-rebuild.
 * - Index stale (post-deploy index update failed) → next resolve's miss
 *   triggers fallback scan; if found, the entry is patched into the
 *   index incrementally.
 * - Two cdkd processes writing concurrently → S3 If-Match optimistic
 *   lock + bounded retry. After exhaustion, the writer logs warn and
 *   continues; the index becomes stale until the next deploy/destroy
 *   updates it.
 */

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getLogger } from '../utils/logger.js';
import type { S3StateBackend } from './s3-state-backend.js';

/** Schema version for the exports index file. Separate from state.json's version. */
export const EXPORT_INDEX_VERSION = 1;

/**
 * Shallow-deep equality on the two `name → ExportIndexEntry` maps used
 * to detect no-op writes in `applyStackUpdate`. Values are compared via
 * JSON.stringify (Output values are always JSON-serializable).
 */
function mapsEqual(a: Map<string, ExportIndexEntry>, b: Map<string, ExportIndexEntry>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, entry] of a) {
    const other = b.get(name);
    if (!other) return false;
    if (
      other.producerStack !== entry.producerStack ||
      other.producerRegion !== entry.producerRegion
    ) {
      return false;
    }
    if (other.value !== entry.value) {
      // Fall back to JSON.stringify for non-primitive Output values.
      if (JSON.stringify(other.value) !== JSON.stringify(entry.value)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * On-disk shape of `_index/{region}/exports.json`.
 *
 * Note: the index intentionally does NOT carry a `consumers[]` list
 * (= CFn's `ListImports` equivalent). Strong-reference destroy checks
 * scan state.json directly (canonical, drift-free), so persisting the
 * reverse mapping would add write amplification without buying safety.
 */
export interface ExportIndexFile {
  indexVersion: number;
  region: string;
  exports: Record<string, ExportIndexEntry>;
  lastModified: number;
}

export interface ExportIndexEntry {
  /** The resolved Output value (post-intrinsic-resolution). */
  value: unknown;
  /** The producer stack that publishes this export. */
  producerStack: string;
  /** The producer's region. May differ from the index's region only on
   *  forward-compat — today, exports are region-scoped so this matches. */
  producerRegion: string;
}

/** Internal state for the in-memory cache + load-once memoization. */
type LoadState =
  | { kind: 'unloaded' }
  | { kind: 'loading'; promise: Promise<void> }
  | { kind: 'loaded'; etag: string | undefined; entries: Map<string, ExportIndexEntry> };

/** Configurable knobs for write-side retry behavior. */
export interface ExportIndexStoreOptions {
  /** Max attempts when an If-Match write fails due to a concurrent writer. */
  maxWriteRetries?: number;
  /** Initial backoff (ms) for write retries; doubled each attempt up to cap. */
  initialBackoffMs?: number;
  /** Cap (ms) for retry backoff. */
  maxBackoffMs?: number;
}

const DEFAULT_OPTIONS: Required<ExportIndexStoreOptions> = {
  maxWriteRetries: 5,
  initialBackoffMs: 100,
  maxBackoffMs: 1000,
};

export class ExportIndexStore {
  private logger = getLogger().child('ExportIndexStore');
  private s3Client: S3Client;
  private bucket: string;
  private prefix: string;
  private region: string;
  private stateBackend: S3StateBackend;
  private loadState: LoadState = { kind: 'unloaded' };
  private opts: Required<ExportIndexStoreOptions>;
  /**
   * In-process serializer for write paths (`updateForStack`,
   * `patchEntry`, `removeStack`). The S3 `If-Match` etag prevents
   * cross-process data loss, but within ONE cdkd process the
   * default `cdkd deploy --all --stack-concurrency > 1` topology
   * lets multiple per-stack writes race on the same etag — they
   * would all read the same loaded snapshot, all attempt to write
   * with that etag, all but one fail with PreconditionFailed, all
   * retry, and burn through the bounded retry budget for no good
   * reason. Serializing write paths via this chained promise lets
   * the etag race only fire across processes (cross-app concurrency)
   * where it actually matters. Reads (`lookup`) remain unsynchronized.
   */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    s3Client: S3Client,
    bucket: string,
    prefix: string,
    region: string,
    stateBackend: S3StateBackend,
    opts: ExportIndexStoreOptions = {}
  ) {
    this.s3Client = s3Client;
    this.bucket = bucket;
    this.prefix = prefix;
    this.region = region;
    this.stateBackend = stateBackend;
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  /** S3 key for this region's index file. */
  private indexKey(): string {
    return `${this.prefix}/_index/${this.region}/exports.json`;
  }

  /**
   * Look up an exported value by name. Returns the cached entry on hit,
   * or `undefined` on miss. The caller is responsible for falling back
   * to a state.json scan and (if found) patching the index via
   * {@link patchEntry}.
   */
  async lookup(exportName: string): Promise<ExportIndexEntry | undefined> {
    await this.ensureLoaded();
    if (this.loadState.kind !== 'loaded') {
      // Defensive — ensureLoaded should always end in `loaded`.
      return undefined;
    }
    return this.loadState.entries.get(exportName);
  }

  /**
   * Replace all entries for `(stackName, producerRegion)` with the
   * supplied `outputs`. Used after a successful deploy save. Writes
   * the updated index to S3 under an If-Match optimistic lock,
   * retrying on conflict.
   *
   * If `outputs` is empty, every entry currently owned by this stack
   * in this region is removed.
   *
   * Best-effort: on persistent retry exhaustion the in-memory map is
   * still updated locally (so this session sees a consistent view) and
   * a warning is logged. The on-disk index will be repaired by the
   * next successful update or by a rebuild on miss.
   */
  async updateForStack(
    stackName: string,
    producerRegion: string,
    outputs: Record<string, unknown>
  ): Promise<void> {
    // No-op short-circuit at the unconditional-skip level is unsafe:
    // a stack that previously published outputs (and so has entries
    // in the persisted index) and now publishes none MUST drop its
    // entries. Without loading the index we can't know whether stale
    // entries exist. The cheaper-but-still-correct optimization is
    // the `mapsEqual` check inside `applyStackUpdate` — it skips the
    // PUT when the resulting in-memory map matches what we already
    // had, which is the typical no-change deploy case.
    //
    // The rebuild on first call IS still a real cost for first-time
    // v4 users (1 listStacks + N parallel GETs + 1 PUT) but happens
    // exactly once per bucket lifetime — same trade-off CFn's
    // internal ListExports index makes.
    await this.enqueueWrite('update', () =>
      this.applyStackUpdate(stackName, producerRegion, outputs)
    );
  }

  /**
   * Patch a single entry into the index after a `lookup` miss fell back
   * to a state.json scan and found the value. Lightweight write that
   * does NOT require a full rebuild.
   */
  async patchEntry(exportName: string, entry: ExportIndexEntry): Promise<void> {
    await this.enqueueWrite('patch', () => this.applyPatch(exportName, entry));
  }

  /**
   * Drop all entries owned by `(stackName, producerRegion)`. Used after
   * a successful destroy. Same retry / best-effort semantics as
   * `updateForStack`. Filtering by both stack AND region is symmetric
   * with the update path so a stack that was re-deployed to a new
   * region keeps its old-region entries (the user must destroy in the
   * old region too to drop them).
   */
  async removeStack(stackName: string, producerRegion: string): Promise<void> {
    await this.enqueueWrite('remove', () => this.applyRemoveStack(stackName, producerRegion));
  }

  /**
   * Serialize write paths within a single process. Chains every write
   * onto a tail Promise so two concurrent `updateForStack` calls don't
   * race on the same etag inside the same cdkd. The S3 If-Match retry
   * remains as cross-process protection.
   */
  private async enqueueWrite(label: string, op: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(() => this.runWithRetry(label, op));
    // Swallow errors on the shared tail so a single write's failure
    // doesn't poison the chain for the next write (runWithRetry
    // already logs warns on bail-out; we don't want a rejected tail).
    this.writeChain = next.catch(() => {});
    return next;
  }

  /**
   * Force a rebuild from state.json files, overwriting whatever is in
   * the on-disk index. Useful for recovery and for tests.
   */
  async rebuild(): Promise<void> {
    const entries = await this.rebuildFromStateBackend();
    const next: ExportIndexFile = {
      indexVersion: EXPORT_INDEX_VERSION,
      region: this.region,
      exports: Object.fromEntries(entries),
      lastModified: Date.now(),
    };
    const etag = await this.writeIndex(next, /* expectedEtag */ undefined);
    this.loadState = { kind: 'loaded', etag, entries };
  }

  // ---------- internals ----------

  private async ensureLoaded(): Promise<void> {
    if (this.loadState.kind === 'loaded') return;
    if (this.loadState.kind === 'loading') {
      await this.loadState.promise;
      return;
    }
    const promise = this.doLoad();
    this.loadState = { kind: 'loading', promise };
    await promise;
  }

  private async doLoad(): Promise<void> {
    try {
      const raw = await this.readIndexRaw();
      if (raw === null) {
        this.logger.info('Exports index missing; rebuilding from state.json files');
        await this.rebuild();
        return;
      }
      const { body, etag } = raw;
      let parsed: ExportIndexFile;
      try {
        parsed = JSON.parse(body) as ExportIndexFile;
      } catch (err) {
        this.logger.warn(
          `Exports index corrupt (${err instanceof Error ? err.message : String(err)}); rebuilding from state.json files`
        );
        await this.rebuild();
        return;
      }
      if (typeof parsed.indexVersion !== 'number' || parsed.indexVersion > EXPORT_INDEX_VERSION) {
        // Newer index version written by a future cdkd binary. We can't
        // safely interpret unknown fields; surface a clear error so the
        // user upgrades rather than silently mishandling.
        throw new Error(
          `Exports index uses indexVersion ${String(parsed.indexVersion)} which is newer than this cdkd binary supports (max ${EXPORT_INDEX_VERSION}). Upgrade cdkd.`
        );
      }
      const entries = new Map<string, ExportIndexEntry>();
      for (const [name, entry] of Object.entries(parsed.exports ?? {})) {
        entries.set(name, entry);
      }
      this.loadState = { kind: 'loaded', etag, entries };
    } catch (err) {
      // Don't strand the loadState in `loading` — that would deadlock the
      // next caller. Reset to `unloaded` and rethrow so the caller decides
      // how to proceed.
      this.loadState = { kind: 'unloaded' };
      throw err;
    }
  }

  private async readIndexRaw(): Promise<{ body: string; etag: string | undefined } | null> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.indexKey(),
        })
      );
      const body = (await response.Body?.transformToString()) ?? '';
      return { body, etag: response.ETag };
    } catch (err) {
      if (this.isNoSuchKey(err)) return null;
      throw err;
    }
  }

  private async writeIndex(
    next: ExportIndexFile,
    expectedEtag: string | undefined
  ): Promise<string | undefined> {
    const body = JSON.stringify(next, null, 2);
    const response = await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.indexKey(),
        Body: body,
        ContentLength: Buffer.byteLength(body),
        ContentType: 'application/json',
        ...(expectedEtag && { IfMatch: expectedEtag }),
      })
    );
    return response.ETag;
  }

  /**
   * Re-read state.json for every stack in the bucket and assemble a
   * fresh `exportName → entry` map. Region-scoped — only state files
   * in this index's region contribute.
   */
  private async rebuildFromStateBackend(): Promise<Map<string, ExportIndexEntry>> {
    const refs = await this.stateBackend.listStacks();
    const inRegion = refs.filter((ref) => ref.region === this.region);
    this.logger.debug(
      `Rebuilding exports index for region '${this.region}' from ${inRegion.length} stack state file(s)`
    );

    const entries = new Map<string, ExportIndexEntry>();
    const results = await Promise.all(
      inRegion.map(async (ref) => {
        try {
          const got = await this.stateBackend.getState(ref.stackName, ref.region ?? this.region);
          return { ref, state: got?.state };
        } catch (err) {
          this.logger.warn(
            `Failed to read state for ${ref.stackName} (${ref.region ?? ''}) during index rebuild: ${err instanceof Error ? err.message : String(err)}`
          );
          return { ref, state: null };
        }
      })
    );
    for (const { ref, state } of results) {
      if (!state || !state.outputs) continue;
      const region = ref.region ?? this.region;
      for (const [name, value] of Object.entries(state.outputs)) {
        entries.set(name, {
          value,
          producerStack: ref.stackName,
          producerRegion: region,
        });
      }
    }
    return entries;
  }

  private async applyStackUpdate(
    stackName: string,
    producerRegion: string,
    outputs: Record<string, unknown>
  ): Promise<void> {
    await this.ensureLoaded();
    if (this.loadState.kind !== 'loaded') return;
    const next = new Map(this.loadState.entries);
    // Drop existing entries owned by this stack.
    for (const [name, entry] of next) {
      if (entry.producerStack === stackName && entry.producerRegion === producerRegion) {
        next.delete(name);
      }
    }
    // Insert fresh entries.
    for (const [name, value] of Object.entries(outputs)) {
      next.set(name, { value, producerStack: stackName, producerRegion });
    }
    // Skip the PUT when the resulting map is byte-identical to the
    // loaded map. Eliminates the no-op writes on deploys where outputs
    // didn't change (the typical incremental-deploy case after the
    // first one). `mapsEqual` alone is sufficient — any per-entry
    // change ends up reflected in `next` and the equality check is
    // strictly more precise than a per-step `changed` flag.
    if (mapsEqual(this.loadState.entries, next)) {
      return;
    }
    await this.persist(next);
  }

  private async applyPatch(exportName: string, entry: ExportIndexEntry): Promise<void> {
    await this.ensureLoaded();
    if (this.loadState.kind !== 'loaded') return;
    const next = new Map(this.loadState.entries);
    next.set(exportName, entry);
    await this.persist(next);
  }

  private async applyRemoveStack(stackName: string, producerRegion: string): Promise<void> {
    await this.ensureLoaded();
    if (this.loadState.kind !== 'loaded') return;
    const next = new Map(this.loadState.entries);
    let changed = false;
    for (const [name, entry] of next) {
      // Match BOTH stack and region — symmetric with `applyStackUpdate`.
      // A stack re-deployed to a different region keeps its old-region
      // entries; the user must destroy in each region separately.
      if (entry.producerStack === stackName && entry.producerRegion === producerRegion) {
        next.delete(name);
        changed = true;
      }
    }
    if (!changed) return;
    await this.persist(next);
  }

  private async persist(entries: Map<string, ExportIndexEntry>): Promise<void> {
    if (this.loadState.kind !== 'loaded') return;
    const file: ExportIndexFile = {
      indexVersion: EXPORT_INDEX_VERSION,
      region: this.region,
      exports: Object.fromEntries(entries),
      lastModified: Date.now(),
    };
    const etag = await this.writeIndex(file, this.loadState.etag);
    this.loadState = { kind: 'loaded', etag, entries };
  }

  private async runWithRetry(label: string, op: () => Promise<void>): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.opts.maxWriteRetries; attempt++) {
      try {
        await op();
        return;
      } catch (err) {
        lastErr = err;
        if (this.isPreconditionFailed(err)) {
          // Etag mismatch — another writer beat us. Reload and retry.
          this.loadState = { kind: 'unloaded' };
          const backoff = Math.min(
            this.opts.initialBackoffMs * 2 ** attempt,
            this.opts.maxBackoffMs
          );
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        // Non-retryable error class for an index write — log and bail
        // (state.json is canonical, so this is a perf-only loss).
        this.logger.warn(
          `Exports index ${label} failed (non-retryable): ${err instanceof Error ? err.message : String(err)}; continuing without index update`
        );
        return;
      }
    }
    this.logger.warn(
      `Exports index ${label} exhausted ${this.opts.maxWriteRetries} retries due to concurrent writers; continuing without index update. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
    );
  }

  private isNoSuchKey(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
  }

  private isPreconditionFailed(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as S3ServiceException;
    return (
      e.name === 'PreconditionFailed' ||
      (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412
    );
  }
}
