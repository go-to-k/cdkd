import {
  CloudFrontClient,
  CreateDistributionCommand,
  CreateDistributionWithTagsCommand,
  UpdateDistributionCommand,
  DeleteDistributionCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NoSuchDistribution,
  DistributionAlreadyExists,
  type DistributionConfig,
  type Tag,
} from '@aws-sdk/client-cloudfront';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { acquireIdempotencyToken } from './idempotency-token.js';
import { CdkdError, ProvisioningError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { resolvedResourceTimeoutMs } from '../resource-timeout-registry.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  SecretMasker,
} from '../../types/resource.js';

/**
 * Top-level `DistributionConfig` fields that are a BARE ARRAY in the CFn
 * template but a `{ Quantity, Items }` wrapper in the SDK shape — so
 * `convertToSdkFormat` wraps them and `convertToCfnFormat` unwraps them.
 *
 * `OriginGroups` is deliberately NOT here (issue #873): unlike `Origins` /
 * `CacheBehaviors` / `Aliases` / `CustomErrorResponses` (bare lists in CFn), the
 * CFn `DistributionConfig.OriginGroups` property is ITSELF a `{ Quantity, Items }`
 * object, and so are its nested `Members` and `FailoverCriteria.StatusCodes`.
 * CDK synthesizes that full `{ Quantity, Items }` shape and `GetDistributionConfig`
 * returns the same, so OriginGroups must pass through UNTOUCHED in both
 * directions — unwrapping it (it was incorrectly listed here before) turned the
 * read-back OriginGroups into a bare array that no longer matched the template's
 * `{ Quantity, Items }`, firing phantom drift.
 */
const QUANTITY_ITEM_FIELDS = ['Origins', 'CacheBehaviors', 'CustomErrorResponses', 'Aliases'];

/**
 * `ViewerCertificate` members whose ACRONYM CASING differs between the CFn
 * resource schema and the CloudFront API (issue #1370). The CFn template
 * carries the left-hand spelling; the SDK model only knows the right-hand
 * one, so an unrenamed key silently never reaches AWS — a custom-domain
 * distribution then fails to create ("Your ViewerCertificate is missing one
 * of ACMCertificateArn, IAMCertificateId, or CloudFrontDefaultCertificate").
 */
const VIEWER_CERTIFICATE_CFN_TO_SDK: Record<string, string> = {
  AcmCertificateArn: 'ACMCertificateArn',
  SslSupportMethod: 'SSLSupportMethod',
  IamCertificateId: 'IAMCertificateId',
};

/**
 * Top-level `DistributionConfig` members with the same CFn-vs-SDK casing
 * divergence (issue #1370): the template's `IPV6Enabled` is `IsIPV6Enabled`
 * in the SDK model, so it was silently dropped (IPv6 ended up disabled).
 */
const TOP_LEVEL_CFN_TO_SDK: Record<string, string> = {
  IPV6Enabled: 'IsIPV6Enabled',
};

/**
 * CloudFormation defaults applied when a top-level `DistributionConfig`
 * member present in the PREVIOUS template is REMOVED from the new one
 * (issue #1371). `UpdateDistribution` is a read-modify-write API taking the
 * complete config, so the update path merges the template over the live
 * config — but a member the user deleted from the template must reset to
 * its CloudFormation default (CFn semantics), not silently keep its live
 * value. Values are in SDK shape.
 *
 * Sources: the AWS::CloudFront::Distribution registry schema `default`
 * annotations (Comment / DefaultRootObject / HttpVersion / PriceClass /
 * Restrictions / ViewerCertificate / WebACLId — verified via
 * `cloudformation:DescribeType`, 2026-08-09); list members reset to the
 * empty `{ Quantity: 0, Items: [] }` wrapper (removing a list property
 * means "no items"); `Logging` to the API's documented off shape. Removed
 * members with NO entry here (e.g. `IsIPV6Enabled` / `Staging` — no
 * schema-documented default) keep their live value with a warning: a
 * visible conservative choice, never a silent guess.
 */
const REMOVAL_RESET_DEFAULTS: Record<string, unknown> = {
  Aliases: { Quantity: 0, Items: [] },
  CacheBehaviors: { Quantity: 0, Items: [] },
  Comment: '',
  CustomErrorResponses: { Quantity: 0, Items: [] },
  DefaultRootObject: '',
  HttpVersion: 'http1.1',
  Logging: { Enabled: false, IncludeCookies: false, Bucket: '', Prefix: '' },
  OriginGroups: { Quantity: 0, Items: [] },
  PriceClass: 'PriceClass_All',
  Restrictions: { GeoRestriction: { RestrictionType: 'none', Quantity: 0, Items: [] } },
  ViewerCertificate: { CloudFrontDefaultCertificate: true },
  WebACLId: '',
};

/**
 * Nested fields inside each CacheBehavior / DefaultCacheBehavior that use
 * the Quantity + Items pattern.
 */
const CACHE_BEHAVIOR_QUANTITY_FIELDS = [
  'AllowedMethods',
  'CachedMethods',
  'LambdaFunctionAssociations',
  'FunctionAssociations',
  'ForwardedValues.Headers',
  'ForwardedValues.QueryStringCacheKeys',
  'ForwardedValues.Cookies.WhitelistedNames',
  'TrustedSigners',
  'TrustedKeyGroups',
];

/**
 * SDK Provider for AWS::CloudFront::Distribution
 *
 * Uses the CloudFront SDK directly for reliable CRUD operations.
 * CloudFront Distribution has a complex nested DistributionConfig structure
 * requiring Quantity + Items pattern conversions for SDK compatibility.
 */
