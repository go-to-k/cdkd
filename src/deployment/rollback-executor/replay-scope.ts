import type {
  ResourceState,
  StackOrphanRecord,
  SupersededResourceRecord,
} from '../../types/state.js';
import type { RolledBackCreate } from '../../state/name-generation.js';
import type { Logger } from '../../types/config.js';
import type { RollbackInlinePolicyWriters } from '../inline-policy-claims.js';
import type { RecordedSecretValues } from '../secret-redaction.js';
import { withPrintingSecrets } from '../resource-secrets-scope.js';
import type { OpMasker } from './names.js';
import type { ReplayResolvers } from './replay-secrets.js';
import type {
  CompletedOperation,
  RollbackActionKind,
  RollbackExecutorContext,
  RollbackReplayResult,
} from './types.js';

/**
 * One op's replay, as `replaySingle` hands it to an arm (issue #4426): its
 * parameters, plus the per-op values it builds before dispatching on the
 * action. The arms live in `replay-*.ts`; the shared catch stays in
 * `replaySingle`, which is why the one value an arm WRITES is a field here.
 */
export interface ReplayOpScope {
  readonly op: CompletedOperation;
  readonly stateResources: Record<string, ResourceState>;
  readonly stackName: string;
  readonly ctx: RollbackExecutorContext;
  readonly resolver: ReplayResolvers;
  readonly orphanLogicalIds: Set<string>;
  readonly result: RollbackReplayResult;
  readonly onOrphan: ((record: StackOrphanRecord) => void) | undefined;
  /** go-to-k/cdkd#5064: told of a CREATE taken back before `afterOp` saves. */
  readonly onRolledBackCreate: ((create: RolledBackCreate) => void) | undefined;
  readonly inlinePolicyWriters: RollbackInlinePolicyWriters;
  readonly afterOp: ((logicalId: string) => Promise<void> | void) | undefined;
  readonly isInterrupted: (() => boolean) | undefined;
  readonly action: RollbackActionKind;
  readonly logger: Logger;
  /** The op's `plaintext -> {{resolve:...}}` bag; see its doc in `replaySingle`. */
  readonly secrets: RecordedSecretValues;
  readonly opMasker: OpMasker;
  readonly mask: OpMasker['mask'];
  /** go-to-k/cdkd#5096: the logical ids this segment CREATED (its CREATE pass deletes them). */
  readonly createdInSegment: ReadonlySet<string>;
  /**
   * The route a CREATE-rollback arm resolved (issue #1366), read by
   * `replaySingle`'s shared catch for its ROLLBACK_RESOURCE_FAILED event.
   */
  createRollbackRoute: 'sdk' | 'cc-api' | undefined;
  /** go-to-k/cdkd#5064: set when the replay runs this op ahead of its slot. */
  readonly deferral: ReplayDeferral | undefined;
}

/**
 * go-to-k/cdkd#5064: a renamed reverse-replacement run AHEAD of the ops that
 * revert to its old name. The create-first arm hands its delete of the new
 * resource to `defer` instead of running it, and the replay runs it at the
 * op's own slot, after those ops moved off the new resource. The handed
 * function never throws.
 *
 * Between the two, no record holds the new resource, so the arm reports it to
 * `onSuperseded` BEFORE `afterOp` saves the old record, and to
 * `onSupersededSettled` once the delete ran: a run killed in between leaves it
 * in `StackState.supersededResources` (#5111), which the next deploy deletes.
 *
 * `keep` is handed only when the new resource IS so recorded: the replay calls
 * it INSTEAD of `finish` when a resource that still uses the new copy did not
 * revert, or on an interrupt, and the entry stays for the next deploy.
 */
export interface ReplayDeferral {
  defer(finish: () => Promise<void>, keep?: (reason: string) => void): void;
  onSuperseded?: ((entry: SupersededResourceRecord) => void) | undefined;
  onSupersededSettled?: ((entry: SupersededResourceRecord) => void) | undefined;
}

/**
 * Run a replay arm's `delete()` under the op's bag and the failed deploy's
 * (`RollbackExecutorContext.logOnlyNeedlesFor`) as PRINTING bags
 * (go-to-k/cdkd#2007), so every line the provider logs while deleting is
 * masked by the logger's sink, a provider that never reads
 * `DeleteContext.maskSecrets` included. Printing only: no provider can read
 * either bag back (`withPrintingSecrets`). The bag a rollback deletes with and
 * the name it addresses carry the DEPLOY's resolution, while the op's bag
 * re-resolves the previous generation, so both are bound.
 */
export function withReplayDeletePrinting<T>(
  scope: Pick<ReplayOpScope, 'ctx' | 'op' | 'secrets'>,
  fn: () => T
): T {
  const deployBag = scope.ctx.logOnlyNeedlesFor?.(scope.op.logicalId);
  return withPrintingSecrets(scope.secrets, () =>
    deployBag === undefined ? fn() : withPrintingSecrets(deployBag, fn)
  );
}

/**
 * go-to-k/cdkd#5064: report that a CREATE's resource was taken back and its
 * record (`undefined` for none) left `stateResources`: onto `result`, and to
 * the caller's callback BEFORE the arm's `afterOp` saves, so every save from
 * then on retires the logical id's generation. CREATE ops only.
 */
export function noteRolledBackCreate(
  scope: {
    result: Pick<RollbackReplayResult, 'rolledBackCreates'>;
    onRolledBackCreate: ((create: RolledBackCreate) => void) | undefined;
  },
  op: { logicalId: string; changeType: string; nameGeneration?: unknown },
  record: ResourceState | undefined
): void {
  if (op.changeType !== 'CREATE') return;
  const create: RolledBackCreate = {
    logicalId: op.logicalId,
    record,
    ...(op.nameGeneration !== undefined && { nameGeneration: op.nameGeneration }),
  };
  scope.result.rolledBackCreates.push(create);
  scope.onRolledBackCreate?.(create);
}
