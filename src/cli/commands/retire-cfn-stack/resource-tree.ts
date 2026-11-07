import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { isPasteableIdent } from '../../../utils/display-safe.js';
import { commandHole } from '../../../utils/pasteable-command.js';
import { NESTED_STACK_RESOURCE_TYPE, type CfnStackResourceTree } from './types.js';

/**
 * Walk a CloudFormation stack and every nested child recursively, returning
 * the full {@link CfnStackResourceTree} rooted at `rootStackName`. Used by
 * `cdkd import --migrate-from-cloudformation` to drive BOTH per-child state
 * writes AND the recursive `injectRetainPoliciesRecursive` walk — both
 * consumers share this single `DescribeStackResources` tree so an
 * arbitrarily-deep nesting only costs one round-trip per stack.
 *
 * For each `AWS::CloudFormation::Stack` row in the root's resources, recursively
 * calls `DescribeStackResources(<child ARN>)` (AWS accepts the ARN as
 * `StackName`) to populate the child node, and so on to arbitrary depth.
 *
 * Issue [#464](https://github.com/go-to-k/cdkd/issues/464): the recursive
 * `cdkd import --migrate-from-cloudformation` flow uses this once at the
 * top of the import command to drive BOTH (a) per-child state writes
 * under the v6 state-key shape `cdkd/<parent>~<child>/<region>/state.json`
 * AND (b) the recursive `injectRetainPoliciesRecursive` walk that retires
 * the whole tree on AWS without orphaning any resources.
 *
 * Children at every level are fetched in parallel via `Promise.all` so an
 * N-stack-wide tree only takes log(depth) round-trips of wall-clock time
 * instead of N — load-bearing when a CDK app spreads micro-services across
 * many nested children.
 *
 * Tree node `physicalId` is the AWS-side identifier accepted by every
 * CFn API call (`DescribeStackResources` / `GetTemplate`). For the root,
 * that's the user-supplied stack name; for nested children, the child
 * stack ARN.
 */
export async function getCloudFormationResourceTree(
  rootStackName: string,
  cfnClient: CloudFormationClient
): Promise<CfnStackResourceTree> {
  return walkCfnStackTree(rootStackName, rootStackName, cfnClient);
}

async function walkCfnStackTree(
  stackName: string,
  physicalId: string,
  cfnClient: CloudFormationClient
): Promise<CfnStackResourceTree> {
  const resp = await cfnClient.send(new DescribeStackResourcesCommand({ StackName: physicalId }));
  const resources = new Map<string, string>();
  const nestedChildren: { logicalId: string; childArn: string }[] = [];
  for (const r of resp.StackResources ?? []) {
    if (!r.LogicalResourceId || !r.PhysicalResourceId) continue;
    resources.set(r.LogicalResourceId, r.PhysicalResourceId);
    if (r.ResourceType === NESTED_STACK_RESOURCE_TYPE) {
      nestedChildren.push({ logicalId: r.LogicalResourceId, childArn: r.PhysicalResourceId });
    }
  }
  const childPairs = await Promise.all(
    nestedChildren.map(async ({ logicalId, childArn }) => ({
      logicalId,
      node: await walkCfnStackTree(childArn, childArn, cfnClient),
    }))
  );
  const nested = new Map<string, CfnStackResourceTree>();
  for (const { logicalId, node } of childPairs) {
    nested.set(logicalId, node);
  }
  return { stackName, physicalId, resources, nested };
}

/** One resource whose physical id differs between two reads of a stack tree. */
export interface ReplacedCfnResource {
  /** Nested-stack logical ids from the root down to the owning stack; `[]` for the root. */
  nestedPath: string[];
  logicalId: string;
  before: string;
  after: string;
}

/**
 * Every resource present in BOTH trees whose physical id changed — what the
 * Retain update replaced (issue #4873). Walks nested children matched by
 * logical id. A row present in only one tree is not a replacement and is left
 * to the import's own not-found handling.
 */
