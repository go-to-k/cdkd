import { supersededResourcesOf } from '../../../deployment/superseded-resources.js';
import {
  NO_LOCAL_CUSTOM_RESOURCES_FLAG,
  customResourcesRunWithoutApp,
  localCustomResourceCommand,
} from '../../../local/custom-resource-runtime-gate.js';
import { isCustomResourceType } from '../../../provisioning/custom-resource-secure-references.js';
import type { StackState } from '../../../types/state.js';
import type { AwsClients } from '../../../utils/aws-clients.js';
import { CdkdError } from '../../../utils/error-handler.js';
import {
  pasteableCommand,
  plainOrDescribed,
  withheldTargetClause,
} from '../../../utils/pasteable-command.js';

/** How many custom resources the refusal names before summarizing the rest. */
const NAMED_MAX = 5;

/** A backstop on the nested-stack walk, far past any real tree. */
const MAX_NESTED_DEPTH = 32;

const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';

/**
 * A Lambda function ARN (optionally qualified): the only `ServiceToken` whose
 * event the local runtime takes. An SNS topic's event goes to the emulator
 * whatever the command read.
 */
const LAMBDA_FUNCTION_ARN = /^arn:aws[a-z-]*:lambda:[^:]+:(\d{12}):function:[^:]+(?::[^:]+)?$/;

/** A top-level stack the destroy targets, in the region its record is read from. */
export interface CustomResourceCheckTarget {
  readonly stackName: string;
  readonly region: string;
}

export interface CustomResourceCheckDeps {
  /** The state backend's read; `null` for a missing record. */
  getState(stackName: string, region: string): Promise<{ state: StackState } | null>;
  /** The account the run's credentials resolve to; `undefined` when unreadable. */
  callerAccount(): Promise<string | undefined>;
}

/**
 * go-to-k/cdkd#6246: refuse, before the first stack is touched, a destroy under
 * `--aws-emulator` that read no CDK app while a target stack, or a nested
 * stack under it, holds custom resources whose events the local runtime would
 * have run.
 *
 * Without the app, the local custom-resource runtime has no function code, so
 * every Delete goes to AWS Emulator's own Lambda runtime, which fails CDK's own
 * providers (`AwsCustomResource`, `autoDeleteObjects`, `BucketDeployment`).
 * The run then went on to delete the handler functions with the rest of the
 * stack, so the advised `cdkd destroy` from the app could no longer run them
 * and whatever they manage stayed live. Refused here, the handlers are still
 * in place when the operator follows the remedy.
 *
 * - Called by `cdkd destroy` and `cdkd state destroy` once, over EVERY target,
 *   before the per-stack loop, so a multi-stack run is refused before its
 *   first stack is destroyed. The refusal names the top-level stacks: a nested
 *   child's record is walked from its parent's `AWS::CloudFormation::Stack`
 *   rows (`<parent>~<logicalId>`, in the parent's region), and its custom
 *   resources are named with the child's name beside them.
 * - Only custom resources whose recorded `ServiceToken` is a Lambda function
 *   ARN in the run's account: an SNS-backed one, or one backed by another
 *   account's function, never reaches the local runtime either way.
 * - Never under `--no-local-custom-resources`, which turns the local runtime
 *   off: the operator accepting the emulator's runtime. Never for any other
 *   command (a rollback that removes a nested stack has its own remedy,
 *   go-to-k/cdkd#6247).
 */
export async function refuseCustomResourcesWithoutApp(
  targets: readonly CustomResourceCheckTarget[],
  deps: CustomResourceCheckDeps
): Promise<void> {
  const command = localCustomResourceCommand();
  if (command !== 'destroy' && command !== 'state destroy') return;
  if (!customResourcesRunWithoutApp() || targets.length === 0) return;
  const account = await deps.callerAccount().catch(() => undefined);
  const found: Array<{ stackName: string; customResources: string[] }> = [];
  for (const target of targets) {
    const record = await deps.getState(target.stackName, target.region);
    if (record === null) continue;
    // A nested child named directly (`cdkd state destroy Parent~Child`) is
    // named by its top-level stack, the one `cdkd destroy` addresses.
    const root = target.stackName.split('~')[0] || target.stackName;
    const customResources: string[] = [];
    await collect(
      target.stackName,
      target.region,
      record.state,
      root === target.stackName ? undefined : target.stackName,
      0,
      account,
      deps,
      customResources
    );
    if (customResources.length === 0) continue;
    const existing = found.find((f) => f.stackName === root);
    if (existing === undefined) found.push({ stackName: root, customResources });
    else existing.customResources.push(...customResources);
  }
  if (found.length === 0) return;
  throw new CdkdError(customResourcesWithoutAppMessage(found), 'EMULATOR_CR_NO_APP');
}

