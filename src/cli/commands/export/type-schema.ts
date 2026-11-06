import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { describeTypeWithThrottleRetry } from '../../../provisioning/describe-type.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import {
  COMPOSITE_PHYSICAL_ID_IDENTIFIERS,
  type IdentifierBackfillDeps,
  resolveIdentifierValue,
} from './composite-physical-id.js';
import {
  COMPOSITE_ID_SPLITTERS,
  type CompositeIdResult,
  PRIMARY_IDENTIFIER_FALLBACK,
} from './composite-id-splitters.js';
import { quotedOrNotShown, safeDetail } from './render.js';

/**
 * Per-type cached registry-schema facts from `cloudformation:DescribeType`.
 * The cache key is the resource type.
 *
 * `fields` is the `primaryIdentifier` field-name list (length 1 for single-key
 * types, length > 1 for composites).
 *
 * `importSupport` records what `DescribeType` says about the type's
 * eligibility for a CFn IMPORT changeset (see {@link typeIsImportUnsupported}):
 * - `importable` — the schema declares a `read` handler, which IMPORT needs.
 * - `unsupported` — no `read` handler AND `ProvisioningType:
 *   NON_PROVISIONABLE`. Two independent fields must positively agree before
 *   cdkd refuses.
 * - `unknown` — anything else, including the `PRIMARY_IDENTIFIER_FALLBACK`
 *   path when DescribeType is unusable. Never blocks: a permissions gap, a
 *   throttle, or a partial response must not be read as "AWS cannot import
 *   this" — those keep the pre-existing behavior of letting CreateChangeSet
 *   answer.
 */
export type PrimaryIdentifierCacheEntry = {
  fields: string[];
  importSupport: 'importable' | 'unsupported' | 'unknown';
};

/**
 * Build the `ResourceIdentifier` map CloudFormation IMPORT expects in
 * `ResourcesToImport[].ResourceIdentifier` for the given resource type
 * and cdkd state's physical ID.
 *
 * Types whose cdkd physicalId is COMPOSITE while the CFn identifier is a
 * single field (`COMPOSITE_PHYSICAL_ID_IDENTIFIERS`): resolved from cdkd
 * state's recorded attributes, BEFORE the field-count branch below — the
 * physicalId is neither the identifier nor a source to split (issue #1659).
 *
 * Single-key types: the map has a single entry keyed by the schema's
 * primaryIdentifier field name (e.g. `{ BucketName: 'my-bucket' }`).
 *
 * Composite types (`primaryIdentifier.length > 1`): a per-type splitter
 * registered in `COMPOSITE_ID_SPLITTERS` parses cdkd's physicalId — whose
 * format is provider-defined, see `src/provisioning/providers/*.ts` —
 * into one entry per field. Composite types without a registered
 * splitter surface a clear error pointing at where to add one.
 *
 * `entry` is the caller's already-resolved registry-schema info — see
 * {@link cachedTypeSchemaInfo}, which prefers `DescribeType` (the authoritative
 * AWS-internal registry) and falls back to a hardcoded single-key table when
 * DescribeType fails (insufficient permissions, throttling, obscure type
 * without a registry entry). Taking it as a parameter rather than fetching is
 * what keeps `buildImportPlan` to ONE DescribeType per type across both the
 * IMPORT pre-flight and this resolution.
 */
