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
}

/**
 * Emit a success `RUN_FINISHED`. No-op when `recorder` is `undefined`
 * (dry-run / older state). `durationMs` is optional (destroy does not
 * carry one at the run level).
 */
export function recordRunSucceeded(
  recorder: DeploymentEventsStore | undefined,
  stackName: string,
  counts: RunCounts,
  durationMs?: number
): void {
  recorder?.record({
    eventType: 'RUN_FINISHED',
    stackName,
    result: 'SUCCEEDED',
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
