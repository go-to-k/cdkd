/**
 * Map the physical id `cdkd import` hands `CloudControlProvider.import()` onto
 * the identifier Cloud Control's `GetResource` accepts (issue
 * [#3672](https://github.com/go-to-k/cdkd/issues/3672)).
 *
 * ## The mismatch
 *
 * Cloud Control identifies a resource whose schema `primaryIdentifier` has more
 * than one field by the field VALUES joined with `|`, in schema order. That
 * joined string is also what cdkd records as the physical id of every resource
 * it creates through Cloud Control. CloudFormation's `PhysicalResourceId` for
 * the same resource is often ONE of those values only — `AWS::EC2::VPCCidrBlock`
 * reports the bare `vpc-cidr-assoc-…` association id, while Cloud Control wants
 * `<Id>|<VpcId>`. `cdkd import --migrate-from-cloudformation` passes
 * CloudFormation's value through as `knownPhysicalId`, so `GetResource` failed,
 * the resource was not adopted, and retiring the stack orphaned it.
 *
 * ## The rule — schema-driven, not a per-type table
 *
 * The composite types that reach this path are exactly the ones with no SDK
 * provider, and the committed schema fixtures (`tests/fixtures/cfn-schemas/`)
 * cover SDK-provider types only, so no committed source enumerates them. The
 * registry schema is read at run time instead (`cloudformation:DescribeType`,
 * one call per type, cached), and a bare id is completed from the template:
 *
 * - every identifier field the template declares as a literal string — after
 *   `cdkd import`'s `Ref` pre-substitution, so `VpcId: {Ref: Vpc}` arrives as
 *   `vpc-…` under `--migrate-from-cloudformation` — takes that value;
 * - EXACTLY ONE field left over takes the supplied id;
 * - NO field left over means the template alone names the resource, and that
 *   composite is used.
 *
 * Everything else is REFUSED with the composite shape to pass instead, rather
 * than guessed: two or more fields the template cannot supply, or a supplied id
 * equal to a value the template already gave another field (it cannot then be
 * told which field it is). A refused import is reported `failed` with that
 * remedy. It does NOT stop `--migrate-from-cloudformation` from retiring the
 * stack: `import.ts` counts it among the not-imported resources, warns that
 * they stay in AWS unmanaged, and retires anyway — the same outcome an
 * unresolvable id had before this module, now with the value to re-import by.
 *
 * Template values are read as literal strings, numbers or booleans (a
 * `RuleNumber: 100` renders `100`, as Cloud Control joins it); anything else —
 * an unresolved intrinsic, an object, a blank string — counts as unknown.
 *
 * An id that already carries the full arity, a single-field type, and a type
 * whose schema cannot be read are passed through UNCHANGED — the behaviour
 * before this module existed.
 */

import { describeTypeWithThrottleRetry, hasNoRegistrySchema } from './describe-type.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { getLogger } from '../utils/logger.js';
import { displaySafe } from '../utils/display-safe.js';
import { COMPOSITE_ID_SEPARATOR, compositeIdSeparatorRefusal } from './composite-id.js';

/**
 * Per-type cache of SUCCESSFUL lookups only (same discipline as
 * `read-only-properties.ts`): the stored promise is the recovered one, and a
 * failure deletes its own entry so a later call retries.
 */
const primaryIdentifierCache = new Map<string, Promise<readonly string[] | undefined>>();

/** Clear the per-type cache. Test-only helper. */
export function clearPrimaryIdentifierCache(): void {
  primaryIdentifierCache.clear();
}

/**
 * The type's schema `primaryIdentifier` as top-level property names, in schema
 * order — the order Cloud Control joins them in.
 *
 * `undefined` when the schema could not be read, declares no identifier, or
 * names a NESTED pointer (`/properties/A/B`), which no template property maps
 * onto. Never throws.
 */
export function getPrimaryIdentifierFields(
  resourceType: string
): Promise<readonly string[] | undefined> {
  if (hasNoRegistrySchema(resourceType)) {
    return Promise.resolve(undefined);
  }
  const cached = primaryIdentifierCache.get(resourceType);
  if (cached) {
    return cached;
  }
  const entry = fetchPrimaryIdentifierFields(resourceType).catch((error) => {
    primaryIdentifierCache.delete(resourceType);
    getLogger()
      .child('CcImportIdentifier')
      .debug(
        `Failed to resolve the primary identifier for ${displaySafe(resourceType, { asciiOnly: true })} ` +
          `via cloudformation:DescribeType (${describeAwsFailure(error).detail}); the import id is ` +
          `passed to Cloud Control unchanged.`
      );
    return undefined;
  });
  primaryIdentifierCache.set(resourceType, entry);
  return entry;
}

