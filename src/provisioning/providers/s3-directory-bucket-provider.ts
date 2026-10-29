import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutBucketEncryptionCommand,
  DeleteBucketEncryptionCommand,
  GetBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketMetricsConfigurationCommand,
  DeleteBucketMetricsConfigurationCommand,
  ListBucketMetricsConfigurationsCommand,
  PutBucketInventoryConfigurationCommand,
  DeleteBucketInventoryConfigurationCommand,
  ListBucketInventoryConfigurationsCommand,
  type BucketLifecycleConfiguration,
  type DataRedundancy,
  type ExpirationStatus,
  type InventoryConfiguration,
  type InventoryFormat,
  type InventoryFrequency,
  type InventoryIncludedObjectVersions,
  type InventoryOptionalField,
  type LifecycleRule,
  type LifecycleRuleFilter,
  type MetricsConfiguration,
  type ServerSideEncryption,
  type ServerSideEncryptionConfiguration,
  type ServerSideEncryptionRule,
  type Tag,
} from '@aws-sdk/client-s3';
import {
  S3ControlClient,
  TagResourceCommand,
  UntagResourceCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-s3-control';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { EC2Client, DescribeAvailabilityZonesCommand } from '@aws-sdk/client-ec2';
import { getLogger } from '../../utils/logger.js';
import { replayWarn, requireConfigString } from '../config-shape.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { LISTING_ENCODING_TYPE, decodeListingKey } from '../../utils/s3-listing-keys.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { S3_AUTO_DELETE_OBJECTS_TAG, hasCdkAutoDeleteTag } from '../data-delete-intent.js';
import { generatedNameFor } from '../resource-name.js';
import { renderDisableCommand } from '../replacement-protection-advice.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { markNotGone } from '../not-gone.js';
import { displayIdent, displaySafe } from '../../utils/display-safe.js';
import {
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import {
  ambientClientDefaults,
  clientDefaultsFor,
  type CredentialConfig,
} from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';

/**
 * What `delete()` throws for a non-empty bucket with no auto-empty opt-in
 * (issue [#1344](https://github.com/go-to-k/cdkd/issues/1344)), with the bucket
 * name rendered safely (issue
 * [#3270](https://github.com/go-to-k/cdkd/issues/3270)).
 *
 * `bucketName` on the delete path is the STATE-borne physical id, which for
 * this type is the TEMPLATE-chosen name, and this message is THROWN from
 * `delete()` — so it reaches the operator's terminal AND the durable
 * `deployments/*.jsonl` store. It used to interpolate the name BARE into
 * `aws s3 rm s3://<name> --recursive`, so a name carrying `;`, a backtick,
 * `$(...)` or a newline APPENDED a command to a recursive delete when pasted.
 *
 * The command goes through the shared `renderDisableCommand`
 * (`displaySafe(asciiOnly)`, then `shellQuote`, then SUPPRESS the whole command
 * when sanitizing CHANGED the value, since a command naming the sanitized name
 * would empty a DIFFERENT bucket). Three things are specific to this site:
 *
 *  - **The quoted unit is the ASSEMBLED `s3://<name>` argument**, not the name:
 *    `aws s3 rm` has no `--bucket <name>` form, and quoting only the name would
 *    put a quote in the middle of a word. `shellQuote` leaves `:` and `/` bare,
 *    so a clean name renders exactly as before.
 *  - **The NAME is compared against its own sanitized form HERE, before the
 *    shared renderer sees it.** The renderer's changed-by-sanitizing test runs
 *    over the assembled argument, where the `s3://` prefix shields a LEADING
 *    space of the name from the sanitizer's trim — so without this check a
 *    padded name would be shown in a command while the prose beside it named
 *    the trimmed one.
 *  - **A name containing `/` is suppressed here**, which the shared renderer
 *    cannot know to do: `s3://a/b` addresses the prefix `b` in bucket `a`, a
 *    DIFFERENT bucket, and both characters pass sanitizing and quoting
 *    unchanged. An empty name is suppressed for the same reason (`s3://` names
 *    no bucket at all).
 *  - **The caller's `DeleteContext.maskSecrets` decides whether the name may
 *    be shown at all** (issue [#2007](https://github.com/go-to-k/cdkd/issues/2007)):
 *    a name the masker changes is secret-derived, so the prose shows it masked
 *    and NO command is printed for it, since `aws s3 rm s3://***` names no
 *    bucket. Every cdkd delete site passes one (`cdkd destroy` its printing bag
 *    of secret-derived names); absent leaves the name as is.
 *
 * The PROSE name goes through `displayIdent`, because this message is
 * persisted: a control byte or a newline in it would otherwise forge lines in
 * the events store even with the command suppressed. A clean name is a plain
 * identifier, which `displayIdent` renders unchanged.
 *
 * The caller marks the refusal NON-RETRYABLE: it is a deterministic verdict,
 * and `delete()` wraps it in a message carrying the LOGICAL id, which the
 * destroy runner and the deploy engine's replacement delete classify as
 * "already deleted" by SUBSTRING (`NotFoundException` there, a bare `NotFound`
 * here). A logical id containing the needle would otherwise have its non-empty
 * bucket read as gone; both classifiers skip a marked error.
 */
function notEmptyRefusalMessage(bucketName: string, maskSecrets: MaskerFn | undefined): string {
  const mask = maskerOrIdentity(maskSecrets);
  const secretDerived = mask(bucketName) !== bucketName;
  const nameable =
    bucketName !== '' &&
    !bucketName.includes('/') &&
    displaySafe(bucketName, { asciiOnly: true }) === bucketName;
  // Decided on the bare NAME, where the masker's whole-value arm reaches a
  // secret below its substring floor; the renderer only sees `s3://<name>`.
  const command =
    nameable && !secretDerived
      ? renderDisableCommand({
          before: 'aws s3 rm',
          identifier: `s3://${bucketName}`,
          after: '--recursive',
        })
      : '';
  const remedy = command
    ? `Delete all objects first (e.g. ${command}) and destroy again.`
    : secretDerived
      ? 'Delete all objects first, via the console, and destroy again: the bucket name is ' +
        'derived from a secret, so cdkd does not print it.'
      : 'Delete all objects first, via the console, and destroy again: the bucket name cdkd ' +
        'recorded cannot be reproduced safely on a command line, so any command shown here could ' +
        'act on a different bucket or run part of the name as shell.';
  // The name masked as a VALUE first, so a secret below the masker's
  // substring floor is caught too, then the whole message.
  return mask(
    `bucket ${displayIdent(mask(bucketName))} is not empty. Matching CloudFormation, cdkd does not ` +
      `delete a non-empty directory bucket without an explicit opt-in. ${remedy}`
  );
}

// --- Bucket configurations (go-to-k/cdkd#2762) ---------------------------------
//
// `BucketEncryption`, `LifecycleConfiguration`, `MetricsConfigurations` and
// `InventoryConfigurations` ride the S3 bucket-configuration calls, which the
// SDK routes to the S3 Express regional (control) endpoint for a `--x-s3`
// bucket name. The CloudFormation shapes are FLATTER than the S3 ones (a rule's
// `Prefix` / `ObjectSizeGreaterThan` / `ObjectSizeLessThan` sit on the rule
// itself, a metrics filter's `Prefix` / `AccessPointArn` on the item), so each
// is translated both ways here: to the SDK input on write, back to the CFn
// shape on `readCurrentState`.

type Json = Record<string, unknown>;

/** Refuses the value at `path` as not being `expected`. Never returns. */
type Refuse = (path: string, expected: string) => never;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A list member's own `Id`, when it is a non-empty string. */
function itemId(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  const id = item['Id'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** `JSON.stringify` with object keys sorted, so key order never reads as a change. */
function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (isRecord(v)) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sorted(v[k])])
      );
    }
    return v;
  };
  return JSON.stringify(sorted(value)) ?? 'undefined';
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function optionalString(value: unknown, path: string, refuse: Refuse): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') refuse(path, 'a string');
  return value;
}

/** A boolean, or its `'true'` / `'false'` spelling (a template parameter's). */
function optionalBoolean(value: unknown, path: string, refuse: Refuse): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return refuse(path, 'a boolean');
}