export async function resolveResourceIdentifier(
  resourceType: string,
  logicalId: string,
  physicalId: string,
  properties: Record<string, unknown>,
  attributes: Record<string, unknown>,
  entry: PrimaryIdentifierCacheEntry,
  backfillDeps: IdentifierBackfillDeps | undefined
): Promise<CompositeIdResult> {
  // Consulted on BOTH branches (i.e. before either can run): "cdkd's id is
  // composite" and "the CFn identifier is multi-field" are independent facts,
  // and conflating them is the #1659 defect.
  const registered = Object.hasOwn(COMPOSITE_PHYSICAL_ID_IDENTIFIERS, resourceType)
    ? COMPOSITE_PHYSICAL_ID_IDENTIFIERS[resourceType]
    : undefined;
  // A schema reporting one of the entry's `physicalIdIsIdentifierFor` fields
  // as the WHOLE identifier is the "physicalId is the identifier" case the
  // entry exists to bypass — so it is not a schema change to refuse, and the
  // single-key path below is the right one. Decided BEFORE the cross-check,
  // which would otherwise name it as a change. The bypass is scoped to a
  // physicalId that is NOT an ARN: a record adopted through
  // `--migrate-from-cloudformation` stores CloudFormation's `PhysicalResourceId`,
  // which for the API is its ARN, and shipping an ARN as `ApiId` would be a
  // wrong identifier — so under a pre-flip registry such a record keeps the
  // cross-check's loud refusal instead.
  const compositeIdentifier =
    registered &&
    entry.fields.length === 1 &&
    registered.physicalIdIsIdentifierFor?.includes(entry.fields[0]!) &&
    !physicalId.trim().startsWith('arn:')
      ? undefined
      : registered;
  if (compositeIdentifier) {
    if (entry.fields.length !== 1 || entry.fields[0] !== compositeIdentifier.field) {
      throw new Error(
        `${resourceType} is registered in COMPOSITE_PHYSICAL_ID_IDENTIFIERS as identified by ` +
          `'${compositeIdentifier.field}', but CloudFormation now reports primaryIdentifier ` +
          `[${entry.fields.join(', ')}]. The registry schema changed under cdkd — update the ` +
          `entry in src/cli/commands/export.ts (or move the type to COMPOSITE_ID_SPLITTERS if ` +
          `its identifier is now composite too)`
      );
    }
    const value = await resolveIdentifierValue(
      compositeIdentifier,
      { logicalId, physicalId, attributes },
      backfillDeps
    );
    return {
      resourceIdentifier: { [compositeIdentifier.field]: value },
      // Every registered field is `readOnlyProperties` (live DescribeType,
      // us-east-1, 2026-08-13), so NOTHING may be overlaid onto the synth
      // template's Properties — CFn rejects a read-only property write at
      // changeset-create. An explicit empty map instead of relying on the
      // overlay site's "only writes a field the template already carries"
      // conditional, same as the splitter family's narrowing.
      propertiesOverlay: {},
    };
  }

  if (entry.fields.length === 1) {
    // Single-key path: the physicalId IS the identifier value.
    const map = { [entry.fields[0]!]: physicalId };
    return { resourceIdentifier: map };
  }

  // Composite path: consult the per-type splitter.
  const splitter = Object.hasOwn(COMPOSITE_ID_SPLITTERS, resourceType)
    ? COMPOSITE_ID_SPLITTERS[resourceType]
    : undefined;
  if (!splitter) {
    throw new Error(
      `resource type uses a composite primary identifier ` +
        `(${entry.fields.length} fields: ${entry.fields.join(', ')}); ` +
        `add an entry to COMPOSITE_ID_SPLITTERS in src/cli/commands/export.ts ` +
        `that parses cdkd's physicalId for this type, or destroy the resource ` +
        `first and let CFn create it fresh`
    );
  }

  let result: CompositeIdResult;
  try {
    result = splitter(physicalId, properties);
  } catch (err) {
    throw new Error(
      `composite-id splitter for ${resourceType} failed: ` + describeAwsFailure(err).detail
    );
  }
  // Sanity check: splitter must produce one resourceIdentifier entry per declared field.
  for (const f of entry.fields) {
    if (!(f in result.resourceIdentifier)) {
      throw new Error(
        `composite-id splitter for ${resourceType} did not produce field '${f}' ` +
          `(produced: ${Object.keys(result.resourceIdentifier).join(', ')})`
      );
    }
  }
  return result;
}

/**
 * Cache-consulting wrapper around {@link fetchPrimaryIdentifier}. Shared by
 * `resolveResourceIdentifier` and `buildImportPlan`'s pre-flight so one
 * DescribeType per type answers both questions.
 */
export async function cachedTypeSchemaInfo(
  resourceType: string,
  cfnClient: AwsClients['cloudFormation'],
  cache: Map<string, PrimaryIdentifierCacheEntry>
): Promise<PrimaryIdentifierCacheEntry> {
  const cached = cache.get(resourceType);
  if (cached !== undefined) return cached;
  const entry = await fetchPrimaryIdentifier(resourceType, cfnClient);
  cache.set(resourceType, entry);
  return entry;
}

