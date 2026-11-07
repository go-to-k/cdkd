import type { DagBuilder } from '../../../analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../types/state.js';
import type { phaseScopeForStack } from '../../../utils/phase-timings.js';
import type { DeployEngine, ProvisionCounts } from '../../deploy-engine.js';
import type { CompletedOperation, FailedOperation } from '../../rollback-executor.js';
import type { InFlightWrite } from '../../stack-records-scope.js';
import type { ReportedCreateToSettle } from './helpers.js';

/**
 * The state one `executeDeployment` call shares with the modules its body was
 * split into (go-to-k/cdkd#5835). Every field is the same binding the call
 * declared: the containers are shared by reference, so a module that pushes
 * to one is seen by the call and by every other module. The call's
 * reassigned locals (`currentEtag`, `pendingMigration`, the save chain) are
 * deliberately NOT here: they stay in `execute.ts`, and a module that reads
 * one is passed its value.
 */
export interface DeployRun {
  readonly engine: DeployEngine;
  readonly template: CloudFormationTemplate;
  readonly currentState: StackState;
  readonly changes: Map<string, ResourceChange>;
  readonly dag: ReturnType<DagBuilder['buildGraph']>;
  readonly stackName: string;
  readonly parameterValues: Record<string, unknown> | undefined;
  readonly conditions: Record<string, boolean> | undefined;
  readonly progress: { current: number; total: number } | undefined;
  readonly newResources: Record<string, ResourceState>;
  readonly actualCounts: ProvisionCounts;
  readonly completedOperations: CompletedOperation[];
  readonly failedOperations: FailedOperation[];
  readonly reportedCreatesToSettle: ReportedCreateToSettle[];
  readonly phaseScope: ReturnType<typeof phaseScopeForStack>;
  readonly saveStateAfterResource: (logicalId: string) => void;
  readonly deleteChanges: Set<string>;
  readonly startedUpdates: Set<string>;
  readonly settledUpdates: Set<string>;
  readonly inFlightWrites: Map<string, { write: InFlightWrite; settle: (ok: boolean) => void }>;
}
