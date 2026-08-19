/**
 * Run-level deployment-event bracket helpers (issue #808).
 *
 * The per-resource + rollback events are emitted by `DeployEngine` /
 * `destroy-runner.ts`; the RUN-level events (`RUN_STARTED` /
 * `RUN_FINISHED`) and the recorder lifecycle (`finalize()` in a `finally`)
 * are owned by the `cdkd deploy` / `cdkd destroy` CLIs. That run-level
 * bracket was originally inline in `deploy.ts` / `destroy.ts` and could
 * only be exercised through the full synth → STS → work-graph pipeline.
 *
 * These thin helpers extract the bracket so it is directly unit-testable
 * (and shared between the two commands), with the exact contract:
 *
 *   - **`--dry-run` creates NO recorder** (no events at all for a dry run).
 *   - `RUN_STARTED` is emitted the moment the recorder is created.
 *   - A successful run emits `RUN_FINISHED { result: 'SUCCEEDED', counts }`.
 *   - A failed run emits `RUN_FINISHED { result: 'FAILED', error }` via
 *     {@link extractDeploymentEventError} (error metadata only — no props).
 *   - `finalize(result)` is always called (caller's `finally`).
 *
 * All of this is best-effort: the recorder's `record()` / `finalize()`
 * never throw, so these helpers never need their own try/catch.
 */

import { DeploymentEventsStore } from '../../state/deployment-events-store.js';
import type { S3StateBackend } from '../../state/s3-state-backend.js';
import {
  extractDeploymentEventError,
  type DeploymentRunCommand,
  type DeploymentRunResult,
} from '../../types/deployment-events.js';

export interface StartRunRecorderArgs {
  backend: S3StateBackend;
  stackName: string;
  region: string;
  command: DeploymentRunCommand;
  /**
   * When true, NO recorder is created and `undefined` is returned — a dry
   * run has no real changes to record. Defaults to `false`.
   */
  dryRun?: boolean;
  /** Test seam: pin the runId / version on the created store. */
  runId?: string;
  cdkdVersion?: string;
}

/**
 * Create a {@link DeploymentEventsStore} and immediately emit its
 * `RUN_STARTED` event. Returns `undefined` under `--dry-run` (no recorder,
 * no events). The caller wires the returned recorder into the engine /
 * runner and `finalize()`s it in a `finally`.
 */
export function startRunRecorder(args: StartRunRecorderArgs): DeploymentEventsStore | undefined {
  if (args.dryRun) return undefined;
  const recorder = new DeploymentEventsStore(args.backend, {
    stackName: args.stackName,
    region: args.region,
    command: args.command,
    ...(args.runId !== undefined && { runId: args.runId }),
    ...(args.cdkdVersion !== undefined && { cdkdVersion: args.cdkdVersion }),
  });
  recorder.record({
    eventType: 'RUN_STARTED',
    stackName: args.stackName,
    command: args.command,
    region: args.region,
    cdkdVersion: recorder.cdkdVersion,
  });
  return recorder;
}

export interface RunCounts {
  created: number;
  updated: number;
  deleted: number;
  /** Failed-resource count (destroy partial failure); omitted when 0. */
  failed?: number;
  /**
   * Resources cdkd could NOT address, so they were not destroyed (issue
   * [#1752](https://github.com/go-to-k/cdkd/issues/1752) on destroy, issue
   * [#1762](https://github.com/go-to-k/cdkd/issues/1762) on the deploy side's
   * template-DELETE branch). Omitted when 0.
   *
   * `cdkd events` renders it as `⚠N` beside the `+created/~updated/-deleted`
   * triple. Without it a run whose only anomaly was a skip records a summary
   * that names nothing anomalous — the events store is the durable
   * post-mortem, so under-reporting there is the same mis-accounting the two
   * issues fix one layer down.
   */
  skipped?: number;
}

/**
 * Emit a `RUN_FINISHED` carrying COUNTS under a caller-chosen result. No-op
 * when `recorder` is `undefined` (dry-run / older state). `durationMs` is
 * optional (destroy does not carry one at the run level).
 *
 * Replaced a `recordRunSucceeded` that hard-coded `'SUCCEEDED'`, because
 * deploy has an outcome that is neither a clean success nor a thrown failure:
 * a run that finished, failed no resource, and yet left one
 * cdkd was responsible for alive in AWS (issue
 * [#1960](https://github.com/go-to-k/cdkd/issues/1960)). That run exits 2, so
 * recording it as `SUCCEEDED` would put the durable post-mortem at odds with
 * the exit code the same run returned.
 *
 * {@link recordRunFailed} cannot serve it: that one carries error metadata and
 * NO counts, and the `skipped` count is the only thing in the summary that says
 * a resource survived — dropping it would leave `cdkd events` showing a failed
 * run naming nothing that failed, which is the exact shape the destroy side
 * added `skipped` to avoid. `cdkd destroy` already records `FAILED` for this
 * outcome (see the `skippedCount > 0` arm in src/cli/commands/destroy.ts), so
 * this is parity rather than a new convention.
 */
export function recordRunOutcome(
  recorder: DeploymentEventsStore | undefined,
  stackName: string,
  result: DeploymentRunResult,
  counts: RunCounts,
  durationMs?: number
): void {
  recorder?.record({
    eventType: 'RUN_FINISHED',
    stackName,
    result,
    ...(durationMs !== undefined && { durationMs }),
    counts,
  });
}

/**
 * Emit a failure `RUN_FINISHED` carrying the extracted error metadata.
 * No-op when `recorder` is `undefined`.
 */
export function recordRunFailed(
  recorder: DeploymentEventsStore | undefined,
  stackName: string,
  error: unknown
): void {
  recorder?.record({
    eventType: 'RUN_FINISHED',
    stackName,
    result: 'FAILED',
    error: extractDeploymentEventError(error),
  });
}