export class CloudFrontDistributionProvider implements ResourceProvider {
  private cloudFrontClient: CloudFrontClient;
  private logger = getLogger().child('CloudFrontDistributionProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::CloudFront::Distribution', new Set(['DistributionConfig', 'Tags'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.cloudFrontClient = awsClients.cloudFront;
  }

  /**
   * Create a CloudFront Distribution
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CloudFront Distribution ${logicalId}`);

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
      const distributionConfig =
        (properties['DistributionConfig'] as Record<string, unknown>) ?? {};
      const sdkConfig = this.convertToSdkFormat({
        ...distributionConfig,
        CallerReference: callerReferenceToken.value,
      });

      // CFn shape: `Tags: [{ Key, Value }]`. CloudFront's SDK wraps tags in
      // a separate `CreateDistributionWithTagsCommand` whose request shape
      // is `{ DistributionConfigWithTags: { DistributionConfig, Tags: { Items: Tag[] } } }`.
      // Switch command class when tags are present so the create is atomic
      // (a post-create `TagResource` race would leave a tag-less window).
      const sdkTags = this.toSdkTags(properties['Tags']);

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
                `(or import it with 'cdkd import') before re-running. The AWS error is on this ` +
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
      throw new ProvisioningError(
        `Failed to create CloudFront Distribution ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
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
  private orphanSearchHint(properties: Record<string, unknown>, maskSecrets: SecretMasker): string {
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
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CloudFront Distribution ${logicalId}: ${physicalId}`);

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
      const domainName = getResponse.Distribution?.DomainName ?? '';
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
        resourceType
      );

      // UpdateDistribution is fire-and-forget by default for the same reason
      // CreateDistribution is (issue #1282); under --full-wait it waits like
      // create does, matching CloudFormation/Terraform which wait on both.
      await this.settleDistribution(logicalId, physicalId);

      this.logger.debug(`Updated CloudFront Distribution ${physicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Id: physicalId,
          DistributionId: physicalId,
          DomainName: domainName,
        },
      };
    } catch (error) {
      // Pass through cdkd-typed errors untouched (#1272): re-labelling an inner
      // ProvisioningError replaces its precise message with this outer one.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CloudFront Distribution ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a CloudFront Distribution
   *
   * CloudFront requires distributions to be disabled before deletion.
   * Steps:
   * 1. Get current config + ETag
   * 2. If Enabled, update to Enabled=false and wait
   * 3. Delete with the latest ETag
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting CloudFront Distribution ${logicalId}: ${physicalId}`);

    try {
      // Step 1: Get current config
      let etag: string;
      let config;
      try {
        const getConfigResponse = await this.cloudFrontClient.send(
          new GetDistributionConfigCommand({ Id: physicalId })
        );
        etag = getConfigResponse.ETag!;
        config = getConfigResponse.DistributionConfig!;
      } catch (error) {
        if (error instanceof NoSuchDistribution) {
          const clientRegion = await this.cloudFrontClient.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`Distribution ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // Step 2: Disable the distribution if it is currently enabled
      if (config.Enabled) {
        this.logger.debug(`Disabling CloudFront Distribution ${physicalId} before deletion`);
        config.Enabled = false;

        const updateResponse = await this.cloudFrontClient.send(
          new UpdateDistributionCommand({
            Id: physicalId,
            IfMatch: etag,
            DistributionConfig: config,
          })
        );
        etag = updateResponse.ETag!;

        // Wait until the disable is fully propagated. We must check BOTH
        // Status==='Deployed' AND DistributionConfig.Enabled===false, because
        // CloudFront's read-after-write is eventually consistent: a GetDistribution
        // call made shortly after UpdateDistribution can still return the previous
        // (Enabled=true, Status=Deployed) snapshot, which would otherwise cause us
        // to exit the wait loop on the very first poll and fire DeleteDistribution
        // against an enabled distribution (yielding DistributionNotDisabled).
        const disabled = await this.waitForDistributionStable(physicalId, false);
        if (!disabled) {
          this.logger.warn(
            `Distribution ${physicalId} disable did not settle (Deployed + disabled) within the wait budget; attempting delete anyway. ` +
              `If it fails with DistributionNotDisabled, retry the destroy or raise the budget with --resource-timeout AWS::CloudFront::Distribution=<duration>.`
          );
        }

        // Re-fetch ETag after waiting (state may have changed)
        const refreshResponse = await this.cloudFrontClient.send(
          new GetDistributionConfigCommand({ Id: physicalId })
        );
        etag = refreshResponse.ETag!;
      } else {
        // Already disabled — but the disable may still be PROPAGATING
        // (issue #1316): a prior interrupted destroy (or an out-of-band
        // console disable) flips the config to Enabled=false immediately
        // while Status stays InProgress for minutes, and DeleteDistribution
        // rejects until Status is Deployed ("has not been disabled"). Wait
        // for the same settled state the just-disabled arm waits for.
        const settled = await this.waitForDistributionStable(physicalId, false);
        if (!settled) {
          this.logger.warn(
            `Distribution ${physicalId} is disabled but its propagation did not settle (Deployed) within the wait budget; attempting delete anyway. ` +
              `If it fails with DistributionNotDisabled, retry the destroy or raise the budget with --resource-timeout AWS::CloudFront::Distribution=<duration>.`
          );
        }

        // Re-fetch ETag after waiting (a completed propagation changes it)
        const refreshResponse = await this.cloudFrontClient.send(
          new GetDistributionConfigCommand({ Id: physicalId })
        );
        etag = refreshResponse.ETag!;
      }

      // Step 3: Delete the distribution
      await this.cloudFrontClient.send(
        new DeleteDistributionCommand({
          Id: physicalId,
          IfMatch: etag,
        })
      );

      this.logger.debug(`Successfully deleted CloudFront Distribution ${logicalId}`);
    } catch (error) {
      if (error instanceof NoSuchDistribution) {
        const clientRegion = await this.cloudFrontClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Distribution ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CloudFront Distribution ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current `DistributionConfig` for drift detection.
   *
   * Calls the read-only `GetDistributionConfigCommand` and inverts the
   * provider's own `convertToSdkFormat` (the CFn-shape → SDK-shape
   * `{ Quantity, Items }` mapping the create / update path applies) back
   * into the CloudFormation `DistributionConfig` shape that cdkd state
   * stores — so the drift comparator sees the same structure on both
   * the deploy-time observed snapshot and a later drift read.
   *
   * The comparator only descends into keys present in cdkd state (or the
   * union of state + AWS when an observed baseline exists), so this does
   * not need to surface every AWS-injected field; it returns the same
   * `DistributionConfig` / `Tags` keys the provider manages.
   *
   * `CallerReference` (a create-time idempotency token AWS echoes back
   * but CDK never templates) is dropped so it cannot fire phantom drift.
   * The remaining write-only / never-readable sub-fields are declared in
   * `getDriftUnknownPaths`.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    if (resourceType !== 'AWS::CloudFront::Distribution') return undefined;

    let config: DistributionConfig | undefined;
    try {
      const response = await this.cloudFrontClient.send(
        new GetDistributionConfigCommand({ Id: physicalId })
      );
      config = response.DistributionConfig;
    } catch (error) {
      if (error instanceof NoSuchDistribution) return undefined;
      throw error;
    }
    if (!config) return undefined;

    const result: Record<string, unknown> = {
      DistributionConfig: this.convertToCfnFormat(config as unknown as Record<string, unknown>),
    };

    // Surface AWS-current tags so a console-side tag edit is detectable.
    // CloudFront tags live on the distribution's ARN, fetched separately
    // via ListTagsForResource. A tag read failure is non-fatal — the
    // DistributionConfig drift is still meaningful on its own.
    try {
      const getResponse = await this.cloudFrontClient.send(
        new GetDistributionCommand({ Id: physicalId })
      );
      const arn = getResponse.Distribution?.ARN;
      if (arn) {
        const tagsResponse = await this.cloudFrontClient.send(
          new ListTagsForResourceCommand({ Resource: arn })
        );
        const items = tagsResponse.Tags?.Items ?? [];
        const cfnTags = items
          .filter((t) => typeof t.Key === 'string' && !t.Key.startsWith('aws:cdk:'))
          .map((t) => ({ Key: t.Key as string, Value: t.Value ?? '' }));
        if (cfnTags.length > 0) {
          result['Tags'] = cfnTags;
        }
      }
    } catch (error) {
      this.logger.debug(
        `Tag read for CloudFront Distribution ${physicalId} failed during drift read: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return result;
  }

  /**
   * State property paths cdkd cannot read back faithfully from AWS, so
   * the drift comparator skips them rather than firing a guaranteed
   * false positive every run (mirrors the Lambda `Code.S3*` precedent).
   *
   * - `DistributionConfig.CallerReference`: a create-time idempotency
   *   token. cdkd generates it internally (`acquireIdempotencyToken`, issue
   *   #2079 — a per-process digest, `cdkd-<sha256 prefix>`); AWS echoes it
   *   back, but it is never templated by CDK, so comparing it would diff
   *   cdkd's generated value on every run. It is not even stable across
   *   cdkd RUNS by design (a process nonce is mixed in), so suppression is
   *   required rather than merely convenient. `convertToCfnFormat` already
   *   drops it from the AWS side; declaring it here also excludes it from
   *   the observed-baseline side.
   * - `DistributionConfig.Logging.Bucket`: CloudFront normalizes the S3
   *   logging bucket to its `<bucket>.s3.amazonaws.com` regional domain on
   *   read, which never matches the bare bucket domain a template may
   *   carry; treat it as drift-unknown to avoid a guaranteed mismatch.
   *
   * NOTE: `DistributionConfig.OriginGroups` is NO LONGER suppressed (issue
   * #873). The earlier suppression worked around `convertToCfnFormat`
   * incorrectly unwrapping the top-level OriginGroups `{ Quantity, Items }`
   * wrapper; the real fix (dropping OriginGroups from `QUANTITY_ITEM_FIELDS` so
   * it passes through untouched in both directions) makes OriginGroups compare
   * equal, so it is now drift-checked normally and a real OriginGroups change
   * IS reported.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType !== 'AWS::CloudFront::Distribution') return [];
    return ['DistributionConfig.CallerReference', 'DistributionConfig.Logging.Bucket'];
  }

  /**
   * Plain-string arrays that are semantically UNORDERED sets, per
   * {@link ResourceProvider.getDriftUnorderedPaths}.
   *
   * `GeoRestriction.Locations` is a set of ISO country codes — the
   * CloudFront API reference documents no ordering semantics and the
   * service does not echo the submitted order back (observed live in the
   * `s3-cloudfront` integ, 2026-08-09: a template `[JP, US]` allowlist
   * read back as `[US, JP]`), so a positional compare fires guaranteed
   * phantom drift on any multi-country restriction.
   */
  getDriftUnorderedPaths(resourceType: string): string[] {
    if (resourceType !== 'AWS::CloudFront::Distribution') return [];
    return ['DistributionConfig.Restrictions.GeoRestriction.Locations'];
  }

  /**
   * Get resource attribute (for Fn::GetAtt resolution)
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'DistributionId') {
      return physicalId;
    }

    if (attributeName === 'DomainName') {
      const response = await this.cloudFrontClient.send(
        new GetDistributionCommand({ Id: physicalId })
      );
      return response.Distribution?.DomainName;
    }

    throw new Error(`Unsupported attribute: ${attributeName} for AWS::CloudFront::Distribution`);
  }

  /**
   * Settle a CloudFront Distribution according to the run's wait mode.
   *
   * cdkd does NOT wait for `Deployed` by default (issue #1282). Both
   * CloudFormation and Terraform (`wait_for_deployment`, default `true`) wait
   * here, so this is a deliberate divergence under the wait-semantics policy's
   * fast-side clause: every `Fn::GetAtt` (Id / DomainName) is final in the
   * Create/Update response so nothing in-deploy consumes `Deployed`, the wait
   * carries no failure signal (a distribution deploy cannot fail — a long
   * wait means slow edge propagation, not brokenness), and Terraform's
   * `wait_for_deployment` toggle keeps the benchmark comparison measurable in
   * both modes. `--full-wait` opts back into the CloudFormation behavior.
   */
  private async settleDistribution(logicalId: string, distributionId: string): Promise<void> {
    if (process.env['CDKD_FULL_WAIT'] === 'true') {
      this.logger.debug(`Waiting for Distribution ${distributionId} to reach Deployed status...`);
      const stable = await this.waitForDistributionStable(distributionId);
      if (!stable) {
        // Unlike the ECS Service --full-wait timeout (which FAILS the deploy —
        // a never-stabilizing service signals a crash-looping rollout), a
        // CloudFront wait timeout only means propagation is slow, so failing
        // would hand auto-rollback a healthy distribution to disable-and-delete.
        // Warn and proceed instead.
        this.logger.warn(
          `CloudFront Distribution ${logicalId} (${distributionId}) did not reach Deployed within the wait budget; continuing (propagation finishes in the background). ` +
            `To wait manually: aws cloudfront wait distribution-deployed --id ${distributionId}. ` +
            `Raise the budget with --resource-timeout AWS::CloudFront::Distribution=<duration>.`
        );
      }
      return;
    }

    // Mention --full-wait only when the invoking COMMAND actually declares it
    // (cdkd deploy sets CDKD_WAIT_FLAGS_AVAILABLE; `cdkd drift --revert`
    // reaches this same code through provider.update and does NOT — issue
    // #1291 pattern).
    const fullWaitHint =
      process.env['CDKD_WAIT_FLAGS_AVAILABLE'] === 'true' ? '; pass --full-wait to wait' : '';
    this.logger.info(
      `CloudFront Distribution ${logicalId} accepted (not waiting for Deployed${fullWaitHint}). ` +
        `To wait manually: aws cloudfront wait distribution-deployed --id ${distributionId}`
    );
  }

  /**
   * Poll until the distribution reports `Status: Deployed` (and, when
   * `expectedEnabled` is given, the matching `Enabled` value — the delete
   * path's disable-then-delete requirement).
   *
   * Returns `true` when the stable state was observed (or the wait was
   * interrupted by SIGINT — the caller is shutting down, so no timeout
   * warning applies), `false` on budget exhaustion.
   */
  private async waitForDistributionStable(
    distributionId: string,
    expectedEnabled?: boolean
  ): Promise<boolean> {
    // A CloudFront distribution reaches Deployed in ~3-6 min. The poll ramps
    // 5s * 1.5x but is capped tight (10s, not the old 30s) so detection lag
    // stays small — a sparse late poll is exactly what made cdkd trail
    // tight-polling tools on CloudFront-bound stacks (same class as the EC2
    // waiter fix). The ~20 min default budget is lifted by an explicit
    // `--resource-timeout` (per-type or global) so this inner waiter can never
    // undercut the outer per-resource deadline the same flag raises (issue
    // #1280) — but the flag never lowers it below the default.
    const budgetMs = Math.max(
      20 * 60 * 1000,
      resolvedResourceTimeoutMs('AWS::CloudFront::Distribution') ?? 0
    );
    const deadline = Date.now() + budgetMs;
    let delay = 5000; // start at 5s
    const maxDelay = 10000;
    let interrupted = false;

    const sigintHandler = () => {
      interrupted = true;
    };
    process.on('SIGINT', sigintHandler);

    try {
      while (Date.now() < deadline) {
        if (interrupted) {
          this.logger.debug(
            `Distribution ${distributionId} wait interrupted by SIGINT, proceeding`
          );
          return true;
        }

        let response;
        try {
          response = await this.cloudFrontClient.send(
            new GetDistributionCommand({ Id: distributionId })
          );
        } catch (error) {
          // A gone distribution is a terminal answer the caller must see (the
          // delete path's NotFound handling). Anything else (throttle, network
          // blip) must NOT escape: the wait has no failure signal by design,
          // and an escaped throw would fail an operation whose mutation
          // already succeeded — on create, the engine's outer retry would then
          // re-invoke create() over a distribution that already exists. Since
          // issue #2079 that no longer duplicates it (the CallerReference is
          // stable across attempts, so CloudFront refuses the replay), but the
          // refusal is a hard `DistributionAlreadyExists` failure over an
          // ORPHAN the user then has to delete by hand — still a failure this
          // wait must not manufacture. Log and keep polling; the deadline
          // bounds the loop either way.
          if (error instanceof NoSuchDistribution) throw error;
          this.logger.debug(
            `Distribution ${distributionId} status read failed (${error instanceof Error ? error.message : String(error)}); retrying`
          );
        }

        if (response) {
          const status = response.Distribution?.Status;
          const enabled = response.Distribution?.DistributionConfig?.Enabled;

          const enabledMatches = expectedEnabled === undefined || enabled === expectedEnabled;

          if (status === 'Deployed' && enabledMatches) {
            this.logger.debug(
              `Distribution ${distributionId} is stable (Status=Deployed, Enabled=${enabled})`
            );
            return true;
          }

          this.logger.debug(
            `Distribution ${distributionId} status: ${status}, enabled: ${enabled}` +
              (expectedEnabled === undefined ? '' : ` (waiting for Enabled=${expectedEnabled})`)
          );
        }

        // Interruptible sleep: check SIGINT every second
        const sleepEnd = Date.now() + delay;
        while (Date.now() < sleepEnd && !interrupted) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        delay = Math.min(delay * 1.5, maxDelay);
      }

      // A SIGINT that lands during the final sleep exits the loop via the
      // deadline check; it is still an interruption, not a timeout — return
      // true so the caller's timeout warning stays suppressed on shutdown.
      if (interrupted) {
        this.logger.debug(`Distribution ${distributionId} wait interrupted by SIGINT, proceeding`);
        return true;
      }

      this.logger.debug(
        `Distribution ${distributionId} did not reach stable state within timeout, proceeding with next step`
      );
      return false;
    } finally {
      process.removeListener('SIGINT', sigintHandler);
    }
  }

  /**
   * Build the complete SDK-shape `DistributionConfig` for an update
   * (issue #1371). Per top-level member:
   *
   * - present in the new template          -> template value (authority)
   * - removed since the previous template  -> CloudFormation default
   *   ({@link REMOVAL_RESET_DEFAULTS}); a member with no known default keeps
   *   its live value with a WARN (visible, never a silent decision)
   * - never templated                      -> live value from `currentConfig`
   *   (the AWS-side default filled at create, or an out-of-band setting cdkd
   *   never managed)
   *
   * One deliberate exception to the never-templated rule: `Comment` is
   * always present in `templateSdk` ({@link convertToSdkFormat} injects
   * `''` when absent — the SDK requires a non-null string), so an
   * untemplated Comment resets to `''` rather than keeping the live value.
   * That matches its CFn registry-schema default and the pre-merge
   * behavior.
   *
   * `CallerReference` is always preserved from the current config (a
   * create-time idempotency token the template never carries).
   */
  private mergeUpdateConfig(
    currentConfig: Record<string, unknown>,
    newDistributionConfig: Record<string, unknown>,
    previousDistributionConfig: Record<string, unknown>,
    logicalId: string
  ): Record<string, unknown> {
    const templateSdk = this.convertToSdkFormat(newDistributionConfig);
    const previousSdk = this.convertToSdkFormat(previousDistributionConfig);

    const merged: Record<string, unknown> = { ...currentConfig };

    for (const key of Object.keys(previousSdk)) {
      if (key in templateSdk || key === 'CallerReference') continue;
      if (key in REMOVAL_RESET_DEFAULTS) {
        merged[key] = structuredClone(REMOVAL_RESET_DEFAULTS[key]);
      } else {
        // Report the key in its CFn/template spelling (the user removes
        // `IPV6Enabled`, not the SDK's `IsIPV6Enabled`).
        const cfnKey =
          Object.entries(TOP_LEVEL_CFN_TO_SDK).find(([, sdkKey]) => sdkKey === key)?.[0] ?? key;
        this.logger.warn(
          `CloudFront Distribution ${logicalId}: '${cfnKey}' was removed from the template but has ` +
            `no known CloudFormation default; keeping the live value. Set the property explicitly ` +
            `in the template to control it.`
        );
      }
    }

    Object.assign(merged, templateSdk);
    merged['CallerReference'] = currentConfig['CallerReference'];
    this.completeRequiredUpdateFields(merged);
    return merged;
  }

  /**
   * Fill the sub-fields `UpdateDistribution` REQUIRES but a CFn template
   * legitimately omits (issue #1371, second layer). The top-level merge
   * makes the payload complete per member, but the template-authoritative
   * `Origins` / `DefaultCacheBehavior` / `CacheBehaviors` members carry the
   * template's SPARSE sub-shapes, and the API — which accepts them sparse
   * on CREATE — rejects an update with per-field errors ("The
   * 'OriginCustomHeaders' field is missing", "OriginReadTimeout is required
   * for updates", "The parameter SmoothStreaming flag is missing", ...).
   *
   * The set below is the EMPIRICALLY REQUIRED list (probed live against
   * UpdateDistribution, 2026-08-09) plus its symmetric CFn-default
   * companions (`FunctionAssociations` / `TrustedSigners` /
   * `TrustedKeyGroups` — same association/signer family, filled with the
   * same disabled/empty CFn defaults CloudFormation submits for an
   * omitted property). Values a template DOES carry always win — every
   * fill is absent-only. Legacy `ForwardedValues`-mode TTLs are
   * deliberately NOT filled (they are forbidden alongside `CachePolicyId`,
   * so a wrong guess would break the modern mode; a legacy template that
   * needs them fails loudly and can be added here).
   */
  private completeRequiredUpdateFields(config: Record<string, unknown>): void {
    const origins = config['Origins'] as Record<string, unknown> | undefined;
    if (origins && Array.isArray(origins['Items'])) {
      origins['Items'] = (origins['Items'] as Record<string, unknown>[]).map((origin) => {
        const o = { ...origin };
        if (o['OriginPath'] === undefined) o['OriginPath'] = '';
        if (o['CustomHeaders'] === undefined) o['CustomHeaders'] = { Quantity: 0, Items: [] };
        if (o['CustomOriginConfig'] && typeof o['CustomOriginConfig'] === 'object') {
          const c = { ...(o['CustomOriginConfig'] as Record<string, unknown>) };
          if (c['OriginReadTimeout'] === undefined) c['OriginReadTimeout'] = 30;
          if (c['OriginKeepaliveTimeout'] === undefined) c['OriginKeepaliveTimeout'] = 5;
          o['CustomOriginConfig'] = c;
        }
        return o;
      });
    }

    const fillBehavior = (behavior: Record<string, unknown>): Record<string, unknown> => {
      const b = { ...behavior };
      if (b['SmoothStreaming'] === undefined) b['SmoothStreaming'] = false;
      if (b['FieldLevelEncryptionId'] === undefined) b['FieldLevelEncryptionId'] = '';
      if (b['LambdaFunctionAssociations'] === undefined) {
        b['LambdaFunctionAssociations'] = { Quantity: 0, Items: [] };
      }
      if (b['FunctionAssociations'] === undefined) {
        b['FunctionAssociations'] = { Quantity: 0, Items: [] };
      }
      if (b['TrustedSigners'] === undefined) {
        b['TrustedSigners'] = { Enabled: false, Quantity: 0 };
      }
      if (b['TrustedKeyGroups'] === undefined) {
        b['TrustedKeyGroups'] = { Enabled: false, Quantity: 0 };
      }
      if (b['AllowedMethods'] === undefined) {
        b['AllowedMethods'] = {
          Quantity: 2,
          Items: ['GET', 'HEAD'],
          CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
        };
      } else if (
        b['AllowedMethods'] &&
        typeof b['AllowedMethods'] === 'object' &&
        (b['AllowedMethods'] as Record<string, unknown>)['CachedMethods'] === undefined
      ) {
        // Template carried AllowedMethods but no CachedMethods sibling —
        // fill the nested CFn default (GET, HEAD).
        b['AllowedMethods'] = {
          ...(b['AllowedMethods'] as Record<string, unknown>),
          CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
        };
      }
      return b;
    };

    if (config['DefaultCacheBehavior'] && typeof config['DefaultCacheBehavior'] === 'object') {
      config['DefaultCacheBehavior'] = fillBehavior(
        config['DefaultCacheBehavior'] as Record<string, unknown>
      );
    }
    const cacheBehaviors = config['CacheBehaviors'] as Record<string, unknown> | undefined;
    if (cacheBehaviors && Array.isArray(cacheBehaviors['Items'])) {
      cacheBehaviors['Items'] = (cacheBehaviors['Items'] as Record<string, unknown>[]).map((cb) =>
        fillBehavior(cb)
      );
    }
  }

  /**
   * Convert CDK/CloudFormation DistributionConfig format to SDK format.
   *
   * The main transformation is adding Quantity fields where the SDK expects
   * the { Quantity: N, Items: [...] } pattern, while CDK templates typically
   * provide just the Items array or an object with only Items.
   */
  private convertToSdkFormat(config: Record<string, unknown>): Record<string, unknown> {
    const result = { ...config };

    // Ensure Comment is never null (SDK requires non-null string)
    if (result['Comment'] === null || result['Comment'] === undefined) {
      result['Comment'] = '';
    }

    // CFn -> SDK acronym-casing renames (issue #1370): top-level
    // IPV6Enabled -> IsIPV6Enabled, plus the three ViewerCertificate members.
    for (const [cfnKey, sdkKey] of Object.entries(TOP_LEVEL_CFN_TO_SDK)) {
      if (result[cfnKey] !== undefined) {
        result[sdkKey] = result[cfnKey];
        delete result[cfnKey];
      }
    }
    if (result['ViewerCertificate'] && typeof result['ViewerCertificate'] === 'object') {
      const viewerCertificate = { ...(result['ViewerCertificate'] as Record<string, unknown>) };
      for (const [cfnKey, sdkKey] of Object.entries(VIEWER_CERTIFICATE_CFN_TO_SDK)) {
        if (viewerCertificate[cfnKey] !== undefined) {
          viewerCertificate[sdkKey] = viewerCertificate[cfnKey];
          delete viewerCertificate[cfnKey];
        }
      }
      result['ViewerCertificate'] = viewerCertificate;
    }

    // CFn Restrictions.GeoRestriction carries a bare `Locations` array; the
    // SDK shape is { RestrictionType, Quantity, Items } with Quantity
    // REQUIRED even when zero (issue #1370, same class as the casing gaps).
    if (result['Restrictions'] && typeof result['Restrictions'] === 'object') {
      const restrictions = { ...(result['Restrictions'] as Record<string, unknown>) };
      if (restrictions['GeoRestriction'] && typeof restrictions['GeoRestriction'] === 'object') {
        const geo = { ...(restrictions['GeoRestriction'] as Record<string, unknown>) };
        if (Array.isArray(geo['Locations'])) {
          geo['Items'] = geo['Locations'];
          delete geo['Locations'];
        }
        if (geo['Quantity'] === undefined) {
          geo['Quantity'] = Array.isArray(geo['Items']) ? (geo['Items'] as unknown[]).length : 0;
        }
        restrictions['GeoRestriction'] = geo;
      }
      result['Restrictions'] = restrictions;
    }

    // Ensure Logging has IncludeCookies and Enabled defaults. Copy before
    // filling: the update path now runs state-sourced previousProperties
    // through this method too, and an in-place fill would mutate the caller's
    // nested object.
    if (result['Logging'] && typeof result['Logging'] === 'object') {
      const logging = { ...(result['Logging'] as Record<string, unknown>) };
      if (logging['IncludeCookies'] === undefined) logging['IncludeCookies'] = false;
      if (logging['Enabled'] === undefined) logging['Enabled'] = true;
      if (logging['Prefix'] === undefined) logging['Prefix'] = '';
      result['Logging'] = logging;
    }

    // Convert top-level Quantity + Items fields
    for (const field of QUANTITY_ITEM_FIELDS) {
      if (result[field] !== undefined) {
        result[field] = this.wrapWithQuantity(result[field]);
      }
    }

    // Convert nested Quantity + Items fields inside DefaultCacheBehavior
    if (result['DefaultCacheBehavior'] && typeof result['DefaultCacheBehavior'] === 'object') {
      result['DefaultCacheBehavior'] = this.convertCacheBehavior(
        result['DefaultCacheBehavior'] as Record<string, unknown>
      );
    }

    // Convert nested Quantity + Items fields inside each CacheBehavior.
    // Copy the wrapper first: when the input ALREADY carries { Quantity,
    // Items } (wrapWithQuantity returns it as-is), an in-place Items
    // reassignment would mutate the caller-owned object — same hazard the
    // Logging copy above closes.
    if (result['CacheBehaviors'] && typeof result['CacheBehaviors'] === 'object') {
      const cacheBehaviors = { ...(result['CacheBehaviors'] as Record<string, unknown>) };
      if (Array.isArray(cacheBehaviors['Items'])) {
        cacheBehaviors['Items'] = (cacheBehaviors['Items'] as Record<string, unknown>[]).map((cb) =>
          this.convertCacheBehavior(cb)
        );
      }
      result['CacheBehaviors'] = cacheBehaviors;
    }

    // Convert Origins items - nested Quantity + Items fields (e.g., CustomHeaders)
    if (result['Origins'] && typeof result['Origins'] === 'object') {
      const origins = { ...(result['Origins'] as Record<string, unknown>) };
      if (Array.isArray(origins['Items'])) {
        origins['Items'] = (origins['Items'] as Record<string, unknown>[]).map((origin) =>
          this.convertOrigin(origin)
        );
      }
      result['Origins'] = origins;
    }

    return result;
  }

  /**
   * Invert {@link convertToSdkFormat}: map an AWS-returned SDK-shape
   * `DistributionConfig` ({@link GetDistributionConfigCommand} output) back
   * into the CloudFormation `DistributionConfig` shape cdkd state stores.
   *
   * The inversion is the mirror image of the create / update conversion:
   * every `{ Quantity, Items }` wrapper becomes its bare `Items` array
   * (top-level list fields + the nested cache-behavior / origin fields),
   * and `CallerReference` is dropped (a create-time idempotency token CDK
   * never templates — see `getDriftUnknownPaths`).
   *
   * Lossiness note: the conversion is NOT perfectly lossless because
   * `convertToSdkFormat` injects SDK-required defaults the CFn template may
   * omit (`Comment: ''`, `Logging.{Enabled,IncludeCookies,Prefix}`,
   * `CustomOriginConfig.HTTP{,S}Port`). Those defaults are preserved on the
   * inverted side, which is correct for the drift comparator: the
   * deploy-time observed baseline (also produced by THIS method) carries the
   * same defaults, so they compare equal. They would only matter against the
   * `properties` fallback baseline (resources with no observedProperties),
   * where an AWS-injected default the template omitted is legitimately a
   * key cdkd never set — but the comparator's state-keys-only walk in that
   * mode never descends into a key absent from the template, so the extra
   * defaults cannot fire false drift there either.
   */
  private convertToCfnFormat(config: Record<string, unknown>): Record<string, unknown> {
    const result = { ...config };

    // Drop the create-time idempotency token (never templated by CDK).
    delete result['CallerReference'];

    // SDK -> CFn acronym-casing inversions (issue #1370). Without these the
    // drift comparator would diff the template's `AcmCertificateArn` /
    // `IPV6Enabled` against the API's `ACMCertificateArn` / `IsIPV6Enabled`
    // and report phantom drift on every read.
    for (const [cfnKey, sdkKey] of Object.entries(TOP_LEVEL_CFN_TO_SDK)) {
      if (result[sdkKey] !== undefined) {
        result[cfnKey] = result[sdkKey];
        delete result[sdkKey];
      }
    }
    if (result['ViewerCertificate'] && typeof result['ViewerCertificate'] === 'object') {
      const viewerCertificate = { ...(result['ViewerCertificate'] as Record<string, unknown>) };
      for (const [cfnKey, sdkKey] of Object.entries(VIEWER_CERTIFICATE_CFN_TO_SDK)) {
        if (viewerCertificate[sdkKey] !== undefined) {
          viewerCertificate[cfnKey] = viewerCertificate[sdkKey];
          delete viewerCertificate[sdkKey];
        }
      }
      result['ViewerCertificate'] = viewerCertificate;
    }

    // Invert the GeoRestriction shape conversion: SDK { RestrictionType,
    // Quantity, Items } back to the CFn { RestrictionType, Locations } form.
    if (result['Restrictions'] && typeof result['Restrictions'] === 'object') {
      const restrictions = { ...(result['Restrictions'] as Record<string, unknown>) };
      if (restrictions['GeoRestriction'] && typeof restrictions['GeoRestriction'] === 'object') {
        const geo = { ...(restrictions['GeoRestriction'] as Record<string, unknown>) };
        if (Array.isArray(geo['Items'])) {
          geo['Locations'] = geo['Items'];
          delete geo['Items'];
        }
        delete geo['Quantity'];
        restrictions['GeoRestriction'] = geo;
      }
      result['Restrictions'] = restrictions;
    }

    // Unwrap top-level Quantity + Items fields back to bare arrays.
    for (const field of QUANTITY_ITEM_FIELDS) {
      if (result[field] !== undefined) {
        result[field] = this.unwrapQuantity(result[field]);
      }
    }

    // Unwrap nested Quantity + Items inside DefaultCacheBehavior.
    if (result['DefaultCacheBehavior'] && typeof result['DefaultCacheBehavior'] === 'object') {
      result['DefaultCacheBehavior'] = this.revertCacheBehavior(
        result['DefaultCacheBehavior'] as Record<string, unknown>
      );
    }

    // Unwrap nested Quantity + Items inside each CacheBehavior (now a bare array).
    if (Array.isArray(result['CacheBehaviors'])) {
      result['CacheBehaviors'] = (result['CacheBehaviors'] as Record<string, unknown>[]).map((cb) =>
        this.revertCacheBehavior(cb)
      );
    }

    // Unwrap nested Quantity + Items inside each Origin (now a bare array).
    if (Array.isArray(result['Origins'])) {
      result['Origins'] = (result['Origins'] as Record<string, unknown>[]).map((origin) =>
        this.revertOrigin(origin)
      );
    }

    return result;
  }

  /**
   * Inverse of {@link wrapWithQuantity}: a `{ Quantity, Items }` object
   * becomes its bare `Items` array; anything else is returned unchanged.
   */
  private unwrapQuantity(value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (Array.isArray(obj['Items'])) {
        return obj['Items'];
      }
    }
    return value;
  }

  /**
   * Inverse of {@link convertCacheBehavior}: unwrap the Quantity + Items
   * fields nested inside a CacheBehavior back to bare arrays.
   */
  private revertCacheBehavior(behavior: Record<string, unknown>): Record<string, unknown> {
    const result = { ...behavior };

    // AWS nests `CachedMethods` INSIDE the `AllowedMethods` wrapper
    // ({ Quantity, Items, CachedMethods: { Quantity, Items } }), whereas the
    // CFn shape carries them as SIBLINGS (AllowedMethods + CachedMethods both
    // bare arrays — `convertToSdkFormat` only wraps the two CFn arrays
    // independently and never re-nests). Hoist CachedMethods back out to a
    // sibling before the generic unwrap so the inverted shape matches CFn and
    // a console-side CachedMethods change stays detectable.
    if (result['AllowedMethods'] && typeof result['AllowedMethods'] === 'object') {
      const allowed = result['AllowedMethods'] as Record<string, unknown>;
      if (allowed['CachedMethods'] !== undefined && result['CachedMethods'] === undefined) {
        result['CachedMethods'] = allowed['CachedMethods'];
        const allowedCopy = { ...allowed };
        delete allowedCopy['CachedMethods'];
        result['AllowedMethods'] = allowedCopy;
      }
    }

    for (const fieldPath of CACHE_BEHAVIOR_QUANTITY_FIELDS) {
      const parts = fieldPath.split('.');
      this.unwrapQuantityAtPath(result, parts);
    }

    return result;
  }

  /**
   * Inverse of {@link convertOrigin}: unwrap CustomHeaders and
   * CustomOriginConfig.OriginSslProtocols back to bare arrays.
   */
  private revertOrigin(origin: Record<string, unknown>): Record<string, unknown> {
    const result = { ...origin };

    if (result['CustomHeaders'] !== undefined) {
      // Unwrap AND restore the CFn spelling (`OriginCustomHeaders`) so the
      // drift comparator sees the template's key (issue #1373, same
      // pattern as `OriginSSLProtocols` below).
      result['OriginCustomHeaders'] = this.unwrapQuantity(result['CustomHeaders']);
      delete result['CustomHeaders'];
    }

    if (result['CustomOriginConfig'] && typeof result['CustomOriginConfig'] === 'object') {
      const customOriginConfig = { ...(result['CustomOriginConfig'] as Record<string, unknown>) };
      if (customOriginConfig['OriginSslProtocols'] !== undefined) {
        // Unwrap AND restore the CFn spelling (`OriginSSLProtocols`) so the
        // drift comparator sees the template's key (issue #1370).
        customOriginConfig['OriginSSLProtocols'] = this.unwrapQuantity(
          customOriginConfig['OriginSslProtocols']
        );
        delete customOriginConfig['OriginSslProtocols'];
      }
      result['CustomOriginConfig'] = customOriginConfig;
    }

    return result;
  }

  /**
   * Inverse of {@link applyQuantityAtPath}: unwrap a `{ Quantity, Items }`
   * value at a nested path (e.g. "ForwardedValues.Headers") back to a bare
   * array.
   */
  private unwrapQuantityAtPath(obj: Record<string, unknown>, path: string[]): void {
    if (path.length === 0) return;

    if (path.length === 1) {
      const key = path[0]!;
      if (obj[key] !== undefined) {
        obj[key] = this.unwrapQuantity(obj[key]);
      }
      return;
    }

    const [head, ...rest] = path;
    const headKey = head!;
    if (obj[headKey] && typeof obj[headKey] === 'object') {
      const nested = { ...(obj[headKey] as Record<string, unknown>) };
      obj[headKey] = nested;
      this.unwrapQuantityAtPath(nested, rest);
    }
  }

  /**
   * Wrap a value with the Quantity + Items pattern if needed.
   *
   * Handles three cases:
   * - Array: wrap as { Quantity: len, Items: array }
   * - Object with Items but no Quantity: add Quantity
   * - Already has Quantity: leave as-is
   */
  private wrapWithQuantity(value: unknown): unknown {
    if (Array.isArray(value)) {
      return { Quantity: value.length, Items: value };
    }

    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (Array.isArray(obj['Items']) && obj['Quantity'] === undefined) {
        return { ...obj, Quantity: (obj['Items'] as unknown[]).length };
      }
    }

    return value;
  }

