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

  // go-to-k/cdkd#4043: a reader promoted ONLY because a `NoEcho` parameter's
  // value may have moved is no template change (the engine compares it with
  // AWS and skips it when unchanged), so it is not asked about.
  const changes = [...args.changes].filter(
    (c) => c.changeType !== 'NO_CHANGE' && !isNoEchoPromotionOnly(c)
  );
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

/**
 * go-to-k/cdkd#4705: hand a plan that DESTROYS something to
 * `options.onDestructivePlan`, BEFORE the approval prompt (a user is never asked
 * and then refused) and any provider call. Destroys means a change classified
 * `WILL_DESTROY` or `WILL_REPLACE` by `findDestructiveChanges` (a
 * `--recreate-via-*` target is `WILL_REPLACE`); `MAY_REPLACE` and a retained
 * removal (`WILL_ORPHAN`) delete nothing, so they do not trigger it. A
 * nested-stack row being updated, replaced or removed also triggers it, since
 * the child's own plan is only known once its row runs, after the parent has
 * started changing things (children never run the hook themselves). Nothing is
 * computed when no hook is set.
 */
export async function checkDestructivePlan(args: {
  options: Pick<DeployEngineOptions, 'onDestructivePlan'>;
  stackName: string;
  changes: Iterable<ResourceChange>;
  records: Readonly<Record<string, ResourceState>>;
  template: CloudFormationTemplate;
  recreateTargetIds?: Iterable<string> | undefined;
}): Promise<void> {
  const hook = args.options.onDestructivePlan;
  if (hook === undefined) return;
  const changes = [...args.changes].filter(
    (c) => c.changeType !== 'NO_CHANGE' && !isNoEchoPromotionOnly(c)
  );
  const destroying = findDestructiveChanges(
    args.stackName,
    changes,
    args.records,
    args.template,
    new Set(args.recreateTargetIds ?? [])
  ).filter((c) => c.impact === 'WILL_DESTROY' || c.impact === 'WILL_REPLACE');
  const nestedRowChanges = changes.some((c) => c.resourceType === NESTED_STACK_TYPE);
  if (destroying.length === 0 && !nestedRowChanges) return;
  await hook(args.stackName, destroying);
}

function approvalAfterTimeout(stackName: string): Error {
  return markNonRetryable(
    new CdkdError(
      safeMsg`Deployment of stack ${stackName} was not started: its parent's nested-stack row already timed out (--resource-timeout). Nothing was changed.`,
      'DEPLOY_APPROVAL_AFTER_TIMEOUT'
    )
  );
}

/**
 * `--require-approval=any-change` for a deploy with no resource change whose
 * Outputs (or export set) still change — the AWS CDK CLI asks for any change,
 * and a changed `Export` reaches every stack importing it. Asked before the
 * no-change path persists the outputs. `destructive` never asks here: no
 * resource is touched.
 */
export async function requireOutputsOnlyApproval(args: {
  options: Pick<DeployEngineOptions, 'requireApproval' | 'approveDeployment'>;
  stackName: string;
}): Promise<void> {
  const approve = args.options.approveDeployment;
  if (args.options.requireApproval !== 'any-change' || approve === undefined) return;
  if (enclosingDeadlineExpired()) throw approvalAfterTimeout(args.stackName);
  let approved: boolean;
  try {
    approved = await whileEnclosingDeadlinesPaused(() =>
      approve({
        stackName: args.stackName,
        level: 'any-change',
        counts: { create: 0, update: 0, delete: 0 },
        destructiveChanges: [],
        outputsOnly: true,
      })
    );
  } catch (error) {
    throw error instanceof Error ? markNonRetryable(error) : error;
  }
  if (!approved) {
    throw markNonRetryable(
      new CdkdError(
        safeMsg`Deployment of stack ${args.stackName} was not approved (--require-approval=any-change). Nothing was changed.`,
        'DEPLOY_NOT_APPROVED'
      )
    );
  }
}

/**
 * An UPDATE whose every property change is a `NoEcho` promotion and that
 * carries no attribute change (go-to-k/cdkd#4043).
 */
export function isNoEchoPromotionOnly(change: ResourceChange): boolean {
  return (
    change.changeType === 'UPDATE' &&
    (change.attributeChanges?.length ?? 0) === 0 &&
    (change.propertyChanges?.length ?? 0) > 0 &&
    change.propertyChanges!.every((pc) => pc.noEchoPromoted === true)
  );
}
