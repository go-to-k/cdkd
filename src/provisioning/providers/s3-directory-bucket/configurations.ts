import {
  type BucketLifecycleConfiguration,
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
} from '@aws-sdk/client-s3';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';

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
export type Refuse = (path: string, expected: string) => never;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A list member's own `Id`, when it is a non-empty string. */
export function itemId(item: unknown): string | undefined {
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

export function sameJson(a: unknown, b: unknown): boolean {
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
export function encryptionToSdk(
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
export function lifecycleToSdk(
  value: unknown,
  refuse: Refuse
): BucketLifecycleConfiguration | undefined {
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
export function recordedItems(value: unknown): Map<string, unknown> {
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
export interface DesiredConfigurations {
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
export function desiredConfigurations(
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
export function configurationRefuser(
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
export function encryptionFromSdk(rules: ServerSideEncryptionRule[]): Json {
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
export function lifecycleFromSdk(rules: LifecycleRule[]): Json {
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
export function metricsFromSdk(item: MetricsConfiguration): Json {
  const filter = item.Filter;
  const scope = (filter?.And ?? filter ?? {}) as { Prefix?: string; AccessPointArn?: string };
  return {
    Id: item.Id,
    ...(scope.Prefix !== undefined ? { Prefix: scope.Prefix } : {}),
    ...(scope.AccessPointArn !== undefined ? { AccessPointArn: scope.AccessPointArn } : {}),
  };
}

/** CFn shape of a listed inventory configuration. */
export function inventoryFromSdk(item: InventoryConfiguration): Json {
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
export function canonicalizeConfigurationsForDrift(properties: Json): Json {
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
export function liveMatchesDesired(name: string, desired: Json, live: Json): boolean {
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
export const CONFIGURATION_READ_ACTIONS: Record<string, string> = {
  BucketEncryption: 's3express:GetEncryptionConfiguration',
  LifecycleConfiguration: 's3express:GetLifecycleConfiguration',
  MetricsConfigurations: 's3express:GetMetricsConfiguration',
  InventoryConfigurations: 's3express:GetInventoryConfiguration',
};