  /**
   * Convert Quantity + Items fields nested inside a CacheBehavior.
   */
  private convertCacheBehavior(behavior: Record<string, unknown>): Record<string, unknown> {
    const result = { ...behavior };

    for (const fieldPath of CACHE_BEHAVIOR_QUANTITY_FIELDS) {
      const parts = fieldPath.split('.');
      this.applyQuantityAtPath(result, parts);
    }

    // The CFn shape carries `AllowedMethods` and `CachedMethods` as SIBLING
    // arrays; the SDK nests CachedMethods INSIDE the AllowedMethods wrapper
    // and has no top-level CachedMethods member — an un-nested sibling was
    // silently dropped by the serializer (issue #1370 shape class).
    // `revertCacheBehavior` has always hoisted it back OUT for drift reads;
    // this is the missing forward direction.
    if (result['CachedMethods'] !== undefined) {
      // CachedMethods with NO AllowedMethods sibling is legal CFn
      // (AllowedMethods defaults to GET, HEAD) — synthesize the default
      // wrapper so the nested value still reaches the SDK.
      const allowedMethods: Record<string, unknown> =
        result['AllowedMethods'] && typeof result['AllowedMethods'] === 'object'
          ? { ...(result['AllowedMethods'] as Record<string, unknown>) }
          : { Quantity: 2, Items: ['GET', 'HEAD'] };
      allowedMethods['CachedMethods'] = result['CachedMethods'];
      result['AllowedMethods'] = allowedMethods;
      delete result['CachedMethods'];
    }

    return result;
  }