export function findReplacedCfnResources(
  before: CfnStackResourceTree,
  after: CfnStackResourceTree,
  nestedPath: string[] = []
): ReplacedCfnResource[] {
  const replaced: ReplacedCfnResource[] = [];
  for (const [logicalId, beforeId] of before.resources) {
    const afterId = after.resources.get(logicalId);
    if (afterId !== undefined && afterId !== beforeId) {
      replaced.push({ nestedPath, logicalId, before: beforeId, after: afterId });
    }
  }
  for (const [childLogicalId, beforeChild] of before.nested) {
    const afterChild = after.nested.get(childLogicalId);
    if (afterChild) {
      replaced.push(
        ...findReplacedCfnResources(beforeChild, afterChild, [...nestedPath, childLogicalId])
      );
    }
  }
  return replaced;
}

/**
 * Flat `logicalId -> physicalId` map for ONE CloudFormation stack, or `null`
 * when no stack of that name exists.
 *
 * This is the non-recursive, non-throwing sibling of
 * {@link getCloudFormationResourceTree}, used by `cdkd import`'s auto mode as
 * a best-effort lookup (issue #1128). The distinction matters:
 *
 *   - the tree walk is for `--migrate-from-cloudformation`, where the stack is
 *     known to exist and nested children must be walked so each child's state
 *     can be written and the whole tree retired;
 *   - this one runs speculatively on every auto-mode import, so a missing
 *     stack is the NORMAL case (a cdkd-native stack has no CFn counterpart)
 *     and must return `null` rather than abort the import.
 *
 * NO failure is fatal. The lookup is an OPTIMIZATION: when it cannot answer,
 * the caller falls through to the per-provider lookups, which is exactly the
 * behavior that shipped before this function existed. Throwing would convert a
 * missed improvement into a hard failure — and it would do so precisely for the
 * users least likely to benefit. A cdkd-native stack has no CloudFormation
 * counterpart, so an operator whose IAM policy is scoped to cdkd's actual needs
 * (no `cloudformation:DescribeStackResources`) would see `AccessDenied` abort an
 * import that worked fine the day before.
 *
 * A missing stack is the expected case and logs at debug. Anything else logs a
 * WARN naming the cause, so a permissions gap or a throttle is visible rather
 * than silent — the user learns why the ids were not resolved, and still gets
 * the pre-existing behavior instead of an abort.
 */
export async function tryGetCloudFormationResourceMap(
  stackName: string,
  cfnClient: CloudFormationClient
): Promise<Map<string, string> | null> {
  const logger = getLogger();
  let resp;
  try {
    resp = await cfnClient.send(new DescribeStackResourcesCommand({ StackName: stackName }));
  } catch (err) {
    if (isStackNotFoundError(err)) {
      logger.debug(`No CloudFormation stack named '${stackName}'.`);
      return null;
    }
    const reason = describeAwsFailure(err).detail;
    // The stack name is shown only when plain and described otherwise, and
    // AWS's message (which can echo it) ends its own line, so the `--resource`
    // remedy starts the next one, with its holes quoted (go-to-k/cdkd#4226):
    // inside cdkd's own `'...'` a `'` in the name closed the quote, a
    // JSON-quoted `$( )` still runs when pasted, and a bare `<physicalId>`
    // redirects.
    const subject = isPasteableIdent(stackName)
      ? `CloudFormation stack '${stackName}'`
      : 'a CloudFormation stack whose name is not a plain identifier';
    logger.warn(
      `Could not read ${subject} to resolve physical IDs (${reason}).\n` +
        `Falling back to per-resource lookup; resources whose physical name CloudFormation ` +
        `generated may be reported as not found. Grant cloudformation:DescribeStackResources, ` +
        `or pass --resource ${commandHole('LogicalId')}=${commandHole('physicalId')} for those resources.`
    );
    return null;
  }

  const resources = new Map<string, string>();
  for (const r of resp.StackResources ?? []) {
    if (!r.LogicalResourceId || !r.PhysicalResourceId) continue;
    resources.set(r.LogicalResourceId, r.PhysicalResourceId);
  }
  return resources;
}

/**
 * CloudFormation reports an unknown stack as a `ValidationError` whose message
 * carries "does not exist" — there is no dedicated exception type to catch.
 * Matching the message is therefore required, but it is kept narrow so an
 * unrelated ValidationError (a malformed stack name, say) still surfaces.
 */
export function isStackNotFoundError(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  const message = (err as { message?: string } | undefined)?.message ?? '';
  return name === 'ValidationError' && /does not exist/i.test(message);
}
