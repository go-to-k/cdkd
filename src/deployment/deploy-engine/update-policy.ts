import { safeMsg } from '../../utils/display-safe.js';
import type { TemplateResource, UpdateContext } from '../../types/resource.js';
import { ignoresUnmodifiedGroupSize } from '../../provisioning/providers/asg/update-policy.js';

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
 * The `UpdatePolicy` keys the type's SDK provider honors under
 * `--update-policy`, per resource type (Cloud Control honors none), each with
 * the provider's own reading of whether the policy asks for anything: a key
 * set to its no-op value (`IgnoreUnmodifiedGroupSizeProperties: false`) gets
 * no hint and no warning. Extend it in the same change as the provider that
 * reads the key.
 */
const HONORED_UPDATE_POLICIES: Readonly<
  Record<
    string,
    ReadonlyArray<{ key: string; asksForIt: (policy: Record<string, unknown>) => boolean }>
  >
> = {
  'AWS::AutoScaling::AutoScalingGroup': [
    { key: 'AutoScalingScheduledAction', asksForIt: ignoresUnmodifiedGroupSize },
  ],
};

interface UpdatePolicyLogger {
  info(message: string): void;
  warn(message: string): void;
}

function honoredKeysPresent(resourceType: string, updatePolicy: Record<string, unknown>): string[] {
  const honored = HONORED_UPDATE_POLICIES[resourceType] ?? [];
  return honored.filter((entry) => entry.asksForIt(updatePolicy)).map((entry) => entry.key);
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
  provisionedBy: 'sdk' | 'cc-api'
): Pick<UpdateContext, 'updatePolicy'> {
  const updatePolicy = resource?.UpdatePolicy;
  if (typeof updatePolicy !== 'object' || updatePolicy === null) return {};
  if (updatePolicyOption === false) return {};
  const keys = honoredKeysPresent(resourceType, updatePolicy);
  if (updatePolicyOption === true) {
    if (provisionedBy !== 'sdk' && keys.length > 0) {
      logger.warn(
        safeMsg`${logicalId}: UpdatePolicy ${keys.join(', ')} is not applied by cdkd on the Cloud Control route this update takes.`
      );
    }
    return { updatePolicy };
  }
  if (provisionedBy === 'sdk' && keys.length > 0) {
    logger.info(
      safeMsg`${logicalId}: UpdatePolicy ${keys.join(', ')} is skipped by default; pass --update-policy to honor it.`
    );
  }
  return {};
}

/**
 * Warn, once per create, that a `CreationPolicy` the template declares is not
 * waited on. Called on the CREATE path only: CloudFormation evaluates a
 * `CreationPolicy` when it creates the resource.
 */
export function warnUnhonoredCreationPolicy(
  logger: UpdatePolicyLogger,
  logicalId: string,
  resource: TemplateResource | undefined
): void {
  if (resource?.CreationPolicy === undefined) return;
  logger.warn(
    safeMsg`${logicalId}: CreationPolicy is not honored; cdkd does not wait for cfn-signal success signals.`
  );
}
