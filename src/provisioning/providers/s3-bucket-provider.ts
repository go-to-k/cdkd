/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutBucketTaggingCommand,
  DeleteBucketTaggingCommand,
  PutBucketOwnershipControlsCommand,
  DeleteBucketOwnershipControlsCommand,
  GetBucketOwnershipControlsCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketCorsCommand,
  DeleteBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  DeleteBucketEncryptionCommand,
  PutBucketLoggingCommand,
  PutBucketWebsiteCommand,
  DeleteBucketWebsiteCommand,
  PutBucketAccelerateConfigurationCommand,
  PutBucketMetricsConfigurationCommand,
  DeleteBucketMetricsConfigurationCommand,
  PutBucketAnalyticsConfigurationCommand,
  DeleteBucketAnalyticsConfigurationCommand,
  PutBucketIntelligentTieringConfigurationCommand,
  DeleteBucketIntelligentTieringConfigurationCommand,
  PutBucketInventoryConfigurationCommand,
  DeleteBucketInventoryConfigurationCommand,
  PutBucketReplicationCommand,
  DeleteBucketReplicationCommand,
  PutObjectLockConfigurationCommand,
  GetBucketEncryptionCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketCorsCommand,
  GetBucketWebsiteCommand,
  GetBucketLoggingCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketReplicationCommand,
  GetObjectLockConfigurationCommand,
  GetBucketAccelerateConfigurationCommand,
  ListBucketMetricsConfigurationsCommand,
  ListBucketAnalyticsConfigurationsCommand,
  ListBucketIntelligentTieringConfigurationsCommand,
  ListBucketInventoryConfigurationsCommand,
  NoSuchBucket,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  type BucketLocationConstraint,
  type ObjectOwnership,
  type CORSRule,
} from '@aws-sdk/client-s3';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { S3_AUTO_DELETE_OBJECTS_TAG, hasCdkAutoDeleteTag } from '../data-delete-intent.js';
import {
  readConfigString,
  replayWarn,
  requireConfigArray,
  requireConfigObject,
  requireConfigString,
} from '../config-shape.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
} from '../../types/resource.js';

/**
 * A plain (non-array) object. `typeof x === 'object'` alone accepts arrays and
 * `null`; a `Transition: []` or an unresolved intrinsic pushed through as a
 * single transition entry makes S3 answer `MalformedXML` for the WHOLE
 * lifecycle configuration, so the legacy singular readers screen with this.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this `Destination` block written in the CFn FLATTENED form
 * (`{ BucketArn, Format, ... }`) rather than the SDK NESTED one
 * (`{ S3BucketDestination: { ... } }`)?
 *
 * ONE predicate, called from both `resolveS3BucketDestination` (which picks the
 * bag) and `s3BucketDestinationPath` (which names it). They were written out
 * twice and a reviewer rightly pointed out that two copies of a branch
 * condition must be edited together or a refusal starts naming the wrong key.
 *
 * `Bucket` is probed alongside `BucketArn` because the readers accept it
 * (`s3Dest['BucketArn'] ?? s3Dest['Bucket']`); omitting it made a
 * `{ Bucket }`-only block take the nested branch, find nothing, and drop — the
 * same silent drop one shape over.
 */
function isFlattenedDestination(dest: Record<string, unknown>): boolean {
  return Boolean(dest['BucketArn'] || dest['Bucket'] || dest['BucketAccountId'] || dest['Format']);
}

/**
 * The CFn path of the destination bag `resolveS3BucketDestination` will pick —
 * issue #1493 item 3, which is a MESSAGE concern, not a value one.
 *
 * Kept separate from the resolver rather than returned alongside the bag:
 * `gen-nested-key-coverage`'s write-evidence walk follows a plain
 * `const x = this.helper(...)` binding to the members written beneath it, and
 * a DESTRUCTURED `const { bag, path } = ...` is a shape it cannot follow — so
 * pairing the two silently withdrew the write evidence for
 * `Destination.BucketArn` / `.BucketAccountId` and turned an opted-in target
 * red with no behavior change at all. Measured against the pre-change provider
 * via the critic's `--providers-dir=` seam.
 */
function s3BucketDestinationPath(dest: unknown, destinationPath: string): string {
  return isPlainObject(dest) && isFlattenedDestination(dest)
    ? destinationPath
    : `${destinationPath}.S3BucketDestination`;
}

/**
 * Name a malformed value in a refusal message, the way `config-shape.ts`'s
 * private `describe` does for the string-reading guards. Kept local rather than
 * exported from there because `resolveS3BucketDestination` is S3-specific
 * branch selection, not a shared shape guard — the two only share the wording.
 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `a string ${JSON.stringify(value)}`;
  if (isPlainObject(value)) return `an object with keys [${Object.keys(value).join(', ')}]`;
  return `a ${typeof value} (${String(value)})`;
}

/**
 * Coerce a CFn numeric to a finite number. CloudFormation is stringly typed —
 * a hand-written or imported template (the audience the legacy lifecycle
 * branches exist for) can carry `"365"` where the schema says number.
 */
function coerceCfnNumber(value: unknown): number | undefined {
  // Screen the TYPE first: `Number([])` is 0 and `Number([5])` is 5, so an
  // unresolved-intrinsic array would coerce to a plausible-looking day count.
  // That is the same class `isPlainObject` blocks on the object path.
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Merge a legacy SINGULAR action object into its modern plural array.
 *
 * S3 rejects two transitions with the same `StorageClass` and fails the whole
 * `PutBucketLifecycleConfiguration`, so a blind concatenation is unsafe. But
 * dropping the singular wholesale loses a legitimate template: a plural
 * `[{GLACIER, 30}]` alongside a singular `{DEEP_ARCHIVE, 90}` is two different
 * classes, which S3 accepts. So: keep both, let the PLURAL win on a
 * StorageClass collision, and say so rather than dropping in silence.
 */
function mergeLegacySingular(
  plural: unknown,
  singular: unknown,
  onCollision: (storageClass: string) => void
): Array<Record<string, unknown>> {
  const out = (Array.isArray(plural) ? plural : []).filter(isPlainObject);
  if (!isPlainObject(singular)) return out;
  const sc = singular['StorageClass'];
  if (typeof sc === 'string' && out.some((e) => e['StorageClass'] === sc)) {
    onCollision(sc);
    return out;
  }
  return [...out, singular];
}

/** Coerce a CFn boolean, which may arrive as the string `"true"` / `"false"`. */
function coerceCfnBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  // Case-insensitive on purpose. CDK renders lowercase, but this also feeds
  // `NotificationConfiguration.EventBridgeConfiguration` (issue #1430), where
  // "not false" means "enable" — so a hand-written / imported `'False'` that
  // fell through to `undefined` would silently ENABLE EventBridge delivery,
  // the exact inversion #1430 fixed.
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  return undefined;
}

/**
 * SDK Provider for AWS::S3::Bucket
 *
 * Uses S3 SDK directly instead of CC API for synchronous bucket creation.
 * S3's CreateBucket is synchronous - no polling needed, unlike CC API which
 * requires async polling (1s→1.5s→2.25s...) adding seconds per resource.
 */
