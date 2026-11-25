/**
 * The Cloud Control identifier of a resource its SDK provider recorded, for
 * the deploy that moves it onto Cloud Control (go-to-k/cdkd#6976).
 *
 * A resource the SDK provider created is auto-routed to Cloud Control when its
 * template gains a property the SDK provider does not handle (#614, #3713).
 * Cloud Control addresses a type whose schema `primaryIdentifier` has more
 * than one field by the field values joined with `|`, in schema order, and the
 * SDK provider's physical id is often ONE of them (an API Gateway deployment's
 * bare deployment id, where Cloud Control wants `<DeploymentId>|<RestApiId>`),
 * so sending it verbatim fails the update.
 *
 * The identifier is built from the RECORD: each field the record's properties
 * (then attributes) hold as a plain scalar takes that value; exactly one
 * field left over takes the SDK id, minus any leading `<value>|` of the fields
 * before it (a Glue table's `<db>|<table>` gives `<table>` under
 * `<CatalogId>|<DatabaseName>|<Name>`). Anything else -- no composite
 * identifier, two fields missing, a masked or `|`-bearing value -- returns the
 * SDK id unchanged, which is what the move sent before, so its failure (and
 * #4904's remedy) is no worse than it was.
 *
 * The field ORDER comes from the live schema (`getPrimaryIdentifierFields`,
 * one cached `DescribeType` per type), read only on the deploy that moves a
 * resource: the generated coverage table sorts the names, and Cloud Control
 * joins them in schema order.
 */
import { getPrimaryIdentifierFields } from './cc-import-identifier.js';
import { COMPOSITE_ID_SEPARATOR } from './composite-id.js';
import { SECRET_MASK } from '../deployment/secret-redaction.js';

export interface SdkRecordForCc {
  resourceType: string;
  physicalId: string;
  properties?: Record<string, unknown> | undefined;
  attributes?: Record<string, unknown> | undefined;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export async function ccIdentifierFromSdkRecord(record: SdkRecordForCc): Promise<string> {
  const fields = await getPrimaryIdentifierFields(record.resourceType);
  if (fields === undefined || fields.length < 2) return record.physicalId;

  const values = fields.map(
    (field) => scalar(record.properties?.[field]) ?? scalar(record.attributes?.[field])
  );
  if (
    values.some(
      (v) =>
        v !== undefined &&
        (v.includes(SECRET_MASK) || v.includes('{{resolve:') || v.includes(COMPOSITE_ID_SEPARATOR))
    )
  ) {
    return record.physicalId;
  }
  const missing = values.flatMap((v, i) => (v === undefined ? [i] : []));
  if (missing.length > 1) return record.physicalId;

  if (missing.length === 1) {
    const at = missing[0]!;
    let own = record.physicalId;
    for (const v of values.slice(0, at)) {
      const prefix = `${v}${COMPOSITE_ID_SEPARATOR}`;
      if (own.startsWith(prefix)) own = own.slice(prefix.length);
    }
    // Only the LAST field may carry the separator (a Glue table name); a
    // `|` anywhere else would put the joined id's boundaries in the wrong place.
    if (own === '' || (at !== fields.length - 1 && own.includes(COMPOSITE_ID_SEPARATOR))) {
      return record.physicalId;
    }
    values[at] = own;
  }
  return values.join(COMPOSITE_ID_SEPARATOR);
}
