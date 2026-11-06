import {
  ServiceDiscoveryClient,
  TagResourceCommand,
  UntagResourceCommand,
  GetNamespaceCommand,
  GetOperationCommand,
  type Tag,
} from '@aws-sdk/client-servicediscovery';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { describeAwsFailure, describeAwsStatusReason } from '../../../utils/aws-failure-text.js';
import type { RetryLogger } from '../../../deployment/retry.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import { planTagDiff, tagPlanWarning } from '../../tag-list.js';
import {
  createMaskedRetryLogger,
  maskerOrIdentity,
  type MaskerFn,
} from '../../masked-retry-logger.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import type { SecretMasker } from '../../../types/resource.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import type { ServiceDiscoveryProvider } from '../servicediscovery-provider.js';

export function getClient(this: ServiceDiscoveryProvider): ServiceDiscoveryClient {
  if (!this.client) {
    this.client = new ServiceDiscoveryClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.client;
}

export function getStsClient(this: ServiceDiscoveryProvider): STSClient {
  if (!this.stsClient) {
    this.stsClient = new STSClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.stsClient;
}

/**
 * A {@link RetryLogger} for this provider's `withRetry` calls, bound to the
 * caller's secret masker (issue #2050).
 *
 * Thin wrapper over the shared {@link createMaskedRetryLogger} — see that
 * module for why the factory is shared with `elbv2-provider.ts` rather than
 * hand-rolled per file, and for why `warn` is threaded rather than omitted.
 *
 * NOT applied to `deleteNamespace`'s retry: that one sends a
 * `DeleteNamespaceCommand` carrying a physical id only. The delete's
 * `maskSecrets` reaches its failure wrap instead.
 */
export function maskedRetryLogger(
  this: ServiceDiscoveryProvider,
  maskSecrets: SecretMasker | undefined
): RetryLogger {
  return createMaskedRetryLogger(this.logger, maskSecrets);
}

/**
 * Mask a caught AWS error's message before it is interpolated into a line
 * this provider logs (issue #2050, review round 2). A thrown failure goes
 * through {@link wrapCaughtError} instead, which masks the same text and
 * also stamps the wrap.
 *
 * Masks `error.message` rather than the assembled sentence so the masker can
 * reach `maskSecretsInText`'s WHOLE-VALUE arm (any length) instead of only
 * the SUBSTRING arm (needles of 4+ characters).
 */
export function maskErrorMessage(
  this: ServiceDiscoveryProvider,
  error: unknown,
  maskSecrets: SecretMasker | undefined
): string {
  const mask = maskerOrIdentity(maskSecrets);
  // `.detail`: the same text, without out-throwing the cleanup catch it runs
  // in on a value `String()` cannot convert (go-to-k/cdkd#3361).
  return mask(describeAwsFailure(error).detail);
}

/**
 * The failure wrap every create / update / delete catch throws.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `debug` through `mask`,
 * and the wrap is stamped `markRedactedCause`, so the retry classifiers read
 * the withheld text on the `cause` chain. An "already exists" is restated
 * ({@link relayedNameCollision}), except from the Service create's
 * attributes wiring ({@link markAuxiliaryFailure}), where "it" would read as
 * the service. A non-`Error` throw is withheld the same way, unstamped: it
 * has no chain to read.
 *
 * A cdkd-authored or transport error keeps its text, masked RAW (an AWS SDK
 * error can echo a request value off the RESOLVED `properties` bag, issue
 * #2050), stamped exactly when the mask changed it (`wrapMaskedAwsError`,
 * issue #4259). The deletes check `NamespaceNotFound` / `ServiceNotFound` by
 * type before they wrap. A method, so `gen-update-wrap-coverage` sees the
 * catch that throws it as a wrap.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: ServiceDiscoveryProvider,
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

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Extract the CFn `Properties.DnsProperties.SOA.TTL` nested field (the only
 * mutable entry in the namespace `Properties` bag, shared by the private
 * and public DNS namespace kinds) into the SDK's input shape. Returns
 * `undefined` when the template does not set a TTL.
 */
export function extractSoaTtlProperties(
  this: ServiceDiscoveryProvider,
  properties: Record<string, unknown>
): { DnsProperties: { SOA: { TTL: number } } } | undefined {
  const propsBag = properties['Properties'] as Record<string, unknown> | undefined;
  const dnsProps = propsBag?.['DnsProperties'] as Record<string, unknown> | undefined;
  const soa = dnsProps?.['SOA'] as { TTL?: number } | undefined;
  return soa?.TTL !== undefined ? { DnsProperties: { SOA: { TTL: Number(soa.TTL) } } } : undefined;
}

/**
 * Resolve the SOA-TTL entry for an Update*Namespace change object,
 * including the REMOVAL reset (issue #1160): a TTL present in the desired
 * template passes through; a TTL absent from the desired template but
 * present in the previous one is reset to the Cloud Map default
 * the caller-supplied per-kind default (the CFn-parity shape — the change
 * object merges, so skipping it would silently keep the customized TTL).
 * Never-present stays absent (no change entry).
 */
export function resolveSoaTtlChange(
  this: ServiceDiscoveryProvider,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  defaultTtl: number
): { DnsProperties: { SOA: { TTL: number } } } | undefined {
  const desired = this.extractSoaTtlProperties(properties);
  if (desired) return desired;
  const previous = this.extractSoaTtlProperties(previousProperties);
  if (previous) {
    return { DnsProperties: { SOA: { TTL: defaultTtl } } };
  }
  return undefined;
}

/**
 * Resolve a namespace's ARN — authoritative via `GetNamespace`, with a
 * deterministic STS-based construction as fallback so a transient read
 * failure right after create does not fail the whole resource.
 *
 * Takes NO masker, deliberately (issue #2063 audit). Its request is
 * `GetNamespace({ Id })` with an AWS-issued namespace id — no resolved
 * template value is in the payload, so the AWS error text it logs cannot
 * echo one back. That is a structural reason, not an assessment of
 * likelihood; add the parameter if this call ever grows a template-derived
 * member. The `TagResource` / `UntagResource` calls in
 * {@link syncNamespaceTags} DO carry resolved values, but they throw rather
 * than log, and the throw lands in the calling arm's masked catch.
 */
export async function resolveNamespaceArn(
  this: ServiceDiscoveryProvider,
  namespaceId: string
): Promise<string> {
  try {
    const resp = await this.getClient().send(new GetNamespaceCommand({ Id: namespaceId }));
    if (resp.Namespace?.Arn) return resp.Namespace.Arn;
  } catch (err) {
    this.logger.debug(
      `GetNamespace(${namespaceId}) failed while resolving ARN: ${describeAwsFailure(err).detail}`
    );
  }
  return this.buildNamespaceArn(namespaceId);
}

/**
 * Diff-and-apply namespace tags via `TagResource` / `UntagResource`.
 *
 * `TagResource` is additive-only, so a tag dropped from the template
 * (partial removal) — or the entire `Tags` property removed (full removal,
 * `newTags === undefined`) — would survive on AWS unless we explicitly
 * `UntagResource` the removed keys (the ECR #981 regression class).
 * Failures THROW (never warn-swallow) so cdkd state is never written
 * as-if-applied; the next deploy retries naturally.
 */
export async function syncNamespaceTags(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): Promise<void> {
  // Untag keys present in the old set but absent from the new set; an
  // absent desired `Tags` removes every recorded key. Both sides are read
  // through `planTagDiff` (go-to-k/cdkd#3994): an unreadable record untags
  // nothing, and the desired side was refused above when malformed.
  const plan = planTagDiff(previousProperties['Tags'], properties['Tags']);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const removedKeys = plan.remove;
  const tagsToAdd: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
  const hasAdds = tagsToAdd.length > 0;

  // A shape-only diff with no actual work (e.g. `Tags: []` vs absent)
  // must not spend a GetNamespace/STS round-trip resolving the ARN.
  if (removedKeys.length === 0 && !hasAdds) return;

  const arn = await this.resolveNamespaceArn(physicalId);

  if (removedKeys.length > 0) {
    await this.getClient().send(
      new UntagResourceCommand({ ResourceARN: arn, TagKeys: removedKeys })
    );
  }
  // Apply added / changed tags. Skip the call when the new set is empty
  // (a pure removal has nothing left to add).
  if (hasAdds) {
    await this.getClient().send(new TagResourceCommand({ ResourceARN: arn, Tags: tagsToAdd }));
  }
  this.logger.debug(`Updated tags for namespace ${logicalId} (${physicalId})`);
}

/**
 * The error a FAILED Cloud Map operation throws (go-to-k/cdkd#2319). AWS's
 * `ErrorMessage` is a status reason a SUCCESSFUL GetOperation reports, and a
 * Route 53 refusal behind it names the caller's assumed-role ARN, so the
 * message carries its `ErrorCode` plus the `--verbose` pointer
 * ({@link describeAwsStatusReason}) and the text goes to `debug`, masked. It
 * rides as the unmasked `cause`, and the wrap is stamped, so the retry
 * classifiers read it as they read the message before (issue #4299). No
 * reason keeps cdkd's fallback text, unstamped.
 */
export function wrapOperationFailedError(
  this: ServiceDiscoveryProvider,
  mask: MaskerFn,
  logicalId: string,
  resourceType: string,
  operation: { ErrorCode?: string | undefined; ErrorMessage?: string | undefined } | undefined
): ProvisioningError {
  const reason = describeAwsStatusReason(
    { code: operation?.ErrorCode, message: operation?.ErrorMessage },
    'Unknown error'
  );
  const raw = new Error(reason.detail);
  const build = (text: string): ProvisioningError =>
    new ProvisioningError(
      `Operation failed for ${logicalId}: ${text}`,
      resourceType,
      logicalId,
      undefined,
      raw
    );
  if (!reason.redacted) return build(reason.detail);
  this.logger.debug(mask(build(mask(reason.detail)).message));
  return markRedactedCause(build(`${mask(reason.summary)}${relayedNameCollision(reason.detail)}`));
}

/**
 * Poll a Service Discovery operation until it completes.
 * Returns the target resource ID from the operation result.
 *
 * MASKS `Operation.ErrorMessage` (issue #2063), and this is the only place
 * that can. Cloud Map's create / update are operation-based: the caller's
 * `Create*Namespace` / `Update*` request carried the RESOLVED `properties`
 * bag — `Name`, `Description`, `Tags`, `DnsConfig` — and AWS reports its
 * rejection here rather than by rejecting the submit call, quoting the
 * offending value back in `ErrorMessage`. A FAILED operation is therefore
 * the NORMAL rejection path for these arms, not an edge case.
 *
 * Why not leave it to the arms' own catch: every namespace arm and
 * `updateService` open with `if (error instanceof ProvisioningError) throw
 * error;`, so a `ProvisioningError` raised here is re-thrown VERBATIM and
 * never reaches their `wrapCaughtError`. `deploy-engine.ts` then prints it
 * at ERROR — DEFAULT verbosity. That passthrough is correct (it preserves
 * the resource/logical-id context this frame added), which is exactly why
 * the mask has to be applied at the point of construction.
 *
 * `errorMessage` is masked RAW, before any interpolation. Stating precisely
 * what that buys, because the obvious phrasing over-claims (issue #2063
 * review): `maskSecretsInText`'s WHOLE-VALUE arm fires only when
 * `secrets.has(text)` — i.e. when the text IS the secret in its entirety —
 * so masking raw covers the case where AWS returns the offending value as
 * the whole `ErrorMessage`, at ANY length, including below the substring
 * arm's 4-character `MIN_NEEDLE_LENGTH` floor. When AWS instead quotes the
 * value INSIDE a sentence, the substring arm handles it and that floor
 * applies either way, raw or not. So masking here is strictly better than
 * masking the assembled message, but it is not general sub-4-character
 * coverage. See `SecretMaskingContext` in `src/types/resource.ts`.
 *
 * The `operationId` / timeout message below carries no template-derived
 * value (an AWS-issued opaque id), so it is left as-is.
 */
export async function pollOperation(
  this: ServiceDiscoveryProvider,
  operationId: string,
  logicalId: string,
  resourceType: string,
  maskSecrets?: SecretMasker
): Promise<string> {
  const client = this.getClient();
  const maxAttempts = 60;
  let delay = 1000; // start at 1s

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await client.send(new GetOperationCommand({ OperationId: operationId }));

    const status = result.Operation?.Status;

    if (status === 'SUCCESS') {
      // Extract the target resource ID (NAMESPACE or SERVICE)
      const targets = result.Operation?.Targets;
      if (targets) {
        return targets['NAMESPACE'] || targets['SERVICE'] || operationId;
      }
      return operationId;
    }

    if (status === 'FAIL') {
      throw this.wrapOperationFailedError(
        maskerOrIdentity(maskSecrets),
        logicalId,
        resourceType,
        result.Operation
      );
    }

    // SUBMITTED or PENDING - wait and retry
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 10000); // exponential backoff, max 10s
  }

  throw new ProvisioningError(
    `Operation timed out for ${logicalId} (operationId: ${operationId})`,
    resourceType,
    logicalId
  );
}

/**
 * Build a namespace ARN from namespace ID.
 * Format: `arn:{partition}:servicediscovery:{region}:{account}:namespace/{namespaceId}`
 *
 * The partition is derived from the region through the same closed mapping
 * `${AWS::Partition}` uses (issue #1815) rather than hardcoded to `aws` —
 * this ARN is recorded into state and served as the namespace's `Arn`
 * attribute, so a commercial-partition literal is silently wrong (but
 * structurally valid, hence unrejected) in `aws-cn` / `aws-us-gov`.
 */
export async function buildNamespaceArn(
  this: ServiceDiscoveryProvider,
  namespaceId: string
): Promise<string> {
  const stsClient = this.getStsClient();
  const identity = await stsClient.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account || '';
  const region = await this.getClient().config.region();
  const { partition } = derivePartitionAndUrlSuffix(region);
  return `arn:${partition}:servicediscovery:${region}:${accountId}:namespace/${namespaceId}`;
}
