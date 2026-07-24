/**
 * Structured deployment-event types (issue #808).
 *
 * cdkd's CloudFormation `DescribeStackEvents` equivalent: every deploy /
 * destroy run appends one JSONL line per lifecycle event to
 * `s3://{bucket}/{prefix}/{stackName}/{region}/deployments/{runId}.jsonl`,
 * plus a small `deployments/index.json` listing the last N runs.
 *
 * Deliberately a SEPARATE key family from `state.json` — no state schema
 * bump is involved (state stays at its current version), and event files
 * survive `cdkd destroy` (state deletion does not touch `deployments/`),
 * so post-mortem context is available even after the stack is gone.
 *
 * SECURITY: events carry error + metadata ONLY. Resource properties are
 * never recorded here (they may contain secrets); properties already live
 * in state.json.
 */

/**
 * The cdkd command that produced a deployment run. `'rollback'` (issue
 * #1183) is the standalone `cdkd rollback` replay — additive literal, no
 * event-schema bump (per the #808 design). Readers must render the new label
 * rather than assuming the old two.
 */
export type DeploymentRunCommand = 'deploy' | 'destroy' | 'rollback';

/** Terminal result of a deployment run. */
export type DeploymentRunResult = 'SUCCEEDED' | 'FAILED';

/**
 * Result as reported in a `DeploymentRunSummary`. A superset of
 * {@link DeploymentRunResult} with `'UNKNOWN'` for the index-fallback case:
 * when `deployments/index.json` is missing / corrupt, `cdkd events` rebuilds
 * the run list by enumerating the `{runId}.jsonl` keys, and a run whose JSONL
 * carries no terminal `RUN_FINISHED` event (e.g. an interrupted run, or one
 * whose index write lost the race) has no definitively-known result — it must
 * NOT be fabricated as `'FAILED'`.
 */
export type DeploymentRunSummaryResult = DeploymentRunResult | 'UNKNOWN';

/** Per-resource operation kind (mirrors the deploy engine's change types). */
export type DeploymentResourceOperation = 'CREATE' | 'UPDATE' | 'DELETE';

/**
 * Event type discriminator. Modeled on CloudFormation stack-event statuses
 * but flattened to cdkd's lifecycle:
 *
 * - `RUN_STARTED` / `RUN_FINISHED` — one pair per deploy / destroy run.
 * - `RESOURCE_STARTED` / `RESOURCE_SUCCEEDED` / `RESOURCE_FAILED` — one
 *   pair (or started+failed) per per-resource CREATE / UPDATE / DELETE.
 * - `RESOURCE_RETAINED` — destroy-side skip for `DeletionPolicy: Retain`.
 * - `ROLLBACK_*` — deploy-failure rollback phase (started / per-resource
 *   outcome / finished).
 */
export type DeploymentEventType =
  | 'RUN_STARTED'
  | 'RUN_FINISHED'
  | 'RESOURCE_STARTED'
  | 'RESOURCE_SUCCEEDED'
  | 'RESOURCE_FAILED'
  | 'RESOURCE_RETAINED'
  | 'ROLLBACK_STARTED'
  | 'ROLLBACK_RESOURCE_SUCCEEDED'
  | 'ROLLBACK_RESOURCE_FAILED'
  | 'ROLLBACK_FINISHED';

/**
 * Error metadata captured on `RESOURCE_FAILED` / `ROLLBACK_RESOURCE_FAILED`
 * / failed `RUN_FINISHED` events. Extracted from the thrown error chain —
 * never includes resource properties.
 */
export interface DeploymentEventError {
  /** `Error.name` of the outermost thrown error. */
  name: string;
  /** `Error.message` of the outermost thrown error. */
  message: string;
  /**
   * AWS service error code (e.g. `AccessDeniedException`), taken from the
   * innermost AWS-SDK-shaped error in the `.cause` chain when present.
   */
  awsErrorCode?: string;
  /** AWS request id from the same AWS-SDK-shaped error, when present. */
  requestId?: string;
}

/**
 * One structured deployment event (one JSONL line). Flat shape with
 * per-event-type optional fields, mirroring how CloudFormation stack
 * events carry a superset of columns.
 */