/**
 * {@link refuseCustomResourcesWithoutApp} over the run's state backend and
 * clients: the one call `cdkd destroy` and `cdkd state destroy` make.
 */
export function refuseDestroyTargetsWithoutApp(
  targets: readonly CustomResourceCheckTarget[],
  stateBackend: Pick<CustomResourceCheckDeps, 'getState'>,
  clients: Pick<AwsClients, 'sts'>
): Promise<void> {
  return refuseCustomResourcesWithoutApp(targets, {
    getState: (stackName, region) => stateBackend.getState(stackName, region),
    callerAccount: () => callerAccountOf(clients),
  });
}

/**
 * The account the run's credentials resolve to (STS `GetCallerIdentity`), or
 * `undefined` when it cannot be read: the check then takes every Lambda
 * function ARN. Only called once the check is live (`--aws-emulator`).
 */
export async function callerAccountOf(
  clients: Pick<AwsClients, 'sts'>
): Promise<string | undefined> {
  try {
    const { GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    return (await clients.sts.send(new GetCallerIdentityCommand({}))).Account;
  } catch {
    return undefined;
  }
}

/** Whether the local runtime would have taken this custom resource's event. */
export function runsInLocalRuntime(serviceToken: unknown, account: string | undefined): boolean {
  if (typeof serviceToken !== 'string') return false;
  const match = LAMBDA_FUNCTION_ARN.exec(serviceToken);
  return match !== null && (account === undefined || match[1] === account);
}

async function collect(
  stackName: string,
  region: string,
  state: StackState,
  nestedStack: string | undefined,
  depth: number,
  account: string | undefined,
  deps: CustomResourceCheckDeps,
  out: string[]
): Promise<void> {
  const label = (logicalId: string): string =>
    plainOrDescribed(logicalId, 'logical id') +
    (nestedStack === undefined
      ? ''
      : ` in nested stack ${plainOrDescribed(nestedStack, 'stack name')}`);
  const rows =
    state.resources !== null && typeof state.resources === 'object' ? state.resources : {};
  for (const [logicalId, row] of Object.entries(rows)) {
    if (row === null || typeof row !== 'object') continue;
    if (
      isCustomResourceType(row.resourceType) &&
      runsInLocalRuntime(row.properties?.['ServiceToken'], account)
    ) {
      out.push(label(logicalId));
    } else if (row.resourceType === NESTED_STACK_TYPE && depth < MAX_NESTED_DEPTH) {
      const childName = `${stackName}~${logicalId}`;
      const child = await deps.getState(childName, region);
      if (child !== null) {
        await collect(childName, region, child.state, childName, depth + 1, account, deps, out);
      }
    }
  }
  for (const entry of supersededResourcesOf(state)) {
    if (
      isCustomResourceType(entry.state.resourceType) &&
      runsInLocalRuntime(entry.state.properties?.['ServiceToken'], account)
    ) {
      out.push(label(entry.logicalId));
    }
  }
}

/** The refusal text, exported for the unit test. */
export function customResourcesWithoutAppMessage(
  found: ReadonlyArray<{ stackName: string; customResources: readonly string[] }>
): string {
  const stacks = found
    .map(({ stackName, customResources }) => {
      const named = customResources.slice(0, NAMED_MAX);
      const more = customResources.length - named.length;
      return (
        `${plainOrDescribed(stackName, 'stack name')} (` +
        named.join(', ') +
        (more > 0 ? ` and ${more} more` : '') +
        ')'
      );
    })
    .join('; ');
  const destroy = pasteableCommand(
    'cdkd destroy',
    found.map(({ stackName }) => ({
      value: stackName,
      hole: 'stack',
      opts: { plainIdent: true },
    }))
  );
  return (
    `Custom resources in ${found.length === 1 ? 'stack' : 'stacks'} ${stacks} would run their ` +
    `Delete handlers in AWS Emulator's own Lambda runtime, because this command did not ` +
    `synthesize the CDK app, and that runtime fails CDK's own provider functions. The destroy ` +
    `would then delete the handler functions too, leaving what the custom resources manage ` +
    `behind with nothing left to delete it. Nothing was deleted.\n` +
    `Run the destroy from the app's directory (Docker running), so the handlers run locally, ` +
    `or pass ${NO_LOCAL_CUSTOM_RESOURCES_FLAG} to send them to AWS Emulator's runtime anyway.` +
    withheldTargetClause(destroy, 'stack', 'cdkd destroy', "A stack's name") +
    `\nRun from the app's directory: ${destroy.command}`
  );
}