/**
 * True when the registry schema says CloudFormation will refuse the type in an
 * IMPORT changeset (`ValidationError: ResourceTypes [<T>] are not supported
 * for Import`) — IMPORT looks the resource up by identifier through the type's
 * `read` handler, so a type without one cannot be adopted.
 *
 * Live-measured (us-east-1, 2026-08-13) against `CreateChangeSet
 * --change-set-type IMPORT`: `AWS::Glue::Table` / `AWS::Route53::RecordSet` /
 * `AWS::AppSync::ApiKey` / `AWS::EC2::NetworkAclEntry` /
 * `AWS::Route53::RecordSetGroup` / `AWS::SQS::QueuePolicy` /
 * `AWS::SNS::TopicPolicy` all lack a `read` handler, are all
 * `NON_PROVISIONABLE`, and were all rejected; `AWS::S3::Bucket`
 * (`FULLY_MUTABLE`, read handler present) passed the type check. Both shapes
 * of "no read handler" occur and both count: NO `handlers` block at all (the
 * legacy types) and a `handlers` block whose keys are only create / update /
 * delete (`AWS::EC2::NetworkAclEntry`).
 *
 * That list is a MEASUREMENT, not a contract, and AWS moves types off it:
 * `AWS::AppSync::ApiKey` was re-published `FULLY_MUTABLE` with a full handler
 * set by 2026-09-18 (issue #3414), so it now passes this pre-flight and is
 * resolved by its `COMPOSITE_ID_SPLITTERS` entry instead. The refusal reads
 * the LIVE response, so such a move needs no edit here — only the resolution
 * that the refusal used to shadow. `AWS::AppSync::GraphQLSchema` is still on
 * the list as of that date (no `handlers` block, `NON_PROVISIONABLE`).
 *
 * **Why the verdict needs TWO agreeing fields.** Reading "the `handlers` key is
 * missing" as a refusal on its own makes any partial or unusual response block
 * an export that works today — the one regression this pre-flight could cause,
 * and strictly worse than the status quo of letting AWS answer. So the refusal
 * also requires `ProvisioningType: NON_PROVISIONABLE`; a response satisfying
 * only one of the two resolves to `unknown` and is left to CreateChangeSet.
 *
 * The two were perfectly CORRELATED across the 21 types sampled on 2026-08-13
 * (every no-read-handler type was NON_PROVISIONABLE and vice versa), so on
 * today's registry the conjunction's real work is requiring a COMPLETE
 * DescribeType response before refusing. The `read` handler stays the primary
 * signal because it is the mechanistic reason CFn accepts a type for IMPORT —
 * refusing on `ProvisioningType` alone would reject a NON_PROVISIONABLE type
 * that does declare one, should AWS ever publish that combination.
 */
export function typeIsImportUnsupported(entry: PrimaryIdentifierCacheEntry): boolean {
  return entry.importSupport === 'unsupported';
}

/**
 * Types CloudFormation REFUSES in an IMPORT changeset although their registry
 * schema passes {@link typeIsImportUnsupported} — a `read` handler declared,
 * `ProvisioningType: FULLY_MUTABLE` — so the registry heuristic lets them
 * through and `CreateChangeSet` answers `ResourceTypes [<T>] are not
 * supported for Import` after the lock, the prompt and the template
 * preprocessing have already happened. The heuristic is NECESSARY (a type
 * with no read handler is never importable) but the 2026-09-18 measurement
 * showed it is not SUFFICIENT: AWS's supported-for-import list is a separate
 * fact the registry does not carry.
 *
 * Each entry is a dated measurement, and the map is the `blocked` message's
 * evidence. `--skip-import-support-preflight` bypasses this set together with
 * the heuristic, for the same reason it exists there: AWS may add support
 * without cdkd noticing, and the changeset is then the authority.
 *
 * | Type | measured |
 * |---|---|
 * | `AWS::AppSync::GraphQLApi` | us-east-1, 2026-09-18, the `export` integ fixture: registry `[read, create, update, delete, list]` / `FULLY_MUTABLE` / identifier `Arn`; `CreateChangeSet --change-set-type IMPORT` carrying the API (resolved to its ARN) rejected with `ResourceTypes [AWS::AppSync::GraphQLApi] are not supported for Import`. `AWS::AppSync::ApiKey` is NOT here: a standalone IMPORT changeset carrying one key with `{ApiId, ApiKeyId}` reached `CREATE_COMPLETE` the same day. (issue #3414) |
 */
const CFN_IMPORT_REFUSED_DESPITE_REGISTRY: ReadonlyMap<string, string> = new Map([
  [
    'AWS::AppSync::GraphQLApi',
    'measured against AWS: the registry schema declares a read handler and ' +
      'FULLY_MUTABLE, yet CreateChangeSet --change-set-type IMPORT rejected the type',
  ],
]);

/**
 * The measurement behind a {@link CFN_IMPORT_REFUSED_DESPITE_REGISTRY}
 * entry, or `undefined` when CloudFormation has not been measured refusing the
 * type. Exported for unit tests.
 */