  /**
   * Convert nested Quantity + Items fields inside an Origin.
   * Handles CustomHeaders and S3OriginConfig/CustomOriginConfig nested fields.
   */
  private convertOrigin(origin: Record<string, unknown>): Record<string, unknown> {
    const result = { ...origin };

    // The CFn template spelling is `OriginCustomHeaders` (a bare
    // `{HeaderName, HeaderValue}[]`); the SDK member is `CustomHeaders`
    // (issue #1373 nested-key critic catch — before this rename a
    // template's origin custom headers never reached AWS, and the update
    // path's required-field fill actively wiped them with an empty
    // `{Quantity: 0}` wrapper). Rename BEFORE the wrap below.
    if (result['OriginCustomHeaders'] !== undefined) {
      result['CustomHeaders'] = result['OriginCustomHeaders'];
      delete result['OriginCustomHeaders'];
    }

    // CustomHeaders uses the Quantity + Items pattern
    if (result['CustomHeaders'] !== undefined) {
      result['CustomHeaders'] = this.wrapWithQuantity(result['CustomHeaders']);
    }

    // S3OriginConfig does not need Quantity wrapping (it's a simple object)
    // CustomOriginConfig.OriginSslProtocols uses Quantity + Items
    if (result['CustomOriginConfig'] && typeof result['CustomOriginConfig'] === 'object') {
      const customOriginConfig = { ...(result['CustomOriginConfig'] as Record<string, unknown>) };
      // The CFn template spelling is `OriginSSLProtocols` (capital SSL);
      // the SDK member is `OriginSslProtocols` (issue #1370 casing class —
      // before this rename the wrap below could never match a real
      // template and the protocol list was silently dropped).
      if (customOriginConfig['OriginSSLProtocols'] !== undefined) {
        customOriginConfig['OriginSslProtocols'] = customOriginConfig['OriginSSLProtocols'];
        delete customOriginConfig['OriginSSLProtocols'];
      }
      if (customOriginConfig['OriginSslProtocols'] !== undefined) {
        customOriginConfig['OriginSslProtocols'] = this.wrapWithQuantity(
          customOriginConfig['OriginSslProtocols']
        );
      }
      // Ensure HTTPPort and HTTPSPort have defaults (SDK requires non-null values)
      if (customOriginConfig['HTTPPort'] === null || customOriginConfig['HTTPPort'] === undefined) {
        customOriginConfig['HTTPPort'] = 80;
      }
      if (
        customOriginConfig['HTTPSPort'] === null ||
        customOriginConfig['HTTPSPort'] === undefined
      ) {
        customOriginConfig['HTTPSPort'] = 443;
      }
      result['CustomOriginConfig'] = customOriginConfig;
    }

    return result;
  }

