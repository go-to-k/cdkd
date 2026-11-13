import { cdkdRemedy } from '../../../utils/pasteable-command.js';
import type { CloudFrontDistributionProvider } from '../cloudfront-distribution-provider.js';
import {
  CreateDistributionCommand,
  CreateDistributionWithTagsCommand,
  UpdateDistributionCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  DistributionAlreadyExists,
  type DistributionConfig,
} from '@aws-sdk/client-cloudfront';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { acquireIdempotencyToken } from '../idempotency-token.js';
import { CdkdError, ProvisioningError } from '../../../utils/error-handler.js';
import {
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { assertRegionMatch } from '../../region-check.js';
import type {
  UpdateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  CreateContext,
  SecretMasker,
} from '../../../types/resource.js';
import { definedAttributes } from '../../attribute-map.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';

/**
 * The failure wrap the create / update / delete catches and the update's
 * tag-diff catch build.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
 * assumed-role ARN. AWS's own text goes to `debug` through the operation's
 * `maskSecrets` (`mask`), and the wrap is stamped `markRedactedCause`, so the
 * retry classifiers read the withheld text on the `cause` chain. An "already
 * exists" is restated ({@link relayedNameCollision}), exactly when the old
 * message carried it, so the collision classifiers answer as before. A
 * cdkd-authored or transport error keeps its text, masked, stamped only when
 * the mask changed it (`wrapMaskedAwsError`, issue #4244); a non-`Error`
 * throw is withheld like an AWS one, unstamped (it has no chain). The
 * `DistributionAlreadyExists`
 * orphan refusal and the delete's `NoSuchDistribution` check run on the
 * error's type before this wrap.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: CloudFrontDistributionProvider,
  mask: SecretMasker | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const m = maskerOrIdentity(mask);
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(m, error, build);
  this.logger.debug(m(build(m(failure.detail)).message));
  const wrapped = build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

/**
 * Create a CloudFront Distribution
 */
export async function create(
  this: CloudFrontDistributionProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating CloudFront Distribution ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  // The orphan message below interpolates RESOLVED template values (an origin
  // domain, the comment), and a `{{resolve:secretsmanager:...}}` scalar is
  // plaintext by the time a provider sees it. The deploy engine masks at its
  // own sinks, but only through `maskSecretsInText`'s SUBSTRING arm — which
  // ignores a needle below `MIN_NEEDLE_LENGTH`, and cannot see a value whose
  // quotes `JSON.stringify` has escaped so it no longer OCCURS literally. So
  // the value is masked HERE, at the leaf, before either can happen.
  // Defaulted to identity per the `SecretMaskingContext` contract: `create()`
  // is also reached from `cdkd drift --revert`, the import path, and tests.
  const maskSecrets: SecretMasker = context?.maskSecrets ?? ((text) => text);

  // Issue #2079. `CallerReference` IS CloudFront's idempotency key, and this
  // used to be `${Date.now()}-${logicalId}-${Math.random()...}` — regenerated
  // on every re-invocation of `create()`, which is the worst shape of all:
  // the call LOOKS idempotent while behaving exactly as if it had no token.
  // The deploy engine wraps `create()` in its outer transient-error retry and
  // issue #2026 made HTTP 500 / 502 / 504 retryable, so a 500 whose
  // `CreateDistribution` actually SUCCEEDED server-side minted a SECOND
  // distribution: no state record, invisible to `cdkd destroy`, billing
  // indefinitely.
  //
  // Same fix as the Route 53 `CreateHostedZone` site (issue #2039), but
  // deliberately WITHOUT its adopt path, because CloudFront has none:
  // `DistributionSummary` — what `ListDistributions` returns — carries
  // `Comment` but NOT `CallerReference` (measured against
  // `@aws-sdk/client-cloudfront` `models_0.d.ts`), and `GetDistribution`
  // needs the `Id` the lost response was carrying. So the replay is REFUSED
  // with `DistributionAlreadyExists` and the catch below turns that into a
  // message naming the orphan and how to find it. Loud-and-orphaned instead
  // of silent-and-orphaned; the orphan exists either way, and only this way
  // does the user learn about it.
  //
  // Writing a cdkd marker into `Comment` to make the orphan findable was
  // considered and REJECTED: `Comment` is capped at 128 characters, so a
  // marker can break a create that works today, and `mergeUpdateConfig`
  // documents `Comment` as fully template-owned.
  const callerReferenceToken = acquireIdempotencyToken({
    scope: 'CreateDistribution',
    logicalId,
    // CloudFront accepts up to 128 characters for CallerReference.
    maxLength: 128,
  });

  try {
    const distributionConfig = (properties['DistributionConfig'] as Record<string, unknown>) ?? {};
    const sdkConfig = this.convertToSdkFormat({
      ...distributionConfig,
      CallerReference: callerReferenceToken.value,
    });

    // CFn shape: `Tags: [{ Key, Value }]`. CloudFront's SDK wraps tags in
    // a separate `CreateDistributionWithTagsCommand` whose request shape
    // is `{ DistributionConfigWithTags: { DistributionConfig, Tags: { Items: Tag[] } } }`.
    // Switch command class when tags are present so the create is atomic
    // (a post-create `TagResource` race would leave a tag-less window).
    const sdkTags = this.toSdkTags(desiredTags);

    const response = sdkTags
      ? await this.cloudFrontClient.send(
          new CreateDistributionWithTagsCommand({
            DistributionConfigWithTags: {
              DistributionConfig: sdkConfig as unknown as DistributionConfig,
              Tags: { Items: sdkTags },
            },
          })
        )
      : await this.cloudFrontClient.send(
          new CreateDistributionCommand({
            DistributionConfig: sdkConfig as unknown as DistributionConfig,
          })
        );

    const distribution = response.Distribution!;
    const distributionId = distribution.Id!;
    const domainName = distribution.DomainName!;

    this.logger.debug(`Created CloudFront Distribution: ${distributionId} (${domainName})`);

    await this.settleDistribution(logicalId, distributionId);

    // Success path ONLY, and after the distribution is settled, mirroring the
    // Route 53 site: releasing bumps the token's generation, so a later
    // create of the same logical id (the `--replace` delete-then-create in
    // one process) is not handed the reference of a distribution that has
    // since been torn down. Releasing on a FAILURE path would defeat the
    // whole mechanism — the next attempt would mint a fresh reference and
    // duplicate again, which is precisely the bug this replaced.
    callerReferenceToken.release();

    return {
      physicalId: distributionId,
      attributes: {
        Id: distributionId,
        DistributionId: distributionId,
        DomainName: domainName,
      },
    };
  } catch (error) {
    // Issue #2079: the stable-token replay. This is the ONLY signal the user
    // gets that a distribution was created by a lost attempt, so the message
    // is load-bearing rather than decorative: with no `CallerReference` on
    // `DistributionSummary` there is nothing to search by, and the message
    // has to hand over the two fields that ARE listed — the origin domain
    // and the comment.
    //
    // The `name` check sits beside the `instanceof` because the latter is
    // identity-dependent (two copies of the SDK in one process, a bundler
    // re-instantiating the class) and a miss here degrades to the generic
    // message above, which never mentions the orphan.
    if (
      error instanceof DistributionAlreadyExists ||
      (error as { name?: string } | undefined)?.name === 'DistributionAlreadyExists'
    ) {
      const cause = error instanceof Error ? error : undefined;
      // BOTH halves are required, and the marker alone is NOT enough.
      //
      // 1. `markNonRetryable`: a repeated `CallerReference` is a DETERMINISTIC
      //    refusal, so every replay is certain to fail. Unmarked, the
      //    `--recreate-via-sdk-provider` path — which has already DELETED the
      //    old distribution — hands this message to `isRecreateRetryableError`
      //    and spends 8 attempts over ~64s on the same in-flight token.
      //
      // 2. The message must not CONTAIN a collision-shaped token. It used to
      //    say `DistributionAlreadyExists`, which `isNameCollisionError`
      //    matches on the bare `AlreadyExists` substring (measured). Two sites
      //    read that classifier from a MESSAGE with no marker gate — the
      //    engine's create-first collision fallback (`deploy-engine.ts`) and
      //    its rollback twin (`rollback-executor.ts`) — and their remedy is to
      //    DELETE the live, in-state old resource and retry a create that
      //    cannot succeed. Latent for this type only because it has empty
      //    `createOnlyProperties` and no `ReplacementRulesRegistry` entry,
      //    which is far too thin a reason for a destructive path to rest on.
      //    This is the exact bound `sns-subscription-provider.ts` documents:
      //    a message-only classifier cannot consult the marker, so the
      //    wording has to carry its own discipline.
      //
      // The AWS error is not lost: it rides on `cause`, which `formatError`
      // prints as a `Caused by:` line and which every marker / classifier
      // walk already follows.
      throw markNonRetryable(
        new ProvisioningError(
          maskSecrets(
            `Failed to create CloudFront Distribution ${logicalId}: CloudFront refused the ` +
              `create because this deploy's CallerReference had been used before, which means ` +
              `an EARLIER attempt of this same create succeeded and cdkd never received its ` +
              `response. That distribution is LIVE, is not in cdkd state, and 'cdkd destroy' ` +
              `will not remove it — it bills until you delete it by hand. CloudFront does not ` +
              `return CallerReference from ListDistributions, so find it with ` +
              `'aws cloudfront list-distributions' and match on ` +
              `${this.orphanSearchHint(properties, maskSecrets)}; then disable and delete it ` +
              `(or import it with '${cdkdRemedy('cdkd import')}') before re-running. The AWS error is on this ` +
              `error's cause.`
          ),
          resourceType,
          logicalId,
          undefined,
          cause
        )
      );
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create CloudFront Distribution ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

/**
 * The identifying fields of the distribution that WOULD have been created,
 * for the `DistributionAlreadyExists` orphan message (issue #2079).
 *
 * Only fields `ListDistributions` actually returns are worth naming — the
 * user has to match the orphan in that output by eye. `Origins[].DomainName`
 * and `Comment` are both on `DistributionSummary`; `CallerReference` is not,
 * which is the whole reason this message exists.
 *
 * Read from the RAW template properties rather than the converted SDK config
 * so the helper stays usable from the catch, which is outside the scope
 * where `sdkConfig` exists. Both the bare-array (CFn) and `{ Quantity,
 * Items }` (SDK) spellings of `Origins` are accepted because a template may
 * carry either.
 *
 * **Every value it returns is a RESOLVED template value, so each is masked
 * HERE, at the leaf** (issue #1932 item 3, the shape
 * `apigatewayv2-provider.ts`'s `toSdkResponseParameters` established). Two
 * reasons the caller's outer mask cannot stand alone, both from
 * `.claude/rules/providers.md`: `maskSecretsInText`'s SUBSTRING arm ignores a
 * needle shorter than `MIN_NEEDLE_LENGTH` (4), and `JSON.stringify` escapes
 * quotes — so a Secrets Manager JSON document no longer OCCURS literally in
 * the finished sentence. Masking the raw string first reaches the
 * WHOLE-VALUE arm at any length, and the mask is idempotent, so both layers
 * are free.
 */
export function orphanSearchHint(
  this: CloudFrontDistributionProvider,
  properties: Record<string, unknown>,
  maskSecrets: SecretMasker
): string {
  const config = (properties['DistributionConfig'] as Record<string, unknown>) ?? {};
  const origins = config['Origins'];
  const originItems: unknown[] = Array.isArray(origins)
    ? origins
    : Array.isArray((origins as { Items?: unknown[] } | undefined)?.Items)
      ? ((origins as { Items: unknown[] }).Items ?? [])
      : [];
  const domains = originItems
    .map((origin) => (origin as { DomainName?: unknown } | undefined)?.DomainName)
    .filter((domain): domain is string => typeof domain === 'string' && domain !== '')
    .map((domain) => maskSecrets(domain));
  const comment = typeof config['Comment'] === 'string' ? maskSecrets(config['Comment']) : '';

  const parts: string[] = [];
  if (domains.length > 0) parts.push(`origin domain ${domains.join(' / ')}`);
  if (comment !== '') parts.push(`comment ${JSON.stringify(comment)}`);
  // A template with neither is legal (an origin can arrive as an unresolved
  // intrinsic, and Comment is optional), so never emit a dangling "match on".
  return parts.length > 0
    ? parts.join(' and ')
    : 'its creation time (the orphan is the newest distribution in this account)';
}

/**
 * Update a CloudFront Distribution
 *
 * `UpdateDistribution` is a read-modify-write API that expects the COMPLETE
 * configuration, while a CFn template legitimately omits every optional
 * member the user did not set — sending the template verbatim fails on the
 * first required-on-update member the template lacks ("WebACLId is missing
 * for the resource", issue #1371). So the update merges per top-level
 * member: `GetDistributionConfigCommand`'s current config is the base, the
 * template is the authority for every member it carries, a member REMOVED
 * since the previous template resets to its CloudFormation default
 * (matching CFn's omission-resets semantics rather than silently keeping
 * the live value), and `CallerReference` is always preserved from the
 * current config. Then calls `UpdateDistributionCommand` with the required
 * IfMatch ETag.
 */
export async function update(
  this: CloudFrontDistributionProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating CloudFront Distribution ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#2613: CloudFront is global -- the SDK sends every region to
  // cloudfront.amazonaws.com -- but the client's configured region is the
  // stack's region (it is built from the shared client options, not pinned
  // to us-east-1), so a mismatch with the recorded region means this client
  // was not built for the stack the record belongs to. Refused before the
  // first call (delete() compares the regions only on a NotFound), outside
  // the try so the refusal is not re-labelled as an AWS failure; the
  // client's region is read only when there is a recorded one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.cloudFrontClient.config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-update',
    'global'
  );
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  try {
    // Get current config and ETag
    const getConfigResponse = await this.cloudFrontClient.send(
      new GetDistributionConfigCommand({ Id: physicalId })
    );
    const etag = getConfigResponse.ETag!;
    const currentConfig = getConfigResponse.DistributionConfig!;

    // Merge the template over the current config per top-level member
    // (issue #1371) — see the method doc for the exact semantics.
    const newDistributionConfig =
      (properties['DistributionConfig'] as Record<string, unknown>) ?? {};
    const previousDistributionConfig =
      (previousProperties['DistributionConfig'] as Record<string, unknown>) ?? {};
    const sdkConfig = this.mergeUpdateConfig(
      currentConfig as unknown as Record<string, unknown>,
      newDistributionConfig,
      previousDistributionConfig,
      logicalId
    );

    await this.cloudFrontClient.send(
      new UpdateDistributionCommand({
        Id: physicalId,
        IfMatch: etag,
        DistributionConfig: sdkConfig as unknown as DistributionConfig,
      })
    );

    // Get updated distribution for attributes (and ARN for tag ops)
    const getResponse = await this.cloudFrontClient.send(
      new GetDistributionCommand({ Id: physicalId })
    );
    const domainName = getResponse.Distribution?.DomainName;
    const arn = getResponse.Distribution?.ARN;

    // Apply tag diff via TagResource / UntagResource. CloudFront has no
    // single SDK call that overlays a tag map atomically — adds /
    // updates use TagResource (TagResource overwrites a key's value
    // when re-tagged), removals use UntagResource. Run the removal
    // first so a renamed key (e.g. value-only edit on key K) is not
    // accidentally cleared by a stale UntagResource pass.
    //
    // Tag-side failures THROW (issue #740 fix): a swallow leaves state
    // recording the new Tags as applied while AWS-side tags stay stale
    // forever (next deploy sees no diff → no retry). The trade-off is
    // that a TagResource throttle flips the whole update into a deploy
    // failure; the retry will re-issue UpdateDistribution against the
    // already-current config (AWS accepts as a no-op) before re-firing
    // the tag-diff. That secondary noise is much cheaper than the
    // silent tag drift the pre-#740 swallow caused.
    await this.applyTagDiff(
      arn,
      previousProperties['Tags'],
      properties['Tags'],
      physicalId,
      logicalId,
      resourceType,
      context?.maskSecrets
    );

    // UpdateDistribution is fire-and-forget by default for the same reason
    // CreateDistribution is (issue #1282); under --full-wait it waits like
    // create does, matching CloudFormation/Terraform which wait on both.
    await this.settleDistribution(logicalId, physicalId);

    this.logger.debug(`Updated CloudFront Distribution ${physicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: definedAttributes({
        Id: physicalId,
        DistributionId: physicalId,
        DomainName: domainName,
      }),
    };
  } catch (error) {
    // Pass through cdkd-typed errors untouched (#1272): re-labelling an inner
    // ProvisioningError replaces its precise message with this outer one.
    if (error instanceof CdkdError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update CloudFront Distribution ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
