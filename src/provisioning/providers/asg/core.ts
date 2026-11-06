import type { ASGProvider } from '../asg-provider.js';
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  type Tag as ASGTag,
  type LaunchTemplateSpecification,
} from '@aws-sdk/client-auto-scaling';
import { EC2Client } from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { SecretMasker } from '../../../types/resource.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';

export function getClient(this: ASGProvider): AutoScalingClient {
  if (!this.asgClient) {
    // Built together with the create client, so both capture the identity
    // active at this ONE call (issue #4639).
    this.asgClient = new AutoScalingClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
    this.createClient = withoutServerErrorRetries(
      new AutoScalingClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      })
    );
  }
  return this.asgClient;
}

/**
 * The client `CreateAutoScalingGroup` goes through: SDK retries on, except
 * a 5xx (`withoutServerErrorRetries`, issue #4639). Separate so every other
 * call keeps the full SDK retry.
 *
 * `CreateAutoScalingGroup` carries no idempotency token and a group name is
 * unique per account and region, so the SDK's own replay of a 5xx whose
 * request had succeeded collides with the group the first send made, and
 * that `AlreadyExists` fault surfaced from the engine's FIRST attempt as a
 * name somebody else holds. Refused here, the 5xx reaches the deploy
 * engine's retry, which marks the create as possibly replayed (`withRetry`,
 * #3978). Nothing is adopted on that collision: a name is not attribution
 * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
 */
export function getCreateClient(this: ASGProvider): AutoScalingClient {
  this.getClient();
  return this.createClient as AutoScalingClient;
}

