import type { ResourceState, StackOrphanRecord } from '../../types/state.js';
import type { Logger } from '../../types/config.js';
import type { RollbackInlinePolicyWriters } from '../inline-policy-claims.js';
import type { RecordedSecretValues } from '../secret-redaction.js';
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
  readonly inlinePolicyWriters: RollbackInlinePolicyWriters;
  readonly afterOp: ((logicalId: string) => Promise<void> | void) | undefined;
  readonly isInterrupted: (() => boolean) | undefined;
  readonly action: RollbackActionKind;
  readonly logger: Logger;
  /** The op's `plaintext -> {{resolve:...}}` bag; see its doc in `replaySingle`. */
  readonly secrets: RecordedSecretValues;
  readonly opMasker: OpMasker;
  readonly mask: OpMasker['mask'];
  /**
   * The route a CREATE-rollback arm resolved (issue #1366), read by
   * `replaySingle`'s shared catch for its ROLLBACK_RESOURCE_FAILED event.
   */
  createRollbackRoute: 'sdk' | 'cc-api' | undefined;
}
