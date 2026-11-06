import type { Route53Provider } from '../route53-provider.js';
import { Route53Client, GetHostedZoneCommand } from '@aws-sdk/client-route-53';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import { markNotGone } from '../../not-gone.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type { DeleteContext } from '../../region-check.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  UpdateContext,
} from '../../../types/resource.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';

/**
 * The failure wrap the create / update / delete catches build.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
 * assumed-role ARN. AWS's own text goes to `debug` through the operation's
 * `maskSecrets` (`mask`), since a record value AWS echoes back can be a
 * resolved secret, and the wrap is stamped `markRedactedCause`, so the retry
 * classifiers read the withheld text on the `cause` chain (`is marked
 * disabled for mutation`, `not authorized to perform`). An "already exists"
 * (a duplicate record) is restated ({@link relayedNameCollision}), which
 * `isRecreateRetryableError` reads on the top-level message, unless a
 * post-create call raised it ({@link isAuxiliaryFailure}). A cdkd-authored
 * or transport error keeps its text, masked, stamped only when the mask
 * changed it (`wrapMaskedAwsError`); a non-`Error` throw is withheld like an
 * AWS one, unstamped (it has no chain). Both deletes recognise "already
 * gone" on the RAW error before they wrap.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: Route53Provider,
  mask: ((text: string) => string) | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const m = maskerOrIdentity(mask);
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(m, error, build);
  this.logger.debug(m(build(m(failure.detail)).message));
  const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
  const wrapped = build(`${m(failure.summary)}${relay}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

/**
 * {@link wrapCaughtError} for a delete catch. The wrap names an AWS failure
 * by its CLASS, and the delete classifiers read `NotFound` in a message as
 * "already deleted": a class naming ANOTHER object's not-found (this
 * resource's own not-found returned before the wrap) is marked
 * `markNotGone`, so the record is kept (go-to-k/cdkd#2319).
 */
export function wrapDeleteError(
  this: Route53Provider,
  mask: ((text: string) => string) | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const thrown = this.wrapCaughtError(mask, error, build);
  return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
}

/**
 * The failure text a cleanup or adopt `warn` quotes after `head`, with its
 * closing period (go-to-k/cdkd#2319). An AWS-authored failure is named by
 * its CLASS at warn, since a denied call names the caller's assumed-role
 * ARN; AWS's own text goes to `debug` under the same `head`, masked. A
 * cdkd-authored or transport error keeps its text, masked.
 */
export function warnFailureText(
  this: Route53Provider,
  head: string,
  error: unknown,
  mask: ((text: string) => string) | undefined
): string {
  const m = maskerOrIdentity(mask);
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return `${m(failure.detail)}.`;
  this.logger.debug(m(`${head}${m(failure.detail)}`));
  return m(failure.summary);
}

export function getClient(this: Route53Provider): Route53Client {
  if (!this.route53Client) {
    this.route53Client = new Route53Client({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.route53Client;
}

// ─── Dispatch ─────────────────────────────────────────────────────
export async function create(
  this: Route53Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  switch (resourceType) {
    case 'AWS::Route53::HostedZone':
      return this.createHostedZone(
        logicalId,
        resourceType,
        properties,
        context?.maskSecrets,
        context
      );
    case 'AWS::Route53::RecordSet':
      return this.createRecordSet(logicalId, resourceType, properties, context?.maskSecrets);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
  }
}

export async function update(
  this: Route53Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  switch (resourceType) {
    case 'AWS::Route53::HostedZone':
      return this.updateHostedZone(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context?.maskSecrets,
        context
      );
    case 'AWS::Route53::RecordSet':
      return this.updateRecordSet(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

export async function deleteImpl(
  this: Route53Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  switch (resourceType) {
    case 'AWS::Route53::HostedZone':
      return this.deleteHostedZone(logicalId, physicalId, resourceType, context);
    case 'AWS::Route53::RecordSet':
      return this.deleteRecordSet(logicalId, physicalId, resourceType, properties, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

export async function getAttribute(
  this: Route53Provider,
  physicalId: string,
  resourceType: string,
  attributeName: string
): Promise<unknown> {
  switch (resourceType) {
    case 'AWS::Route53::HostedZone':
      return this.getHostedZoneAttribute(physicalId, attributeName);
    default:
      return undefined;
  }
}

export async function getHostedZoneAttribute(
  this: Route53Provider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  switch (attributeName) {
    case 'Id':
      return physicalId;
    case 'NameServers': {
      const response = await this.getClient().send(new GetHostedZoneCommand({ Id: physicalId }));
      return response.DelegationSet?.NameServers ?? [];
    }
    default:
      return undefined;
  }
}
