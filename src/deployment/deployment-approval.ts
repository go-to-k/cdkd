import { findDestructiveChanges } from '../analyzer/destructive-changes.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceChange, ResourceState } from '../types/state.js';
import { safeMsg } from '../utils/display-safe.js';
import { CdkdError } from '../utils/error-handler.js';
import type { DeployEngineOptions } from './deploy-engine/options.js';
import { enclosingDeadlineExpired, whileEnclosingDeadlinesPaused } from './resource-deadline.js';
import { markNonRetryable } from './retryable-errors.js';

const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';

/**
 * `--require-approval` (AWS CDK CLI parity, aws/aws-cdk-cli#2021): ask the
 * operator about the diff this deploy is about to execute, and throw unless
 * they approve. Called after the `--dry-run` return and before any provider
 * call, so a declined deploy changes nothing.
 *
 * - `destructive` asks when a change replaces, deletes or orphans a resource
 *   (`findDestructiveChanges`). A `--recreate-via-*` target counts as a
 *   replacement: the engine destroys and re-creates it whatever its properties
 *   say.
 * - `any-change` asks for any change, except when every change is an UPDATE of
 *   a nested-stack row: each child engine asks for its own changes when the
 *   row is reached, so asking here too would ask twice for one change. A
 *   nested row's CREATE or DELETE is still asked here — a deleted child runs no
 *   engine to ask.
 *
 * A nested child asks from inside its parent row's provider call, so the row's
 * deadline (and every one enclosing it) is paused while the question is open.
 * One that already expired before the question (the child's own load and diff
 * outlived it) refuses without asking: the parent has failed, so a "yes"
 * could only provision a child nothing will track.
 */
export async function requireDeploymentApproval(args: {
  options: Pick<DeployEngineOptions, 'requireApproval' | 'approveDeployment'>;
  stackName: string;
  changes: Iterable<ResourceChange>;
  records: Readonly<Record<string, ResourceState>>;
  template: CloudFormationTemplate;
  recreateTargetIds?: Iterable<string> | undefined;
}): Promise<void> {
  const level = args.options.requireApproval ?? 'never';
  const approve = args.options.approveDeployment;
  if (level === 'never' || approve === undefined) return;

  const changes = [...args.changes].filter((c) => c.changeType !== 'NO_CHANGE');
  const destructiveChanges = findDestructiveChanges(
    args.stackName,
    changes,
    args.records,
    args.template,
    new Set(args.recreateTargetIds ?? [])
  );
  const onlyNestedUpdates = changes.every(
    (c) => c.changeType === 'UPDATE' && c.resourceType === NESTED_STACK_TYPE
  );
  const ask =
    level === 'destructive'
      ? destructiveChanges.length > 0
      : changes.length > 0 && !onlyNestedUpdates;
  if (!ask) return;

  const count = (type: ResourceChange['changeType']): number =>
    changes.filter((c) => c.changeType === type).length;
  // Already timed out: a "yes" could not take effect, so do not ask.
  if (enclosingDeadlineExpired()) throw approvalAfterTimeout(args.stackName);
  let approved: boolean;
  try {
    approved = await whileEnclosingDeadlinesPaused(() =>
      approve({
        stackName: args.stackName,
        level,
        counts: { create: count('CREATE'), update: count('UPDATE'), delete: count('DELETE') },
        destructiveChanges,
      })
    );
  } catch (error) {
    // A refusal to ask (no terminal) is no more transient than a "no".
    throw error instanceof Error ? markNonRetryable(error) : error;
  }
  // Non-retryable: the operator's answer is not a transient failure, and the
  // messages carry a template-chosen stack name.
  if (!approved) {
    throw markNonRetryable(
      new CdkdError(
        safeMsg`Deployment of stack ${args.stackName} was not approved (--require-approval=${level}). Nothing was changed.`,
        'DEPLOY_NOT_APPROVED'
      )
    );
  }
}

function approvalAfterTimeout(stackName: string): Error {
  return markNonRetryable(
    new CdkdError(
      safeMsg`Deployment of stack ${stackName} was not started: its parent's nested-stack row already timed out (--resource-timeout). Nothing was changed.`,
      'DEPLOY_APPROVAL_AFTER_TIMEOUT'
    )
  );
}