/**
 * A non-negative integer, or its decimal string (the CFn `ObjectSize*` spelling).
 * At most 15 digits where the schema allows 20: a longer string has no exact
 * JavaScript number, and an S3 object is far smaller.
 */
function optionalInteger(value: unknown, path: string, refuse: Refuse): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^[0-9]{1,15}$/.test(value)) return Number(value);
  return refuse(path, 'a non-negative integer');
}

function listOf(value: unknown, path: string, refuse: Refuse): unknown[] {
  if (!Array.isArray(value)) refuse(path, 'a list');
  return value;
}

/**
 * The `ServerSideEncryptionConfiguration` for `BucketEncryption`, or
 * `undefined` when there is nothing to send (absent, or an empty rule list).
 */
function encryptionToSdk(
  value: unknown,
  refuse: Refuse
): ServerSideEncryptionConfiguration | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) refuse('BucketEncryption', 'an object');
  const rules = listOf(
    value['ServerSideEncryptionConfiguration'],
    'BucketEncryption.ServerSideEncryptionConfiguration',
    refuse
  );
  if (rules.length === 0) return undefined;
  return {
    Rules: rules.map((rule, i): ServerSideEncryptionRule => {
      const path = `BucketEncryption.ServerSideEncryptionConfiguration[${i}]`;
      if (!isRecord(rule)) refuse(path, 'an object');
      const out: ServerSideEncryptionRule = {};
      const byDefault = rule['ServerSideEncryptionByDefault'];
      if (byDefault !== undefined && byDefault !== null) {
        if (!isRecord(byDefault)) refuse(`${path}.ServerSideEncryptionByDefault`, 'an object');
        const algorithm = optionalString(
          byDefault['SSEAlgorithm'],
          `${path}.ServerSideEncryptionByDefault.SSEAlgorithm`,
          refuse
        );
        const keyId = optionalString(
          byDefault['KMSMasterKeyID'],
          `${path}.ServerSideEncryptionByDefault.KMSMasterKeyID`,
          refuse
        );
        out.ApplyServerSideEncryptionByDefault = {
          SSEAlgorithm: algorithm as ServerSideEncryption | undefined,
          ...(keyId !== undefined ? { KMSMasterKeyID: keyId } : {}),
        };
      }
      const bucketKey = optionalBoolean(
        rule['BucketKeyEnabled'],
        `${path}.BucketKeyEnabled`,
        refuse
      );
      if (bucketKey !== undefined) out.BucketKeyEnabled = bucketKey;
      return out;
    }),
  };
}

/**
 * A lifecycle rule's filter. CloudFormation puts `Prefix` and the two object
 * size bounds on the rule; S3 takes them in `Filter`, under `And` when more
 * than one is set. A rule with none applies to every object, which S3 spells
 * as an empty prefix.
 */
function lifecycleFilterToSdk(rule: Json, path: string, refuse: Refuse): LifecycleRuleFilter {
  const prefix = optionalString(rule['Prefix'], `${path}.Prefix`, refuse);
  const greater = optionalInteger(
    rule['ObjectSizeGreaterThan'],
    `${path}.ObjectSizeGreaterThan`,
    refuse
  );
  const less = optionalInteger(rule['ObjectSizeLessThan'], `${path}.ObjectSizeLessThan`, refuse);
  const members = {
    ...(prefix !== undefined ? { Prefix: prefix } : {}),
    ...(greater !== undefined ? { ObjectSizeGreaterThan: greater } : {}),
    ...(less !== undefined ? { ObjectSizeLessThan: less } : {}),
  };
  const count = Object.keys(members).length;
  if (count === 0) return { Prefix: '' };
  if (count === 1) return members;
  return { And: members };
}

/**
 * The `LifecycleConfiguration` for S3, or `undefined` when there is nothing to
 * send (absent, or an empty rule list: S3 holds no empty lifecycle).
 */
function lifecycleToSdk(value: unknown, refuse: Refuse): BucketLifecycleConfiguration | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) refuse('LifecycleConfiguration', 'an object');
  const rules = listOf(value['Rules'], 'LifecycleConfiguration.Rules', refuse);
  if (rules.length === 0) return undefined;
  return {
    Rules: rules.map((rule, i): LifecycleRule => {
      const path = `LifecycleConfiguration.Rules[${i}]`;
      if (!isRecord(rule)) refuse(path, 'an object');
      const id = optionalString(rule['Id'], `${path}.Id`, refuse);
      const status = optionalString(rule['Status'], `${path}.Status`, refuse);
      const days = optionalInteger(rule['ExpirationInDays'], `${path}.ExpirationInDays`, refuse);
      const out: LifecycleRule = {
        ...(id !== undefined ? { ID: id } : {}),
        Status: status as ExpirationStatus | undefined,
        Filter: lifecycleFilterToSdk(rule, path, refuse),
      };
      if (days !== undefined) out.Expiration = { Days: days };
      const abort = rule['AbortIncompleteMultipartUpload'];
      if (abort !== undefined && abort !== null) {
        if (!isRecord(abort)) refuse(`${path}.AbortIncompleteMultipartUpload`, 'an object');
        const after = optionalInteger(
          abort['DaysAfterInitiation'],
          `${path}.AbortIncompleteMultipartUpload.DaysAfterInitiation`,
          refuse
        );
        out.AbortIncompleteMultipartUpload =
          after !== undefined ? { DaysAfterInitiation: after } : {};
      }
      return out;
    }),
  };
}

/**
 * The `Id`-keyed items of `MetricsConfigurations` / `InventoryConfigurations`:
 * each must carry a distinct non-empty `Id`, which is what names it to S3 (its
 * Put and its Delete), so an item without one could never be removed again.
 */
function keyedItems(value: unknown, property: string, refuse: Refuse): Map<string, Json> {
  const out = new Map<string, Json>();
  if (value === undefined || value === null) return out;
  listOf(value, property, refuse).forEach((item, i) => {
    if (!isRecord(item)) refuse(`${property}[${i}]`, 'an object');
    const id = itemId(item);
    if (id === undefined) refuse(`${property}[${i}].Id`, 'a non-empty string');
    if (out.has(id)) refuse(`${property}[${i}].Id`, 'an Id no other item of the list carries');
    out.set(id, item);
  });
  return out;
}

/** The lenient read of a RECORDED list: its items that carry an `Id`, by `Id`. */
function recordedItems(value: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    const id = itemId(item);
    if (id !== undefined && !out.has(id)) out.set(id, item);
  }
  return out;
}

function metricsItemToSdk(
  id: string,
  item: Json,
  path: string,
  refuse: Refuse
): MetricsConfiguration {
  const prefix = optionalString(item['Prefix'], `${path}.Prefix`, refuse);
  const accessPoint = optionalString(item['AccessPointArn'], `${path}.AccessPointArn`, refuse);
  if (prefix !== undefined && accessPoint !== undefined) {
    return { Id: id, Filter: { And: { Prefix: prefix, AccessPointArn: accessPoint } } };
  }
  if (prefix !== undefined) return { Id: id, Filter: { Prefix: prefix } };
  if (accessPoint !== undefined) return { Id: id, Filter: { AccessPointArn: accessPoint } };
  return { Id: id };
}