  /**
   * Apply Quantity wrapping at a nested path (e.g., "ForwardedValues.Headers").
   */
  private applyQuantityAtPath(obj: Record<string, unknown>, path: string[]): void {
    if (path.length === 0) return;

    if (path.length === 1) {
      const key = path[0]!;
      if (obj[key] !== undefined) {
        obj[key] = this.wrapWithQuantity(obj[key]);
      }
      return;
    }

    const [head, ...rest] = path;
    const headKey = head!;
    if (obj[headKey] && typeof obj[headKey] === 'object') {
      // Shallow copy the nested object to avoid mutating the original
      const nested = { ...(obj[headKey] as Record<string, unknown>) };
      obj[headKey] = nested;
      this.applyQuantityAtPath(nested, rest);
    }
  }

  /**
   * Convert CFn `Tags: [{ Key, Value }]` to the CloudFront SDK's `Tag[]`
   * shape (which happens to be the same `{ Key, Value }` per-entry shape),
   * dropping entries missing a Key and normalizing missing-Value to `''`
   * (matching `tagsArrayToMap`'s shape so the create-path and update-diff-
   * path agree on what counts as "the same tag"). Returns `undefined`
   * when the input is absent or empty so the caller can route to
   * `CreateDistributionCommand` instead of `CreateDistributionWithTagsCommand`
   * — passing an empty `Tags.Items: []` to the latter is a silent no-op
   * but uses the tags-enabled control-plane path for nothing.
   */
  private toSdkTags(value: unknown): Tag[] | undefined {
    const map = this.tagsArrayToMap(value);
    if (map.size === 0) return undefined;
    return [...map.entries()].map(([Key, Value]) => ({ Key, Value }));
  }