export interface DeploymentEvent {
  /** ISO 8601 timestamp, stamped at record time. */
  timestamp: string;
  eventType: DeploymentEventType;
  /**
   * The stack the event belongs to. Usually the run's own stack; nested
   * stack children deployed inside a parent run record the CHILD stack
   * name here while landing in the parent's run stream.
   */
  stackName: string;
  /** RUN_STARTED only: the command that started the run. */
  command?: DeploymentRunCommand;
  /** RUN_STARTED only: target region. */
  region?: string;
  /** RUN_STARTED only: cdkd version that performed the run. */
  cdkdVersion?: string;
  /** RUN_FINISHED only: terminal result. */
  result?: DeploymentRunResult;
  /** Per-resource events: operation kind. */
  operation?: DeploymentResourceOperation;
  /** Per-resource events: template logical id. */
  logicalId?: string;
  /** Per-resource events: CloudFormation resource type. */
  resourceType?: string;
  /** RESOURCE_SUCCEEDED: the AWS physical id (when known). */
  physicalId?: string;
  /** Per-resource events: routing layer (#614), when known. */
  provisionedBy?: 'sdk' | 'cc-api';
  /** RESOURCE_SUCCEEDED / RESOURCE_FAILED / RUN_FINISHED: elapsed ms. */
  durationMs?: number;
  /** RUN_FINISHED (deploy success): per-operation counters. */
  counts?: {
    created: number;
    updated: number;
    deleted: number;
    failed?: number;
  };
  /** Failure events: extracted error metadata (never properties). */
  error?: DeploymentEventError;
}

/**
 * Minimal recording seam the deploy engine / destroy runner emit through.
 * `record` MUST be synchronous and MUST never throw — implementations
 * buffer in memory and flush to S3 asynchronously (best-effort).
 */
export interface DeploymentEventRecorder {
  record(event: Omit<DeploymentEvent, 'timestamp'>): void;
  /**
   * The run's id, when the recorder is a real `DeploymentEventsStore`. The
   * deploy engine stamps it into the rollback-journal segment it writes on a
   * failed deploy (issue #1183) so `cdkd events` can correlate the failed
   * run with its later `cdkd rollback` run.
   */
  readonly runId?: string;
}

/**
 * Per-run summary row in `deployments/index.json`.
 */
export interface DeploymentRunSummary {
  runId: string;
  command: DeploymentRunCommand;
  cdkdVersion: string;
  /** ISO 8601 — when the run's recorder was opened. */
  startedAt: string;
  /** ISO 8601 — when the run was finalized. */
  finishedAt: string;
  /**
   * Terminal result. `'SUCCEEDED'` / `'FAILED'` come from the index
   * (written by `finalize()`); `'UNKNOWN'` only appears in the read-side
   * index-fallback when a run's JSONL carries no terminal `RUN_FINISHED`
   * event (see {@link DeploymentRunSummaryResult}).
   */
  result: DeploymentRunSummaryResult;
  /** Number of events persisted for the run. */
  eventCount: number;
}

/** Schema version for `deployments/index.json` (independent of state.json). */
export const DEPLOYMENT_EVENTS_INDEX_VERSION = 1;

/**
 * On-disk shape of `deployments/index.json`. Written WITHOUT optimistic
 * locking — last-writer-wins is acceptable for this derived view (the
 * per-run `.jsonl` files are the source of truth and are keyed by unique
 * runId, so concurrent runs never clobber each other's event streams).
 */
export interface DeploymentRunIndexFile {
  indexVersion: number;
  stackName: string;
  region: string;
  /** Newest-first, truncated to the last N runs. */
  runs: DeploymentRunSummary[];
  lastModified: number;
}

/**
 * Walk an error's `.cause` chain (bounded) and extract metadata for a
 * deployment event. The outermost error supplies `name` / `message`
 * (matching what the user sees in the log); the innermost AWS-SDK-shaped
 * error (the one carrying `$metadata`) supplies `awsErrorCode` /
 * `requestId` when present.
 */
export function extractDeploymentEventError(err: unknown): DeploymentEventError {
  if (!(err instanceof Error)) {
    return { name: 'UnknownError', message: String(err) };
  }
  const result: DeploymentEventError = {
    name: err.name || 'Error',
    message: err.message,
  };
  // Find the deepest AWS-shaped error in the cause chain (bounded depth
  // so a pathological self-referencing chain cannot loop forever).
  let current: unknown = err;
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    const maybeAws = current as Error & {
      $metadata?: { requestId?: string };
      Code?: string;
    };
    if (maybeAws.$metadata !== undefined) {
      const code = maybeAws.Code ?? maybeAws.name;
      if (code) result.awsErrorCode = code;
      if (maybeAws.$metadata.requestId) result.requestId = maybeAws.$metadata.requestId;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return result;
}