function inventoryItemToSdk(
  id: string,
  item: Json,
  path: string,
  refuse: Refuse
): InventoryConfiguration {
  const destination = item['Destination'];
  if (!isRecord(destination)) refuse(`${path}.Destination`, 'an object');
  const bucketArn = optionalString(
    destination['BucketArn'],
    `${path}.Destination.BucketArn`,
    refuse
  );
  const accountId = optionalString(
    destination['BucketAccountId'],
    `${path}.Destination.BucketAccountId`,
    refuse
  );
  const format = optionalString(destination['Format'], `${path}.Destination.Format`, refuse);
  const destPrefix = optionalString(destination['Prefix'], `${path}.Destination.Prefix`, refuse);
  const enabled = optionalBoolean(item['Enabled'], `${path}.Enabled`, refuse);
  const versions = optionalString(
    item['IncludedObjectVersions'],
    `${path}.IncludedObjectVersions`,
    refuse
  );
  const prefix = optionalString(item['Prefix'], `${path}.Prefix`, refuse);
  const frequency = optionalString(item['ScheduleFrequency'], `${path}.ScheduleFrequency`, refuse);
  const fields = item['OptionalFields'];
  let optionalFields: string[] | undefined;
  if (fields !== undefined && fields !== null) {
    optionalFields = listOf(fields, `${path}.OptionalFields`, refuse).map((f, j) => {
      if (typeof f !== 'string') refuse(`${path}.OptionalFields[${j}]`, 'a string');
      return f;
    });
  }
  return {
    Id: id,
    Destination: {
      S3BucketDestination: {
        Bucket: bucketArn,
        Format: format as InventoryFormat | undefined,
        ...(accountId !== undefined ? { AccountId: accountId } : {}),
        ...(destPrefix !== undefined ? { Prefix: destPrefix } : {}),
      },
    },
    IsEnabled: enabled,
    IncludedObjectVersions: versions as InventoryIncludedObjectVersions | undefined,
    Schedule: { Frequency: frequency as InventoryFrequency | undefined },
    ...(prefix !== undefined ? { Filter: { Prefix: prefix } } : {}),
    ...(optionalFields !== undefined
      ? { OptionalFields: optionalFields as InventoryOptionalField[] }
      : {}),
  };
}

/** Every configuration write a desired bag asks for, built before any call. */
interface DesiredConfigurations {
  encryption: ServerSideEncryptionConfiguration | undefined;
  lifecycle: BucketLifecycleConfiguration | undefined;
  metrics: Map<string, MetricsConfiguration>;
  inventory: Map<string, InventoryConfiguration>;
}

/**
 * Translates the four configuration properties of `properties`, refusing a
 * malformed one through `refuse` — so a create or update refuses BEFORE its
 * first call, never halfway through its writes.
 */
function desiredConfigurations(
  properties: Json,
  refuse: Refuse,
  onUnusable?: (message: string) => void
): DesiredConfigurations {
  const warnOut = (error: ProvisioningError, what: string): void =>
    onUnusable?.(
      `${error.message.replace(/ — the resource was not created$/, '')}; replaying a recorded ` +
        `state, so the bucket is created without ${what}`
    );
  /**
   * Builds one property; with `onUnusable` (a CREATE replaying a state record,
   * which the template cannot fix), a malformed property is warned about and
   * left out instead of refusing the whole create.
   */
  const build = <T>(fallback: T, what: string, run: () => T): T => {
    if (!onUnusable) return run();
    try {
      return run();
    } catch (error) {
      if (!(error instanceof ProvisioningError)) throw error;
      warnOut(error, what);
      return fallback;
    }
  };
  /**
   * An `Id`-keyed list. On a replay, a malformed ITEM is left out alone (the
   * others are still created); a value that is not a list leaves the whole
   * list out. A path names an item by its INDEX, never by its `Id`, so a
   * refusal quotes no template value.
   */
  const buildList = <T>(
    property: string,
    toSdk: (id: string, item: Json, path: string) => T
  ): Map<string, T> => {
    if (!onUnusable) {
      const out = new Map<string, T>();
      let i = 0;
      for (const [id, item] of keyedItems(properties[property], property, refuse)) {
        out.set(id, toSdk(id, item, `${property}[${i++}]`));
      }
      return out;
    }
    const out = new Map<string, T>();
    const value = properties[property];
    if (value === undefined || value === null) return out;
    const items = build<unknown[] | undefined>(undefined, `any ${property} item`, () =>
      listOf(value, property, refuse)
    );
    items?.forEach((item, i) => {
      const path = `${property}[${i}]`;
      build(undefined, `${path}`, () => {
        if (!isRecord(item)) refuse(path, 'an object');
        const id = itemId(item);
        if (id === undefined) refuse(`${path}.Id`, 'a non-empty string');
        if (out.has(id)) refuse(`${path}.Id`, 'an Id no other item of the list carries');
        out.set(id, toSdk(id, item, path));
        return undefined;
      });
    });
    return out;
  };
  const metrics = buildList('MetricsConfigurations', (id, item, path) =>
    metricsItemToSdk(id, item, path, refuse)
  );
  const inventory = buildList('InventoryConfigurations', (id, item, path) =>
    inventoryItemToSdk(id, item, path, refuse)
  );
  return {
    encryption: build(undefined, 'its BucketEncryption', () =>
      encryptionToSdk(properties['BucketEncryption'], refuse)
    ),
    lifecycle: build(undefined, 'its LifecycleConfiguration', () =>
      lifecycleToSdk(properties['LifecycleConfiguration'], refuse)
    ),
    metrics,
    inventory,
  };
}