export function getEc2Client(this: ASGProvider): EC2Client {
  if (!this.ec2Client) {
    this.ec2Client = new EC2Client({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.ec2Client;
}

/**
 * The failure wrap the create / update / delete catches throw.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
 * assumed-role ARN. AWS's own text goes to `debug` through `mask`, and the
 * wrap is stamped `markRedactedCause`, so the retry classifiers read the
 * withheld text on the `cause` chain. An "already exists" is restated
 * ({@link relayedNameCollision}), except from a create-time wiring call's
 * failure ({@link markAuxiliaryFailure}), where "it" would read as the
 * group. A non-`Error` throw is withheld the same way, unstamped: it has no
 * chain to read.
 *
 * A cdkd-authored or transport error keeps its text masked (AWS's SDK and
 * cdkd's own refusals can quote the group name, which can be secret-derived,
 * go-to-k/cdkd#4275), stamped exactly when the mask changed it
 * (`wrapMaskedAwsError`). The delete checks its not-found by type and
 * message on the RAW error before it wraps, so no "already gone" reading
 * depends on the wrapped text.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: ASGProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
  this.logger.debug(mask(build(mask(failure.detail)).message));
  const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
  const wrapped = build(`${mask(failure.summary)}${relay}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

/**
 * The `update()` failure wrap ({@link wrapCaughtError}), through the masker
 * paired with the recorded group name. A method, so
 * `gen-update-wrap-coverage` sees the catch that throws it as a wrap.
 */
export function wrapUpdateError(
  this: ASGProvider,
  error: unknown,
  resourceType: string,
  logicalId: string,
  physicalId: string,
  maskSecrets: MaskerFn | undefined
): ProvisioningError {
  const cause = error instanceof Error ? error : undefined;
  return this.wrapCaughtError(
    maskerOrIdentity(maskSecrets),
    error,
    (text) =>
      new ProvisioningError(
        `Failed to update AutoScalingGroup ${logicalId}: ${text}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      )
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

export function buildLaunchTemplate(
  this: ASGProvider,
  properties: Record<string, unknown>
): LaunchTemplateSpecification | undefined {
  const lt = properties['LaunchTemplate'] as
    | { LaunchTemplateId?: string; LaunchTemplateName?: string; Version?: string | number }
    | undefined;
  if (!lt) return undefined;
  const out: LaunchTemplateSpecification = {};
  // AWS UpdateAutoScalingGroup rejects when both LaunchTemplateId and
  // LaunchTemplateName are present in the same LaunchTemplate object
  // ("Valid requests must contain either launchTemplateId or
  // LaunchTemplateName"). DescribeAutoScalingGroups returns both, so
  // a straight readCurrentState → update round-trip on `drift --revert`
  // would hit this. Prefer the ID (canonical, doesn't change on LT
  // rename) and only fall back to Name when ID is absent.
  if (lt.LaunchTemplateId !== undefined) {
    out.LaunchTemplateId = lt.LaunchTemplateId;
    if (lt.LaunchTemplateName !== undefined) {
      // User templated BOTH — AWS would reject the resulting Create /
      // Update otherwise; we silently prefer the ID. Surface the
      // choice in --verbose so a user wondering why their Name didn't
      // take effect has an auditable signal.
      this.logger.debug(
        `buildLaunchTemplate: both LaunchTemplateId (${lt.LaunchTemplateId}) and LaunchTemplateName (${lt.LaunchTemplateName}) templated; dropping Name`
      );
    }
  } else if (lt.LaunchTemplateName !== undefined) {
    out.LaunchTemplateName = lt.LaunchTemplateName;
  }
  if (lt.Version !== undefined) {
    // Defensive coercion: AWS SDK `LaunchTemplateSpecification.Version`
    // is `string` and AWS rejects non-string forms with `Invalid
    // launch template version: either '$Default', '$Latest', or a
    // numeric version are allowed.`. cdkd's `IntrinsicResolver`
    // resolves `Fn::GetAtt <LaunchTemplate>.LatestVersionNumber`
    // through a per-type lookup; intermediate cases could surface
    // numeric values, so we coerce defensively.
    out.Version = String(lt.Version);
  }
  if (out.LaunchTemplateId === undefined && out.LaunchTemplateName === undefined) {
    return undefined;
  }
  return out;
}

/**
 * CFn `Tags` is `[{Key, Value, PropagateAtLaunch?}]`. AWS expects each
 * tag to also carry `ResourceId: <groupName>` and `ResourceType:
 * 'auto-scaling-group'`. We tack those on at create time so the SDK
 * input shape matches without forcing the user to template them.
 */
export function buildTags(
  this: ASGProvider,
  groupName: string,
  properties: Record<string, unknown>
): ASGTag[] {
  const raw = properties['Tags'] as
    | Array<{ Key?: string; Value?: string; PropagateAtLaunch?: boolean }>
    | undefined;
  if (!raw) return [];
  return raw
    .filter((t) => t.Key !== undefined)
    .map((t) => ({
      ResourceId: groupName,
      ResourceType: 'auto-scaling-group',
      Key: t.Key as string,
      Value: t.Value ?? '',
      PropagateAtLaunch: t.PropagateAtLaunch ?? false,
    }));
}

/**
 * CFn `VPCZoneIdentifier` is a list of subnet ids; the AWS SDK input
 * field is a comma-joined string.
 */
export function joinVpcZoneIdentifier(this: ASGProvider, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const cleaned = value.map((v) => String(v).trim()).filter((v) => v.length > 0);
    if (cleaned.length === 0) return undefined;
    return cleaned.join(',');
  }
  if (typeof value === 'string') return value;
  return undefined;
}

export async function describeGroup(this: ASGProvider, groupName: string) {
  const response = await this.getClient().send(
    new DescribeAutoScalingGroupsCommand({
      AutoScalingGroupNames: [groupName],
    })
  );
  return response.AutoScalingGroups?.[0];
}

export async function fetchArn(
  this: ASGProvider,
  groupName: string,
  // The create path passes its masker: the name may be a resolved secret.
  maskSecrets: SecretMasker = (text) => text
): Promise<string | undefined> {
  try {
    const group = await this.describeGroup(groupName);
    return group?.AutoScalingGroupARN;
  } catch (err) {
    this.logger.debug(
      maskSecrets(
        `DescribeAutoScalingGroups(${groupName}) failed: ${describeAwsFailure(err).detail}`
      )
    );
    return undefined;
  }
}

export function isNotFoundError(this: ASGProvider, error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = (error as { name?: string }).name ?? '';
  const message = error.message.toLowerCase();
  // ASG returns ValidationError with message "AutoScalingGroup name not
  // found" rather than a typed NotFound exception; cover both shapes.
  return (
    name === 'ValidationError' &&
    (message.includes('autoscalinggroup name not found') ||
      message.includes('not found') ||
      message.includes('does not exist'))
  );
}

export function sleep(this: ASGProvider, ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