async function fetchPrimaryIdentifierFields(
  resourceType: string
): Promise<readonly string[] | undefined> {
  const response = await describeTypeWithThrottleRetry(resourceType);
  if (!response.Schema) return undefined;
  const parsed = JSON.parse(response.Schema) as { primaryIdentifier?: unknown };
  const primary = parsed.primaryIdentifier;
  if (!Array.isArray(primary) || primary.length === 0) return undefined;
  const fields: string[] = [];
  for (const pointer of primary) {
    if (typeof pointer !== 'string') return undefined;
    const match = /^\/properties\/([^/]+)$/.exec(pointer);
    if (!match?.[1]) return undefined;
    fields.push(match[1].replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return fields;
}

/** What {@link toCloudControlIdentifier} needs about the resource being imported. */
export interface CcImportIdentifierInput {
  resourceType: string;
  logicalId: string;
  /** The id `cdkd import` supplied (`--resource`, or CloudFormation's physical id). */
  physicalId: string;
  /** The template's properties, after `cdkd import`'s `Ref` pre-substitution. */
  properties: Record<string, unknown>;
  /** The type's `primaryIdentifier` fields in schema order, or `undefined` if unknown. */
  fields: readonly string[] | undefined;
}

/**
 * The identifier to send to Cloud Control `GetResource` — and to record as the
 * physical id, since it is the value every later Cloud Control call on the
 * resource needs. Pure; see the module header for the rule.
 *
 * @throws Error when the id cannot be completed unambiguously. The message names
 *   the composite shape `--resource` accepts.
 */
export function toCloudControlIdentifier(input: CcImportIdentifierInput): string {
  const { resourceType, logicalId, physicalId, properties, fields } = input;
  if (fields === undefined || fields.length < 2) return physicalId;
  // Already the full composite, or Cloud Control's JSON identifier form.
  if (physicalId.split(COMPOSITE_ID_SEPARATOR).length === fields.length) return physicalId;
  if (physicalId.trimStart().startsWith('{')) return physicalId;

  const safeType = displaySafe(resourceType, { asciiOnly: true });
  const safeLogicalId = displaySafe(logicalId, { asciiOnly: true });
  const safeId = displaySafe(physicalId, { asciiOnly: true });
  const shape = fields.map((field) => `<${field}>`).join(COMPOSITE_ID_SEPARATOR);
  const remedy = `Pass the Cloud Control identifier instead: --resource '${safeLogicalId}=${shape}'.`;

  if (physicalId.includes(COMPOSITE_ID_SEPARATOR)) {
    throw new Error(
      `${safeType} ${safeLogicalId}: '${safeId}' has ${physicalId.split(COMPOSITE_ID_SEPARATOR).length} ` +
        `'${COMPOSITE_ID_SEPARATOR}'-separated segments, but Cloud Control identifies this type by ` +
        `${fields.length} (${shape}). ${remedy}`
    );
  }

  const values = fields.map((field) => {
    const value = Object.hasOwn(properties, field) ? properties[field] : undefined;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  });
  const missing = fields.filter((_, index) => values[index] === undefined);

  if (missing.length > 1) {
    throw new Error(
      `${safeType} ${safeLogicalId}: Cloud Control identifies this type by ${shape}, and the ` +
        `template supplies no literal value for ${missing.join(' or ')}, so '${safeId}' cannot be ` +
        `placed. ${remedy}`
    );
  }
  if (missing.length === 1 && values.includes(physicalId)) {
    throw new Error(
      `${safeType} ${safeLogicalId}: '${safeId}' equals a value the template already gives another ` +
        `field of the identifier ${shape}, so it cannot be told which field it is. ${remedy}`
    );
  }

  const completed = values.map((value) => value ?? physicalId);
  const refusal = compositeIdSeparatorRefusal(
    resourceType,
    logicalId,
    fields.map((name, index) => ({ name, value: completed[index]! }))
  );
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
  const identifier = completed.join(COMPOSITE_ID_SEPARATOR);
  if (missing.length === 0 && !values.includes(physicalId)) {
    // The template alone names the resource, and the supplied id matches none
    // of its values. DEBUG, not warn: under `--migrate-from-cloudformation` this
    // is the EXPECTED shape for every such type (CloudFormation's id is often a
    // generated name, e.g. `AWS::EC2::TransitGatewayRoute`), so a default-
    // verbosity line would fire on every ordinary migration. The lookup still
    // verifies the resource exists.
    getLogger()
      .child('CcImportIdentifier')
      .debug(
        `${safeType} ${safeLogicalId}: the template supplies every field of the Cloud Control ` +
          `identifier ${shape}, so '${displaySafe(identifier, { asciiOnly: true })}' is looked up ` +
          `and the supplied id '${safeId}' is not used.`
      );
  }
  getLogger()
    .child('CcImportIdentifier')
    .debug(
      `${safeType} ${safeLogicalId}: completed '${safeId}' to the Cloud Control identifier ` +
        `'${displaySafe(identifier, { asciiOnly: true })}' (${shape}) from the template.`
    );
  return identifier;
}