/** The refusal a malformed configuration property raises: no value is quoted. */
function configurationRefuser(
  resourceType: string,
  logicalId: string,
  physicalId?: string
): Refuse {
  const updating = physicalId !== undefined;
  return (path, expected) => {
    throw markNonRetryable(
      new ProvisioningError(
        `${updating ? 'desired ' : ''}${path} of ${resourceType} ${logicalId} is not ${expected} ` +
          `— the resource was not ${updating ? 'updated' : 'created'}`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  };
}

/** CFn shape of a `GetBucketEncryption` rule list. */
function encryptionFromSdk(rules: ServerSideEncryptionRule[]): Json {
  return {
    ServerSideEncryptionConfiguration: rules.map((rule) => {
      const out: Json = {};
      const byDefault = rule.ApplyServerSideEncryptionByDefault;
      if (byDefault) {
        out['ServerSideEncryptionByDefault'] = {
          ...(byDefault.SSEAlgorithm !== undefined ? { SSEAlgorithm: byDefault.SSEAlgorithm } : {}),
          ...(byDefault.KMSMasterKeyID !== undefined
            ? { KMSMasterKeyID: byDefault.KMSMasterKeyID }
            : {}),
        };
      }
      if (rule.BucketKeyEnabled !== undefined) out['BucketKeyEnabled'] = rule.BucketKeyEnabled;
      return out;
    }),
  };
}

/** CFn shape of a `GetBucketLifecycleConfiguration` rule list. */
function lifecycleFromSdk(rules: LifecycleRule[]): Json {
  return {
    Rules: rules.map((rule) => {
      const out: Json = {};
      if (rule.ID !== undefined) out['Id'] = rule.ID;
      if (rule.Status !== undefined) out['Status'] = rule.Status;
      const scope = { ...(rule.Filter?.And ?? {}), ...(rule.Filter ?? {}) } as Json;
      // A legacy rule-level prefix, should S3 answer one.
      const prefix = (scope['Prefix'] as string | undefined) ?? rule.Prefix;
      // An empty prefix is "every object", which the CFn rule spells by
      // carrying none (and the write side sends for one).
      if (prefix !== undefined && prefix !== '') out['Prefix'] = prefix;
      if (typeof scope['ObjectSizeGreaterThan'] === 'number') {
        out['ObjectSizeGreaterThan'] = String(scope['ObjectSizeGreaterThan']);
      }
      if (typeof scope['ObjectSizeLessThan'] === 'number') {
        out['ObjectSizeLessThan'] = String(scope['ObjectSizeLessThan']);
      }
      if (rule.Expiration?.Days !== undefined) out['ExpirationInDays'] = rule.Expiration.Days;
      if (rule.AbortIncompleteMultipartUpload) {
        const after = rule.AbortIncompleteMultipartUpload.DaysAfterInitiation;
        out['AbortIncompleteMultipartUpload'] =
          after !== undefined ? { DaysAfterInitiation: after } : {};
      }
      return out;
    }),
  };
}

/** CFn shape of a listed metrics configuration. */
function metricsFromSdk(item: MetricsConfiguration): Json {
  const filter = item.Filter;
  const scope = (filter?.And ?? filter ?? {}) as { Prefix?: string; AccessPointArn?: string };
  return {
    Id: item.Id,
    ...(scope.Prefix !== undefined ? { Prefix: scope.Prefix } : {}),
    ...(scope.AccessPointArn !== undefined ? { AccessPointArn: scope.AccessPointArn } : {}),
  };
}

/** CFn shape of a listed inventory configuration. */
function inventoryFromSdk(item: InventoryConfiguration): Json {
  const dest = item.Destination?.S3BucketDestination;
  return {
    Id: item.Id,
    Destination: {
      ...(dest?.Bucket !== undefined ? { BucketArn: dest.Bucket } : {}),
      ...(dest?.AccountId !== undefined ? { BucketAccountId: dest.AccountId } : {}),
      ...(dest?.Format !== undefined ? { Format: dest.Format } : {}),
      ...(dest?.Prefix !== undefined ? { Prefix: dest.Prefix } : {}),
    },
    ...(item.IsEnabled !== undefined ? { Enabled: item.IsEnabled } : {}),
    ...(item.IncludedObjectVersions !== undefined
      ? { IncludedObjectVersions: item.IncludedObjectVersions }
      : {}),
    ...(item.Filter?.Prefix !== undefined ? { Prefix: item.Filter.Prefix } : {}),
    ...(item.Schedule?.Frequency !== undefined
      ? { ScheduleFrequency: item.Schedule.Frequency }
      : {}),
    ...(item.OptionalFields !== undefined && item.OptionalFields.length > 0
      ? { OptionalFields: [...item.OptionalFields] }
      : {}),
  };
}

/**
 * The value S3 reads `BucketKeyEnabled` as when a rule leaves it unset, by
 * algorithm: off for SSE-S3, and ALWAYS on for SSE-KMS, which a directory
 * bucket cannot turn off ("S3 Bucket Keys are always enabled for GET and PUT
 * operations in a directory bucket", the `PutBucketEncryption` reference).
 */
function impliedBucketKey(algorithm: unknown): boolean | undefined {
  if (algorithm === 'AES256') return false;
  if (algorithm === 'aws:kms') return true;
  return undefined;
}

/**
 * {@link S3DirectoryBucketProvider.canonicalizeDriftProperties}'s two
 * rewrites, each the identity when it does not apply: a `BucketKeyEnabled`
 * at the value its algorithm implies, and a lifecycle rule's empty `Prefix`,
 * are both dropped, since the readback and a template can each spell the same
 * bucket with or without them.
 */
function canonicalizeConfigurationsForDrift(properties: Json): Json {
  let out = properties;
  const encryption = properties['BucketEncryption'];
  if (isRecord(encryption) && Array.isArray(encryption['ServerSideEncryptionConfiguration'])) {
    let changed = false;
    const rules = (encryption['ServerSideEncryptionConfiguration'] as unknown[]).map((rule) => {
      if (!isRecord(rule) || !('BucketKeyEnabled' in rule)) return rule;
      const byDefault = rule['ServerSideEncryptionByDefault'];
      const implied = impliedBucketKey(isRecord(byDefault) ? byDefault['SSEAlgorithm'] : undefined);
      // A template parameter spells the boolean as a string.
      const declared = rule['BucketKeyEnabled'];
      const asBoolean = declared === 'true' ? true : declared === 'false' ? false : declared;
      if (implied === undefined || asBoolean !== implied) return rule;
      changed = true;
      const { BucketKeyEnabled: _dropped, ...rest } = rule;
      return rest;
    });
    if (changed) {
      out = {
        ...out,
        BucketEncryption: { ...encryption, ServerSideEncryptionConfiguration: rules },
      };
    }
  }
  const lifecycle = properties['LifecycleConfiguration'];
  if (isRecord(lifecycle) && Array.isArray(lifecycle['Rules'])) {
    let changed = false;
    const rules = (lifecycle['Rules'] as unknown[]).map((rule) => {
      if (!isRecord(rule) || rule['Prefix'] !== '') return rule;
      changed = true;
      const { Prefix: _dropped, ...rest } = rule;
      return rest;
    });
    if (changed) out = { ...out, LifecycleConfiguration: { ...lifecycle, Rules: rules } };
  }
  return out;
}

/**
 * Whether the live value of configuration `name` is the one `desired` asks for,
 * read the way `cdkd drift` reads the pair: both sides canonicalized
 * ({@link canonicalizeConfigurationsForDrift}), the two `Id`-keyed lists as
 * sets, and an `Id` S3 assigned to a lifecycle rule the template left
 * unnamed not counted.
 */
function liveMatchesDesired(name: string, desired: Json, live: Json): boolean {
  const d = canonicalizeConfigurationsForDrift({ [name]: desired[name] })[name];
  let l = canonicalizeConfigurationsForDrift({ [name]: live[name] })[name];
  if (name === 'LifecycleConfiguration' && isRecord(d) && isRecord(l)) {
    const dRules = Array.isArray(d['Rules']) ? (d['Rules'] as unknown[]) : [];
    const lRules = Array.isArray(l['Rules']) ? (l['Rules'] as unknown[]) : [];
    l = {
      ...l,
      Rules: lRules.map((rule, i) => {
        const declared = dRules[i];
        if (!isRecord(rule) || !isRecord(declared) || 'Id' in declared) return rule;
        const { Id: _assigned, ...rest } = rule;
        return rest;
      }),
    };
  }
  if (name === 'MetricsConfigurations' || name === 'InventoryConfigurations') {
    // An inventory's `OptionalFields` is a set too.
    const withSortedFields = (item: unknown): unknown =>
      isRecord(item) && Array.isArray(item['OptionalFields'])
        ? { ...item, OptionalFields: [...(item['OptionalFields'] as unknown[])].map(String).sort() }
        : item;
    const asSet = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.map((item) => canonicalJson(withSortedFields(item))).sort()
        : [canonicalJson(v)];
    return sameJson(asSet(d), asSet(l));
  }
  return sameJson(d, l);
}

/** The IAM action each configuration read needs, named when it is denied. */
const CONFIGURATION_READ_ACTIONS: Record<string, string> = {
  BucketEncryption: 's3express:GetEncryptionConfiguration',
  LifecycleConfiguration: 's3express:GetLifecycleConfiguration',
  MetricsConfigurations: 's3express:GetMetricsConfiguration',
  InventoryConfigurations: 's3express:GetInventoryConfiguration',
};

/**
 * SDK Provider for AWS::S3Express::DirectoryBucket
 *
 * Uses S3 SDK directly for S3 Express Directory Bucket operations.
 * Directory buckets use the S3 Express One Zone storage class with
 * single-AZ data redundancy.
 */
export class S3DirectoryBucketProvider implements ResourceProvider {
  private s3Client: S3Client;
  private createClient: Promise<S3Client> | undefined;
  /** The credential half of the `AwsClients` `s3Client` came from (#4639). */
  private readonly credentialConfig: CredentialConfig;
  private stsClient: STSClient;
  private logger = getLogger().child('S3DirectoryBucketProvider');

  /**
   * The failure wrap this provider's create, update and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through the operation's
   * masker, and the wrap is stamped `markRedactedCause`, so the retry
   * classifiers read the withheld text on the `cause` chain. An "already
   * exists" is restated ({@link relayedNameCollision}), so a create-first
   * replacement still recognises the collision. A cdkd-authored or transport
   * error keeps its text, masked, stamped only when the mask changed it
   * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like
   * an AWS one, unstamped (it has no chain). A delete catch tests not-found
   * before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  private wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::S3Express::DirectoryBucket',
      new Set([
        'DataRedundancy',
        'LocationName',
        'BucketName',
        'Tags',
        'BucketEncryption',
        'LifecycleConfiguration',
        'MetricsConfigurations',
        'InventoryConfigurations',
      ]),
    ],
  ]);

  /**
   * go-to-k/cdkd#5487: the live values of the unsettled `names`, for the
   * engine's convergence step and its post-update proof. That proof compares
   * the TEMPLATE's value with this read without the drift canonicalization,
   * so a configuration AWS holds as asked, but spells otherwise (an implied
   * `BucketKeyEnabled`, an `Id` S3 gave an unnamed lifecycle rule), is
   * answered in the template's spelling ({@link liveMatchesDesired});
   * anything else is answered as read. A failed read throws.
   */
  async readUnsettled(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    names: ReadonlySet<string>,
    recordedProperties?: Record<string, unknown>,
    desiredProperties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    // Every unsettled name must be read: a failed read throws.
    const live = await this.readState(physicalId);
    if (live === RESOURCE_NOT_FOUND) return live;
    const desired = desiredProperties ?? recordedProperties ?? {};
    const out: Record<string, unknown> = {};
    for (const name of names) {
      if (!Object.hasOwn(live, name)) continue;
      if (desired[name] !== undefined && liveMatchesDesired(name, desired, live)) {
        out[name] = desired[name];
        continue;
      }
      // An `Id` neither the record nor the template names is somebody else's
      // (added out of band): it is left out, so the convergence never deletes
      // it, as it never removes a tag it did not record. The known limit is
      // the Tags one in unsettled-convergence.ts: an Id a failed attempt Put,
      // then dropped from the template before the next deploy, is named by
      // neither side and stays.
      if (name === 'MetricsConfigurations' || name === 'InventoryConfigurations') {
        const named = new Set([
          ...recordedItems(recordedProperties?.[name]).keys(),
          ...recordedItems(desiredProperties?.[name]).keys(),
        ]);
        const items = live[name];
        out[name] = Array.isArray(items)
          ? items.filter((item) => {
              const id = itemId(item);
              return id !== undefined && named.has(id);
            })
          : items;
        continue;
      }
      out[name] = live[name];
    }
    return out;
  }

  /**
   * The two `Id`-keyed lists are SETS: S3 names each item by its `Id` and
   * documents no order for `ListBucketMetricsConfigurations` /
   * `ListBucketInventoryConfigurations`, and an inventory's `OptionalFields`
   * is a set of field names. `LifecycleConfiguration.Rules` stays ordered.
   */
  getDriftUnorderedPaths(resourceType: string): string[] {
    if (resourceType !== 'AWS::S3Express::DirectoryBucket') return [];
    return ['MetricsConfigurations', 'InventoryConfigurations'];
  }

  /**
   * Drops, from BOTH drift bags, what a template and the readback can each
   * spell either way for the same bucket: a `BucketKeyEnabled` at the value
   * its algorithm implies, and a lifecycle rule's empty `Prefix`
   * ({@link canonicalizeConfigurationsForDrift}). Identity otherwise.
   */
  canonicalizeDriftProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (resourceType !== 'AWS::S3Express::DirectoryBucket') return properties;
    return canonicalizeConfigurationsForDrift(properties);
  }

  private ec2Client: EC2Client | undefined;
  private s3ControlClient: S3ControlClient | undefined;
  private readonly providerRegion = ambientRegion();

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
    this.stsClient = awsClients.sts;
    // A test double may carry no `credentialConfig`: degrade to `{}`, as
    // `ambientCredentialConfig` does.
    this.credentialConfig =
      (awsClients as { credentialConfig?: CredentialConfig }).credentialConfig ?? {};
  }

  /**
   * The client `CreateBucket` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * -- and every other provider sharing `getAwsClients().s3` -- keeps the full
   * SDK retry. Built in the shared client's REGION (read from it, as
   * `config.region()` resolves it), so the create cannot land in another
   * region than the calls around it, and with the credentials of the SAME
   * `AwsClients` that client came from, read at construction, so a later
   * `setAwsClients` switch cannot give the create another identity. The
   * PROMISE is cached, so two creates on a cold provider build one client; a
   * rejected region read is not cached, so the next create retries it.
   *
   * `CreateBucket` carries no idempotency token, and a directory bucket name
   * is unique in its zone, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with the bucket the first send made, and that
   * collision surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). The bucket is
   * not adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  private getCreateClient(): Promise<S3Client> {
    this.createClient ??= this.s3Client.config.region().then(
      (region) =>
        withoutServerErrorRetries(
          new S3Client({ ...clientDefaultsFor(this.credentialConfig), region })
        ),
      (error: unknown) => {
        this.createClient = undefined;
        throw error;
      }
    );
    return this.createClient;
  }

  private getEc2Client(): EC2Client {
    if (!this.ec2Client) {
      this.ec2Client = new EC2Client({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.ec2Client;
  }

  /**
   * Directory-bucket tags live on the S3 control plane: `PutBucketTagging`
   * is documented "not supported for directory buckets", and the tag CRUD
   * after create is S3 Control's `TagResource` / `UntagResource` /
   * `ListTagsForResource` (requiring the `s3express:TagResource` /
   * `s3express:UntagResource` / `s3express:ListTagsForResource` permissions).
   */
  private getS3ControlClient(): S3ControlClient {
    if (!this.s3ControlClient) {
      this.s3ControlClient = new S3ControlClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.s3ControlClient;
  }

  /**
   * Convert AZ name (us-east-1a) to AZ ID (use1-az1) via EC2 DescribeAvailabilityZones
   */
  private async getAzId(azName: string): Promise<string> {
    try {
      const response = await this.getEc2Client().send(
        new DescribeAvailabilityZonesCommand({
          ZoneNames: [azName],
        })
      );
      const azId = response.AvailabilityZones?.[0]?.ZoneId;
      if (azId) {
        this.logger.debug(`Resolved AZ name ${azName} → AZ ID ${azId}`);
        return azId;
      }
    } catch (error) {
      this.logger.debug(
        `Failed to resolve AZ ID for ${azName}: ${describeAwsFailure(error).detail}`
      );
    }
    // Fallback: return the AZ name as-is
    return azName;
  }

  /**
   * Get the region from the S3 client config
   */
  private async getRegion(): Promise<string> {
    const region = await this.s3Client.config.region();
    return region || 'us-east-1';
  }

  /**
   * Get the AWS account ID via STS
   */
  private async getAccountId(): Promise<string> {
    const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
    return identity.Account!;
  }

  /**
   * Build attributes for a directory bucket
   */
  private async buildAttributes(bucketName: string): Promise<Record<string, unknown>> {
    return {
      Arn: await this.buildBucketArn(bucketName),
    };
  }

  /**
   * Directory bucket ARN:
   * `arn:{partition}:s3express:{region}:{account}:bucket/{name}`.
   * Also the `ResourceArn` for the S3 Control tag operations. Callers that
   * already resolved the account (for the S3 Control `AccountId` parameter)
   * pass it in so the STS lookup runs once per operation.
   *
   * The partition is derived from the region through the same closed mapping
   * `${AWS::Partition}` uses (issue #1815) rather than hardcoded to `aws`.
   * Here it is load-bearing TWICE over: the value is served as the bucket's
   * `Arn` attribute AND passed to S3 Control as the `ResourceArn` of a tag
   * mutation, so outside the commercial partition the wrong literal does not
   * merely record a bad string — it aims the tag call at an ARN that does not
   * name this bucket.
   *
   * KNOWN BOUND (pre-existing, not introduced by #1815): the region — and now
   * the partition derived from it — comes from `s3Client`, while the tag
   * calls that consume this ARN go through `s3ControlClient`, built from
   * `providerRegion` (`ambientRegion()`). Those two can disagree,
   * so the ARN can name a different region than the client receiving it. The
   * region SEGMENT already had this exposure before the partition rode along
   * with it; unifying the two clients' region resolution is a separate change.
   */
  private async buildBucketArn(bucketName: string, accountId?: string): Promise<string> {
    const region = await this.getRegion();
    const account = accountId ?? (await this.getAccountId());
    const { partition } = derivePartitionAndUrlSuffix(region);
    return `arn:${partition}:s3express:${region}:${account}:bucket/${bucketName}`;
  }

  /**
   * Create an S3 Express Directory Bucket
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 Express Directory Bucket ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
    // go-to-k/cdkd#2762: the configuration writes after CreateBucket, built
    // (and a malformed one refused) before any call.
    // A create REPLAYING a state record (the rollback executor reviving the old
    // bucket of a reverse replacement) warns and leaves a malformed one out,
    // as `DataRedundancy` does below (issue #1544): the template cannot fix it.
    const configs = desiredConfigurations(
      properties,
      configurationRefuser(resourceType, logicalId),
      replayWarn(this.logger, context).onUnusable
    );

    // `replayWarn`: the rollback executor's reverse-replacement arm revives
    // the OLD bucket from `previousState.properties`, which the user cannot
    // edit from the template — a hard refusal there would leave the resource
    // unrestorable (issue #1544). Template-path creates keep the refusal.
    const dataRedundancy = requireConfigString(
      properties['DataRedundancy'],
      'SingleAvailabilityZone',
      'AWS::S3Express::DirectoryBucket DataRedundancy',
      replayWarn(this.logger, context)
    );
    // CFn LocationName: "us-east-1a--x-s3" → extract AZ name: "us-east-1a"
    const cfnLocationName = properties['LocationName'] as string | undefined;
    const azName = cfnLocationName?.replace(/--x-s3$/, '') || 'us-east-1a';

    // S3 CreateBucket API requires AZ ID (use1-az1), not AZ name (us-east-1a)
    const azId = await this.getAzId(azName);

    // Generate bucket name if not specified
    // Directory bucket names must follow: {name}--{az-id}--x-s3
    let bucketName = properties['BucketName'] as string | undefined;
    if (!bucketName) {
      // The WHOLE name is at most 63 characters (go-to-k/cdkd#5064: a cut to
      // 64 before the suffix made every long name invalid). The rule Cloud
      // Control fills too (go-to-k/cdkd#5095).
      bucketName = generatedNameFor('AWS::S3Express::DirectoryBucket', logicalId, {
        zoneId: azId,
      });
    }

    // Tags ride the create call itself (`CreateBucketConfiguration.Tags`,
    // needing `s3express:TagResource`) — the ONLY tag write the plain
    // s3express data/control split supports at create time. A malformed
    // value was refused above; an absent or empty list omits the member.
    const tags: Tag[] = desiredTags;
    const includeTags = tags.length > 0;

    let bucketCreated = false;
    try {
      // Resolved BEFORE CreateBucket (go-to-k/cdkd#4583): the STS account
      // lookup is the only call that could otherwise fail after the bucket
      // exists, leaving a bucket no state record names.
      const attributes = await this.buildAttributes(bucketName);

      await (
        await this.getCreateClient()
      ).send(
        new CreateBucketCommand({
          Bucket: bucketName,
          CreateBucketConfiguration: {
            Bucket: {
              Type: 'Directory',
              DataRedundancy: dataRedundancy as DataRedundancy,
            },
            Location: {
              Name: azId,
              // A Local Zone bucket names its zone with `Type: 'LocalZone'`
              // (go-to-k/cdkd#5317); the zone id flows through `getAzId`
              // unchanged (its lookup fails soft to the given name).
              Type: dataRedundancy === 'SingleLocalZone' ? 'LocalZone' : 'AvailabilityZone',
            },
            ...(includeTags ? { Tags: tags } : {}),
          },
        })
      );
      bucketCreated = true;
      this.logger.debug(`Created S3 Express Directory Bucket: ${bucketName}`);

      await this.applyConfigurations(bucketName, configs, properties, {}, true);

      return {
        physicalId: bucketName,
        attributes,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create S3 Express Directory Bucket ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            bucketName,
            cause
          )
      );
      // A configuration write failed after CreateBucket returned: the bucket
      // exists because THIS create made it, so the deploy engine can journal
      // it for `cdkd rollback --revert-failed`.
      if (bucketCreated) markCreatedBeforeFailure(thrown, logicalId, resourceType, bucketName);
      throw thrown;
    }
  }

  /**
   * Converge the four configuration properties (go-to-k/cdkd#2762) from
   * `previous` to `desired`: what `desired` holds and `previous` does not hold
   * in the same form is Put, and what `previous` holds and `desired` no longer
   * does is Deleted. On create (`creating`) everything desired is Put and
   * nothing is Deleted. A Delete is a REMOVAL from the template. That this
   * matches CloudFormation's update is ASSUMED, not measured with a CFn A/B:
   * it is inferred from the CFn handler's update permissions, the
   * `s3express:Put*` ones the directory-bucket Delete calls require:
   *  - `DeleteBucketEncryption` returns the bucket to its default, SSE-S3;
   *  - `DeleteBucketLifecycle` removes every rule;
   *  - `DeleteBucketMetricsConfiguration` / `DeleteBucketInventoryConfiguration`
   *    remove the one item a removed `Id` names, leaving the others.
   * `previous` is read leniently (it is the record, which the template cannot
   * fix); only `desired` was refused when malformed.
   */
  private async applyConfigurations(
    bucketName: string,
    desired: DesiredConfigurations,
    desiredRaw: Record<string, unknown>,
    previousRaw: Record<string, unknown>,
    creating: boolean,
    // go-to-k/cdkd#5380: named before each write, so an update failing after
    // an earlier write landed leaves that key unsettled for the next deploy.
    markUnsettled: (key: string) => void = () => {}
  ): Promise<void> {
    const changed = (desiredValue: unknown, previousValue: unknown): boolean =>
      creating || !sameJson(desiredValue, previousValue);
    // What the RECORD holds, read leniently: an empty rule list (the readback's
    // "none") holds nothing to delete, and a malformed record is assumed to
    // hold something, so the Delete converges it.
    const holds = (value: unknown, toSdk: (v: unknown, refuse: Refuse) => unknown): boolean => {
      try {
        return (
          toSdk(value, () => {
            throw new Error('malformed');
          }) !== undefined
        );
      } catch {
        return true;
      }
    };

    if (changed(desiredRaw['BucketEncryption'], previousRaw['BucketEncryption'])) {
      if (desired.encryption) {
        markUnsettled('BucketEncryption');
        await this.s3Client.send(
          new PutBucketEncryptionCommand({
            Bucket: bucketName,
            ServerSideEncryptionConfiguration: desired.encryption,
          })
        );
      } else if (!creating && holds(previousRaw['BucketEncryption'], encryptionToSdk)) {
        markUnsettled('BucketEncryption');
        await this.s3Client.send(new DeleteBucketEncryptionCommand({ Bucket: bucketName }));
        this.logger.debug('Sent DeleteBucketEncryption: the default encryption is back to SSE-S3');
      }
    }

    if (changed(desiredRaw['LifecycleConfiguration'], previousRaw['LifecycleConfiguration'])) {
      if (desired.lifecycle) {
        markUnsettled('LifecycleConfiguration');
        await this.s3Client.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: bucketName,
            LifecycleConfiguration: desired.lifecycle,
          })
        );
      } else if (!creating && holds(previousRaw['LifecycleConfiguration'], lifecycleToSdk)) {
        markUnsettled('LifecycleConfiguration');
        await this.s3Client.send(new DeleteBucketLifecycleCommand({ Bucket: bucketName }));
        this.logger.debug('Sent DeleteBucketLifecycle: every lifecycle rule is removed');
      }
    }

    const desiredMetrics = recordedItems(desiredRaw['MetricsConfigurations']);
    const previousMetrics = creating
      ? new Map<string, unknown>()
      : recordedItems(previousRaw['MetricsConfigurations']);
    for (const [id, config] of desired.metrics) {
      if (previousMetrics.has(id) && sameJson(previousMetrics.get(id), desiredMetrics.get(id))) {
        continue;
      }
      markUnsettled('MetricsConfigurations');
      await this.s3Client.send(
        new PutBucketMetricsConfigurationCommand({
          Bucket: bucketName,
          Id: id,
          MetricsConfiguration: config,
        })
      );
    }
    for (const id of previousMetrics.keys()) {
      if (desired.metrics.has(id)) continue;
      markUnsettled('MetricsConfigurations');
      await this.deleteItemIdempotently(
        new DeleteBucketMetricsConfigurationCommand({ Bucket: bucketName, Id: id })
      );
    }

    const desiredInventory = recordedItems(desiredRaw['InventoryConfigurations']);
    const previousInventory = creating
      ? new Map<string, unknown>()
      : recordedItems(previousRaw['InventoryConfigurations']);
    for (const [id, config] of desired.inventory) {
      if (
        previousInventory.has(id) &&
        sameJson(previousInventory.get(id), desiredInventory.get(id))
      ) {
        continue;
      }
      markUnsettled('InventoryConfigurations');
      await this.s3Client.send(
        new PutBucketInventoryConfigurationCommand({
          Bucket: bucketName,
          Id: id,
          InventoryConfiguration: config,
        })
      );
    }
    for (const id of previousInventory.keys()) {
      if (desired.inventory.has(id)) continue;
      markUnsettled('InventoryConfigurations');
      await this.deleteItemIdempotently(
        new DeleteBucketInventoryConfigurationCommand({ Bucket: bucketName, Id: id })
      );
    }
  }

  /**
   * A per-`Id` Delete whose item is already gone is done: the deploy engine
   * re-runs a failed `update()` whole with the same `previousProperties`, so
   * an item an earlier attempt deleted answers `NoSuchConfiguration` on the
   * retry, and failing there would strand the update on every later deploy.
   */
  private async deleteItemIdempotently(
    command: DeleteBucketMetricsConfigurationCommand | DeleteBucketInventoryConfigurationCommand
  ): Promise<void> {
    try {
      if (command instanceof DeleteBucketMetricsConfigurationCommand) {
        await this.s3Client.send(command);
      } else {
        await this.s3Client.send(command);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchConfiguration') {
        this.logger.debug('A configuration this update deletes is already gone');
        return;
      }
      throw error;
    }
  }

  /**
   * Update an S3 Express Directory Bucket
   *
   * `BucketName` / `DataRedundancy` / `LocationName` are create-only (the
   * registry-schema fallback classifies changes to them as replacement). The
   * four bucket configurations converge through {@link applyConfigurations}
   * (go-to-k/cdkd#2762). `Tags` are applied via S3 Control's
   * `TagResource` / `UntagResource` (the directory-bucket tag CRUD; the
   * bucket-level `PutBucketTagging` is not supported for directory buckets).
   * `TagResource` is additive-only, so a tag dropped from the template
   * (partial removal) — or the entire `Tags` property removed (full removal,
   * `newTags === undefined`) — would survive on AWS unless the removed keys
   * are explicitly `UntagResource`d.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // go-to-k/cdkd#2613: the tag writes name the bucket by an ARN whose region
    // is the shared S3 client's and go out through the S3 Control client, so
    // both are compared with the recorded region: either one in another region
    // than the state record would aim the writes at a region this record was
    // not written through. Ahead of the STS lookup and every write, outside the
    // try so a refusal is not re-labelled as an AWS failure. The clients'
    // regions are resolved only when there is one to compare with.
    if (context?.expectedRegion) {
      for (const clientRegion of [
        await this.s3Client.config.region(),
        await this.getS3ControlClient().config.region(),
      ]) {
        assertRegionMatch(
          clientRegion,
          context.expectedRegion,
          resourceType,
          logicalId,
          physicalId,
          'pre-update'
        );
      }
    }
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call
    // (read as empty, it would untag every recorded key).
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    // go-to-k/cdkd#2762: a malformed desired configuration is refused before
    // any call too.
    const configs = desiredConfigurations(
      properties,
      configurationRefuser(resourceType, logicalId, physicalId)
    );
    try {
      const plan = planTagDiff(previousProperties['Tags'], properties['Tags']);
      const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
      if (tagWarning !== undefined) {
        this.logger.warn(tagWarning);
      }
      const removedKeys = plan.remove;
      const tagsToApply: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
      if (removedKeys.length > 0 || tagsToApply.length > 0) {
        const accountId = await this.getAccountId();
        const resourceArn = await this.buildBucketArn(physicalId, accountId);

        if (removedKeys.length > 0) {
          context?.markUnsettled?.('Tags');
          await this.getS3ControlClient().send(
            new UntagResourceCommand({
              AccountId: accountId,
              ResourceArn: resourceArn,
              TagKeys: removedKeys,
            })
          );
        }
        // Apply added / changed tags. Skip the call when there are none
        // (a pure removal has nothing left to add).
        if (tagsToApply.length > 0) {
          context?.markUnsettled?.('Tags');
          await this.getS3ControlClient().send(
            new TagResourceCommand({
              AccountId: accountId,
              ResourceArn: resourceArn,
              Tags: tagsToApply,
            })
          );
        }
        this.logger.debug(`Updated tags for S3 Express Directory Bucket ${physicalId}`);
      }
      await this.applyConfigurations(
        physicalId,
        configs,
        properties,
        previousProperties,
        false,
        (key) => context?.markUnsettled?.(key)
      );
      return {
        physicalId,
        wasReplaced: false,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update S3 Express Directory Bucket ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * Delete an S3 Express Directory Bucket
   *
   * CloudFormation-parity data guard (issue #1344, sibling of #1340): a
   * non-empty directory bucket is only auto-emptied when the user opted in —
   * the `aws-cdk:auto-delete-objects` tag on the bucket (a first-class
   * template `Tags` entry now that `Tags` is a handled property, issue #609)
   * or the deploy engine's `--force-stateful-recreation` consent on a
   * replacement delete (`DeleteContext.forceDataDelete`). Otherwise the
   * not-empty error surfaces exactly like CloudFormation's DELETE_FAILED
   * (live-A/B-verified 2026-08-03: CFn fails a non-empty DirectoryBucket
   * delete with "The bucket you tried to delete is not empty", 409).
   *
   * Directory buckets do not support versioning, so the opted-in auto-empty
   * only needs to delete current objects.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    // go-to-k/cdkd#2007: the physical id is the bucket name, which can be
    // secret-derived.
    const mask = maskerOrIdentity(context?.maskSecrets);
    this.logger.debug(
      mask(`Deleting S3 Express Directory Bucket ${logicalId}: ${mask(physicalId)}`)
    );
    // go-to-k/cdkd#2613: the empty-and-delete goes through the shared S3
    // client, so a client in another region than the state record would aim
    // it at a region this record was not written through. Refuse before any
    // call, not only on NoSuchBucket; the client's region is resolved only when
    // there is one to compare with.
    assertRegionMatch(
      context?.expectedRegion ? await this.s3Client.config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-delete'
    );

    const allowAutoEmpty =
      context?.forceDataDelete === true ||
      hasCdkAutoDeleteTag(properties, S3_AUTO_DELETE_OBJECTS_TAG);

    try {
      await this.deleteBucketWithEmptyRetry(
        logicalId,
        physicalId,
        allowAutoEmpty,
        context?.maskSecrets
      );
    } catch (error) {
      // Bucket not found = already deleted (idempotent)
      if (
        error instanceof Error &&
        (error.name === 'NoSuchBucket' || error.name === 'BucketNotFound')
      ) {
        const clientRegion = await this.s3Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(mask(`Bucket ${mask(physicalId)} does not exist, skipping deletion`));
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            mask(`Failed to delete S3 Express Directory Bucket ${logicalId}: ${text}`),
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // The wrap names an AWS failure by its CLASS, and the delete classifiers
      // read `NotFoundException` in a message as "already deleted": only the
      // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }
  }

  /**
   * Delete the bucket, absorbing the write race on an opted-in auto-empty:
   * an object written between the empty pass and the delete makes AWS reject
   * the delete as not-empty, so re-empty and retry (bounded) — the same
   * bounded loop as the standard-bucket sibling, ported per issue #609's
   * "Tags becomes a handled property" note (the tag opt-in is mainstream
   * now, so the ~zero-opt-in rationale for skipping the loop in PR #1347 no
   * longer holds). Without the opt-in, the first not-empty error surfaces
   * as the CloudFormation-parity guard (issue #1344).
   */
  private async deleteBucketWithEmptyRetry(
    logicalId: string,
    bucketName: string,
    allowAutoEmpty: boolean,
    maskSecrets: MaskerFn | undefined
  ): Promise<void> {
    const mask = maskerOrIdentity(maskSecrets);
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
        this.logger.debug(`Successfully deleted S3 Express Directory Bucket ${logicalId}`);
        return;
      } catch (error) {
        // `.detail`, never `.summary`: the substring test below is what keeps this
        // degradation alive, and it matches AWS's OWN wording. Byte-identical to
        // the ternary it replaced, minus that ternary's throw.
        const msg = describeAwsFailure(error).detail;
        if (msg.includes('not empty') || msg.includes('BucketNotEmpty')) {
          if (!allowAutoEmpty) {
            throw markNonRetryable(new Error(notEmptyRefusalMessage(bucketName, maskSecrets)));
          }
          this.logger.info(
            mask(
              `Directory bucket ${mask(bucketName)} not empty (attempt ${attempt}/${maxAttempts}), emptying (auto-delete opt-in present)...`
            )
          );
          await this.emptyBucket(bucketName, mask);
          continue;
        }
        throw error;
      }
    }
    // Final attempt after emptying
    await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
    this.logger.debug(`Successfully deleted S3 Express Directory Bucket ${logicalId}`);
  }

  /**
   * Empty all objects from a directory bucket.
   * Lists and deletes objects in batches of 1000.
   */
  private async emptyBucket(bucketName: string, mask: MaskerFn): Promise<void> {
    let continuationToken: string | undefined;

    do {
      const listResponse = await this.s3Client.send(
        new ListObjectsV2Command({
          // go-to-k/cdkd#3313: a CR in a key becomes an LF without this.
          EncodingType: LISTING_ENCODING_TYPE,
          Bucket: bucketName,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        })
      );

      const objects = listResponse.Contents;
      if (objects && objects.length > 0) {
        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
              // go-to-k/cdkd#3313: decoded — these Keys are deleted.
              Objects: objects.map((obj) => ({ Key: decodeListingKey(obj.Key) })),
              Quiet: true,
            },
          })
        );
        this.logger.debug(
          mask(`Deleted ${objects.length} objects from bucket ${mask(bucketName)}`)
        );
      }

      continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  /**
   * Read the AWS-current S3 Express Directory Bucket configuration in
   * CFn-property shape.
   *
   * Issues `HeadBucket` to verify existence and surfaces `BucketName`
   * (the physicalId) plus `Tags` (via S3 Control `ListTagsForResource`,
   * the directory-bucket tag read). `DataRedundancy` comes from the
   * `HeadBucket` response's `BucketLocationType`; `LocationName` is not
   * exposed by any cheap S3 Express API — the only way to inspect it is by
   * parsing the bucket name's `--<az-id>--x-s3` suffix, which is best
   * effort.
   *
   * `--<az-id>--x-s3` suffix parsing: directory bucket names follow the
   * format `<base>--<az-id>--x-s3`, e.g.
   * `my-bucket--use1-az1--x-s3`. We don't reverse the AZ-ID -> AZ-name
   * mapping here (that would require a per-call EC2 `DescribeAvailabilityZones`
   * round-trip); state's `LocationName` is `us-east-1a--x-s3`-style,
   * while the bucket name carries the AZ-ID `use1-az1`. Cross-region
   * mapping is too expensive for v1 — we omit `LocationName` from the
   * snapshot and rely on the comparator's "key absent in state never
   * drifts" rule to no-op against state.
   *
   * Returns `RESOURCE_NOT_FOUND` when the bucket is gone (`HeadBucket` returns
   * `NotFound` / `NoSuchBucket`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return this.readState(physicalId);
  }

  /**
   * {@link readCurrentState}'s read. Every configuration read must succeed: a
   * value left out would read as REMOVED to `cdkd drift` (a directory bucket's
   * encryption is recorded even when undeclared, SSE-S3 being its default), so
   * `--accept` would record nothing and `--revert` would put it back. A
   * missing permission is therefore an error naming the action
   * ({@link CONFIGURATION_READ_ACTIONS}), like any other failure.
   */
  private async readState(physicalId: string): Promise<Record<string, unknown> | ResourceNotFound> {
    let locationType: string | undefined;
    try {
      const head = await this.s3Client.send(new HeadBucketCommand({ Bucket: physicalId }));
      locationType = head?.BucketLocationType;
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NotFound' || e.name === 'NoSuchBucket' || e.name === 'BucketNotFound') {
        return RESOURCE_NOT_FOUND;
      }
      throw err;
    }

    const result: Record<string, unknown> = {
      BucketName: physicalId,
    };

    // Best-effort: directory bucket names always carry `--x-s3`. HeadBucket's
    // `BucketLocationType` tells a Local Zone bucket (`SingleLocalZone`) from
    // an Availability Zone one (`SingleAvailabilityZone`, go-to-k/cdkd#5317),
    // so the comparator does not flag drift when state holds the same value.
    if (physicalId.endsWith('--x-s3')) {
      result['DataRedundancy'] =
        locationType === 'LocalZone' ? 'SingleLocalZone' : 'SingleAvailabilityZone';
    }

    // Tags via S3 Control ListTagsForResource (always-emit per
    // docs/provider-rules.md#readcurrentstate-for-drift-detection; an untagged bucket returns an empty
    // list, not an error, and the comparator's "key absent in state never
    // drifts" rule keeps pre-Tags-support stacks quiet).
    result['Tags'] = await this.readTags(physicalId);

    // go-to-k/cdkd#2762, always emitted: an unset configuration reads as its
    // empty form (`[]` rules / items), which `update()` treats as "none".
    const reads: Array<[string, () => Promise<unknown>]> = [
      ['BucketEncryption', () => this.readEncryption(physicalId)],
      ['LifecycleConfiguration', () => this.readLifecycle(physicalId)],
      ['MetricsConfigurations', () => this.readMetrics(physicalId)],
      ['InventoryConfigurations', () => this.readInventory(physicalId)],
    ];
    const values = await Promise.all(
      reads.map(([key, read]) =>
        read().catch((error: unknown) => {
          const name = (error as { name?: unknown } | undefined)?.name;
          if (name === 'AccessDenied' || name === 'AccessDeniedException') {
            // A plain Error, not a ProvisioningError: the engine's unsettled
            // convergence passes a ProvisioningError through as its own
            // refusal, and wraps anything else with its context.
            throw new Error(
              `Reading ${key} of an S3 Express directory bucket needs ` +
                `${CONFIGURATION_READ_ACTIONS[key]}: grant it to read the bucket back`,
              { cause: error }
            );
          }
          throw error;
        })
      )
    );
    values.forEach((value, i) => {
      result[reads[i]![0]] = value;
    });

    return result;
  }

  private async readEncryption(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
      return encryptionFromSdk(resp.ServerSideEncryptionConfiguration?.Rules ?? []);
    } catch (err) {
      if ((err as { name?: string }).name === 'ServerSideEncryptionConfigurationNotFoundError') {
        return { ServerSideEncryptionConfiguration: [] };
      }
      throw err;
    }
  }

  private async readLifecycle(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
      );
      return lifecycleFromSdk(resp.Rules ?? []);
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchLifecycleConfiguration') {
        return { Rules: [] };
      }
      throw err;
    }
  }

  private async readMetrics(bucket: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let token: string | undefined;
    do {
      const resp = await this.s3Client.send(
        new ListBucketMetricsConfigurationsCommand({ Bucket: bucket, ContinuationToken: token })
      );
      for (const item of resp.MetricsConfigurationList ?? []) out.push(metricsFromSdk(item));
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  private async readInventory(bucket: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let token: string | undefined;
    do {
      const resp = await this.s3Client.send(
        new ListBucketInventoryConfigurationsCommand({ Bucket: bucket, ContinuationToken: token })
      );
      for (const item of resp.InventoryConfigurationList ?? []) out.push(inventoryFromSdk(item));
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  private async readTags(bucketName: string): Promise<Array<{ Key: string; Value: string }>> {
    const accountId = await this.getAccountId();
    const resourceArn = await this.buildBucketArn(bucketName, accountId);
    const resp = await this.getS3ControlClient().send(
      new ListTagsForResourceCommand({ AccountId: accountId, ResourceArn: resourceArn })
    );
    return normalizeAwsTagsToCfn(resp.Tags);
  }

  /**
   * Adopt an existing S3 Express Directory Bucket into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<name>` override or `Properties.BucketName` →
   *     verify via `HeadBucket`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'BucketName');
    if (explicit) {
      try {
        await this.s3Client.send(new HeadBucketCommand({ Bucket: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        const e = err as { name?: string };
        if (e.name === 'NotFound' || e.name === 'NoSuchBucket') return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a
    // directory bucket reaching here needs an explicit `--resource` override.
    return null;
  }
}
