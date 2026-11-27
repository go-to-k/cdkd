import { valueMentionsDynamicReference } from '../secret-redaction/recorded-secrecy.js';
import { safeMsg } from '../../utils/display-safe.js';
import { CdkdError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../retryable-errors.js';
import { markRefusedBeforeApplying } from '../prior-attempt-scope.js';
import {
  createSecretMasker,
  logOnlyValueCount,
  printingCorpusOf,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import type {
  CloudFormationTemplate,
  TemplateResource,
  UpdateContext,
} from '../../types/resource.js';
import type { ResourceChange } from '../../types/state.js';
import {
  INSTANCE_REFRESH_TRIGGER_PROPERTIES,
  REPLACEMENT_TRIGGER_PROPERTIES,
  ignoresUnmodifiedGroupSize,
  rollingUpdatePolicy,
  willReplaceGroup,
} from '../../provisioning/providers/asg/update-policy.js';

/**
 * go-to-k/cdkd#6437: the template `UpdatePolicy` / `CreationPolicy`
 * attributes, which cdkd used to drop silently.
 *
 * `UpdatePolicy` is OPT-IN today (`--update-policy` / `cdk.json
 * context.cdkd.updatePolicy: true`); the v1 release (go-to-k/cdkd#6443) flips
 * the default to honor and keeps `--no-update-policy` as the opt-out.
 * Performance gives way to CloudFormation parity there, for the templates that
 * declare a policy only: a deploy whose template carries none is unchanged.
 *
 * `CreationPolicy` cannot be honored: `cfn-signal` sends its signal to a
 * CloudFormation stack, which a cdkd deploy has none of. A create of a
 * resource declaring one logs a warning and proceeds; the exit code and
 * `--strict` are untouched.
 */

/**
 * The `UpdatePolicy` keys `--update-policy` honors, per resource type, each
 * with its reading of whether the policy asks for anything on THIS update
 * (`changed`: the top-level properties it changes): a key set to its no-op
 * value (`IgnoreUnmodifiedGroupSizeProperties: false`), or one whose trigger
 * properties the update leaves alone, gets no hint and no warning.
 * `route: 'sdk'` keys are applied by the type's SDK provider (Cloud Control
 * reads no `UpdatePolicy`); `'any'` keys on either route (by the engine, or,
 * for a type with no SDK provider, by the Cloud Control provider).
 * Extend it in the same change as the code that reads the key.
 */
const HONORED_UPDATE_POLICIES: Readonly<
  Record<
    string,
    ReadonlyArray<{
      key: string;
      route: 'sdk' | 'any';
      asksForIt: (policy: Record<string, unknown>, changed: ReadonlySet<string>) => boolean;
    }>
  >
> = {
  'AWS::AutoScaling::AutoScalingGroup': [
    {
      key: 'AutoScalingScheduledAction',
      route: 'sdk',
      asksForIt: (policy) => ignoresUnmodifiedGroupSize(policy),
    },
    {
      key: 'AutoScalingReplacingUpdate',
      route: 'any',
      asksForIt: (policy, changed) =>
        willReplaceGroup(policy) && REPLACEMENT_TRIGGER_PROPERTIES.some((k) => changed.has(k)),
    },
    {
      key: 'AutoScalingRollingUpdate',
      route: 'sdk',
      asksForIt: (policy, changed) =>
        rollingUpdatePolicy(policy) !== undefined &&
        REPLACEMENT_TRIGGER_PROPERTIES.some((k) => changed.has(k)),
    },
    {
      key: 'AutoScalingInstanceRefresh',
      route: 'sdk',
      asksForIt: (policy, changed) =>
        isObject(policy['AutoScalingInstanceRefresh']) &&
        !willReplaceGroup(policy) &&
        INSTANCE_REFRESH_TRIGGER_PROPERTIES.some((k) => changed.has(k)),
    },
  ],
  // `AWS::Lambda::Alias` has no SDK provider: the CodeDeploy deployment runs
  // in `CloudControlProvider.update`, its only route, so the key is `'any'`.
  'AWS::Lambda::Alias': [
    {
      key: 'CodeDeployLambdaAliasUpdate',
      route: 'any',
      asksForIt: (policy, changed) =>
        isObject(policy['CodeDeployLambdaAliasUpdate']) && changed.has('FunctionVersion'),
    },
  ],
};

/**
 * go-to-k/cdkd#6437: the `UpdatePolicy` an `AWS::Lambda::Alias` update hands
 * its provider under `--update-policy`, with `CodeDeployLambdaAliasUpdate`'s
 * values RESOLVED (`resolve`: the update's own resolver context). CDK writes
 * them as `Ref`s to the application, the deployment group and the hook
 * functions, which CodeDeploy needs as names. `undefined` when nothing applies
 * (flag off, another type, no such policy): the template's policy as written.
 *
 * Only when the update changes `FunctionVersion` (`versionChanges`), the one
 * change the policy applies to: any other alias update resolves nothing.
 *
 * The resolved values are journaled for the rollback revert, so a secret is
 * refused here, before anything is sent: a `{{resolve:...}}` in the policy as
 * written (CloudFormation resolves dynamic references in resource properties
 * only), and any resolved value that is one by another route (an `Fn::Join`
 * spelling a reference, a `Ref` to a `NoEcho` parameter or to a recorded
 * secret): `secretBearing` answers from the update's own secrets bag, which
 * the resolution adds to.
 */
export async function resolveAliasUpdatePolicy(
  updatePolicyOption: boolean | undefined,
  logicalId: string,
  resourceType: string,
  resource: TemplateResource | undefined,
  versionChanges: boolean,
  resolve: (value: unknown) => Promise<unknown>,
  /**
   * Taken right before the resolution (a snapshot of the update's secrets
   * bag); its answer says whether the resolved value is, or added, a secret.
   */
  secretGuard: () => (resolved: unknown) => boolean
): Promise<Record<string, unknown> | undefined> {
  if (updatePolicyOption !== true || resourceType !== 'AWS::Lambda::Alias') return undefined;
  if (!versionChanges) return undefined;
  const updatePolicy = resource?.UpdatePolicy;
  if (!isObject(updatePolicy)) return undefined;
  const aliasPolicy = updatePolicy['CodeDeployLambdaAliasUpdate'];
  if (!isObject(aliasPolicy)) return undefined;
  const refusal = (): Error =>
    markRefusedBeforeApplying(
      markNonRetryable(
        new CdkdError(
          safeMsg`${logicalId}: UpdatePolicy CodeDeployLambdaAliasUpdate names a secret (a dynamic reference or a NoEcho value), which cdkd does not resolve there. Name the application, deployment group and hook functions directly or with Ref.`,
          'UPDATE_POLICY_SECRET_REFUSED'
        )
      )
    );
  if (valueMentionsDynamicReference(aliasPolicy)) throw refusal();
  const isSecretBearing = secretGuard();
  const resolved = await resolve(aliasPolicy);
  if (isSecretBearing(resolved)) throw refusal();
  return { ...updatePolicy, CodeDeployLambdaAliasUpdate: resolved };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface UpdatePolicyLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** The honored keys this update asks for, applied on `route` (`'sdk'` takes every key). */
function askedKeys(
  resourceType: string,
  updatePolicy: Record<string, unknown>,
  changed: ReadonlySet<string>,
  route: 'sdk' | 'cc-api'
): string[] {
  return (HONORED_UPDATE_POLICIES[resourceType] ?? [])
    .filter(
      (entry) =>
        (route === 'sdk' || entry.route === 'any') && entry.asksForIt(updatePolicy, changed)
    )
    .map((entry) => entry.key);
}

/**
 * The `UpdateContext` fragment for an in-place update of `logicalId`, taken
 * once per update (never inside its retry).
 *
 * - `--update-policy` on: `{ updatePolicy }` when the template declares one.
 *   When the update routes through Cloud Control, which honors no policy, a
 *   policy some SDK provider would honor gets one `warn` line instead.
 * - `--no-update-policy`: nothing, silently.
 * - neither (the default): nothing, plus one `info` line when the template
 *   declares a policy the flag WOULD honor on this route. It is printed only
 *   for a resource this deploy updates, so it repeats once per update of that
 *   resource and never on a no-change deploy.
 */
export function updatePolicyContext(
  updatePolicyOption: boolean | undefined,
  logger: UpdatePolicyLogger,
  logicalId: string,
  resourceType: string,
  resource: TemplateResource | undefined,
  provisionedBy: 'sdk' | 'cc-api',
  changed: ReadonlySet<string>,
  /** {@link resolveAliasUpdatePolicy}'s answer for this update, handed over in place of the template's. */
  resolved?: Record<string, unknown>
): Pick<UpdateContext, 'updatePolicy'> {
  const updatePolicy = resolved ?? resource?.UpdatePolicy;
  if (typeof updatePolicy !== 'object' || updatePolicy === null) return {};
  if (updatePolicyOption === false) return {};
  if (updatePolicyOption === true) {
    if (provisionedBy !== 'sdk') {
      const unapplied = askedKeys(resourceType, updatePolicy, changed, 'sdk').filter(
        (key) => !askedKeys(resourceType, updatePolicy, changed, 'cc-api').includes(key)
      );
      if (unapplied.length > 0) {
        logger.warn(
          safeMsg`${logicalId}: UpdatePolicy ${unapplied.join(', ')} is not applied by cdkd on the Cloud Control route this update takes.`
        );
      }
    }
    return { updatePolicy };
  }
  const keys = askedKeys(resourceType, updatePolicy, changed, provisionedBy);
  if (keys.length > 0) {
    logger.info(
      safeMsg`${logicalId}: UpdatePolicy ${keys.join(', ')} is skipped by default; pass --update-policy to honor it.`
    );
  }
  return {};
}

/**
 * {@link resolveAliasUpdatePolicy}'s `secretGuard` over the update's secrets
 * bag: a snapshot taken before the policy is resolved, whose answer is `true`
 * when the resolution recorded a secret or a `NoEcho` value (either count
 * grew), when a string of the result IS one already recorded (any length: an
 * alias property can hold the same value, so no count grows, and the masker
 * below skips a value shorter than its floor), or when the printing masker
 * changes the result's text.
 */
export function aliasPolicySecretGuard(
  secrets: RecordedSecretValues
): (resolved: unknown) => boolean {
  const pairs = secrets.size;
  const logOnly = logOnlyValueCount(secrets);
  return (resolved) => {
    if (secrets.size !== pairs || logOnlyValueCount(secrets) !== logOnly) return true;
    const corpus = printingCorpusOf(secrets);
    if (stringLeaves(resolved).some((leaf) => corpus.has(leaf))) return true;
    const text = JSON.stringify(resolved) ?? '';
    return createSecretMasker(secrets)(text) !== text;
  };
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (isObject(value)) return Object.values(value).flatMap(stringLeaves);
  return [];
}

/**
 * Warn, once per create, that a `CreationPolicy` the template declares is not
 * waited on. Called on the CREATE path only: CloudFormation evaluates a
 * `CreationPolicy` when it creates the resource. Silent when the stack's
 * signal receiver waits on it (`waited`, go-to-k/cdkd#6705).
 */
export function warnUnhonoredCreationPolicy(
  logger: UpdatePolicyLogger,
  logicalId: string,
  resource: TemplateResource | undefined,
  waited = false
): void {
  if (resource?.CreationPolicy === undefined || waited) return;
  logger.warn(
    safeMsg`${logicalId}: CreationPolicy is not honored; cdkd does not wait for cfn-signal success signals.`
  );
}

/**
 * Why cdkd cannot make the `AutoScalingReplacingUpdate` replacement the diff
 * decided (go-to-k/cdkd#6437, `markUpdatePolicyReplacements`), or `undefined`
 * when it can. Read before anything is sent:
 *
 * - the template declares both `AutoScalingInstanceRefresh` and
 *   `AutoScalingRollingUpdate`, which CloudFormation fails an update on
 *   whatever `WillReplace` says;
 * - the template names the group (`AutoScalingGroupName`): the new group
 *   would need the old one's name, and CloudFormation refuses to replace a
 *   custom-named resource the same way;
 * - the stack has no instance id (`stackHasInstanceId` false): the
 *   replacement's generated name would be the old group's.
 */
export function updatePolicyReplacementRefusal(
  logicalId: string,
  resource: TemplateResource | undefined,
  desired: Readonly<Record<string, unknown>>,
  triggerPaths: readonly string[],
  stackHasInstanceId: boolean
): string | undefined {
  const updatePolicy = resource?.UpdatePolicy;
  const changed = [...new Set(triggerPaths.map((path) => path.split(/[.[]/)[0] ?? path))];
  const head = safeMsg`${logicalId}: UpdatePolicy AutoScalingReplacingUpdate (WillReplace: true) replaces the group because ${changed.join(', ')} changed, but `;
  if (
    isObject(updatePolicy) &&
    isObject(updatePolicy['AutoScalingInstanceRefresh']) &&
    isObject(updatePolicy['AutoScalingRollingUpdate'])
  ) {
    return (
      head +
      'the template also declares both AutoScalingInstanceRefresh and AutoScalingRollingUpdate, which CloudFormation fails an update on. Keep one of the two.'
    );
  }
  const name = desired['AutoScalingGroupName'];
  if (name !== undefined && name !== null && name !== '') {
    return (
      head +
      'the template names the group (AutoScalingGroupName), so the new group cannot be created beside the old one. CloudFormation refuses to replace a custom-named resource the same way. ' +
      'Remove AutoScalingGroupName, or deploy without --update-policy to update the group in place.'
    );
  }
  // go-to-k/cdkd#5064 moves a generated name only on a stack with an id.
  if (!stackHasInstanceId) {
    return (
      head +
      "this stack's state predates cdkd's replacement names, so the new group would be given the name the old group holds. " +
      'Deploy without --update-policy to update the group in place.'
    );
  }
  return undefined;
}

/**
 * The `UpdatePolicy` a deploy journals on an UPDATE operation (go-to-k/cdkd#6457):
 * the template's, when `--update-policy` handed it to the update (an alias's
 * with its `CodeDeployLambdaAliasUpdate` names resolved). Absent
 * otherwise, so a journal written without the flag is byte-identical to one
 * an older cdkd writes, and an older cdkd reading a journal that carries it
 * ignores the field.
 */
export function journaledUpdatePolicy(
  updatePolicyOption: boolean | undefined,
  resource: TemplateResource | undefined,
  /** {@link resolveAliasUpdatePolicy}'s answer for this update, journaled in its place. */
  resolved?: Record<string, unknown>
): Record<string, unknown> | undefined {
  const updatePolicy = resolved ?? resource?.UpdatePolicy;
  return updatePolicyOption === true && isObject(updatePolicy) ? updatePolicy : undefined;
}

/**
 * The `UpdatePolicy` a rollback revert of an UPDATE hands its provider
 * (go-to-k/cdkd#6457): the one the forward deploy journaled, without
 * `AutoScalingScheduledAction` -- CloudFormation: "This property is ignored
 * during a stack rollback", so a revert re-sends every recorded size.
 *
 * CloudFormation rolls back under "the UpdatePolicy configuration specified in
 * the template before the current stack update"; cdkd keeps no earlier
 * template, so the revert uses the forward deploy's policy. They differ only
 * when that deploy also changed the `UpdatePolicy` itself. A malformed
 * journaled value is ignored.
 */
export function revertUpdatePolicy(journaled: unknown): Record<string, unknown> | undefined {
  if (!isObject(journaled)) return undefined;
  const { AutoScalingScheduledAction: _ignoredOnRollback, ...rest } = journaled;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** {@link revertUpdatePolicy} as the `UpdateContext` fragment a revert spreads. */
export function revertUpdatePolicyContext(journaled: unknown): Pick<UpdateContext, 'updatePolicy'> {
  const updatePolicy = revertUpdatePolicy(journaled);
  return updatePolicy !== undefined ? { updatePolicy } : {};
}

/**
 * Every {@link updatePolicyReplacementRefusal} the plan holds: an UPDATE whose
 * replacing changes are all `updatePolicyReplacement` (the diff's
 * `AutoScalingReplacingUpdate` verdict). Read before anything is provisioned
 * by `cdkd deploy`'s plan checks, and by `cdkd diff` as a blocking reason, so
 * a replacement cdkd cannot make stops the run before other resources change.
 * The engine asks again at the resource, from the resolved name.
 */
export function findUpdatePolicyReplacementRefusals(
  changes: ReadonlyMap<string, ResourceChange>,
  template: CloudFormationTemplate | undefined,
  stackHasInstanceId: boolean,
  /**
   * Whether the replacement's new group would be created through Cloud
   * Control (the route its create takes: no recorded-layer hint), which
   * cannot wait for the new instances; absent, the route is not checked.
   */
  createRoutesToCloudControl?: (logicalId: string, change: ResourceChange) => boolean
): string[] {
  const refusals: string[] = [];
  for (const [logicalId, change] of changes) {
    if (change.changeType !== 'UPDATE') continue;
    const replacing = (change.propertyChanges ?? []).filter((pc) => pc.requiresReplacement);
    if (replacing.length === 0 || !replacing.every((pc) => pc.updatePolicyReplacement === true)) {
      continue;
    }
    // Only a CEILING (a launch template version read through `Fn::GetAtt`,
    // shown as "may be replaced"): whether anything moves is known once the
    // engine resolves it, so the engine's own check at the resource decides.
    if (
      replacing.every((pc) => pc.inPlacePropagated === true || pc.replacementPropagated === true)
    ) {
      continue;
    }
    if (createRoutesToCloudControl?.(logicalId, change) === true) {
      refusals.push(cloudControlReplacementRefusal(logicalId));
      continue;
    }
    // A name behind an intrinsic the plan cannot resolve yet (an `Fn::If`
    // that may pick `AWS::NoValue`) is left to the engine's check of the
    // resolved value.
    const { AutoScalingGroupName: name, ...rest } = change.desiredProperties ?? {};
    const refusal = updatePolicyReplacementRefusal(
      logicalId,
      template?.Resources?.[logicalId],
      typeof name === 'string' ? { ...rest, AutoScalingGroupName: name } : rest,
      replacing.map((pc) => pc.path),
      stackHasInstanceId
    );
    if (refusal !== undefined) refusals.push(refusal);
  }
  return refusals;
}

/**
 * The refusal of an `AutoScalingReplacingUpdate` whose new group would be
 * created through Cloud Control: only the SDK provider's create can wait for
 * the new instances before the old group goes.
 */
export function cloudControlReplacementRefusal(logicalId: string): string {
  return (
    safeMsg`${logicalId}: UpdatePolicy AutoScalingReplacingUpdate (WillReplace: true) replaces the group, but the new group would be created through Cloud Control, which cannot wait for its instances to be in service before the old group is deleted. ` +
    'Deploy without --update-policy to update the group in place.'
  );
}

/** The provider registry's routing call, as `findUpdatePolicyReplacementRefusals`'s route check needs it. */
export type CreateRouteOf = (input: {
  resourceType: string;
  properties?: Record<string, unknown> | undefined;
  previousProperties?: Record<string, unknown> | undefined;
}) => { provisionedBy?: 'sdk' | 'cc-api' | undefined };

/**
 * Whether a replacement's new resource would be created through Cloud
 * Control: the decision `update-replace.ts` takes for its create (the desired
 * bag, the record's as the baseline, no recorded-layer hint). ONE function
 * for `cdkd deploy`'s plan check and `cdkd diff`, both handing in the
 * registry's `getProviderFor`, so the preview refuses what the deploy does.
 */
export function replacementCreateRoutesToCloudControl(
  getProviderFor: CreateRouteOf,
  change: ResourceChange,
  recordProperties: Record<string, unknown> | undefined
): boolean {
  return (
    getProviderFor({
      resourceType: change.resourceType,
      properties: change.desiredProperties ?? {},
      previousProperties: recordProperties,
    }).provisionedBy !== 'sdk'
  );
}