export function cfnRefusesImportDespiteRegistry(resourceType: string): string | undefined {
  return CFN_IMPORT_REFUSED_DESPITE_REGISTRY.get(resourceType);
}

/**
 * Types whose cdkd physicalId is NOT the registry `primaryIdentifier` value,
 * and for which cdkd records nothing that is. The single-key path would send
 * the physicalId as the identifier and CreateChangeSet fails after the lock.
 * `AWS::CloudWatch::AnomalyDetector`'s SDK provider derives a metric
 * descriptor; Cloud Control's `Id` (published for a while as
 * `AnomalyDetectorId`) is an opaque
 * `<hash>-<Stat>-<period>-<...>` value the CloudWatch API never returns
 * (issue #4668).
 */
const PHYSICAL_ID_NOT_IMPORT_IDENTIFIER: ReadonlyMap<string, string> = new Map([
  [
    'AWS::CloudWatch::AnomalyDetector',
    "its physicalId is a metric descriptor cdkd derives, not the registry's primaryIdentifier, " +
      'and the CloudWatch API does not return that identifier',
  ],
]);

/** The reason for a {@link PHYSICAL_ID_NOT_IMPORT_IDENTIFIER} entry. Exported for unit tests. */
export function physicalIdIsNotImportIdentifier(resourceType: string): string | undefined {
  return PHYSICAL_ID_NOT_IMPORT_IDENTIFIER.get(resourceType);
}

/**
 * Fetch the primary identifier field names for a resource type, with a
 * hardcoded single-key fallback when DescribeType is unavailable. Exported
 * for unit testing.
 */
export async function fetchPrimaryIdentifier(
  resourceType: string,
  cfnClient: AwsClients['cloudFormation']
): Promise<PrimaryIdentifierCacheEntry> {
  try {
    // Throttle-shaped DescribeType failures retry with backoff (issue #1236
    // follow-up) instead of instantly degrading to the hardcoded fallback
    // table — a type absent from the table would otherwise abort the export
    // on a transient throttle.
    const resp = await describeTypeWithThrottleRetry(resourceType, cfnClient);
    if (resp.Schema) {
      const parsed = JSON.parse(resp.Schema) as {
        primaryIdentifier?: unknown;
        handlers?: unknown;
      };
      const primary = parsed.primaryIdentifier;
      if (
        Array.isArray(primary) &&
        primary.length > 0 &&
        primary.every((p) => typeof p === 'string')
      ) {
        // Schema entries look like "/properties/BucketName" — strip the
        // JSON-pointer prefix to get the property name.
        const fields = primary.map((p) => p.replace(/^\/properties\//, ''));
        // A missing `handlers` block is how the legacy types (Glue::Table,
        // Route53::RecordSet, AppSync::GraphQLSchema) render, so its absence is
        // meaningful — but only in combination with NON_PROVISIONABLE, per
        // `typeIsImportUnsupported`'s two-agreeing-fields rule.
        // The `!== null` is load-bearing (`hasOwnProperty.call(null, …)`
        // throws, and `typeof null === 'object'`). An `Array.isArray` clause
        // was removed as dead: a JSON-parsed array carries only index keys, so
        // `hasOwnProperty(…, 'read')` already answers false for the `handlers:
        // []` legacy render — a mutation probe confirmed no fixture could
        // distinguish it, and both shapes are covered by tests.
        const handlers = parsed.handlers;
        const hasRead =
          typeof handlers === 'object' &&
          handlers !== null &&
          Object.prototype.hasOwnProperty.call(handlers, 'read');
        const importSupport = hasRead
          ? 'importable'
          : resp.ProvisioningType === 'NON_PROVISIONABLE'
            ? 'unsupported'
            : 'unknown';
        return { fields, importSupport };
      }
    }
  } catch (err) {
    const msg = describeAwsFailure(err).detail;
    getLogger().debug(
      `DescribeType failed for ${quotedOrNotShown(resourceType)}: ${safeDetail(msg)} — using fallback`
    );
  }

  const fallback = PRIMARY_IDENTIFIER_FALLBACK[resourceType];
  if (fallback) {
    // The fallback table carries identifier names only — nothing is known
    // about handlers here, so the IMPORT pre-flight must not fire.
    return { fields: [fallback], importSupport: 'unknown' };
  }
  throw new Error(
    `primary identifier unknown (DescribeType returned no usable schema and no fallback ` +
      `is registered). Add ${quotedOrNotShown(resourceType)} to PRIMARY_IDENTIFIER_FALLBACK in ` +
      `export.ts, or open an issue.`
  );
}