  /**
   * Compute the (removed-keys, upserted-tags) diff between two CFn `Tags`
   * snapshots. Pure function — does NOT touch AWS, so the caller can
   * decide on the basis of the result whether the ARN is actually needed
   * (no diff = no ARN required).
   */
  private computeTagDiff(
    previousTags: unknown,
    newTags: unknown
  ): { removed: string[]; upserts: Tag[] } {
    const prev = this.tagsArrayToMap(previousTags);
    const next = this.tagsArrayToMap(newTags);

    const removed = [...prev.keys()].filter((k) => !next.has(k));
    const upserts: Tag[] = [];
    for (const [k, v] of next.entries()) {
      if (prev.get(k) !== v) upserts.push({ Key: k, Value: v });
    }
    return { removed, upserts };
  }

  /**
   * Apply a tag diff to a distribution.
   *
   * CloudFront has no atomic overlay API for tags — `TagResource` adds /
   * overwrites and `UntagResource` removes. Run the removal first, then
   * the upsert, so a same-key value rewrite (which lands in `upserts`)
   * is not accidentally cleared by a stale Untag.
   *
   * Errors are RETHROWN as `ProvisioningError` (issue #740 fix) so the
   * deploy engine sees a failed update() and (a) does NOT write the new
   * properties.Tags into state — the next deploy retries the tag-diff
   * against the still-old state, (b) surfaces the failure to the user
   * via the standard error path. The deploy engine's `withRetry` MAY
   * pick up some transient AWS errors via the cause-message-pattern
   * match (`retryable-errors.ts`'s `RETRYABLE_ERROR_MESSAGE_PATTERNS`),
   * but bare HTTP 429 throttles wrapped by update()'s outer catch reach
   * the classifier two levels deep and slip past its single-level
   * `.cause` walk — so the **load-bearing retry guarantee is the
   * next-deploy retry**, not in-deploy retry. This is acceptable: the
   * user sees the failure, can react, and the next `cdkd deploy`
   * re-fires the tag-diff against the still-old state cleanly.
   *
   * Trade-off: a tag-side failure flips an otherwise-successful
   * `UpdateDistribution` into a deploy failure, and the retry will
   * re-issue UpdateDistribution against the (now-current) config —
   * AWS accepts the no-op idempotently. The cost of that secondary
   * noise is much lower than the cost of silent tag drift the pre-#740
   * swallow caused.
   *
   * The ARN is unexpectedly absent only on a hypothetical SDK regression
   * (`GetDistribution` returns ARN as a required string in every SDK
   * shape verified so far). When that happens AND a tag delta exists,
   * THROW so the silent-drop does not silently resurface; when no delta
   * exists, return without needing ARN.
   */
  private async applyTagDiff(
    arn: string | undefined,
    previousTags: unknown,
    newTags: unknown,
    physicalId: string,
    logicalId: string,
    resourceType: string
  ): Promise<void> {
    const { removed, upserts } = this.computeTagDiff(previousTags, newTags);
    if (removed.length === 0 && upserts.length === 0) return;

    if (!arn) {
      throw new ProvisioningError(
        `CloudFront Distribution ${physicalId}: GetDistribution returned no ARN; ` +
          `cannot apply tag diff (removed=${removed.length}, upserts=${upserts.length}). ` +
          `Refusing to silently drop the tag update — retry on next deploy or check SDK version.`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      if (removed.length > 0) {
        this.logger.debug(`Untagging CloudFront Distribution ${arn}: ${removed.join(', ')}`);
        await this.cloudFrontClient.send(
          new UntagResourceCommand({
            Resource: arn,
            TagKeys: { Items: removed },
          })
        );
      }
      if (upserts.length > 0) {
        this.logger.debug(
          `Tagging CloudFront Distribution ${arn}: ${upserts.map((t) => t.Key).join(', ')}`
        );
        await this.cloudFrontClient.send(
          new TagResourceCommand({
            Resource: arn,
            Tags: { Items: upserts },
          })
        );
      }
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw new ProvisioningError(
        `CloudFront Distribution ${physicalId}: tag diff failed (removed=${removed.length}, ` +
          `upserts=${upserts.length}): ${err instanceof Error ? err.message : String(err)}. ` +
          `UpdateDistribution succeeded but TagResource/UntagResource did not — state has NOT been updated so the next deploy will retry the tag-diff.`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Convert a CFn `Tags: [{ Key, Value }]` array to a plain map. Entries
   * missing a `Key` are dropped; a missing `Value` becomes `''` so the
   * diff treats `{ Key: 'k' }` and `{ Key: 'k', Value: '' }` the same.
   */
  private tagsArrayToMap(value: unknown): Map<string, string> {
    const map = new Map<string, string>();
    if (!Array.isArray(value)) return map;
    for (const entry of value as Array<Record<string, unknown>>) {
      const key = entry['Key'];
      if (typeof key !== 'string') continue;
      const val = entry['Value'];
      map.set(key, typeof val === 'string' ? val : '');
    }
    return map;
  }

  /**
   * Adopt an existing CloudFront distribution into cdkd state.
   *
   * CloudFront distributions don't carry a template-supplied name
   * (physical id is the AWS-generated `E...` distribution id), so the
   * lookup is explicit-override only.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        await this.cloudFrontClient.send(new GetDistributionCommand({ Id: input.knownPhysicalId }));
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof NoSuchDistribution) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a
    // distribution reaching here needs an explicit `--resource` override.
    return null;
  }
}