export class S3BucketProvider implements ResourceProvider {
  private s3Client: S3Client;
  private logger = getLogger().child('S3BucketProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::S3::Bucket',
      new Set([
        'BucketName',
        'VersioningConfiguration',
        'Tags',
        'OwnershipControls',
        'NotificationConfiguration',
        'CorsConfiguration',
        'LifecycleConfiguration',
        'PublicAccessBlockConfiguration',
        'BucketEncryption',
        'LoggingConfiguration',
        'WebsiteConfiguration',
        'AccelerateConfiguration',
        'MetricsConfigurations',
        'AnalyticsConfigurations',
        'IntelligentTieringConfigurations',
        'InventoryConfigurations',
        'ReplicationConfiguration',
        'ObjectLockConfiguration',
        'ObjectLockEnabled',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::S3::Bucket',
      new Map<string, string>([
        [
          'AccessControl',
          'Legacy canned ACL; AWS disables ACLs by default since 2023-04 — use BucketOwnershipControls + BucketPolicy / PublicAccessBlockConfiguration instead',
        ],
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
  }

  /**
   * Get the region from the S3 client config
   */
  private async getRegion(): Promise<string> {
    const region = await this.s3Client.config.region();
    return region || 'us-east-1';
  }

  /**
   * Build attributes for an S3 bucket.
   *
   * Covers every CloudFormation `Fn::GetAtt` return value for
   * `AWS::S3::Bucket`. All fields are derivable from `bucketName` + region —
   * no extra AWS API call is needed. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html#aws-properties-s3-bucket-return-values
   */
  private async buildAttributes(bucketName: string): Promise<Record<string, unknown>> {
    const region = await this.getRegion();
    return {
      Arn: `arn:aws:s3:::${bucketName}`,
      DomainName: `${bucketName}.s3.amazonaws.com`,
      DualStackDomainName: `${bucketName}.s3.dualstack.${region}.amazonaws.com`,
      RegionalDomainName: `${bucketName}.s3.${region}.amazonaws.com`,
      WebsiteURL: `http://${bucketName}.s3-website-${region}.amazonaws.com`,
    };
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing bucket.
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references. All S3 Bucket attributes are
   * derivable from bucket name + region, so this avoids the round trip and
   * reuses the same templating as `buildAttributes`.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    const attrs = await this.buildAttributes(physicalId);
    return attrs[attributeName];
  }

  /**
   * Apply versioning configuration if specified
   */
  private async applyVersioning(bucketName: string, versioningConfig: unknown): Promise<void> {
    // `unknown`, not `Record<string, unknown>`: the CREATE path's truthiness
    // gate lets a malformed value (`VersioningConfiguration: 'Enabled'`) reach
    // here, and defaulting its missing `Status` to Suspended is exactly the
    // silent versioning-OFF of issue #1471. Refuse instead.
    const status = readConfigString(
      versioningConfig,
      'Status',
      'Suspended',
      'AWS::S3::Bucket VersioningConfiguration'
    );
    await this.s3Client.send(
      new PutBucketVersioningCommand({
        Bucket: bucketName,
        VersioningConfiguration: {
          Status: status as 'Enabled' | 'Suspended',
        },
      })
    );
    this.logger.debug(`Applied versioning (${status}) to bucket ${bucketName}`);
  }

  /**
   * Apply tags if specified
   */
  private async applyTags(
    bucketName: string,
    tags: Array<{ Key: string; Value: string }>
  ): Promise<void> {
    await this.s3Client.send(
      new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: {
          TagSet: tags,
        },
      })
    );
    this.logger.debug(`Applied ${tags.length} tags to bucket ${bucketName}`);
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via S3's
   * `PutBucketTagging` (full-replace) / `DeleteBucketTagging` APIs.
   *
   * S3's `PutBucketTagging` replaces the entire tag set in one call, so we
   * don't need separate add/remove API operations. When the new set is
   * empty, we issue `DeleteBucketTagging` to clear it. When old and new
   * are equal, we skip the call entirely.
   */
  private async applyTagDiff(
    bucketName: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const normalize = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Array<{ Key: string; Value: string }> => {
      const out: Array<{ Key: string; Value: string }> = [];
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) out.push({ Key: t.Key, Value: t.Value });
      }
      return out;
    };

    const oldNorm = normalize(oldTagsRaw);
    const newNorm = normalize(newTagsRaw);
    if (JSON.stringify(oldNorm) === JSON.stringify(newNorm)) return;

    if (newNorm.length === 0) {
      // Clear tags. Use PutBucketTaggingCommand with empty TagSet — S3
      // does not have a public `DeleteBucketTagging` parity for the SDK
      // we use, so emit an empty Tagging set instead.
      try {
        await this.s3Client.send(
          new DeleteBucketTaggingCommand({
            Bucket: bucketName,
          })
        );
        this.logger.debug(`Cleared tags from bucket ${bucketName}`);
      } catch (err) {
        // Some S3 API versions reject empty TagSet on Put; fall back to
        // re-Put. The `NoSuchTagSet` (already-empty) response is fine.
        const e = err as { name?: string };
        if (e.name === 'NoSuchTagSet') return;
        throw err;
      }
      return;
    }
    await this.s3Client.send(
      new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: { TagSet: newNorm },
      })
    );
    this.logger.debug(`Replaced tag set on bucket ${bucketName} (${newNorm.length} tags)`);
  }

  /**
   * Apply CORS configuration
   *
   * CFn property: CorsConfiguration.CorsRules[]
   * SDK: PutBucketCors with CORSConfiguration.CORSRules[]
   *
   * CFn CorsRule fields map to SDK CORSRule fields:
   * - AllowedHeaders, AllowedMethods, AllowedOrigins, ExposedHeaders, MaxAge
   * SDK uses the same names except ExposedHeaders -> ExposeHeaders, MaxAge -> MaxAgeSeconds
   */
  private async applyCorsConfiguration(
    bucketName: string,
    corsConfig: { CorsRules: Array<Record<string, unknown>> }
  ): Promise<void> {
    const corsRules: CORSRule[] = corsConfig.CorsRules.map((rule) => ({
      ID: rule['Id'] as string | undefined,
      AllowedHeaders: rule['AllowedHeaders'] as string[] | undefined,
      AllowedMethods: rule['AllowedMethods'] as string[],
      AllowedOrigins: rule['AllowedOrigins'] as string[],
      ExposeHeaders: rule['ExposedHeaders'] as string[] | undefined,
      MaxAgeSeconds: rule['MaxAge'] as number | undefined,
    }));
    await this.s3Client.send(
      new PutBucketCorsCommand({
        Bucket: bucketName,
        CORSConfiguration: {
          CORSRules: corsRules,
        },
      })
    );
    this.logger.debug(`Applied CORS configuration to bucket ${bucketName}`);
  }

  /**
   * Apply lifecycle configuration
   *
   * CFn property: LifecycleConfiguration.Rules[]
   * SDK: PutBucketLifecycleConfiguration with LifecycleConfiguration.Rules[]
   *
   * CFn and SDK use the same structure with minor differences:
   * - CFn uses TagFilters, SDK uses Tag/Tags in Filter
   * - CFn Transition.TransitionInDays -> SDK Transition.Days
   * - CFn Transition.TransitionDate -> SDK Transition.Date
   */
  private async applyLifecycleConfiguration(
    bucketName: string,
    lifecycleConfig: {
      Rules: Array<Record<string, unknown>>;
      TransitionDefaultMinimumObjectSize?: unknown;
    },
    onUnusable?: (message: string) => void
  ): Promise<void> {
    // Validate every rule's `TagFilters` container up front (issue #1579): a
    // present-but-non-array value used to fall through `gatherScope`'s blind
    // cast, read as "no tags" via the `.length` gates below, and the rule
    // applied WITHOUT its tag scope — for an expiration rule, to the WHOLE
    // bucket (the #1388 widened-scope hazard, this time from a malformed
    // container instead of a mis-placed key). Refuse on a template-path
    // create; on the state-replay paths (`onUnusable`) warn and leave the
    // WHOLE live lifecycle configuration alone — the Put replaces every rule,
    // so skipping only the malformed rule would silently DELETE it from AWS.
    for (const rule of lifecycleConfig.Rules) {
      // ...and the `Filter` CONTAINER those TagFilters live in, one level up
      // (issue #1581). A present-but-non-OBJECT `Filter` (`Filter: 'logs/'`,
      // an array, an unresolved intrinsic) indexes EVERY member probe in
      // `gatherScope` — Prefix / TagFilters / ObjectSizeGreaterThan /
      // ObjectSizeLessThan — to `undefined`, so the rule kept NO scope at all
      // and fell through to the empty-prefix V2 `Filter` below, applying to
      // the WHOLE bucket. For an expiration rule that deletes objects the rule
      // was never meant to touch: the same #1388 widened-scope hazard as the
      // TagFilters guard, reached through the parent container instead. Same
      // refusal split, and the same whole-Put skip unit for the same reason.
      const rawFilter = rule['Filter'];
      if (
        rawFilter != null &&
        requireConfigObject(rawFilter, 'AWS::S3::Bucket LifecycleConfiguration.Rules[].Filter', {
          ...(onUnusable ? { onUnusable } : {}),
        }) === undefined
      ) {
        return;
      }
      const filter = rawFilter as Record<string, unknown> | undefined;
      const rawTagFilters = filter?.['TagFilters'] ?? rule['TagFilters'];
      if (rawTagFilters != null) {
        const validated = requireConfigArray(
          rawTagFilters,
          'AWS::S3::Bucket LifecycleConfiguration.Rules[].TagFilters',
          { ...(onUnusable ? { onUnusable } : {}) }
        );
        if (validated === undefined) return;
      }
    }
    // Gather a rule's full location scope from EVERY source CFn can express it:
    // an explicit `Filter` object (Prefix / TagFilters / ObjectSizeGreaterThan /
    // ObjectSizeLessThan), a top-level `Prefix` (the deprecated V1 form), AND the
    // top-level `ObjectSizeGreaterThan` / `ObjectSizeLessThan` rule properties —
    // which is the shape CDK's `LifecycleRule.objectSizeGreaterThan` actually
    // synthesizes (NOT nested under Filter). Reading only `Filter.*` silently
    // dropped those top-level size constraints.
    const gatherScope = (
      rule: Record<string, unknown>
    ): {
      prefix: string | undefined;
      tagFilters: Array<{ Key: string; Value: string }> | undefined;
      sizeGt: number | undefined;
      sizeLt: number | undefined;
    } => {
      const filter = rule['Filter'] as Record<string, unknown> | undefined;
      return {
        prefix: (filter?.['Prefix'] ?? rule['Prefix']) as string | undefined,
        // `TagFilters` lives at the RULE level in the CFn schema — there is no
        // `Filter` member on `AWS::S3::Bucket`'s lifecycle Rule at all, and a
        // real `cdk synth` of `LifecycleRule.tagFilters` emits it there (the
        // `Filter` read is cdkd's own accommodation for SDK-shaped / imported
        // input). Reading ONLY `Filter.TagFilters` dropped the tag scope, so a
        // tag-scoped rule fell through to the empty-prefix Filter below and
        // applied to the WHOLE bucket — for an expiration rule, that deletes
        // objects the rule was never meant to touch (issue #1388).
        tagFilters: (filter?.['TagFilters'] ?? rule['TagFilters']) as
          | Array<{ Key: string; Value: string }>
          | undefined,
        sizeGt: (filter?.['ObjectSizeGreaterThan'] ?? rule['ObjectSizeGreaterThan']) as
          | number
          | undefined,
        sizeLt: (filter?.['ObjectSizeLessThan'] ?? rule['ObjectSizeLessThan']) as
          | number
          | undefined,
      };
    };

    // S3 forbids mixing V1 (a top-level `Prefix` on the rule) and V2 (a `Filter`
    // element) rules within a SINGLE lifecycle configuration — `PutBucketLifecycle-
    // Configuration` rejects it with "Filter element can only be used in Lifecycle
    // V2." CloudFormation normalizes this transparently. Decide the form ONCE for
    // the whole config: a rule can stay V1 ONLY if its scope is EXACTLY a single
    // top-level `Prefix` (no tags, no size constraint, no explicit `Filter`). If
    // ANY rule needs a Filter (tags / size / explicit Filter / no scope at all),
    // emit EVERY rule in V2 Filter form (a bare top-level `Prefix` becomes
    // `Filter: { Prefix }`).
    const isPlainPrefixOnly = (rule: Record<string, unknown>): boolean => {
      // `!= null`, not `!== undefined`: the container guard above treats an
      // explicit `Filter: null` as ABSENT (nothing to refuse), so the strict
      // compare read the same value as PRESENT here and forced every rule in
      // the configuration into V2 Filter form. Aligning the two makes `null`
      // mean "block omitted" throughout the function, matching what the
      // sibling `TagFilters` reads already do.
      if (rule['Filter'] != null) return false;
      const s = gatherScope(rule);
      return (
        s.prefix !== undefined &&
        // `== null`, not `=== undefined`: an explicit `TagFilters: null` is
        // "no entries" per the list-block contract (`requireConfigArray`'s
        // callers keep the absent case as `== null`), and the strict compare
        // sent `null` into `.length` — a raw TypeError (PR #1580 review).
        (s.tagFilters == null || s.tagFilters.length === 0) &&
        s.sizeGt === undefined &&
        s.sizeLt === undefined
      );
    };
    const useFilterForm = !lifecycleConfig.Rules.every(isPlainPrefixOnly);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = lifecycleConfig.Rules.map((rule): any => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdkRule: any = {
        ID: rule['Id'] as string | undefined,
        Status: readConfigString(
          rule,
          'Status',
          'Enabled',
          'AWS::S3::Bucket LifecycleConfiguration.Rules[]'
        ),
        // In V2-Filter form the location scope lives under `Filter` (set below);
        // a top-level `Prefix` alongside a `Filter` is exactly the illegal mix.
        Prefix: useFilterForm ? undefined : (rule['Prefix'] as string | undefined),
      };

      // Expiration
      const expiration = rule['ExpirationInDays'] || rule['ExpirationDate'] || rule['Expiration'];
      if (typeof expiration === 'number') {
        sdkRule.Expiration = { Days: expiration };
      } else if (typeof expiration === 'string') {
        sdkRule.Expiration = { Date: new Date(expiration) };
      } else if (expiration && typeof expiration === 'object') {
        const exp = expiration as Record<string, unknown>;
        sdkRule.Expiration = {
          Days: exp['Days'] as number | undefined,
          Date: exp['Date'] ? new Date(exp['Date'] as string) : undefined,
          ExpiredObjectDeleteMarker: exp['ExpiredObjectDeleteMarker'] as boolean | undefined,
        };
      }
      // `ExpiredObjectDeleteMarker` is a RULE-level CFn property (it is what
      // `LifecycleRule.expiredObjectDeleteMarker` synthesizes), not a member of
      // a nested `Expiration` object. Read only from the nested form, a rule
      // whose ONLY action is the delete-marker cleanup produced no `Expiration`
      // at all and S3 rejects the action-less rule (issue #1388). S3 forbids
      // combining it with Days / Date, so it only fills an empty Expiration.
      // Gate on whether the built `Expiration` actually carries a Days / Date
      // rather than on its mere existence: the nested branch above emits an
      // object with every member `undefined` for an empty / unresolved
      // `Expiration`, so an existence check would drop the marker AND leave the
      // rule action-less — the exact failure this block exists to prevent.
      // Only TRUE engages. `false` is a legal synth (CDK's own validation is
      // truthy-gated), and treating it as a request would both warn about a
      // cleanup nobody asked for and, on a marker-only rule, emit
      // `Expiration: { ExpiredObjectDeleteMarker: false }` — action-less again.
      const ruleLevelDeleteMarker = coerceCfnBoolean(rule['ExpiredObjectDeleteMarker']);
      if (ruleLevelDeleteMarker === true) {
        const exp = sdkRule.Expiration as Record<string, unknown> | undefined;
        const hasDaysOrDate = exp?.['Days'] !== undefined || exp?.['Date'] !== undefined;
        if (!hasDaysOrDate) {
          sdkRule.Expiration = { ExpiredObjectDeleteMarker: true };
        } else {
          // S3 rejects ExpiredObjectDeleteMarker combined with Days / Date, so
          // one of the two has to go. Warn instead of dropping in silence.
          this.logger.warn(
            `Lifecycle rule '${(rule['Id'] as string) ?? '<unnamed>'}' on ${bucketName} sets ` +
              `ExpiredObjectDeleteMarker alongside an expiration Days/Date; S3 forbids ` +
              `combining them, so the delete-marker cleanup was not applied.`
          );
        }
      }

      // NoncurrentVersionExpiration. The CFn schema ALSO still accepts the
      // legacy scalar `NoncurrentVersionExpirationInDays` alongside the modern
      // object form; the object wins when both are present (issue #1388).
      const nve = isPlainObject(rule['NoncurrentVersionExpiration'])
        ? rule['NoncurrentVersionExpiration']
        : undefined;
      const legacyNveDays = rule['NoncurrentVersionExpirationInDays'];
      if (nve) {
        sdkRule.NoncurrentVersionExpiration = {
          NoncurrentDays: nve['NoncurrentDays'] as number | undefined,
          NewerNoncurrentVersions: nve['NewerNoncurrentVersions'] as number | undefined,
        };
      } else if (coerceCfnNumber(legacyNveDays) !== undefined) {
        // Coerced, not `typeof === 'number'`: CFn is stringly typed and this
        // branch exists specifically for hand-written / imported templates,
        // which is exactly where `"365"` shows up.
        sdkRule.NoncurrentVersionExpiration = { NoncurrentDays: coerceCfnNumber(legacyNveDays) };
      }

      // NoncurrentVersionTransitions, plus the legacy singular
      // `NoncurrentVersionTransition` object the CFn schema still accepts.
      // Both may appear on one rule; they are MERGED, with the plural winning
      // on a StorageClass collision (see `mergeLegacySingular`).
      const toSdkNvt = (nvt: Record<string, unknown>): Record<string, unknown> => ({
        // CFn spells the day count `TransitionInDays` on BOTH the singular
        // `NoncurrentVersionTransition` and the plural
        // `NoncurrentVersionTransitions[]`; the SDK member is `NoncurrentDays`.
        // Reading only the SDK spelling meant the day count was `undefined` for
        // every real template, so a CDK `noncurrentVersionTransitions` lost its
        // schedule. The `?? nvt['NoncurrentDays']` fallback keeps SDK-shaped /
        // imported input working, exactly as the `Transitions` mapping below
        // already does with `TransitionInDays ?? Days` (issue #1388).
        NoncurrentDays: (nvt['TransitionInDays'] ?? nvt['NoncurrentDays']) as number | undefined,
        StorageClass: nvt['StorageClass'] as string | undefined,
        NewerNoncurrentVersions: nvt['NewerNoncurrentVersions'] as number | undefined,
      });
      const nvts = rule['NoncurrentVersionTransitions'] as
        | Array<Record<string, unknown>>
        | undefined;
      const singularNvt = rule['NoncurrentVersionTransition'] as
        | Record<string, unknown>
        | undefined;
      const allNvts = mergeLegacySingular(nvts, singularNvt, (sc) =>
        this.logger.warn(
          `Lifecycle rule '${(rule['Id'] as string) ?? '<unnamed>'}' on ${bucketName} declares ` +
            `both NoncurrentVersionTransitions and the legacy NoncurrentVersionTransition for ` +
            `storage class ${sc}; S3 rejects duplicates, so the legacy singular was ignored.`
        )
      );
      if (allNvts.length > 0) {
        sdkRule.NoncurrentVersionTransitions = allNvts.map(toSdkNvt);
      }

      // Transitions, plus the legacy singular `Transition` object. Same merge
      // rule as the noncurrent-version pair above.
      const toSdkTransition = (t: Record<string, unknown>): Record<string, unknown> => ({
        Days: (t['TransitionInDays'] ?? t['Days']) as number | undefined,
        Date:
          (t['TransitionDate'] ?? t['Date'])
            ? new Date((t['TransitionDate'] ?? t['Date']) as string)
            : undefined,
        StorageClass: t['StorageClass'] as string | undefined,
      });
      const transitions = rule['Transitions'] as Array<Record<string, unknown>> | undefined;
      const singularTransition = rule['Transition'] as Record<string, unknown> | undefined;
      const allTransitions = mergeLegacySingular(transitions, singularTransition, (sc) =>
        this.logger.warn(
          `Lifecycle rule '${(rule['Id'] as string) ?? '<unnamed>'}' on ${bucketName} declares ` +
            `both Transitions and the legacy Transition for storage class ${sc}; S3 rejects ` +
            `duplicates, so the legacy singular was ignored.`
        )
      );
      if (allTransitions.length > 0) {
        sdkRule.Transitions = allTransitions.map(toSdkTransition);
      }

      // AbortIncompleteMultipartUpload
      const abort = isPlainObject(rule['AbortIncompleteMultipartUpload'])
        ? rule['AbortIncompleteMultipartUpload']
        : undefined;
      if (abort) {
        sdkRule.AbortIncompleteMultipartUpload = {
          DaysAfterInitiation: abort['DaysAfterInitiation'] as number | undefined,
        };
      }

      // Build the SDK `Filter` from the rule's full gathered scope (explicit
      // Filter + top-level Prefix + top-level ObjectSizeGreaterThan/LessThan).
      // S3 requires either a top-level Prefix (V1) or a Filter (V2) on each rule;
      // a rule with no scope at all gets the empty-prefix Filter (matches all).
      const { prefix, tagFilters, sizeGt, sizeLt } = gatherScope(rule);
      // `!= null` for the same reason as `isPlainPrefixOnly` above: an
      // explicit `TagFilters: null` means "no entries", not a `.length` crash.
      const hasTags = tagFilters != null && tagFilters.length > 0;
      const componentCount =
        (hasTags ? 1 : 0) +
        (prefix !== undefined ? 1 : 0) +
        (sizeGt !== undefined ? 1 : 0) +
        (sizeLt !== undefined ? 1 : 0);

      if (componentCount > 1) {
        // Multiple conditions must be combined under And (V2 only).
        sdkRule.Filter = {
          And: {
            Prefix: prefix,
            Tags: hasTags ? tagFilters : undefined,
            ObjectSizeGreaterThan: sizeGt,
            ObjectSizeLessThan: sizeLt,
          },
        };
      } else if (hasTags && tagFilters!.length > 1) {
        // Several tags and NOTHING else still needs `And` — the SDK's `Tag`
        // member holds exactly one tag, so the pre-#1388 `Tag: tagFilters[0]`
        // silently dropped every tag after the first. Unreachable before this
        // change (rule-level `TagFilters` was never gathered), so fixing the
        // gather without fixing this would have traded one silent drop for
        // another.
        sdkRule.Filter = { And: { Tags: tagFilters } };
      } else if (hasTags) {
        sdkRule.Filter = { Tag: tagFilters![0] };
      } else if (sizeGt !== undefined) {
        sdkRule.Filter = { ObjectSizeGreaterThan: sizeGt };
      } else if (sizeLt !== undefined) {
        sdkRule.Filter = { ObjectSizeLessThan: sizeLt };
      } else if (useFilterForm) {
        // Single Prefix (or no scope) in a V2 config: a bare top-level Prefix
        // becomes `Filter: { Prefix }`; no scope becomes the empty-prefix Filter.
        sdkRule.Filter = { Prefix: prefix ?? '' };
      }
      // else: V1 config, single-Prefix rule — keep the top-level `sdkRule.Prefix`
      // set above.

      return sdkRule;
    });

    await this.s3Client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucketName,
        LifecycleConfiguration: { Rules: rules },
        // TransitionDefaultMinimumObjectSize (issue #1495): the account-level
        // default that decides whether objects under 128 KB are eligible for
        // transition. It sits on the REQUEST rather than inside
        // `LifecycleConfiguration`, which is why the rules-only mapper never
        // reached it — a bucket declaring `all_storage_classes_128K` silently
        // kept the `varies_by_storage_class` default.
        TransitionDefaultMinimumObjectSize: lifecycleConfig[
          'TransitionDefaultMinimumObjectSize'
        ] as import('@aws-sdk/client-s3').TransitionDefaultMinimumObjectSize | undefined,
      })
    );
    this.logger.debug(`Applied lifecycle configuration to bucket ${bucketName}`);
  }

  /**
   * Apply public access block configuration
   *
   * CFn property: PublicAccessBlockConfiguration
   * SDK: PutPublicAccessBlock with PublicAccessBlockConfiguration
   * Field names are identical between CFn and SDK.
   */
  private async applyPublicAccessBlockConfiguration(
    bucketName: string,
    config: Record<string, unknown>
  ): Promise<void> {
    await this.s3Client.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucketName,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: config['BlockPublicAcls'] as boolean | undefined,
          BlockPublicPolicy: config['BlockPublicPolicy'] as boolean | undefined,
          IgnorePublicAcls: config['IgnorePublicAcls'] as boolean | undefined,
          RestrictPublicBuckets: config['RestrictPublicBuckets'] as boolean | undefined,
        },
      })
    );
    this.logger.debug(`Applied public access block configuration to bucket ${bucketName}`);
  }

  /**
   * Apply bucket encryption configuration
   *
   * CFn property: BucketEncryption.ServerSideEncryptionConfiguration[]
   * SDK: PutBucketEncryption with ServerSideEncryptionConfiguration.Rules[]
   *
   * CFn ServerSideEncryptionRule fields:
   * - ServerSideEncryptionByDefault.SSEAlgorithm, KMSMasterKeyID
   * - BucketKeyEnabled
   */
  private async applyBucketEncryption(
    bucketName: string,
    encryptionConfig: { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
  ): Promise<void> {
    // See applyOwnershipControls: malformed values reach here deliberately, so
    // fail by name rather than with a bare `.map` TypeError.
    if (!Array.isArray(encryptionConfig?.ServerSideEncryptionConfiguration)) {
      // Plain Error on purpose: create()/update() wrap every throw into a
      // ProvisioningError carrying the real logicalId (which this private
      // helper does not have), so raising one here would only be re-labelled.
      throw new Error(
        `BucketEncryption.ServerSideEncryptionConfiguration must be an array (got ` +
          `${
            encryptionConfig?.ServerSideEncryptionConfiguration === undefined
              ? 'undefined'
              : typeof encryptionConfig.ServerSideEncryptionConfiguration
          }) — check for an unresolved intrinsic or a mis-nested template value`
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = encryptionConfig.ServerSideEncryptionConfiguration.map((rule): any => {
      const byDefault = rule['ServerSideEncryptionByDefault'] as
        | Record<string, unknown>
        | undefined;
      // BlockedEncryptionTypes (issue #1495): the per-rule opt-out of an
      // encryption type (today only SSE-C). Never built before, so a bucket
      // declaring the block silently kept accepting the type it wanted to
      // refuse — a security-relevant drop, not just a lost setting.
      const blocked = rule['BlockedEncryptionTypes'] as Record<string, unknown> | undefined;
      return {
        ApplyServerSideEncryptionByDefault: byDefault
          ? {
              SSEAlgorithm: byDefault['SSEAlgorithm'] as string,
              KMSMasterKeyID: byDefault['KMSMasterKeyID'] as string | undefined,
            }
          : undefined,
        BucketKeyEnabled: rule['BucketKeyEnabled'] as boolean | undefined,
        BlockedEncryptionTypes:
          blocked != null && blocked['EncryptionType'] !== undefined
            ? { EncryptionType: blocked['EncryptionType'] as string[] }
            : undefined,
      };
    });
    await this.s3Client.send(
      new PutBucketEncryptionCommand({
        Bucket: bucketName,
        ServerSideEncryptionConfiguration: { Rules: rules },
      })
    );
    this.logger.debug(`Applied encryption configuration to bucket ${bucketName}`);
  }

  /**
   * Apply logging configuration
   *
   * CFn property: LoggingConfiguration
   *   - DestinationBucketName -> SDK TargetBucket
   *   - LogFilePrefix -> SDK TargetPrefix
   * SDK: PutBucketLogging with BucketLoggingStatus.LoggingEnabled
   */
  private async applyLoggingConfiguration(
    bucketName: string,
    loggingConfig: unknown
  ): Promise<void> {
    // Shape-check the CONTAINER before the clearing branch below (issue
    // #1471). That branch reads `loggingConfig['DestinationBucketName']`, so a
    // malformed value (`LoggingConfiguration: 'my-log-bucket'`) indexes to
    // `undefined`, takes the clear path, and turns logging OFF on a bucket
    // whose template declares it — the same declaring-the-feature-disables-it
    // shape this issue exists to remove. Guarding only the `LogFilePrefix`
    // read below would leave it live, because control never reaches it.
    //
    // An ABSENT config still resolves to the fallback and clears, which is the
    // legitimate removal path.
    const destinationBucket = readConfigString(
      loggingConfig,
      'DestinationBucketName',
      '',
      'AWS::S3::Bucket LoggingConfiguration'
    );

    // S3 supports clearing logging by sending an empty BucketLoggingStatus
    // (no LoggingEnabled field). When loggingConfig is undefined or has no
    // DestinationBucketName, we issue the clearing call.
    if (!loggingConfig || destinationBucket === '') {
      await this.s3Client.send(
        new PutBucketLoggingCommand({
          Bucket: bucketName,
          BucketLoggingStatus: {},
        })
      );
      this.logger.debug(`Cleared logging configuration on bucket ${bucketName}`);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loggingEnabled: any = {
      TargetBucket: destinationBucket,
      TargetPrefix: readConfigString(
        loggingConfig,
        'LogFilePrefix',
        '',
        'AWS::S3::Bucket LoggingConfiguration'
      ),
    };

    // TargetObjectKeyFormat (issue #1495): the partitioned server-access-log
    // key format. Never built before, so a bucket declaring it silently got
    // the default FLAT format. CFn and the SDK spell the whole block
    // identically, but it is assembled member by member rather than forwarded
    // so a future CFn-only member cannot ride through unnoticed.
    const keyFormat = (loggingConfig as Record<string, unknown>)['TargetObjectKeyFormat'] as
      | Record<string, unknown>
      | undefined;
    if (keyFormat != null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdkKeyFormat: any = {};
      // `SimplePrefix: {}` is the CFn opt-in for the default format: the value
      // is an EMPTY object whose PRESENCE is the signal, so it must survive.
      if (keyFormat['SimplePrefix'] !== undefined) sdkKeyFormat.SimplePrefix = {};
      const partitioned = keyFormat['PartitionedPrefix'] as Record<string, unknown> | undefined;
      if (partitioned != null && partitioned['PartitionDateSource'] !== undefined) {
        sdkKeyFormat.PartitionedPrefix = {
          PartitionDateSource: partitioned['PartitionDateSource'] as string,
        };
      }
      if (Object.keys(sdkKeyFormat).length > 0) {
        loggingEnabled.TargetObjectKeyFormat = sdkKeyFormat;
      }
    }

    await this.s3Client.send(
      new PutBucketLoggingCommand({
        Bucket: bucketName,
        BucketLoggingStatus: { LoggingEnabled: loggingEnabled },
      })
    );
    this.logger.debug(`Applied logging configuration to bucket ${bucketName}`);
  }

  /**
   * Apply website configuration
   *
   * CFn property: WebsiteConfiguration
   *   - IndexDocument -> SDK IndexDocument.Suffix
   *   - ErrorDocument -> SDK ErrorDocument.Key
   *   - RoutingRules -> SDK RoutingRules[]
   *   - RedirectAllRequestsTo -> SDK RedirectAllRequestsTo
   * SDK: PutBucketWebsite with WebsiteConfiguration
   */
  private async applyWebsiteConfiguration(
    bucketName: string,
    websiteConfig: Record<string, unknown>
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkConfig: any = {};

    const indexDoc = websiteConfig['IndexDocument'] as string | undefined;
    if (indexDoc) {
      sdkConfig['IndexDocument'] = { Suffix: indexDoc };
    }

    const errorDoc = websiteConfig['ErrorDocument'] as string | undefined;
    if (errorDoc) {
      sdkConfig['ErrorDocument'] = { Key: errorDoc };
    }

    const redirectAll = websiteConfig['RedirectAllRequestsTo'] as
      | Record<string, unknown>
      | undefined;
    if (redirectAll) {
      sdkConfig['RedirectAllRequestsTo'] = {
        HostName: redirectAll['HostName'] as string,
        Protocol: redirectAll['Protocol'] as string | undefined,
      };
    }

    const routingRules = websiteConfig['RoutingRules'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (routingRules && Array.isArray(routingRules)) {
      sdkConfig['RoutingRules'] = routingRules.map((rule) => {
        const condition = rule['RoutingRuleCondition'] as Record<string, unknown> | undefined;
        const redirect = rule['RedirectRule'] as Record<string, unknown> | undefined;
        return {
          Condition: condition
            ? {
                HttpErrorCodeReturnedEquals: condition['HttpErrorCodeReturnedEquals'] as
                  | string
                  | undefined,
                KeyPrefixEquals: condition['KeyPrefixEquals'] as string | undefined,
              }
            : undefined,
          Redirect: redirect
            ? {
                HostName: redirect['HostName'] as string | undefined,
                HttpRedirectCode: redirect['HttpRedirectCode'] as string | undefined,
                Protocol: redirect['Protocol'] as string | undefined,
                ReplaceKeyPrefixWith: redirect['ReplaceKeyPrefixWith'] as string | undefined,
                ReplaceKeyWith: redirect['ReplaceKeyWith'] as string | undefined,
              }
            : undefined,
        };
      });
    }

    await this.s3Client.send(
      new PutBucketWebsiteCommand({
        Bucket: bucketName,
        WebsiteConfiguration: sdkConfig,
      })
    );
    this.logger.debug(`Applied website configuration to bucket ${bucketName}`);
  }

  /**
   * Apply accelerate configuration
   *
   * CFn property: AccelerateConfiguration.AccelerationStatus
   * SDK: PutBucketAccelerateConfiguration with AccelerateConfiguration.Status
   */
  private async applyAccelerateConfiguration(
    bucketName: string,
    config: Record<string, unknown>
  ): Promise<void> {
    await this.s3Client.send(
      new PutBucketAccelerateConfigurationCommand({
        Bucket: bucketName,
        AccelerateConfiguration: {
          Status: config['AccelerationStatus'] as 'Enabled' | 'Suspended',
        },
      })
    );
    this.logger.debug(`Applied accelerate configuration to bucket ${bucketName}`);
  }

  /**
   * Apply notification configuration (full-replace via PutBucketNotificationConfiguration)
   *
   * CFn property: NotificationConfiguration with TopicConfigurations,
   *   QueueConfigurations, LambdaConfigurations, EventBridgeConfiguration.
   * SDK uses the same structure (PutBucketNotificationConfiguration replaces
   * the entire notification configuration in one call).
   */
  private async applyNotificationConfiguration(
    bucketName: string,
    notifConfig: Record<string, unknown> | undefined
  ): Promise<void> {
    // PutBucketNotificationConfiguration is a full-replace API; sending an
    // empty NotificationConfiguration clears all notifications.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg: any = {};

    if (notifConfig) {
      const topics = notifConfig['TopicConfigurations'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (topics && Array.isArray(topics) && topics.length > 0) {
        cfg.TopicConfigurations = topics.map((t) => ({
          Id: t['Id'] as string | undefined,
          TopicArn: (t['Topic'] ?? t['TopicArn']) as string,
          Events: t['Event'] !== undefined ? [t['Event'] as string] : (t['Events'] as string[]),
          Filter: this.cfnNotifFilterToSdk(t['Filter']),
        }));
      }
      const queues = notifConfig['QueueConfigurations'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (queues && Array.isArray(queues) && queues.length > 0) {
        cfg.QueueConfigurations = queues.map((q) => ({
          Id: q['Id'] as string | undefined,
          QueueArn: (q['Queue'] ?? q['QueueArn']) as string,
          Events: q['Event'] !== undefined ? [q['Event'] as string] : (q['Events'] as string[]),
          Filter: this.cfnNotifFilterToSdk(q['Filter']),
        }));
      }
      const lambdas = notifConfig['LambdaConfigurations'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (lambdas && Array.isArray(lambdas) && lambdas.length > 0) {
        cfg.LambdaFunctionConfigurations = lambdas.map((l) => ({
          Id: l['Id'] as string | undefined,
          LambdaFunctionArn: (l['Function'] ?? l['LambdaFunctionArn']) as string,
          Events: l['Event'] !== undefined ? [l['Event'] as string] : (l['Events'] as string[]),
          Filter: this.cfnNotifFilterToSdk(l['Filter']),
        }));
      }
      const eb = notifConfig['EventBridgeConfiguration'];
      // `isPlainObject`, not `!== undefined`: this branch now READS a member off
      // the block, so an explicit `null` (hand-written JSON / an intrinsic that
      // resolved to null) would throw where it previously just emitted the
      // block. A non-object stays on the pre-change enable-on-presence side.
      if (
        eb !== undefined &&
        (!isPlainObject(eb) || coerceCfnBoolean(eb['EventBridgeEnabled']) !== false)
      ) {
        // The SDK's `EventBridgeConfiguration` is an EMPTY structure — presence
        // enables EventBridge delivery, absence disables it. CFn instead carries
        // a REQUIRED boolean `EventBridgeEnabled` inside the block (that is what
        // `CfnBucket` renders), so the boolean has no SDK member to land on and
        // has to be translated into presence/absence here. Before issue #1430
        // the block was emitted whenever it existed, so an explicit
        // `EventBridgeEnabled: false` silently ENABLED notifications — the
        // inverse of the template's intent. Absent / unresolved values keep the
        // pre-existing enable-on-presence behavior.
        cfg.EventBridgeConfiguration = {};
      }
    }

    await this.s3Client.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucketName,
        NotificationConfiguration: cfg,
      })
    );
    this.logger.debug(`Applied notification configuration to bucket ${bucketName}`);
  }

  /**
   * Convert CFn notification Filter ({ S3Key: { Rules: [{ Name, Value }] } })
   * to SDK NotificationConfigurationFilter.Key.FilterRules.
   */
  private cfnNotifFilterToSdk(
    filter: unknown
  ): { Key: { FilterRules: Array<{ Name: string; Value: string }> } } | undefined {
    if (!filter || typeof filter !== 'object') return undefined;
    const f = filter as Record<string, unknown>;
    const s3Key = f['S3Key'] as Record<string, unknown> | undefined;
    if (!s3Key) return undefined;
    const rules = s3Key['Rules'] as Array<{ Name?: string; Value?: string }> | undefined;
    if (!rules || !Array.isArray(rules) || rules.length === 0) return undefined;
    return {
      Key: {
        FilterRules: rules
          .filter((r) => r.Name !== undefined && r.Value !== undefined)
          .map((r) => ({ Name: r.Name as string, Value: r.Value as string })),
      },
    };
  }

  /**
   * Apply metrics configurations
   *
   * CFn property: MetricsConfigurations[] (array of configurations)
   * SDK: PutBucketMetricsConfiguration (one per configuration, keyed by Id)
   */
  private async applyMetricsConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>,
    onUnusable?: (message: string) => void
  ): Promise<void> {
    // The per-ITEM `config` container is deliberately NOT guarded here, and
    // the audit that settled it belongs next to the decision (issue #1581).
    // Of the five per-item appliers, three already refuse a non-object item
    // through an existing `readConfigString(config | rule, …)` — intelligent
    // tiering (`Status`), inventory (`IncludedObjectVersions`) and the
    // lifecycle rules (`Status`). Metrics and analytics read only `Id` off the
    // item, so a malformed one reaches AWS — but `id` is a REQUIRED query
    // parameter of `PutBucket{Metrics,Analytics}Configuration`, so the request
    // is rejected outright. That is a LOUD failure, not the silent
    // scope-widening / silent-drop hazard the container guards exist for, so
    // adding a refusal here would buy a nicer error message at the cost of a
    // behavior change on the replay path (skip instead of surface).
    for (const config of configs) {
      const id = config['Id'] as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const metricsConfig: any = {
        Id: id,
      };
      const prefix = config['Prefix'] as string | undefined;
      const accessPointArn = config['AccessPointArn'] as string | undefined;
      // A present-but-non-array `TagFilters` (issue #1579) used to read as
      // ZERO predicates through the `?.length` below, so the Filter block was
      // silently omitted and the configuration deployed with a WIDER scope
      // (all objects) than the template declared — the #1493
      // malformed-container class. Refuse on a template-path create; on the
      // state-replay paths (`onUnusable`) warn and skip this configuration
      // item, since applying it WITHOUT its tag predicate would widen the
      // monitored scope, the very misbehavior being refused.
      // `tagFilters` stays bound to the bag read directly (not to the guard's
      // return value): the nested-key critic's write-evidence walk follows the
      // bag-read binding into the `And.Tags` write, and routing the value
      // through the helper call would sever that hand-off and false-flag
      // `TagFilters.Key` / `.Value` as never written.
      const tagFilters = config['TagFilters'] as Array<{ Key: string; Value: string }> | undefined;
      if (
        tagFilters != null &&
        requireConfigArray(tagFilters, 'AWS::S3::Bucket MetricsConfigurations[].TagFilters', {
          ...(onUnusable ? { onUnusable } : {}),
        }) === undefined
      ) {
        continue;
      }
      const tagCount = tagFilters?.length ?? 0;
      // The single-predicate shapes (Prefix / Tag / AccessPointArn) carry
      // exactly ONE condition; every combination — and 2+ tags on their own —
      // needs the And operator. Issue #1573: this used to branch on Prefix
      // FIRST, so a Prefix combined with TagFilters or AccessPointArn
      // silently dropped the other predicate(s). Counting PREDICATES (not
      // predicate kinds — the sibling builders' variant of the same bug)
      // routes every multi-condition filter through And; no filter at all
      // means the configuration applies to every object.
      const predicateCount = (prefix ? 1 : 0) + tagCount + (accessPointArn ? 1 : 0);
      if (predicateCount > 1) {
        metricsConfig.Filter = {
          And: {
            Prefix: prefix,
            Tags: tagCount > 0 ? tagFilters : undefined,
            AccessPointArn: accessPointArn,
          },
        };
      } else if (prefix) {
        metricsConfig.Filter = { Prefix: prefix };
      } else if (tagFilters && tagFilters.length === 1) {
        metricsConfig.Filter = { Tag: tagFilters[0] };
      } else if (accessPointArn) {
        metricsConfig.Filter = { AccessPointArn: accessPointArn };
      }
      await this.s3Client.send(
        new PutBucketMetricsConfigurationCommand({
          Bucket: bucketName,
          Id: id,
          MetricsConfiguration: metricsConfig,
        })
      );
    }
    this.logger.debug(`Applied ${configs.length} metrics configuration(s) to bucket ${bucketName}`);
  }

  /**
   * Pick the `S3BucketDestination` bag out of an analytics / inventory
   * `Destination` block, refusing a shape that would otherwise be dropped.
   *
   * Two shapes are legitimate and both must keep working: the CFn FLATTENED
   * form (`Destination: { BucketArn, Format, ... }`, what the schema declares)
   * and the SDK NESTED form (`Destination: { S3BucketDestination: { ... } }`,
   * accepted because state records and hand-written templates carry it).
   *
   * Issue #1493 item 2: the branch was picked by probing member presence
   * (`dest?.['BucketAccountId'] || dest?.['BucketArn'] || dest?.['Format']`),
   * so a `Destination` that is a STRING / array / unresolved intrinsic indexed
   * every probe to `undefined`, fell through to an equally-`undefined`
   * `S3BucketDestination`, and the caller's `s3Dest ? … : undefined` omitted
   * the whole block from the Put — a configuration silently deployed without
   * the destination it declared. Unlike the sibling defaulting class this is a
   * DROP, not a substituted default, so `readConfigString` does not cover it:
   * it needs its own decision, and per issue #1513's precedent that decision is
   * REFUSE on the template-borne create path, WARN on the replay-reachable
   * update path (`onUnusable`), where the desired bag can be a historical cdkd
   * state record with no template-side remedy.
   *
   * Also returns the CFn path of the bag it picked (issue #1493 item 3): the
   * callers used to hardcode `…Destination.S3BucketDestination` in the
   * `containerPath` they pass to `readConfigString`, so a refusal on the
   * FLATTENED branch — where the bag IS `dest` itself — named a key the user's
   * template does not contain.
   *
   * @returns the picked bag, or `undefined` when the block was ABSENT or was
   *   refused on a warn-only path. The caller distinguishes the two by testing
   *   its own `Destination` value — see the `continue` at each call site.
   */
  private resolveS3BucketDestination(
    dest: unknown,
    destinationPath: string,
    onUnusable?: (message: string) => void
  ): Record<string, unknown> | undefined {
    const nestedPath = `${destinationPath}.S3BucketDestination`;
    const drop = (message: string): undefined => {
      if (onUnusable) {
        onUnusable(
          `${message}. Leaving this configuration unchanged; the same value is REFUSED ` +
            `on a template-path create`
        );
        return undefined;
      }
      throw new Error(message);
    };

    // An ABSENT block is the template's own omission, not a shape problem —
    // AWS reports the missing required destination itself. Unchanged.
    if (dest === undefined || dest === null) {
      return undefined;
    }

    if (!isPlainObject(dest)) {
      return drop(
        `${destinationPath} must be an object (got ${describeValue(dest)}) — check for an ` +
          `unresolved intrinsic or a mis-nested template value; the destination would ` +
          `otherwise be dropped from the request with no error`
      );
    }

    // Branch selection is TRUTHINESS-based, matching the pre-fix code exactly.
    // A presence (`!== undefined`) test reads better but silently re-routes
    // `{ BucketAccountId: '', S3BucketDestination: {...} }` from the nested
    // branch — where it worked — to the flat one, where it sends
    // `Bucket: undefined`. Turning a working template into a broken request is
    // the opposite of this guard's purpose, so the probe stays truthy and the
    // REFUSAL below is what the change actually adds.
    const bag = isFlattenedDestination(dest) ? dest : (dest['S3BucketDestination'] as unknown);

    if (bag === undefined || bag === null) {
      return drop(
        `${destinationPath} carries neither a bucket (BucketArn / Bucket) nor a nested ` +
          `S3BucketDestination object (got ${describeValue(dest)}) — the destination would ` +
          `otherwise be dropped from the request with no error`
      );
    }
    if (!isPlainObject(bag)) {
      return drop(
        `${nestedPath} must be an object (got ${describeValue(bag)}) — check for an ` +
          `unresolved intrinsic or a mis-nested template value; the destination would ` +
          `otherwise be dropped from the request with no error`
      );
    }

    // The bucket is REQUIRED by both APIs, and it is the one member neither
    // branch can default. Checking it on the PICKED bag rather than only on the
    // flat one closes the asymmetry a reviewer found: `{ S3BucketDestination: {} }`
    // is truthy, so it used to sail through to a `Bucket: undefined` Put.
    if (!bag['BucketArn'] && !bag['Bucket']) {
      return drop(
        `${bag === dest ? destinationPath : nestedPath} has no destination bucket ` +
          `(BucketArn / Bucket) (got ${describeValue(bag)}) — the request would be ` +
          `rejected by S3, or silently carry no destination`
      );
    }

    return bag;
  }

  /**
   * Apply analytics configurations
   *
   * CFn property: AnalyticsConfigurations[] (array of configurations)
   * SDK: PutBucketAnalyticsConfiguration (one per configuration, keyed by Id)
   */
  private async applyAnalyticsConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>,
    onUnusable?: (message: string) => void
  ): Promise<void> {
    for (const config of configs) {
      const id = config['Id'] as string;
      // The `StorageClassAnalysis` CONTAINER (issue #1581) — the analytics
      // sibling of the lifecycle `Filter` guard. A present-but-non-OBJECT
      // value indexes the `DataExport` probe below to `undefined`, so the
      // whole data-export block was dropped and the configuration deployed as
      // `StorageClassAnalysis: {}` — which S3 ACCEPTS as "no export", so
      // nothing surfaced anywhere. Refuse on a template-path create; on the
      // state-replay paths warn and skip THIS configuration item (the Put is
      // per-Id, so the siblings are unaffected — unlike the lifecycle Put,
      // which replaces every rule at once).
      const rawStorageClassAnalysis = config['StorageClassAnalysis'];
      if (
        rawStorageClassAnalysis != null &&
        requireConfigObject(
          rawStorageClassAnalysis,
          'AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis',
          { ...(onUnusable ? { onUnusable } : {}) }
        ) === undefined
      ) {
        continue;
      }
      const storageClassAnalysis = rawStorageClassAnalysis as Record<string, unknown> | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const analyticsConfig: any = {
        Id: id,
        StorageClassAnalysis: {},
      };

      // Filter. The single-predicate shapes carry exactly ONE condition; a
      // combination — and 2+ tags on their own — needs the And operator.
      // Issue #1573: the old guard counted predicate KINDS, so 2+ tags with
      // no Prefix collapsed to the single-Tag shape and silently dropped
      // every tag after the first. And-with-only-Tags is accepted by the API
      // and reads back unchanged (live-probed 2026-08-11).
      const prefix = config['Prefix'] as string | undefined;
      // Non-array `TagFilters` guard (issue #1579) — see the metrics sibling,
      // including why the binding must stay a direct bag read.
      const tagFilters = config['TagFilters'] as Array<{ Key: string; Value: string }> | undefined;
      if (
        tagFilters != null &&
        requireConfigArray(tagFilters, 'AWS::S3::Bucket AnalyticsConfigurations[].TagFilters', {
          ...(onUnusable ? { onUnusable } : {}),
        }) === undefined
      ) {
        continue;
      }
      const tagCount = tagFilters?.length ?? 0;
      if ((prefix ? 1 : 0) + tagCount > 1) {
        analyticsConfig.Filter = { And: { Prefix: prefix, Tags: tagFilters } };
      } else if (prefix) {
        analyticsConfig.Filter = { Prefix: prefix };
      } else if (tagFilters && tagFilters.length === 1) {
        analyticsConfig.Filter = { Tag: tagFilters[0] };
      }

      // StorageClassAnalysis.DataExport
      //
      // `!= null`, NOT a truthiness gate: a FALSY malformed `DataExport` ('' /
      // 0) skips the whole block and sends `StorageClassAnalysis: {}` with no
      // error — the same silent drop this change exists for, one gate up.
      // `.claude/rules/providers.md` names #1493 as having shipped exactly that
      // gate bug once already.
      if (storageClassAnalysis?.['DataExport'] != null) {
        const rawDataExport = storageClassAnalysis['DataExport'];
        // The `DataExport` container itself (issue #1581). It WAS refused
        // before this change, but only INDIRECTLY and only in one direction:
        // the `readConfigString(dataExport, 'OutputSchemaVersion', …)` below
        // carries no `onUnusable`, so a malformed block hard-threw on the
        // state-replay paths too — the un-rollbackable refusal every sibling
        // guard in this file exists to avoid. Guarding it explicitly moves the
        // replay path onto the same warn-and-skip contract as its siblings and
        // leaves the create-path refusal exactly where it was.
        if (
          requireConfigObject(
            rawDataExport,
            'AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis.DataExport',
            { ...(onUnusable ? { onUnusable } : {}) }
          ) === undefined
        ) {
          continue;
        }
        const dataExport = rawDataExport as Record<string, unknown>;
        const analyticsDestPath =
          'AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis.DataExport.Destination';
        const rawDest = dataExport['Destination'];
        const s3Dest = this.resolveS3BucketDestination(rawDest, analyticsDestPath, onUnusable);
        // A PRESENT-but-unusable destination that only warned leaves the live
        // configuration ALONE rather than sending a destination-less request.
        // `Destination` is a REQUIRED SDK member, so emitting the Put without
        // it is rejected by S3 — the replay would be stranded anyway, just with
        // an opaque AWS error instead of cdkd's actionable one, which is the
        // whole point of warning here. An ABSENT destination keeps the old
        // behavior and lets AWS report the missing required field.
        if (s3Dest === undefined && rawDest != null) continue;
        const destPath = s3BucketDestinationPath(rawDest, analyticsDestPath);
        analyticsConfig.StorageClassAnalysis = {
          DataExport: {
            OutputSchemaVersion: readConfigString(
              dataExport,
              'OutputSchemaVersion',
              'V_1',
              'AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis.DataExport'
            ),
            Destination: s3Dest
              ? {
                  S3BucketDestination: {
                    Bucket: (s3Dest['BucketArn'] ?? s3Dest['Bucket']) as string,
                    BucketAccountId: s3Dest['BucketAccountId'] as string | undefined,
                    // Same downgrade as the destination guard above: a
                    // rollback / `drift --revert` replays a STATE record here,
                    // so a malformed `Format` must not hard-fail one line below
                    // a guard that deliberately warns.
                    Format: readConfigString(s3Dest, 'Format', 'CSV', destPath, {
                      ...(onUnusable ? { onUnusable } : {}),
                    }),
                    Prefix: s3Dest['Prefix'] as string | undefined,
                  },
                }
              : undefined,
          },
        };
      }

      await this.s3Client.send(
        new PutBucketAnalyticsConfigurationCommand({
          Bucket: bucketName,
          Id: id,
          AnalyticsConfiguration: analyticsConfig,
        })
      );
    }
    this.logger.debug(
      `Applied ${configs.length} analytics configuration(s) to bucket ${bucketName}`
    );
  }

  /**
   * Apply intelligent tiering configurations
   *
   * CFn property: IntelligentTieringConfigurations[]
   * SDK: PutBucketIntelligentTieringConfiguration (one per configuration, keyed by Id)
   */
  private async applyIntelligentTieringConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>,
    onUnusable?: (message: string) => void
  ): Promise<void> {
    for (const config of configs) {
      const id = config['Id'] as string;
      const tierings = config['Tierings'] as Array<Record<string, unknown>> | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itConfig: any = {
        Id: id,
        Status: readConfigString(
          config,
          'Status',
          'Enabled',
          'AWS::S3::Bucket IntelligentTieringConfigurations[]'
        ),
        Tierings: (tierings || []).map((t: Record<string, unknown>) => ({
          AccessTier: t['AccessTier'] as string,
          Days: t['Days'] as number,
        })),
      };

      // Filter. Same predicate-count rule as applyAnalyticsConfigurations —
      // the old kind-count guard dropped every tag after the first when
      // Prefix was absent (issue #1573; And-with-only-Tags live-probed
      // 2026-08-11).
      const prefix = config['Prefix'] as string | undefined;
      // Non-array `TagFilters` guard (issue #1579) — see the metrics sibling,
      // including why the binding must stay a direct bag read.
      const tagFilters = config['TagFilters'] as Array<{ Key: string; Value: string }> | undefined;
      if (
        tagFilters != null &&
        requireConfigArray(
          tagFilters,
          'AWS::S3::Bucket IntelligentTieringConfigurations[].TagFilters',
          { ...(onUnusable ? { onUnusable } : {}) }
        ) === undefined
      ) {
        continue;
      }
      const tagCount = tagFilters?.length ?? 0;
      if ((prefix ? 1 : 0) + tagCount > 1) {
        itConfig.Filter = { And: { Prefix: prefix, Tags: tagFilters } };
      } else if (prefix) {
        itConfig.Filter = { Prefix: prefix };
      } else if (tagFilters && tagFilters.length === 1) {
        itConfig.Filter = { Tag: tagFilters[0] };
      }

      await this.s3Client.send(
        new PutBucketIntelligentTieringConfigurationCommand({
          Bucket: bucketName,
          Id: id,
          IntelligentTieringConfiguration: itConfig,
        })
      );
    }
    this.logger.debug(
      `Applied ${configs.length} intelligent tiering configuration(s) to bucket ${bucketName}`
    );
  }

  /**
   * Apply inventory configurations
   *
   * CFn property: InventoryConfigurations[]
   * SDK: PutBucketInventoryConfiguration (one per configuration, keyed by Id)
   */
  private async applyInventoryConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>,
    onUnusable?: (message: string) => void
  ): Promise<void> {
    for (const config of configs) {
      const id = config['Id'] as string;
      const inventoryDestPath = 'AWS::S3::Bucket InventoryConfigurations[].Destination';
      const rawDest = config['Destination'];
      const s3Dest = this.resolveS3BucketDestination(rawDest, inventoryDestPath, onUnusable);
      // See the analytics sibling: a warned-away destination leaves the live
      // configuration untouched instead of sending a request S3 rejects.
      if (s3Dest === undefined && rawDest != null) continue;
      const destPath = s3BucketDestinationPath(rawDest, inventoryDestPath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inventoryConfig: any = {
        Id: id,
        IsEnabled: (config['Enabled'] as boolean) ?? true,
        IncludedObjectVersions: readConfigString(
          config,
          'IncludedObjectVersions',
          'All',
          'AWS::S3::Bucket InventoryConfigurations[]'
        ),
        Schedule: {
          // Same class as the guarded siblings above (issue #1471): a
          // malformed `Schedule` used to index to `undefined` and silently
          // default to Weekly. The two-source precedence is preserved.
          Frequency:
            config['ScheduleFrequency'] !== undefined
              ? requireConfigString(
                  config['ScheduleFrequency'],
                  'Weekly',
                  'AWS::S3::Bucket InventoryConfigurations[].ScheduleFrequency'
                )
              : readConfigString(
                  config['Schedule'],
                  'Frequency',
                  'Weekly',
                  'AWS::S3::Bucket InventoryConfigurations[].Schedule'
                ),
        },
        Destination: {
          S3BucketDestination: s3Dest
            ? {
                Bucket: (s3Dest['BucketArn'] ?? s3Dest['Bucket']) as string,
                AccountId: s3Dest['BucketAccountId'] as string | undefined,
                // Same update-path downgrade as the analytics sibling.
                Format: readConfigString(s3Dest, 'Format', 'CSV', destPath, {
                  ...(onUnusable ? { onUnusable } : {}),
                }),
                Prefix: s3Dest['Prefix'] as string | undefined,
              }
            : undefined,
        },
        OptionalFields: config['OptionalFields'] as string[] | undefined,
        Filter: config['Prefix'] ? { Prefix: config['Prefix'] as string } : undefined,
      };

      await this.s3Client.send(
        new PutBucketInventoryConfigurationCommand({
          Bucket: bucketName,
          Id: id,
          InventoryConfiguration: inventoryConfig,
        })
      );
    }
    this.logger.debug(
      `Applied ${configs.length} inventory configuration(s) to bucket ${bucketName}`
    );
  }

  /**
   * Apply replication configuration
   *
   * CFn property: ReplicationConfiguration
   *   - Role (IAM role ARN)
   *   - Rules[] (replication rules)
   * SDK: PutBucketReplication with ReplicationConfiguration
   */
  /**
   * Build the SDK `Destination` for one replication rule.
   *
   * Before issue #1495 this was an inline literal carrying `Bucket` / `Account`
   * / `StorageClass` only, so FOUR whole sub-blocks the CFn schema declares
   * were accepted from the template and never sent — each one silently:
   *
   * - `AccessControlTranslation` — cross-account replication with owner
   *   override; without it the replicas keep the SOURCE account's ownership.
   * - `EncryptionConfiguration.ReplicaKmsKeyID` — the replica-side SSE-KMS key;
   *   dropped, the replicas are not encrypted with the declared key. CDK's
   *   `aws-s3` L2 emits this for a `replicationRules` entry with a KMS key.
   * - `ReplicationTime` + `Metrics` — S3 Replication Time Control. RTC is a
   *   billed SLA feature and both blocks are required to enable it, so a
   *   template asking for RTC got plain asynchronous replication.
   *
   * CFn and the SDK spell every member identically here (verified against
   * `@aws-sdk/client-s3`'s `Destination`), but the block is assembled member by
   * member rather than forwarded so a CFn-only member cannot ride through.
   */
  private buildReplicationDestination(dest: Record<string, unknown>): Record<string, unknown> {
    const sdkDest: Record<string, unknown> = {
      Bucket: dest['Bucket'] as string,
      Account: dest['Account'] as string | undefined,
      StorageClass: dest['StorageClass'] as string | undefined,
    };

    // Every gate below is `!= null`, not truthiness: a FALSY malformed value
    // (`''`, `0`) must not be silently skipped — that is the #1493 gate bug one
    // level down, and `.claude/rules/providers.md` requires the `!= null` form.
    // Each block is also assembled into a local and only attached when it
    // carries at least one member, so a template's `AccessControlTranslation: {}`
    // does not become `{Owner: undefined}` on the wire (AWS rejects that, where
    // the pre-fix code sent nothing at all).
    // Each block is written as a NAMED assignment rather than through a helper
    // taking a string-literal key: `gen-nested-key-coverage`'s write-evidence
    // pass recognises `sdkDest['X'] = { … }`, and routing these through a
    // generic attach() made all 12 members invisible to it (measured: the S3
    // residual went 93 instead of 81). The empty-block guard is therefore
    // inlined per block.
    const acl = dest['AccessControlTranslation'] as Record<string, unknown> | undefined;
    if (acl != null && acl['Owner'] !== undefined) {
      sdkDest['AccessControlTranslation'] = { Owner: acl['Owner'] as string };
    }

    const encryption = dest['EncryptionConfiguration'] as Record<string, unknown> | undefined;
    if (encryption != null && encryption['ReplicaKmsKeyID'] !== undefined) {
      sdkDest['EncryptionConfiguration'] = {
        ReplicaKmsKeyID: encryption['ReplicaKmsKeyID'] as string,
      };
    }

    const replicationTime = dest['ReplicationTime'] as Record<string, unknown> | undefined;
    if (replicationTime != null) {
      const time = replicationTime['Time'] as Record<string, unknown> | undefined;
      const rt: Record<string, unknown> = {};
      if (replicationTime['Status'] !== undefined) rt['Status'] = replicationTime['Status'];
      if (time != null && time['Minutes'] !== undefined) {
        rt['Time'] = { Minutes: time['Minutes'] as number };
      }
      if (Object.keys(rt).length > 0) sdkDest['ReplicationTime'] = rt;
    }

    const metrics = dest['Metrics'] as Record<string, unknown> | undefined;
    if (metrics != null) {
      const threshold = metrics['EventThreshold'] as Record<string, unknown> | undefined;
      const m: Record<string, unknown> = {};
      if (metrics['Status'] !== undefined) m['Status'] = metrics['Status'];
      if (threshold != null && threshold['Minutes'] !== undefined) {
        m['EventThreshold'] = { Minutes: threshold['Minutes'] as number };
      }
      if (Object.keys(m).length > 0) sdkDest['Metrics'] = m;
    }

    return sdkDest;
  }

  private async applyReplicationConfiguration(
    bucketName: string,
    replConfig: Record<string, unknown>
  ): Promise<void> {
    const rules = replConfig['Rules'] as Array<Record<string, unknown>> | undefined;
    await this.s3Client.send(
      new PutBucketReplicationCommand({
        Bucket: bucketName,
        ReplicationConfiguration: {
          Role: replConfig['Role'] as string,
          Rules: (rules || []).map((rule) => {
            const dest = rule['Destination'] as Record<string, unknown>;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sdkRule: any = {
              ID: rule['Id'] as string | undefined,
              Status: readConfigString(
                rule,
                'Status',
                'Enabled',
                'AWS::S3::Bucket ReplicationConfiguration.Rules[]'
              ),
              Priority: rule['Priority'] as number | undefined,
              Destination: this.buildReplicationDestination(dest),
            };

            // SourceSelectionCriteria (issue #1495): which source objects are
            // eligible for replication. Never built before, so a rule opting
            // into replica-modification or SSE-KMS-object replication was
            // accepted from the template and never sent — silently replicating
            // a different set of objects than declared.
            const criteria = rule['SourceSelectionCriteria'] as Record<string, unknown> | undefined;
            if (criteria != null) {
              const sdkCriteria: Record<string, unknown> = {};
              const replicaMods = criteria['ReplicaModifications'] as
                | Record<string, unknown>
                | undefined;
              if (replicaMods != null && replicaMods['Status'] !== undefined) {
                sdkCriteria['ReplicaModifications'] = {
                  Status: replicaMods['Status'] as string,
                };
              }
              const sseKms = criteria['SseKmsEncryptedObjects'] as
                | Record<string, unknown>
                | undefined;
              if (sseKms != null && sseKms['Status'] !== undefined) {
                sdkCriteria['SseKmsEncryptedObjects'] = {
                  Status: sseKms['Status'] as string,
                };
              }
              if (Object.keys(sdkCriteria).length > 0) {
                sdkRule['SourceSelectionCriteria'] = sdkCriteria;
              }
            }

            // Filter (V2). An empty `Filter: {}` is the valid CFn "replicate every
            // object" form and MUST be preserved — S3's V2 replication schema
            // requires a `Filter` on every rule, so dropping the empty object
            // produces an invalid PutBucketReplication payload (the same element-
            // wise-transform-drops-a-valid-shape class as the lifecycle V1/V2 bug).
            const filter = rule['Filter'] as Record<string, unknown> | undefined;
            if (filter) {
              // CFn's ReplicationRuleFilter shapes, faithfully translated to the
              // S3 SDK shape (which differs only in `TagFilter`->`Tag` and
              // `And.TagFilters`->`And.Tags`):
              //   { And: { Prefix?, TagFilters[] } } <- the ONLY way CFn/CDK
              //       combine a prefix + tags (CDK's L2 emits this when a rule
              //       sets both `prefix` and `tags`). It was previously NOT read
              //       at all, so a combined filter silently fell through to the
              //       empty-filter branch below and replicated EVERY object
              //       instead of the prefix+tag subset (a silent scope-broadening
              //       divergence — same class as the lifecycle V1/V2 bug).
              //   { Prefix }     <- prefix-only
              //   { TagFilter }  <- single-tag-only
              //   {}             <- replicate-all (must be preserved; see #936)
              const and = filter['And'] as Record<string, unknown> | undefined;
              const prefix = filter['Prefix'] as string | undefined;
              const tagFilter = filter['TagFilter'] as { Key: string; Value: string } | undefined;
              if (and) {
                const andPrefix = and['Prefix'] as string | undefined;
                const andTags = and['TagFilters'] as
                  | Array<{ Key: string; Value: string }>
                  | undefined;
                const sdkAnd: Record<string, unknown> = {};
                if (andPrefix !== undefined) sdkAnd['Prefix'] = andPrefix;
                if (andTags !== undefined) sdkAnd['Tags'] = andTags;
                sdkRule['Filter'] = { And: sdkAnd };
              } else if (prefix !== undefined && tagFilter) {
                // Non-canonical template that put both at the top level; CFn
                // requires `And` to combine, but translate gracefully anyway.
                sdkRule['Filter'] = { And: { Prefix: prefix, Tags: [tagFilter] } };
              } else if (prefix !== undefined) {
                sdkRule['Filter'] = { Prefix: prefix };
              } else if (tagFilter) {
                sdkRule['Filter'] = { Tag: tagFilter };
              } else {
                // Empty / unrecognized filter object -> empty V2 filter (replicate all).
                sdkRule['Filter'] = {};
              }
            } else if (rule['Prefix'] !== undefined) {
              sdkRule['Prefix'] = rule['Prefix'] as string;
            }

            // DeleteMarkerReplication
            if (rule['DeleteMarkerReplication']) {
              const dmr = rule['DeleteMarkerReplication'] as Record<string, unknown>;
              sdkRule['DeleteMarkerReplication'] = { Status: dmr['Status'] as string };
            }

            return sdkRule;
          }),
        },
      })
    );
    this.logger.debug(`Applied replication configuration to bucket ${bucketName}`);
  }

  /**
   * Apply object lock configuration
   *
   * CFn property: ObjectLockConfiguration
   *   - ObjectLockEnabled: 'Enabled'
   *   - Rule.DefaultRetention (Mode, Days, Years)
   * SDK: PutObjectLockConfiguration with ObjectLockConfiguration
   *
   * Note: ObjectLockEnabled at bucket level must be set at creation time.
   * This method only applies the rule/default retention config post-creation.
   */
  private async applyObjectLockConfiguration(
    bucketName: string,
    config: Record<string, unknown>
  ): Promise<void> {
    const rule = config['Rule'] as Record<string, unknown> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objectLockConfig: any = {
      ObjectLockEnabled: 'Enabled',
    };
    if (rule) {
      const retention = rule['DefaultRetention'] as Record<string, unknown> | undefined;
      if (retention) {
        objectLockConfig.Rule = {
          DefaultRetention: {
            Mode: retention['Mode'] as string | undefined,
            Days: retention['Days'] as number | undefined,
            Years: retention['Years'] as number | undefined,
          },
        };
      }
    }
    await this.s3Client.send(
      new PutObjectLockConfigurationCommand({
        Bucket: bucketName,
        ObjectLockConfiguration: objectLockConfig,
      })
    );
    this.logger.debug(`Applied object lock configuration to bucket ${bucketName}`);
  }

  /**
   * Apply additional bucket configuration after creation.
   *
   * `options.skipDiffManaged` is passed by `update()` for the three
   * sub-configs that moved onto the diff path (`VersioningConfiguration` /
   * `OwnershipControls` / `BucketEncryption`, issue #1466). They stay here for
   * CREATE — where there is no previous side to diff against — but on UPDATE
   * they must go through `applySubConfigDiffs` so a REMOVED property is reset
   * to the CloudFormation default instead of silently surviving. Applying them
   * in both places would double-PUT.
   */
  private async applyConfiguration(
    bucketName: string,
    properties: Record<string, unknown>,
    options: { skipTags?: boolean; skipDiffManaged?: boolean } = {}
  ): Promise<void> {
    const { skipTags = false, skipDiffManaged = false } = options;

    // Versioning
    const versioningConfig = properties['VersioningConfiguration'];
    // `!= null`, not truthiness: a falsy non-object ('' / 0 / false) is
    // MALFORMED and must reach the apply call so create refuses it the same
    // way update does (issue #1471). A truthy check silently skipped it on
    // create only, and a truthy-but-malformed value ('Enabled') then had its
    // missing `Status` defaulted to Suspended. Same rationale as the
    // OwnershipControls / BucketEncryption gates below; nullish rather than
    // strict-undefined to match `diffSubConfig`'s treatment of a desired null.
    if (!skipDiffManaged && versioningConfig != null) {
      await this.applyVersioning(bucketName, versioningConfig);
    }

    // Tags. Only applied at create time here (`applyTags` is full-replace, no
    // removal). For update, the caller passes `skipTags=true` and uses the
    // diff-aware `applyTagDiff` helper instead.
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    if (!skipTags && tags && Array.isArray(tags) && tags.length > 0) {
      await this.applyTags(bucketName, tags);
    }

    // Ownership Controls (e.g., BucketOwnerPreferred for CloudFront logs)
    const ownershipControls = properties['OwnershipControls'] as
      | { Rules: Array<{ ObjectOwnership: string }> }
      | undefined;
    // Normalized so an empty `Rules: []` (the readCurrentState placeholder, or
    // a condition-pruned template) is treated as not-declared instead of
    // firing a Put that AWS 400s — mirroring the encryption branch below.
    const normalizedOwnership = S3BucketProvider.emptyListConfigToUndefined(
      ownershipControls,
      'Rules'
    );
    // `!== undefined`, not truthiness: a falsy non-object ('' / 0 / false) is
    // MALFORMED and must reach the apply call so create fails the same way
    // update does. A truthy check would silently skip it on create only.
    if (!skipDiffManaged && normalizedOwnership !== undefined) {
      await this.applyOwnershipControls(bucketName, normalizedOwnership);
    }

    // Public Access Block Configuration
    const publicAccessBlock = properties['PublicAccessBlockConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (publicAccessBlock) {
      await this.applyPublicAccessBlockConfiguration(bucketName, publicAccessBlock);
    }

    // Bucket Encryption. Skip empty-rules placeholder (Class 2): AWS
    // rejects `PutBucketEncryption` when the rules array is empty
    // (`ServerSideEncryptionConfiguration must contain at least one
    // Rule`). `readCurrentState` always-emits
    // `BucketEncryption: { ServerSideEncryptionConfiguration: [] }` for
    // buckets without explicit SSE — that placeholder must NOT be pushed
    // back through `update()` on a `cdkd drift --revert` round-trip.
    //
    // Routed through the SAME normalizer the update path uses, so create and
    // update agree on what "empty" means. The previous inline
    // `Array.isArray(...) && length > 0` guard silently SKIPPED a malformed
    // value on create (leaving the bucket unencrypted-by-declaration with no
    // error and nothing for drift to see) while update failed loudly on it.
    const normalizedEncryption = S3BucketProvider.emptyListConfigToUndefined(
      properties['BucketEncryption'] as
        | { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
        | undefined,
      'ServerSideEncryptionConfiguration'
    );
    if (!skipDiffManaged && normalizedEncryption !== undefined) {
      await this.applyBucketEncryption(bucketName, normalizedEncryption);
    }
  }

  /**
   * CFn property: OwnershipControls
   * SDK: PutBucketOwnershipControls
   */
  private async applyOwnershipControls(
    bucketName: string,
    ownershipControls: { Rules: Array<{ ObjectOwnership: string }> }
  ): Promise<void> {
    // A malformed value reaches here by design (the normalizer passes it
    // through rather than reading it as a removal). Name the property instead
    // of letting `.map` throw a bare "Cannot read properties of undefined".
    if (!Array.isArray(ownershipControls?.Rules)) {
      throw new Error(
        `OwnershipControls.Rules must be an array (got ` +
          `${ownershipControls?.Rules === undefined ? 'undefined' : typeof ownershipControls.Rules}` +
          `) — check for an unresolved intrinsic or a mis-nested template value`
      );
    }
    await this.s3Client.send(
      new PutBucketOwnershipControlsCommand({
        Bucket: bucketName,
        OwnershipControls: {
          Rules: ownershipControls.Rules.map((r) => ({
            ObjectOwnership: r.ObjectOwnership as ObjectOwnership,
          })),
        },
      })
    );
    this.logger.debug(`Applied ownership controls to bucket ${bucketName}`);
  }

  /**
   * Normalize an "empty container" sub-config value to `undefined` so the diff
   * path cannot mistake a placeholder for a real value.
   *
   * `readCurrentState` always-emits placeholder shapes for un-configured
   * features (`BucketEncryption: { ServerSideEncryptionConfiguration: [] }`,
   * and the `OwnershipControls: { Rules: [] }` added with issue #1466), and a
   * `cdkd drift --revert` round-trip feeds those back through `update()`.
   *
   * The rule is "empty container == not declared", applied to BOTH sides. Per
   * pairing that means:
   *   empty desired  + absent previous -> no call (without this, a Put with an
   *                                      empty list, which both APIs reject)
   *   absent desired + empty previous  -> no call (without this, a Delete
   *                                      against a bucket that never had it)
   *   empty desired  + REAL previous   -> Delete. This one is NOT suppressed
   *                                      and must not be: it is a genuine
   *                                      declared -> not-declared transition,
   *                                      which is exactly what CloudFormation
   *                                      removes.
   *
   * "Empty" is deliberately NARROW. Only two shapes fold to `undefined`:
   * a block with NO keys at all (`{}`), and a block whose list key holds an
   * empty array. Everything else — a non-object, an array where the object
   * belongs (wrong nesting), a block whose list key is absent but which
   * carries OTHER keys, or a non-array list (an unresolved intrinsic) — is
   * MALFORMED, not empty, and passes through so the apply call refuses it by
   * name. Folding any of those to `undefined` would emit a Delete and
   * silently downgrade a live bucket (KMS -> AES256) while the template still
   * declares the config.
   *
   * NOTE this helper does NOT cover `VersioningConfiguration` (it has no list
   * key). That property is malformed-shape-refused separately, by
   * `readConfigString` in `applyVersioning` + `applySubConfigDiffs`
   * (issue #1471) — same outcome, different mechanism, because a versioning
   * block has an inner FIELD to validate rather than a list to measure.
   */
  private static emptyListConfigToUndefined<T extends Record<string, unknown>>(
    config: T | undefined,
    listKey: string
  ): T | undefined {
    if (config === undefined || config === null) return undefined;
    // A non-object (or an array where an object belongs -- the wrong-nesting
    // shape a hand-written L1 template produces) is MALFORMED, not empty.
    if (typeof config !== 'object' || Array.isArray(config)) return config;

    const list = config[listKey];
    if (list === undefined || list === null) {
      // The list key is absent. That is "not declared" ONLY when the block
      // carries nothing else; a block with OTHER keys is malformed or
      // partially pruned and must NOT be read as a removal.
      return Object.keys(config).length === 0 ? undefined : config;
    }
    // Genuinely empty list == not declared (the readCurrentState placeholder).
    if (Array.isArray(list) && list.length === 0) return undefined;
    // Non-array list (an unresolved intrinsic) is malformed -- pass through.
    return config;
  }

  /**
   * Diff CFn-shape sub-config values between previous and new state.
   *
   * Four transitions:
   * - undefined -> defined  (value differs from previous, OR previous undefined): Put
   * - defined -> undefined: Delete
   * - defined -> defined (different): Put
   * - unchanged: skip
   *
   * For the array-shaped configs (Metrics / Analytics / IntelligentTier /
   * Inventory) this is per-id rather than per-config — see the dedicated
   * helpers below.
   */
  private async diffSubConfig<T>(
    _bucketName: string,
    oldVal: T | undefined,
    newVal: T | undefined,
    onPut: (newVal: T) => Promise<void>,
    onDelete: () => Promise<void>
  ): Promise<void> {
    const same = JSON.stringify(oldVal ?? null) === JSON.stringify(newVal ?? null);
    if (same) return;
    if (newVal === undefined || newVal === null) {
      await onDelete();
      return;
    }
    await onPut(newVal);
  }

  /**
   * Per-id diff for the four array-shaped configs (MetricsConfigurations,
   * AnalyticsConfigurations, IntelligentTieringConfigurations,
   * InventoryConfigurations). Each AWS API operates on one config per
   * (bucket, id) pair: Put-on-add or Put-on-change, Delete-on-removed.
   */
  private async diffArrayConfigById(
    _bucketName: string,
    oldArr: Array<Record<string, unknown>> | undefined,
    newArr: Array<Record<string, unknown>> | undefined,
    onPut: (id: string, config: Record<string, unknown>) => Promise<void>,
    onDelete: (id: string) => Promise<void>
  ): Promise<void> {
    const oldById = new Map<string, Record<string, unknown>>();
    for (const c of oldArr ?? []) {
      const id = c['Id'] as string | undefined;
      if (id) oldById.set(id, c);
    }
    const newById = new Map<string, Record<string, unknown>>();
    for (const c of newArr ?? []) {
      const id = c['Id'] as string | undefined;
      if (id) newById.set(id, c);
    }

    // Adds + changes
    for (const [id, cfg] of newById) {
      const old = oldById.get(id);
      if (!old || JSON.stringify(old) !== JSON.stringify(cfg)) {
        await onPut(id, cfg);
      }
    }
    // Deletes
    for (const id of oldById.keys()) {
      if (!newById.has(id)) {
        await onDelete(id);
      }
    }
  }

  /**
   * Apply the diff between previous and new sub-configs, issuing Put / Delete
   * SDK calls only for differing keys. Called from `update()`.
   *
   * PublicAccessBlockConfiguration and Tags stay on `applyConfiguration` /
   * `applyTagDiff`. `PublicAccessBlockConfiguration` is deliberately NOT on the
   * diff path: a live CloudFormation A/B (issue #1466) confirmed CFn ALSO
   * leaves the block in place when the property is removed, so cdkd is at
   * parity and adding an `onRemove` here would CREATE a divergence.
   *
   * VersioningConfiguration / OwnershipControls / BucketEncryption used to sit
   * on that always-PUT path too, on the assumption that their APIs had no clean
   * "delete" counterpart. That was wrong in all three cases and made removal a
   * silent no-op (issue #1466): the same A/B showed CFn suspends versioning,
   * deletes ownership controls, and resets encryption to the SSE-S3 default.
   * They are now diffed here like every other Put/Delete pair.
   */
  private async applySubConfigDiffs(
    bucketName: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<void> {
    // Versioning is split by RESULTING STATUS, not by transition kind.
    //
    // S3 rejects PutBucketVersioning(Suspended) while a replication
    // configuration is still active, so EVERY path that lands on 'Suspended'
    // must run after the replication diff below -- both the removal
    // (property dropped => CFn resets to Suspended) AND an explicit
    // `{ Status: 'Suspended' }` in the template. Deferring only the removal
    // would leave the explicit form on the early path and hit exactly the S3
    // rejection this split exists to avoid; `cdkd drift --revert` reaches that
    // form routinely, because `readCurrentState` always emits
    // `{ Status: 'Suspended' }` for an un-versioned bucket.
    //
    // The ENABLE direction stays early: an ADDED replication configuration
    // requires versioning to already be on.
    const previousVersioning = previousProperties['VersioningConfiguration'] as
      | Record<string, unknown>
      | undefined;
    const nextVersioning = properties['VersioningConfiguration'] as
      | Record<string, unknown>
      | undefined;
    // Nullish (not strict-undefined) to match `diffSubConfig`'s own semantics;
    // a desired `null` is a removal there, so it must be one here too.
    const versioningChanged =
      JSON.stringify(previousVersioning ?? null) !== JSON.stringify(nextVersioning ?? null);
    // An absent (or `{}`) VersioningConfiguration means Suspended, so the
    // effective desired status is what decides which side of the split runs.
    // Guarded on the DESIRED side only (issue #1471): `previousVersioning`
    // comes from cdkd state, and refusing a malformed value there would make a
    // stack whose state already holds one permanently undeployable. It is only
    // compared as a whole above, never field-read, so it stays permissive.
    // Computing this BEFORE `applyVersioning` is load-bearing — a malformed
    // desired value used to resolve to 'Suspended' here and take the SUSPEND
    // branch below, turning versioning off on a live bucket.
    const desiredVersioningStatus = readConfigString(
      nextVersioning,
      'Status',
      'Suspended',
      'AWS::S3::Bucket VersioningConfiguration'
    );

    // `nextVersioning != null` is implied by the status check (a null value
    // resolves to 'Suspended'); it is kept for TypeScript's narrowing.
    if (versioningChanged && nextVersioning != null && desiredVersioningStatus !== 'Suspended') {
      await this.applyVersioning(bucketName, nextVersioning);
    }

    // Ownership controls (per-id-free single config; empty Rules == absent)
    await this.diffSubConfig(
      bucketName,
      S3BucketProvider.emptyListConfigToUndefined(
        previousProperties['OwnershipControls'] as
          | { Rules: Array<{ ObjectOwnership: string }> }
          | undefined,
        'Rules'
      ),
      S3BucketProvider.emptyListConfigToUndefined(
        properties['OwnershipControls'] as
          | { Rules: Array<{ ObjectOwnership: string }> }
          | undefined,
        'Rules'
      ),
      async (cfg) => this.applyOwnershipControls(bucketName, cfg),
      async () => {
        await this.s3Client.send(new DeleteBucketOwnershipControlsCommand({ Bucket: bucketName }));
        this.logger.debug(`Deleted ownership controls on bucket ${bucketName}`);
      }
    );

    // Bucket encryption (empty ServerSideEncryptionConfiguration == absent;
    // DeleteBucketEncryption reverts the bucket to the SSE-S3 / AES256 default)
    await this.diffSubConfig(
      bucketName,
      S3BucketProvider.emptyListConfigToUndefined(
        previousProperties['BucketEncryption'] as
          | { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
          | undefined,
        'ServerSideEncryptionConfiguration'
      ),
      S3BucketProvider.emptyListConfigToUndefined(
        properties['BucketEncryption'] as
          | { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
          | undefined,
        'ServerSideEncryptionConfiguration'
      ),
      async (cfg) => this.applyBucketEncryption(bucketName, cfg),
      async () => {
        await this.s3Client.send(new DeleteBucketEncryptionCommand({ Bucket: bucketName }));
        this.logger.debug(`Deleted bucket encryption on bucket ${bucketName}`);
      }
    );

    // Lifecycle
    await this.diffSubConfig(
      bucketName,
      previousProperties['LifecycleConfiguration'] as
        | { Rules: Array<Record<string, unknown>> }
        | undefined,
      properties['LifecycleConfiguration'] as { Rules: Array<Record<string, unknown>> } | undefined,
      async (cfg) => {
        // Skip empty-rules placeholder (Class 2)
        if (!cfg.Rules || !Array.isArray(cfg.Rules) || cfg.Rules.length === 0) return;
        // WARN, never throw, on the update path (issue #1579) — same
        // rationale as the analytics sibling below.
        await this.applyLifecycleConfiguration(bucketName, cfg, (m) => this.logger.warn(m));
      },
      async () => {
        await this.s3Client.send(new DeleteBucketLifecycleCommand({ Bucket: bucketName }));
        this.logger.debug(`Deleted lifecycle configuration on bucket ${bucketName}`);
      }
    );

    // CORS
    await this.diffSubConfig(
      bucketName,
      previousProperties['CorsConfiguration'] as
        | { CorsRules: Array<Record<string, unknown>> }
        | undefined,
      properties['CorsConfiguration'] as { CorsRules: Array<Record<string, unknown>> } | undefined,
      async (cfg) => {
        // Skip empty-rules placeholder (Class 2)
        if (!cfg.CorsRules || !Array.isArray(cfg.CorsRules) || cfg.CorsRules.length === 0) return;
        await this.applyCorsConfiguration(bucketName, cfg);
      },
      async () => {
        await this.s3Client.send(new DeleteBucketCorsCommand({ Bucket: bucketName }));
        this.logger.debug(`Deleted CORS configuration on bucket ${bucketName}`);
      }
    );

    // Website
    await this.diffSubConfig(
      bucketName,
      previousProperties['WebsiteConfiguration'] as Record<string, unknown> | undefined,
      properties['WebsiteConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => this.applyWebsiteConfiguration(bucketName, cfg),
      async () => {
        await this.s3Client.send(new DeleteBucketWebsiteCommand({ Bucket: bucketName }));
        this.logger.debug(`Deleted website configuration on bucket ${bucketName}`);
      }
    );

    // Logging — no DeleteBucketLogging API; clearing is via PutBucketLogging
    // with empty BucketLoggingStatus.
    await this.diffSubConfig(
      bucketName,
      previousProperties['LoggingConfiguration'] as Record<string, unknown> | undefined,
      properties['LoggingConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => this.applyLoggingConfiguration(bucketName, cfg),
      async () => this.applyLoggingConfiguration(bucketName, undefined)
    );

    // Notification — no DeleteBucketNotification API; clearing is via
    // PutBucketNotificationConfiguration with empty NotificationConfiguration.
    await this.diffSubConfig(
      bucketName,
      previousProperties['NotificationConfiguration'] as Record<string, unknown> | undefined,
      properties['NotificationConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => this.applyNotificationConfiguration(bucketName, cfg),
      async () => this.applyNotificationConfiguration(bucketName, undefined)
    );

    // Replication
    await this.diffSubConfig(
      bucketName,
      previousProperties['ReplicationConfiguration'] as Record<string, unknown> | undefined,
      properties['ReplicationConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => this.applyReplicationConfiguration(bucketName, cfg),
      async () => {
        await this.s3Client.send(new DeleteBucketReplicationCommand({ Bucket: bucketName }));
        this.logger.debug(`Deleted replication configuration on bucket ${bucketName}`);
      }
    );

    // Object Lock — no DeleteObjectLockConfiguration API; the bucket-level
    // ObjectLockEnabled flag is set at creation time and cannot be cleared
    // via Put. The Rule (default retention) can be reset via Put with no
    // Rule, so a transition from "configured" -> undefined just sends an
    // empty-Rule Put. AWS accepts this for buckets that already have
    // ObjectLockEnabled.
    await this.diffSubConfig(
      bucketName,
      previousProperties['ObjectLockConfiguration'] as Record<string, unknown> | undefined,
      properties['ObjectLockConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => this.applyObjectLockConfiguration(bucketName, cfg),
      async () => {
        await this.s3Client.send(
          new PutObjectLockConfigurationCommand({
            Bucket: bucketName,
            ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
          })
        );
        this.logger.debug(`Cleared object lock rule on bucket ${bucketName}`);
      }
    );

    // Accelerate — no DeleteBucketAccelerate API; clearing is via
    // PutBucketAccelerateConfiguration with Status='Suspended'.
    await this.diffSubConfig(
      bucketName,
      previousProperties['AccelerateConfiguration'] as Record<string, unknown> | undefined,
      properties['AccelerateConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => this.applyAccelerateConfiguration(bucketName, cfg),
      async () => this.applyAccelerateConfiguration(bucketName, { AccelerationStatus: 'Suspended' })
    );

    // Metrics (per-id diff)
    await this.diffArrayConfigById(
      bucketName,
      previousProperties['MetricsConfigurations'] as Array<Record<string, unknown>> | undefined,
      properties['MetricsConfigurations'] as Array<Record<string, unknown>> | undefined,
      // WARN, never throw, on the update path (issue #1579) — same rationale
      // as the analytics sibling below.
      async (_id, cfg) =>
        this.applyMetricsConfigurations(bucketName, [cfg], (m) => this.logger.warn(m)),
      async (id) => {
        await this.s3Client.send(
          new DeleteBucketMetricsConfigurationCommand({ Bucket: bucketName, Id: id })
        );
        this.logger.debug(`Deleted metrics configuration ${id} on bucket ${bucketName}`);
      }
    );

    // Analytics (per-id diff)
    await this.diffArrayConfigById(
      bucketName,
      previousProperties['AnalyticsConfigurations'] as Array<Record<string, unknown>> | undefined,
      properties['AnalyticsConfigurations'] as Array<Record<string, unknown>> | undefined,
      // WARN, never throw, on the update path: `rollback-executor.ts` and
      // `drift --revert` replay `update()` with a historical cdkd STATE record
      // as the desired bag, so a refusal here would strand the resource with no
      // template-side remedy (issue #1493 item 2).
      async (_id, cfg) =>
        this.applyAnalyticsConfigurations(bucketName, [cfg], (m) => this.logger.warn(m)),
      async (id) => {
        await this.s3Client.send(
          new DeleteBucketAnalyticsConfigurationCommand({ Bucket: bucketName, Id: id })
        );
        this.logger.debug(`Deleted analytics configuration ${id} on bucket ${bucketName}`);
      }
    );

    // IntelligentTiering (per-id diff)
    await this.diffArrayConfigById(
      bucketName,
      previousProperties['IntelligentTieringConfigurations'] as
        | Array<Record<string, unknown>>
        | undefined,
      properties['IntelligentTieringConfigurations'] as Array<Record<string, unknown>> | undefined,
      // WARN, never throw, on the update path (issue #1579) — same rationale
      // as the analytics sibling above.
      async (_id, cfg) =>
        this.applyIntelligentTieringConfigurations(bucketName, [cfg], (m) => this.logger.warn(m)),
      async (id) => {
        await this.s3Client.send(
          new DeleteBucketIntelligentTieringConfigurationCommand({
            Bucket: bucketName,
            Id: id,
          })
        );
        this.logger.debug(
          `Deleted intelligent tiering configuration ${id} on bucket ${bucketName}`
        );
      }
    );

    // Inventory (per-id diff)
    await this.diffArrayConfigById(
      bucketName,
      previousProperties['InventoryConfigurations'] as Array<Record<string, unknown>> | undefined,
      properties['InventoryConfigurations'] as Array<Record<string, unknown>> | undefined,
      // Same update-path warn as the analytics sibling above.
      async (_id, cfg) =>
        this.applyInventoryConfigurations(bucketName, [cfg], (m) => this.logger.warn(m)),
      async (id) => {
        await this.s3Client.send(
          new DeleteBucketInventoryConfigurationCommand({ Bucket: bucketName, Id: id })
        );
        this.logger.debug(`Deleted inventory configuration ${id} on bucket ${bucketName}`);
      }
    );

    // Versioning SUSPEND — deferred to LAST on purpose (issue #1466); see the
    // split rationale at the top of this method.
    if (versioningChanged && desiredVersioningStatus === 'Suspended') {
      // Object Lock structurally forbids suspending versioning
      // (`InvalidBucketState`), so this is un-actionable rather than a
      // divergence — warn instead of failing the deploy, which is what an
      // unconditional suspend would newly do here.
      //
      // BOTH sides are consulted: `ObjectLockEnabled` is not classified as a
      // replacement-forcing property for AWS::S3::Bucket, so a template that
      // drops `ObjectLockEnabled` and `VersioningConfiguration` together takes
      // the in-place UPDATE path. Reading only the desired side would see no
      // Object Lock and issue the suspend the live bucket still refuses.
      // Test the MEANINGFUL field, never mere presence of the block.
      // `readObjectLock` always-emits `ObjectLockConfiguration` and returns
      // `{}` for a bucket with no object lock, and `cdkd drift --revert` feeds
      // that snapshot in as BOTH sides — so a presence check
      // (`!== undefined`) is true for EVERY bucket on the revert path and
      // would suppress every legitimate suspend, leaving the drift
      // unfixable and warning about object lock the bucket does not have.
      const hasObjectLock = (p: Record<string, unknown>): boolean => {
        if (p['ObjectLockEnabled'] === true || p['ObjectLockEnabled'] === 'true') return true;
        const cfg = p['ObjectLockConfiguration'] as Record<string, unknown> | undefined;
        return cfg?.['ObjectLockEnabled'] === 'Enabled';
      };
      if (hasObjectLock(properties) || hasObjectLock(previousProperties)) {
        this.logger.warn(
          `Bucket ${bucketName}: versioning would be suspended (VersioningConfiguration removed ` +
            `or set to Suspended), but the bucket has Object Lock enabled and S3 does not allow ` +
            `suspending versioning on it. Leaving versioning enabled.`
        );
      } else {
        await this.applyVersioning(bucketName, { Status: 'Suspended' });
      }
    }
  }

  /**
   * Apply ALL sub-configs unconditionally on initial create. Used by
   * `create()` so the bucket starts out matching the template.
   */
  private async applyAllSubConfigsForCreate(
    bucketName: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<void> {
    // `create()` is NOT always template-borne: `rollback-executor.ts`'s
    // reverse-replacement arm revives the OLD resource by calling
    // `create(..., previousState.properties, REPLAYING_STATE_CREATE_CONTEXT)`.
    // A bucket whose STATE record carries a malformed destination (written by
    // a pre-fix binary) would otherwise be unrestorable, with only a hand-edit
    // of state.json as a remedy — which is what `.claude/rules/providers.md`
    // requires a create-side pre-flight refusal to downgrade for.
    const replayOnUnusable = replayWarn(this.logger, context).onUnusable;
    // Notification (with EventBridge gate kept for backwards-compat with the
    // pre-existing single-EventBridge create path)
    const notifConfig = properties['NotificationConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (notifConfig) {
      await this.applyNotificationConfiguration(bucketName, notifConfig);
    }

    // CORS — skip empty-rules placeholder
    const corsConfig = properties['CorsConfiguration'] as
      | { CorsRules: Array<Record<string, unknown>> }
      | undefined;
    if (
      corsConfig?.CorsRules &&
      Array.isArray(corsConfig.CorsRules) &&
      corsConfig.CorsRules.length > 0
    ) {
      await this.applyCorsConfiguration(bucketName, corsConfig);
    }

    // Lifecycle — skip empty-rules placeholder
    const lifecycleConfig = properties['LifecycleConfiguration'] as
      | { Rules: Array<Record<string, unknown>> }
      | undefined;
    if (
      lifecycleConfig?.Rules &&
      Array.isArray(lifecycleConfig.Rules) &&
      lifecycleConfig.Rules.length > 0
    ) {
      await this.applyLifecycleConfiguration(bucketName, lifecycleConfig, replayOnUnusable);
    }

    // Logging
    const loggingConfig = properties['LoggingConfiguration'];
    // Shape-check the container BEFORE the has-a-destination gate (issue
    // #1471): the old `loggingConfig?.['DestinationBucketName']` test indexed a
    // malformed value to `undefined` and silently skipped the whole block, so
    // a bucket whose template declares logging came up with none. Absent /
    // `{}` still resolve to '' and skip, which is the legitimate no-logging
    // path — this adds a refusal, not an extra API call.
    const loggingDestination = readConfigString(
      loggingConfig,
      'DestinationBucketName',
      '',
      'AWS::S3::Bucket LoggingConfiguration'
    );
    if (loggingDestination !== '') {
      await this.applyLoggingConfiguration(bucketName, loggingConfig);
    }

    // Website
    const websiteConfig = properties['WebsiteConfiguration'] as Record<string, unknown> | undefined;
    if (websiteConfig) {
      await this.applyWebsiteConfiguration(bucketName, websiteConfig);
    }

    // Accelerate
    const accelerateConfig = properties['AccelerateConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (accelerateConfig) {
      await this.applyAccelerateConfiguration(bucketName, accelerateConfig);
    }

    // Metrics Configurations
    const metricsConfigs = properties['MetricsConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (metricsConfigs && Array.isArray(metricsConfigs) && metricsConfigs.length > 0) {
      await this.applyMetricsConfigurations(bucketName, metricsConfigs, replayOnUnusable);
    }

    // Analytics Configurations
    const analyticsConfigs = properties['AnalyticsConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (analyticsConfigs && Array.isArray(analyticsConfigs) && analyticsConfigs.length > 0) {
      await this.applyAnalyticsConfigurations(bucketName, analyticsConfigs, replayOnUnusable);
    }

    // Intelligent Tiering Configurations
    const itConfigs = properties['IntelligentTieringConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (itConfigs && Array.isArray(itConfigs) && itConfigs.length > 0) {
      await this.applyIntelligentTieringConfigurations(bucketName, itConfigs, replayOnUnusable);
    }

    // Inventory Configurations
    const inventoryConfigs = properties['InventoryConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (inventoryConfigs && Array.isArray(inventoryConfigs) && inventoryConfigs.length > 0) {
      await this.applyInventoryConfigurations(bucketName, inventoryConfigs, replayOnUnusable);
    }

    // Replication Configuration
    const replConfig = properties['ReplicationConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (replConfig) {
      await this.applyReplicationConfiguration(bucketName, replConfig);
    }

    // Object Lock Configuration (rule/retention, not the ObjectLockEnabled flag)
    const objectLockConfig = properties['ObjectLockConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (objectLockConfig) {
      await this.applyObjectLockConfiguration(bucketName, objectLockConfig);
    }
  }

  /**
   * Create an S3 bucket
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 bucket ${logicalId}`);

    const bucketName =
      (properties['BucketName'] as string | undefined) ||
      generateResourceName(logicalId, {
        maxLength: 63,
        lowercase: true,
        allowedPattern: /[^a-z0-9.-]/g,
      });

    try {
      // CreateBucket params
      const createParams: {
        Bucket: string;
        CreateBucketConfiguration?: { LocationConstraint: BucketLocationConstraint };
        ObjectLockEnabledForBucket?: boolean;
      } = {
        Bucket: bucketName,
      };

      // Add LocationConstraint for non-us-east-1 regions
      const region = await this.getRegion();
      if (region !== 'us-east-1') {
        createParams.CreateBucketConfiguration = {
          LocationConstraint: region as BucketLocationConstraint,
        };
      }

      // ObjectLockEnabled must be set at bucket creation time
      if (properties['ObjectLockEnabled'] === true || properties['ObjectLockEnabled'] === 'true') {
        createParams.ObjectLockEnabledForBucket = true;
      }

      // Track whether THIS call actually created the bucket (vs hit the
      // idempotent `BucketAlreadyOwnedByYou` fallback). Only the truly-
      // created case is eligible for partial-failure cleanup — deleting a
      // pre-existing bucket would destroy a user resource that lived
      // before this deploy ran.
      let createdNewBucket = false;
      try {
        await this.s3Client.send(new CreateBucketCommand(createParams));
        createdNewBucket = true;
        this.logger.debug(`Created S3 bucket: ${bucketName}`);
      } catch (createError) {
        // "BucketAlreadyOwnedByYou" is success (idempotent create)
        if (
          createError instanceof Error &&
          (createError.name === 'BucketAlreadyOwnedByYou' ||
            createError.message.includes('you already own it'))
        ) {
          this.logger.debug(`S3 bucket ${bucketName} already exists and is owned by you`);
        } else {
          throw createError;
        }
      }

      // Apply additional configuration in an inner try so a wiring
      // failure can be self-healed by issuing a best-effort `DeleteBucket`
      // cleanup. Without this, a sub-config failure leaves an orphan
      // bucket that AWS will reject on the next redeploy. The cleanup
      // is gated on `createdNewBucket` so we never delete a pre-existing
      // bucket. See Issue #376 for the cross-provider sweep.
      try {
        await this.applyConfiguration(bucketName, properties);
        await this.applyAllSubConfigsForCreate(bucketName, properties, context);
      } catch (innerError) {
        if (createdNewBucket) {
          try {
            await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
            this.logger.debug(
              `Cleaned up partially-created S3 bucket ${logicalId} (${bucketName}) after wiring failure`
            );
          } catch (cleanupError) {
            this.logger.warn(
              `Failed to clean up partially-created S3 bucket ${logicalId} (${bucketName}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws s3api delete-bucket --bucket '${bucketName}'`
            );
          }
        }
        throw innerError;
      }

      const attributes = await this.buildAttributes(bucketName);

      this.logger.debug(`Successfully created S3 bucket ${logicalId}: ${bucketName}`);

      return {
        physicalId: bucketName,
        attributes,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create S3 bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        bucketName,
        cause
      );
    }
  }

  /**
   * Update an S3 bucket
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating S3 bucket ${logicalId}: ${physicalId}`);

    const newBucketName = properties['BucketName'] as string | undefined;

    // Bucket name is immutable - if changed, requires replacement
    if (newBucketName && newBucketName !== physicalId) {
      this.logger.debug(
        `Bucket name changed (${physicalId} -> ${newBucketName}), replacement required`
      );
      return {
        physicalId,
        wasReplaced: true,
      };
    }

    try {
      // Apply configuration changes. Tags are skipped because
      // `applyConfiguration` only adds and never removes (handled by
      // `applyTagDiff` below), and the three diff-managed sub-configs
      // (Versioning / OwnershipControls / BucketEncryption) are skipped
      // because `applySubConfigDiffs` owns them on the UPDATE path so that
      // REMOVING one resets it like CloudFormation does (issue #1466).
      // What is left on the always-PUT path here is
      // `PublicAccessBlockConfiguration`, which is at CFn parity.
      await this.applyConfiguration(physicalId, properties, {
        skipTags: true,
        skipDiffManaged: true,
      });

      // Apply diff-aware Put/Delete for the sub-configs that have proper
      // Put/Delete API pairs.
      await this.applySubConfigDiffs(physicalId, properties, previousProperties);

      // Apply tag diff. S3 uses PutBucketTagging (full-replace) and
      // DeleteBucketTagging when the new tag set is empty.
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      const attributes = await this.buildAttributes(physicalId);

      this.logger.debug(`Successfully updated S3 bucket ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update S3 bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an S3 bucket
   *
   * Note: The bucket must be empty before deletion.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting S3 bucket ${logicalId}: ${physicalId}`);

    // CloudFormation-parity data guard (issue #1340): a non-empty bucket is
    // only auto-emptied when the user opted in — CDK's `autoDeleteObjects`
    // tag on the bucket, or the deploy engine's `--force-stateful-recreation`
    // consent on a replacement delete. Otherwise the not-empty error
    // surfaces exactly like CloudFormation's DELETE_FAILED.
    const allowAutoEmpty =
      context?.forceDataDelete === true ||
      hasCdkAutoDeleteTag(properties, S3_AUTO_DELETE_OBJECTS_TAG);

    try {
      await this.deleteBucketWithEmptyRetry(logicalId, physicalId, allowAutoEmpty);
    } catch (error) {
      if (error instanceof NoSuchBucket) {
        const clientRegion = await this.s3Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Bucket ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete S3 bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current S3 bucket configuration in CFn-property shape.
   *
   * Issues a small handful of independent S3 GET calls and stitches them
   * into a single CFn-shaped object. Each call can throw a "feature not
   * configured" error (`NoSuchBucketConfiguration`,
   * `ServerSideEncryptionConfigurationNotFoundError`, `NoSuchTagSet`,
   * `NoSuchPublicAccessBlockConfiguration`, etc.) — those are caught
   * individually and the corresponding key is emitted as a CFn-shape
   * placeholder (per docs/provider-development.md § 3b: always-emit
   * user-controllable top-level keys), NOT treated as the bucket being
   * absent.
   *
   * Only the bucket-gone case (`NoSuchBucket`, HTTP 404 from `HeadBucket`)
   * returns `undefined`.
   *
   * Coverage: `BucketName`, `VersioningConfiguration`, `BucketEncryption`,
   * `OwnershipControls`, `PublicAccessBlockConfiguration`, `Tags`, plus all 12
   * sub-configs:
   * `LifecycleConfiguration`, `CorsConfiguration`, `WebsiteConfiguration`,
   * `LoggingConfiguration`, `NotificationConfiguration`,
   * `ReplicationConfiguration`, `ObjectLockConfiguration`,
   * `AccelerateConfiguration`, `MetricsConfigurations`,
   * `AnalyticsConfigurations`, `IntelligentTieringConfigurations`,
   * `InventoryConfigurations`.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    // Fast existence check. Treat NotFound / NoSuchBucket as "drift unknown".
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: physicalId }));
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (
        err instanceof NoSuchBucket ||
        e.name === 'NotFound' ||
        e.name === 'NoSuchBucket' ||
        e.$metadata?.httpStatusCode === 404
      ) {
        return undefined;
      }
      throw err;
    }

    // Fire all 16 GET / List calls in parallel. Each helper handles its own
    // "feature not configured" → placeholder fallback.
    const [
      versioning,
      encryption,
      ownership,
      pab,
      tags,
      lifecycle,
      cors,
      website,
      logging,
      notification,
      replication,
      objectLock,
      accelerate,
      metrics,
      analytics,
      intelligentTier,
      inventory,
    ] = await Promise.all([
      this.readVersioning(physicalId),
      this.readEncryption(physicalId),
      this.readOwnershipControls(physicalId),
      this.readPublicAccessBlock(physicalId),
      this.readTags(physicalId),
      this.readLifecycle(physicalId),
      this.readCors(physicalId),
      this.readWebsite(physicalId),
      this.readLogging(physicalId),
      this.readNotification(physicalId),
      this.readReplication(physicalId),
      this.readObjectLock(physicalId),
      this.readAccelerate(physicalId),
      this.readMetricsList(physicalId),
      this.readAnalyticsList(physicalId),
      this.readIntelligentTieringList(physicalId),
      this.readInventoryList(physicalId),
    ]);

    return {
      BucketName: physicalId,
      VersioningConfiguration: versioning,
      BucketEncryption: encryption,
      OwnershipControls: ownership,
      PublicAccessBlockConfiguration: pab,
      Tags: tags,
      LifecycleConfiguration: lifecycle,
      CorsConfiguration: cors,
      WebsiteConfiguration: website,
      LoggingConfiguration: logging,
      NotificationConfiguration: notification,
      ReplicationConfiguration: replication,
      ObjectLockConfiguration: objectLock,
      AccelerateConfiguration: accelerate,
      MetricsConfigurations: metrics,
      AnalyticsConfigurations: analytics,
      IntelligentTieringConfigurations: intelligentTier,
      InventoryConfigurations: inventory,
    };
  }

  // -------------------------------------------------------------------
  // readCurrentState helpers — one per sub-config. Each catches the
  // "feature not configured" error and returns the always-emit
  // placeholder shape per docs/provider-development.md § 3b.
  // -------------------------------------------------------------------

  private async readVersioning(bucket: string): Promise<Record<string, unknown>> {
    // VersioningConfiguration { Status }. Always emit a placeholder so a
    // console-side enable on a never-versioned bucket surfaces as drift.
    // 'Suspended' is the semantic "off" value in CFn.
    const resp = await this.s3Client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    return { Status: resp.Status ?? 'Suspended' };
  }

  /**
   * OwnershipControls { Rules: [{ ObjectOwnership }] }. Always emit a
   * placeholder (empty `Rules`) so a console-side change on a bucket that
   * declares the property surfaces as drift. Added with issue #1466 — without
   * a read here, `cdkd drift` could not see ownership controls at all, which
   * is why the removal bug that issue fixes produced no signal from ANY
   * command.
   */
  private async readOwnershipControls(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(
        new GetBucketOwnershipControlsCommand({ Bucket: bucket })
      );
      return {
        Rules: (resp.OwnershipControls?.Rules ?? []).map((r) => ({
          ObjectOwnership: r.ObjectOwnership,
        })),
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'OwnershipControlsNotFoundError') {
        return { Rules: [] };
      }
      throw err;
    }
  }

  private async readEncryption(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
      const rules = resp.ServerSideEncryptionConfiguration?.Rules ?? [];
      return {
        ServerSideEncryptionConfiguration: rules.map((rule) => {
          const out: Record<string, unknown> = {};
          const sse = rule.ApplyServerSideEncryptionByDefault;
          if (sse) {
            const sseOut: Record<string, unknown> = {};
            if (sse.SSEAlgorithm !== undefined) sseOut['SSEAlgorithm'] = sse.SSEAlgorithm;
            if (sse.KMSMasterKeyID !== undefined) sseOut['KMSMasterKeyID'] = sse.KMSMasterKeyID;
            out['ServerSideEncryptionByDefault'] = sseOut;
          }
          if (rule.BucketKeyEnabled !== undefined) out['BucketKeyEnabled'] = rule.BucketKeyEnabled;
          // Issue #1495: read back the block the write side now sends.
          if (rule.BlockedEncryptionTypes?.EncryptionType !== undefined) {
            out['BlockedEncryptionTypes'] = {
              EncryptionType: rule.BlockedEncryptionTypes.EncryptionType,
            };
          }
          return out;
        }),
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'ServerSideEncryptionConfigurationNotFoundError') {
        return { ServerSideEncryptionConfiguration: [] };
      }
      throw err;
    }
  }

  private async readPublicAccessBlock(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
      const cfg = resp.PublicAccessBlockConfiguration;
      return {
        BlockPublicAcls: cfg?.BlockPublicAcls ?? false,
        BlockPublicPolicy: cfg?.BlockPublicPolicy ?? false,
        IgnorePublicAcls: cfg?.IgnorePublicAcls ?? false,
        RestrictPublicBuckets: cfg?.RestrictPublicBuckets ?? false,
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchPublicAccessBlockConfiguration') {
        return {
          BlockPublicAcls: false,
          BlockPublicPolicy: false,
          IgnorePublicAcls: false,
          RestrictPublicBuckets: false,
        };
      }
      throw err;
    }
  }

  private async readTags(bucket: string): Promise<Array<{ Key: string; Value: string }>> {
    try {
      const resp = await this.s3Client.send(new GetBucketTaggingCommand({ Bucket: bucket }));
      return normalizeAwsTagsToCfn(resp.TagSet);
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchTagSet') return [];
      throw err;
    }
  }

  private async readLifecycle(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
      );
      const rules = resp.Rules ?? [];
      const lifecycleOut: Record<string, unknown> = {};
      // Issue #1495: emit whatever AWS returns, unconditionally.
      //
      // The first cut filtered out `varies_by_storage_class` as "the account
      // default". That polarity is WRONG — AWS defaults new buckets (created
      // after September 2024) to `all_storage_classes_128K`, so the filter
      // suppressed the one value a template meaningfully declares and emitted
      // the real default for every bucket. A template declaring
      // `varies_by_storage_class` would then never read back, i.e. permanent
      // phantom drift on the `properties`-fallback baseline — exactly the
      // asymmetry this issue set out to remove.
      //
      // Emitting it even when the template never declared it is deliberate and
      // NOT free: `drift.ts` passes `unionWalkObjects` on the observed-baseline
      // path, so a new sub-key under the state-present `LifecycleConfiguration`
      // IS compared. The effect is the same one-time stale-observed-baseline
      // drift the `EventBridgeConfiguration` block below already documents, and
      // it clears on the next deploy — strictly better than the alternative,
      // where a template that DOES declare the value never reads it back and
      // drifts forever.
      if (resp.TransitionDefaultMinimumObjectSize !== undefined) {
        lifecycleOut['TransitionDefaultMinimumObjectSize'] =
          resp.TransitionDefaultMinimumObjectSize;
      }
      return {
        ...lifecycleOut,
        Rules: rules.map((r) => {
          const out: Record<string, unknown> = {};
          if (r.ID !== undefined) out['Id'] = r.ID;
          if (r.Status !== undefined) out['Status'] = r.Status;
          if (r.Prefix !== undefined) out['Prefix'] = r.Prefix;

          // Expiration
          if (r.Expiration) {
            const exp: Record<string, unknown> = {};
            if (r.Expiration.Days !== undefined) exp['Days'] = r.Expiration.Days;
            if (r.Expiration.Date !== undefined) exp['Date'] = r.Expiration.Date.toISOString();
            if (r.Expiration.ExpiredObjectDeleteMarker !== undefined)
              exp['ExpiredObjectDeleteMarker'] = r.Expiration.ExpiredObjectDeleteMarker;
            out['Expiration'] = exp;
          }

          // Transitions
          if (r.Transitions && r.Transitions.length > 0) {
            out['Transitions'] = r.Transitions.map((t) => {
              const item: Record<string, unknown> = {};
              if (t.Days !== undefined) item['TransitionInDays'] = t.Days;
              if (t.Date !== undefined) item['TransitionDate'] = t.Date.toISOString();
              if (t.StorageClass !== undefined) item['StorageClass'] = t.StorageClass;
              return item;
            });
          }

          // NoncurrentVersionExpiration
          if (r.NoncurrentVersionExpiration) {
            const nve: Record<string, unknown> = {};
            if (r.NoncurrentVersionExpiration.NoncurrentDays !== undefined)
              nve['NoncurrentDays'] = r.NoncurrentVersionExpiration.NoncurrentDays;
            if (r.NoncurrentVersionExpiration.NewerNoncurrentVersions !== undefined)
              nve['NewerNoncurrentVersions'] =
                r.NoncurrentVersionExpiration.NewerNoncurrentVersions;
            out['NoncurrentVersionExpiration'] = nve;
          }

          // NoncurrentVersionTransitions
          if (r.NoncurrentVersionTransitions && r.NoncurrentVersionTransitions.length > 0) {
            out['NoncurrentVersionTransitions'] = r.NoncurrentVersionTransitions.map((nvt) => {
              const item: Record<string, unknown> = {};
              // Reverse-map to the CFn spelling `TransitionInDays`, matching
              // the `Transitions` sibling 20 lines above. Emitting the SDK's
              // `NoncurrentDays` here made `cdkd drift` report a permanent
              // phantom diff on every versioned bucket with a noncurrent
              // transition, because the template baseline carries
              // `TransitionInDays` and `Rules` is compared array-wholesale.
              // Latent until this PR: the write side never delivered the day
              // count, so the two sides were both empty and agreed by accident.
              if (nvt.NoncurrentDays !== undefined) item['TransitionInDays'] = nvt.NoncurrentDays;
              if (nvt.StorageClass !== undefined) item['StorageClass'] = nvt.StorageClass;
              if (nvt.NewerNoncurrentVersions !== undefined)
                item['NewerNoncurrentVersions'] = nvt.NewerNoncurrentVersions;
              return item;
            });
          }

          // AbortIncompleteMultipartUpload
          if (r.AbortIncompleteMultipartUpload) {
            out['AbortIncompleteMultipartUpload'] = {
              DaysAfterInitiation: r.AbortIncompleteMultipartUpload.DaysAfterInitiation,
            };
          }

          // Filter — reverse-map SDK Filter shape (Tag / Prefix / And / etc)
          // back to CFn TagFilters / Prefix / ObjectSize* form.
          if (r.Filter) {
            const f = r.Filter as Record<string, unknown>;
            const cfnFilter: Record<string, unknown> = {};
            const and = f['And'] as Record<string, unknown> | undefined;
            const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
            if (and) {
              if (and['Prefix'] !== undefined) cfnFilter['Prefix'] = and['Prefix'];
              if (and['Tags']) cfnFilter['TagFilters'] = and['Tags'];
              if (and['ObjectSizeGreaterThan'] !== undefined)
                cfnFilter['ObjectSizeGreaterThan'] = and['ObjectSizeGreaterThan'];
              if (and['ObjectSizeLessThan'] !== undefined)
                cfnFilter['ObjectSizeLessThan'] = and['ObjectSizeLessThan'];
            } else if (tagOnly) {
              cfnFilter['TagFilters'] = [tagOnly];
            } else {
              if (f['Prefix'] !== undefined) cfnFilter['Prefix'] = f['Prefix'];
              if (f['ObjectSizeGreaterThan'] !== undefined)
                cfnFilter['ObjectSizeGreaterThan'] = f['ObjectSizeGreaterThan'];
              if (f['ObjectSizeLessThan'] !== undefined)
                cfnFilter['ObjectSizeLessThan'] = f['ObjectSizeLessThan'];
            }
            if (Object.keys(cfnFilter).length > 0) out['Filter'] = cfnFilter;
          }

          return out;
        }),
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchLifecycleConfiguration') return { Rules: [] };
      throw err;
    }
  }

  private async readCors(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketCorsCommand({ Bucket: bucket }));
      const rules = resp.CORSRules ?? [];
      return {
        CorsRules: rules.map((r) => {
          const out: Record<string, unknown> = {};
          if (r.ID !== undefined) out['Id'] = r.ID;
          if (r.AllowedHeaders !== undefined) out['AllowedHeaders'] = r.AllowedHeaders;
          if (r.AllowedMethods !== undefined) out['AllowedMethods'] = r.AllowedMethods;
          if (r.AllowedOrigins !== undefined) out['AllowedOrigins'] = r.AllowedOrigins;
          if (r.ExposeHeaders !== undefined) out['ExposedHeaders'] = r.ExposeHeaders;
          if (r.MaxAgeSeconds !== undefined) out['MaxAge'] = r.MaxAgeSeconds;
          return out;
        }),
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchCORSConfiguration') return { CorsRules: [] };
      throw err;
    }
  }

  private async readWebsite(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketWebsiteCommand({ Bucket: bucket }));
      const out: Record<string, unknown> = {};
      if (resp.IndexDocument?.Suffix !== undefined) {
        out['IndexDocument'] = resp.IndexDocument.Suffix;
      }
      if (resp.ErrorDocument?.Key !== undefined) {
        out['ErrorDocument'] = resp.ErrorDocument.Key;
      }
      if (resp.RedirectAllRequestsTo) {
        const redirect: Record<string, unknown> = {};
        if (resp.RedirectAllRequestsTo.HostName !== undefined)
          redirect['HostName'] = resp.RedirectAllRequestsTo.HostName;
        if (resp.RedirectAllRequestsTo.Protocol !== undefined)
          redirect['Protocol'] = resp.RedirectAllRequestsTo.Protocol;
        out['RedirectAllRequestsTo'] = redirect;
      }
      if (resp.RoutingRules && resp.RoutingRules.length > 0) {
        out['RoutingRules'] = resp.RoutingRules.map((rr) => {
          const ruleOut: Record<string, unknown> = {};
          if (rr.Condition) {
            const c: Record<string, unknown> = {};
            if (rr.Condition.HttpErrorCodeReturnedEquals !== undefined)
              c['HttpErrorCodeReturnedEquals'] = rr.Condition.HttpErrorCodeReturnedEquals;
            if (rr.Condition.KeyPrefixEquals !== undefined)
              c['KeyPrefixEquals'] = rr.Condition.KeyPrefixEquals;
            ruleOut['RoutingRuleCondition'] = c;
          }
          if (rr.Redirect) {
            const r: Record<string, unknown> = {};
            if (rr.Redirect.HostName !== undefined) r['HostName'] = rr.Redirect.HostName;
            if (rr.Redirect.HttpRedirectCode !== undefined)
              r['HttpRedirectCode'] = rr.Redirect.HttpRedirectCode;
            if (rr.Redirect.Protocol !== undefined) r['Protocol'] = rr.Redirect.Protocol;
            if (rr.Redirect.ReplaceKeyPrefixWith !== undefined)
              r['ReplaceKeyPrefixWith'] = rr.Redirect.ReplaceKeyPrefixWith;
            if (rr.Redirect.ReplaceKeyWith !== undefined)
              r['ReplaceKeyWith'] = rr.Redirect.ReplaceKeyWith;
            ruleOut['RedirectRule'] = r;
          }
          return ruleOut;
        });
      }
      return out;
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchWebsiteConfiguration') return {};
      throw err;
    }
  }

  private async readLogging(bucket: string): Promise<Record<string, unknown>> {
    const resp = await this.s3Client.send(new GetBucketLoggingCommand({ Bucket: bucket }));
    if (!resp.LoggingEnabled) return {};
    const out: Record<string, unknown> = {};
    if (resp.LoggingEnabled.TargetBucket !== undefined)
      out['DestinationBucketName'] = resp.LoggingEnabled.TargetBucket;
    if (resp.LoggingEnabled.TargetPrefix !== undefined)
      out['LogFilePrefix'] = resp.LoggingEnabled.TargetPrefix;
    // Issue #1495: read back the key format the write side now sends, or a
    // bucket that declares it would report permanent phantom drift.
    const keyFormat = resp.LoggingEnabled.TargetObjectKeyFormat;
    if (keyFormat) {
      const cfnKeyFormat: Record<string, unknown> = {};
      if (keyFormat.SimplePrefix !== undefined) cfnKeyFormat['SimplePrefix'] = {};
      if (keyFormat.PartitionedPrefix) {
        const partitioned: Record<string, unknown> = {};
        if (keyFormat.PartitionedPrefix.PartitionDateSource !== undefined) {
          partitioned['PartitionDateSource'] = keyFormat.PartitionedPrefix.PartitionDateSource;
        }
        cfnKeyFormat['PartitionedPrefix'] = partitioned;
      }
      if (Object.keys(cfnKeyFormat).length > 0) out['TargetObjectKeyFormat'] = cfnKeyFormat;
    }
    return out;
  }

  private async readNotification(bucket: string): Promise<Record<string, unknown>> {
    const resp = await this.s3Client.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: bucket })
    );
    const out: Record<string, unknown> = {};
    if (resp.TopicConfigurations && resp.TopicConfigurations.length > 0) {
      out['TopicConfigurations'] = resp.TopicConfigurations.map((t) => {
        const e: Record<string, unknown> = {};
        if (t.Id !== undefined) e['Id'] = t.Id;
        if (t.TopicArn !== undefined) e['Topic'] = t.TopicArn;
        if (t.Events !== undefined) e['Events'] = t.Events;
        if (t.Filter) e['Filter'] = this.sdkNotifFilterToCfn(t.Filter);
        return e;
      });
    }
    if (resp.QueueConfigurations && resp.QueueConfigurations.length > 0) {
      out['QueueConfigurations'] = resp.QueueConfigurations.map((q) => {
        const e: Record<string, unknown> = {};
        if (q.Id !== undefined) e['Id'] = q.Id;
        if (q.QueueArn !== undefined) e['Queue'] = q.QueueArn;
        if (q.Events !== undefined) e['Events'] = q.Events;
        if (q.Filter) e['Filter'] = this.sdkNotifFilterToCfn(q.Filter);
        return e;
      });
    }
    if (resp.LambdaFunctionConfigurations && resp.LambdaFunctionConfigurations.length > 0) {
      out['LambdaConfigurations'] = resp.LambdaFunctionConfigurations.map((l) => {
        const e: Record<string, unknown> = {};
        if (l.Id !== undefined) e['Id'] = l.Id;
        if (l.LambdaFunctionArn !== undefined) e['Function'] = l.LambdaFunctionArn;
        if (l.Events !== undefined) e['Events'] = l.Events;
        if (l.Filter) e['Filter'] = this.sdkNotifFilterToCfn(l.Filter);
        return e;
      });
    }
    // Always-emit, and in the CFn shape (`{EventBridgeEnabled: <bool>}`) rather
    // than the SDK's empty-structure shape — cdkd's state baseline holds the
    // CFn spelling, so returning `{}` reported the boolean as permanently
    // missing on every EventBridge-enabled bucket (issue #1430). Emitting
    // `false` when the response omits the block keeps the disabled side
    // comparable too.
    //
    // ONE-TIME DRIFT ON UPGRADE, accepted deliberately. `cdkd drift` runs the
    // observed-properties path with `unionWalkObjects: true`, which walks the
    // union of baseline+AWS keys inside a nested object, so a state record
    // captured by an older binary reports one diff on the first run after
    // upgrading: `EventBridgeConfiguration: {}` vs `{EventBridgeEnabled: true}`
    // on an enabled bucket, or an added `EventBridgeConfiguration` on a bucket
    // with no such key at all. It is cosmetic — `--revert` re-sends the old
    // observed blob and the write side re-derives the same AWS state — and it
    // clears on the next `cdkd state refresh-observed`, `drift --accept`, or
    // ANY subsequent `cdkd deploy` (the engine persists refreshed
    // `observedProperties` even on the no-change path). The alternative (emit only when present) is
    // what caused the PERMANENT phantom drift this fixes.
    out['EventBridgeConfiguration'] = {
      EventBridgeEnabled: resp.EventBridgeConfiguration !== undefined,
    };
    return out;
  }

  private sdkNotifFilterToCfn(filter: unknown): Record<string, unknown> {
    if (!filter || typeof filter !== 'object') return {};
    const f = filter as Record<string, unknown>;
    const key = f['Key'] as Record<string, unknown> | undefined;
    if (!key) return {};
    const filterRules = key['FilterRules'] as Array<{ Name?: string; Value?: string }> | undefined;
    if (!filterRules) return {};
    return {
      S3Key: {
        Rules: filterRules.map((r) => ({ Name: r.Name, Value: r.Value })),
      },
    };
  }

  private async readReplication(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketReplicationCommand({ Bucket: bucket }));
      const cfg = resp.ReplicationConfiguration;
      if (!cfg) return {};
      const out: Record<string, unknown> = {};
      if (cfg.Role !== undefined) out['Role'] = cfg.Role;
      if (cfg.Rules) {
        out['Rules'] = cfg.Rules.map((r) => {
          const ruleOut: Record<string, unknown> = {};
          if (r.ID !== undefined) ruleOut['Id'] = r.ID;
          if (r.Status !== undefined) ruleOut['Status'] = r.Status;
          if (r.Priority !== undefined) ruleOut['Priority'] = r.Priority;
          if (r.Prefix !== undefined) ruleOut['Prefix'] = r.Prefix;
          if (r.Destination) {
            const d: Record<string, unknown> = {};
            if (r.Destination.Bucket !== undefined) d['Bucket'] = r.Destination.Bucket;
            if (r.Destination.Account !== undefined) d['Account'] = r.Destination.Account;
            if (r.Destination.StorageClass !== undefined)
              d['StorageClass'] = r.Destination.StorageClass;
            // Issue #1495: the four blocks the write side now sends. Without
            // the read-back a bucket declaring any of them reports permanent
            // phantom drift that `--revert` would then keep re-applying.
            // Every member below is emitted ONLY when AWS actually returned it.
            // `drift-calculator.ts` compares arrays wholesale, and state.json's
            // JSON round-trip drops undefined keys — so echoing a member AWS
            // omitted would turn the whole `Rules` array into permanent drift.
            const acl = r.Destination.AccessControlTranslation;
            if (acl?.Owner !== undefined) {
              d['AccessControlTranslation'] = { Owner: acl.Owner };
            }
            const enc = r.Destination.EncryptionConfiguration;
            if (enc?.ReplicaKmsKeyID !== undefined) {
              d['EncryptionConfiguration'] = { ReplicaKmsKeyID: enc.ReplicaKmsKeyID };
            }
            const rtIn = r.Destination.ReplicationTime;
            if (rtIn) {
              const rt: Record<string, unknown> = {};
              if (rtIn.Status !== undefined) rt['Status'] = rtIn.Status;
              if (rtIn.Time?.Minutes !== undefined) rt['Time'] = { Minutes: rtIn.Time.Minutes };
              if (Object.keys(rt).length > 0) d['ReplicationTime'] = rt;
            }
            const metricsIn = r.Destination.Metrics;
            if (metricsIn) {
              const m: Record<string, unknown> = {};
              if (metricsIn.Status !== undefined) m['Status'] = metricsIn.Status;
              if (metricsIn.EventThreshold?.Minutes !== undefined) {
                m['EventThreshold'] = { Minutes: metricsIn.EventThreshold.Minutes };
              }
              if (Object.keys(m).length > 0) d['Metrics'] = m;
            }
            ruleOut['Destination'] = d;
          }
          if (r.SourceSelectionCriteria) {
            const criteria: Record<string, unknown> = {};
            const replicaMods = r.SourceSelectionCriteria.ReplicaModifications;
            if (replicaMods?.Status !== undefined) {
              criteria['ReplicaModifications'] = { Status: replicaMods.Status };
            }
            const sseKms = r.SourceSelectionCriteria.SseKmsEncryptedObjects;
            if (sseKms?.Status !== undefined) {
              criteria['SseKmsEncryptedObjects'] = { Status: sseKms.Status };
            }
            if (Object.keys(criteria).length > 0) ruleOut['SourceSelectionCriteria'] = criteria;
          }
          if (r.Filter) {
            const f = r.Filter as Record<string, unknown>;
            const cfnFilter: Record<string, unknown> = {};
            const and = f['And'] as Record<string, unknown> | undefined;
            const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
            if (and) {
              // Round-trip back to the CFn-canonical combined-filter shape
              // `{ And: { Prefix?, TagFilters[] } }` (S3 SDK's `And.Tags` ->
              // CFn `And.TagFilters`) so it matches the template-derived
              // state.properties exactly and does not surface as phantom drift.
              // (The old code collapsed it to a top-level `{ Prefix, TagFilter }`
              // — not a valid CFn shape — and dropped every tag past the first.)
              const innerAnd: Record<string, unknown> = {};
              if (and['Prefix'] !== undefined) innerAnd['Prefix'] = and['Prefix'];
              const tags = and['Tags'] as Array<{ Key?: string; Value?: string }> | undefined;
              if (tags && tags.length > 0) innerAnd['TagFilters'] = tags;
              cfnFilter['And'] = innerAnd;
            } else if (tagOnly) {
              cfnFilter['TagFilter'] = tagOnly;
            } else if (f['Prefix'] !== undefined) {
              cfnFilter['Prefix'] = f['Prefix'];
            }
            if (Object.keys(cfnFilter).length > 0) ruleOut['Filter'] = cfnFilter;
          }
          if (r.DeleteMarkerReplication?.Status !== undefined) {
            ruleOut['DeleteMarkerReplication'] = {
              Status: r.DeleteMarkerReplication.Status,
            };
          }
          return ruleOut;
        });
      }
      return out;
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'ReplicationConfigurationNotFoundError') return {};
      throw err;
    }
  }

  private async readObjectLock(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(
        new GetObjectLockConfigurationCommand({ Bucket: bucket })
      );
      const cfg = resp.ObjectLockConfiguration;
      if (!cfg) return {};
      const out: Record<string, unknown> = {};
      if (cfg.ObjectLockEnabled !== undefined) out['ObjectLockEnabled'] = cfg.ObjectLockEnabled;
      if (cfg.Rule?.DefaultRetention) {
        const r = cfg.Rule.DefaultRetention;
        const retention: Record<string, unknown> = {};
        if (r.Mode !== undefined) retention['Mode'] = r.Mode;
        if (r.Days !== undefined) retention['Days'] = r.Days;
        if (r.Years !== undefined) retention['Years'] = r.Years;
        out['Rule'] = { DefaultRetention: retention };
      }
      return out;
    } catch (err) {
      const e = err as { name?: string };
      if (
        e.name === 'ObjectLockConfigurationNotFoundError' ||
        e.name === 'NoSuchBucketConfiguration'
      ) {
        return {};
      }
      throw err;
    }
  }

  private async readAccelerate(bucket: string): Promise<Record<string, unknown>> {
    const resp = await this.s3Client.send(
      new GetBucketAccelerateConfigurationCommand({ Bucket: bucket })
    );
    // Always-emit placeholder. AWS-side default is "no acceleration" which
    // surfaces as Status=undefined. We emit `Suspended` (the semantic "off"
    // that AWS accepts on Put) so a console-side enable surfaces.
    return { AccelerationStatus: resp.Status ?? 'Suspended' };
  }

  private async readMetricsList(bucket: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let continuationToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.s3Client.send(
        new ListBucketMetricsConfigurationsCommand({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of resp.MetricsConfigurationList ?? []) {
        out.push(this.metricsSdkToCfn(c as unknown as Record<string, unknown>));
      }
      if (!resp.IsTruncated) break;
      continuationToken = resp.NextContinuationToken;
    }
    return out;
  }

  private metricsSdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (c['Id'] !== undefined) out['Id'] = c['Id'];
    const f = c['Filter'] as Record<string, unknown> | undefined;
    if (f) {
      const and = f['And'] as Record<string, unknown> | undefined;
      const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
      if (and) {
        if (and['Prefix'] !== undefined) out['Prefix'] = and['Prefix'];
        if (and['Tags']) out['TagFilters'] = and['Tags'];
        if (and['AccessPointArn'] !== undefined) out['AccessPointArn'] = and['AccessPointArn'];
      } else if (tagOnly) {
        out['TagFilters'] = [tagOnly];
      } else {
        if (f['Prefix'] !== undefined) out['Prefix'] = f['Prefix'];
        if (f['AccessPointArn'] !== undefined) out['AccessPointArn'] = f['AccessPointArn'];
      }
    }
    return out;
  }

  private async readAnalyticsList(bucket: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let continuationToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.s3Client.send(
        new ListBucketAnalyticsConfigurationsCommand({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of resp.AnalyticsConfigurationList ?? []) {
        out.push(this.analyticsSdkToCfn(c as unknown as Record<string, unknown>));
      }
      if (!resp.IsTruncated) break;
      continuationToken = resp.NextContinuationToken;
    }
    return out;
  }

  private analyticsSdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (c['Id'] !== undefined) out['Id'] = c['Id'];
    const f = c['Filter'] as Record<string, unknown> | undefined;
    if (f) {
      const and = f['And'] as Record<string, unknown> | undefined;
      const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
      if (and) {
        if (and['Prefix'] !== undefined) out['Prefix'] = and['Prefix'];
        if (and['Tags']) out['TagFilters'] = and['Tags'];
      } else if (tagOnly) {
        out['TagFilters'] = [tagOnly];
      } else if (f['Prefix'] !== undefined) {
        out['Prefix'] = f['Prefix'];
      }
    }
    const sca = c['StorageClassAnalysis'] as Record<string, unknown> | undefined;
    if (sca?.['DataExport']) {
      const dataExport = sca['DataExport'] as Record<string, unknown>;
      const dest = dataExport['Destination'] as Record<string, unknown> | undefined;
      const s3Dest = dest?.['S3BucketDestination'] as Record<string, unknown> | undefined;
      out['StorageClassAnalysis'] = {
        DataExport: {
          OutputSchemaVersion: dataExport['OutputSchemaVersion'],
          Destination: s3Dest
            ? {
                S3BucketDestination: {
                  BucketArn: s3Dest['Bucket'],
                  BucketAccountId: s3Dest['BucketAccountId'],
                  Format: s3Dest['Format'],
                  Prefix: s3Dest['Prefix'],
                },
              }
            : undefined,
        },
      };
    }
    return out;
  }

  private async readIntelligentTieringList(
    bucket: string
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let continuationToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.s3Client.send(
        new ListBucketIntelligentTieringConfigurationsCommand({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of resp.IntelligentTieringConfigurationList ?? []) {
        out.push(this.intelligentTieringSdkToCfn(c as unknown as Record<string, unknown>));
      }
      if (!resp.IsTruncated) break;
      continuationToken = resp.NextContinuationToken;
    }
    return out;
  }

  private intelligentTieringSdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (c['Id'] !== undefined) out['Id'] = c['Id'];
    if (c['Status'] !== undefined) out['Status'] = c['Status'];
    if (c['Tierings']) {
      const tierings = c['Tierings'] as Array<Record<string, unknown>>;
      out['Tierings'] = tierings.map((t) => ({
        AccessTier: t['AccessTier'],
        Days: t['Days'],
      }));
    }
    const f = c['Filter'] as Record<string, unknown> | undefined;
    if (f) {
      const and = f['And'] as Record<string, unknown> | undefined;
      const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
      if (and) {
        if (and['Prefix'] !== undefined) out['Prefix'] = and['Prefix'];
        if (and['Tags']) out['TagFilters'] = and['Tags'];
      } else if (tagOnly) {
        out['TagFilters'] = [tagOnly];
      } else if (f['Prefix'] !== undefined) {
        out['Prefix'] = f['Prefix'];
      }
    }
    return out;
  }

  private async readInventoryList(bucket: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let continuationToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.s3Client.send(
        new ListBucketInventoryConfigurationsCommand({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of resp.InventoryConfigurationList ?? []) {
        out.push(this.inventorySdkToCfn(c as unknown as Record<string, unknown>));
      }
      if (!resp.IsTruncated) break;
      continuationToken = resp.NextContinuationToken;
    }
    return out;
  }

  private inventorySdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (c['Id'] !== undefined) out['Id'] = c['Id'];
    if (c['IsEnabled'] !== undefined) out['Enabled'] = c['IsEnabled'];
    if (c['IncludedObjectVersions'] !== undefined)
      out['IncludedObjectVersions'] = c['IncludedObjectVersions'];
    const schedule = c['Schedule'] as Record<string, unknown> | undefined;
    if (schedule?.['Frequency'] !== undefined) out['ScheduleFrequency'] = schedule['Frequency'];
    if (c['OptionalFields'] !== undefined) out['OptionalFields'] = c['OptionalFields'];
    const dest = c['Destination'] as Record<string, unknown> | undefined;
    const s3Dest = dest?.['S3BucketDestination'] as Record<string, unknown> | undefined;
    if (s3Dest) {
      const cfnDest: Record<string, unknown> = {};
      if (s3Dest['Bucket'] !== undefined) cfnDest['BucketArn'] = s3Dest['Bucket'];
      if (s3Dest['AccountId'] !== undefined) cfnDest['BucketAccountId'] = s3Dest['AccountId'];
      if (s3Dest['Format'] !== undefined) cfnDest['Format'] = s3Dest['Format'];
      if (s3Dest['Prefix'] !== undefined) cfnDest['Prefix'] = s3Dest['Prefix'];
      out['Destination'] = cfnDest;
    }
    const filter = c['Filter'] as Record<string, unknown> | undefined;
    if (filter?.['Prefix'] !== undefined) out['Prefix'] = filter['Prefix'];
    return out;
  }

  /**
   * Adopt an existing S3 bucket into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<name>` override or `Properties.BucketName` → use directly,
   *     verify with `HeadBucket`.
   *
   * Returns `null` when nothing matches — caller treats this as
   * "not deployed yet" rather than a failure.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'BucketName');
    if (explicit) {
      try {
        await this.s3Client.send(new HeadBucketCommand({ Bucket: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        const e = err as { name?: string };
        if (e.name === 'NotFound' || e.name === 'NoSuchBucket') {
          return null;
        }
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a bucket
    // reaching here needs an explicit `--resource` override.
    return null;
  }

  /**
   * Delete a bucket, emptying it first if not empty — but ONLY when
   * `allowAutoEmpty` is set (issue #1340).
   *
   * With `allowAutoEmpty` (CDK `autoDeleteObjects` tag present, or
   * `--force-stateful-recreation` consent via
   * {@link DeleteContext.forceDataDelete}), the retry loop handles the race
   * condition where objects (e.g., ALB logs) are written after
   * CustomResource cleanup but before bucket deletion.
   *
   * Without it, a not-empty bucket refuses deletion with an actionable
   * error — matching CloudFormation's DELETE_FAILED, which is the safety
   * net users rely on to keep `cdkd destroy` from silently destroying data
   * they never opted into losing.
   */
  private async deleteBucketWithEmptyRetry(
    logicalId: string,
    bucketName: string,
    allowAutoEmpty: boolean
  ): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
        this.logger.debug(`Successfully deleted S3 bucket ${logicalId}`);
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('not empty') || msg.includes('BucketNotEmpty')) {
          if (!allowAutoEmpty) {
            throw new Error(
              `bucket ${bucketName} is not empty. Matching CloudFormation, cdkd does not ` +
                `delete a non-empty bucket unless it opted into automatic emptying ` +
                `(CDK's autoDeleteObjects: true, i.e. the '${S3_AUTO_DELETE_OBJECTS_TAG}' tag). ` +
                `Either empty the bucket first (delete all objects — and for versioned ` +
                `buckets all object versions and delete markers), or redeploy with ` +
                `autoDeleteObjects: true and destroy again.`
            );
          }
          this.logger.info(
            `Bucket ${bucketName} not empty (attempt ${attempt}/${maxAttempts}), emptying (auto-delete opt-in present)...`
          );
          await this.emptyBucket(bucketName);
          continue;
        }
        throw error;
      }
    }
    // Final attempt after emptying
    await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
    this.logger.debug(`Successfully deleted S3 bucket ${logicalId}`);
  }

  /**
   * Empty a bucket by deleting all object versions and delete markers.
   */
  private async emptyBucket(bucketName: string): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const listResp = await this.s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: bucketName,
          MaxKeys: 1000,
          ...(keyMarker && { KeyMarker: keyMarker }),
          ...(versionIdMarker && { VersionIdMarker: versionIdMarker }),
        })
      );

      const objects: Array<{ Key: string; VersionId: string }> = [];
      for (const v of listResp.Versions || []) {
        if (v.Key && v.VersionId) objects.push({ Key: v.Key, VersionId: v.VersionId });
      }
      for (const d of listResp.DeleteMarkers || []) {
        if (d.Key && d.VersionId) objects.push({ Key: d.Key, VersionId: d.VersionId });
      }

      if (objects.length > 0) {
        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: objects, Quiet: true },
          })
        );
        this.logger.debug(`Emptied ${objects.length} objects from ${bucketName}`);
      }

      if (!listResp.IsTruncated) break;
      keyMarker = listResp.NextKeyMarker;
      versionIdMarker = listResp.NextVersionIdMarker;
    }
  }
}
