import type { S3TablesProvider } from '../s3-tables-provider.js';
import {
  GetNamespaceCommand,
  GetTableBucketCommand,
  GetTableCommand,
  ListTableBucketsCommand,
  NotFoundException,
  type GetTableCommandOutput,
} from '@aws-sdk/client-s3tables';
import { definedAttributes } from '../../attribute-map.js';
import { compositeIdSeparatorRefusal } from '../../composite-id.js';
import { findSdkUnwiredProperties } from '../../property-coverage.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';
import {
  parseNamespaceCompositeId,
  parseTableCompositeId,
  readStringProperty,
  tableIdentityFromGetTable,
} from './shared.js';

/**
 * The attribute map `createTable` records, built from a `GetTable` response:
 * `TableARN` plus the read-only `WarehouseLocation` / `VersionToken`, which a
 * cross-resource `Fn::GetAtt` reads under exactly these keys (issue #6238).
 */
function tableAttributes(
  tableARN: string,
  response: GetTableCommandOutput
): Record<string, unknown> {
  return definedAttributes({
    TableARN: tableARN,
    WarehouseLocation: response.warehouseLocation,
    VersionToken: response.versionToken,
  });
}

// ─── Import dispatch ──────────────────────────────────────────────

/**
 * Adopt an existing S3 Tables resource into cdkd state.
 *
 *  - **AWS::S3Tables::TableBucket**: `--resource <id>=<arn>` override, or
 *    a `Properties.TableBucketName` match against `ListTableBuckets`.
 *  - **AWS::S3Tables::Table**: explicit-override only.
 *  - **AWS::S3Tables::Namespace**: explicit-override only.
 */
export async function importImpl(
  this: S3TablesProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  switch (input.resourceType) {
    case 'AWS::S3Tables::TableBucket':
      return this.importTableBucket(input);
    case 'AWS::S3Tables::Namespace':
      return this.importNamespace(input);
    case 'AWS::S3Tables::Table':
      return this.importTable(input);
    default:
      return null;
  }
}

export async function importTableBucket(
  this: S3TablesProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      await this.getClient().send(
        new GetTableBucketCommand({ tableBucketARN: input.knownPhysicalId })
      );
      return { physicalId: input.knownPhysicalId, attributes: {} };
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }

  // The `aws:cdk:path` tag match that used to ride this walk is gone: AWS
  // rejects `aws:`-prefixed tag writes, so that tag never exists on a real
  // resource and the comparison could not match (issue #1134). The walk
  // stays only for the template physical-name match below, so skip it
  // entirely when the template supplies no `TableBucketName`.
  const desiredName =
    typeof input.properties?.['TableBucketName'] === 'string'
      ? input.properties['TableBucketName']
      : undefined;
  if (!desiredName) return null;

  let token: string | undefined;
  do {
    const list = await this.getClient().send(
      new ListTableBucketsCommand({ ...(token && { continuationToken: token }) })
    );
    for (const bucket of list.tableBuckets ?? []) {
      if (!bucket.arn) continue;
      if (bucket.name === desiredName) {
        return { physicalId: bucket.arn, attributes: {} };
      }
    }
    token = list.continuationToken;
  } while (token);
  return null;
}

/**
 * Adopt an existing namespace (issue #1668).
 *
 * cdkd's physicalId is `<tableBucketARN>|<namespaceName>` and so is
 * CloudFormation's — the registry declares a two-field
 * `primaryIdentifier` (`/properties/TableBucketARN` + `/properties/Namespace`,
 * verified live us-east-1 2026-08-12) and Cloud Control joins a multi-part
 * identifier with `|`. So the two agree and no foreign form has to be
 * accepted; what was missing is that a WRONG-ARITY id was recorded verbatim,
 * after which every other method on this provider — which all split the
 * stored id on `|` — failed against a state row that looked adopted.
 *
 * A wrong-arity override is REFUSED rather than silently replaced with the
 * template's identity: `knownPhysicalId` is documented as ground truth
 * (`ResourceImportInput`), so quietly adopting a different resource than the
 * one the user named would be worse than declining. An unverifiable
 * namespace returns `null` (`skipped-not-found`), which is loud and leaves
 * state clean.
 *
 * NOTE this now issues an AWS call where it previously made none, so
 * `s3tables:GetNamespace` is newly required, and a path that could not fail
 * before can now report `failed` on a non-`NotFound` error (throttle, IAM).
 */
export async function importNamespace(
  this: S3TablesProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (!input.knownPhysicalId) return null;

  const identity = parseNamespaceCompositeId(input.knownPhysicalId);
  if (!identity) {
    this.logger.warn(
      `S3 Tables Namespace ${input.logicalId}: physical id '${input.knownPhysicalId}' is not ` +
        `'<tableBucketARN>|<namespace>'. CloudFormation uses the same two-field composite for ` +
        `this type, so this id names no namespace cdkd can verify; skipping import.`
    );
    return null;
  }

  try {
    await this.getClient().send(
      new GetNamespaceCommand({
        tableBucketARN: identity.tableBucketARN,
        namespace: identity.namespace,
      })
    );
  } catch (err) {
    if (err instanceof NotFoundException) return null;
    throw err;
  }

  // `parseNamespaceCompositeId` accepted EXACTLY two segments, so neither can
  // carry a `|` and this refusal is unreachable today (issue #1672). It is
  // applied anyway so a future relaxation of that parser cannot silently
  // start recording an ambiguous id. Warn-and-SKIP rather than throw: an
  // unverifiable id is `skipped-not-found` on this path, which is the idiom
  // every other unusable-id arm in this method already uses, and a throw
  // would abort the whole `cdkd import` over one row.
  const namespaceRefusal = compositeIdSeparatorRefusal(
    'AWS::S3Tables::Namespace',
    input.logicalId,
    [
      { name: 'tableBucketARN', value: identity.tableBucketARN },
      { name: 'namespace', value: identity.namespace },
    ]
  );
  if (namespaceRefusal !== undefined) {
    this.logger.warn(`${namespaceRefusal} Skipping import.`);
    return null;
  }

  return {
    physicalId: `${identity.tableBucketARN}|${identity.namespace}`,
    attributes: {},
  };
}

/**
 * Adopt an existing table (issue #1668).
 *
 * Unlike the namespace above, the two id shapes DISAGREE here: cdkd's
 * physicalId is `<tableBucketARN>|<namespace>|<name>` while the registry
 * declares a SINGLE-field `primaryIdentifier` of `/properties/TableARN`
 * (verified live us-east-1 2026-08-12), so CloudFormation's physicalId is
 * the table ARN. An auto-mode / `--migrate-from-cloudformation` import
 * merges CFn-derived ids into the overrides, so that ARN was landing in
 * state verbatim and every later update / delete / read then failed to parse
 * it — the #1651 class on a second type.
 *
 * **The identity is resolved from AWS, not from the template.** An earlier
 * draft rebuilt the composite out of `Properties.TableBucketARN` /
 * `Namespace` / `TableName`, and that is INERT for the case this exists to
 * fix: in a CDK-synthesized template `TableBucketARN` is
 * `{"Fn::GetAtt": ["TableBucket", "TableBucketARN"]}`, `import.ts`
 * pre-substitutes only overridden `{Ref}`s and account / region
 * pseudo-parameter intrinsics before calling a provider (never a GetAtt), and
 * full intrinsic resolution runs AFTER every `provider.import()`. So the
 * template read yielded `undefined` on exactly the
 * `--migrate-from-cloudformation` path that supplies the bare ARN, turning a
 * corrupt adoption into a non-adoption instead of canonicalizing it.
 *
 * `GetTable` accepts `tableArn` directly and returns `name` + `namespace`,
 * so the ARN resolves its own identity with no template involvement. The
 * bucket ARN is the table ARN's prefix (`<bucketArn>/table/<id>`); when the
 * template DOES carry a literal `TableBucketARN` it is cross-checked, and a
 * disagreement is refused rather than guessed at.
 */
export async function importTable(
  this: S3TablesProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const known = input.knownPhysicalId;
  if (!known) {
    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // table reaching here needs an explicit `--resource` override.
    return null;
  }

  const composite = parseTableCompositeId(known);
  const request = composite
    ? {
        tableBucketARN: composite.tableBucketARN,
        namespace: composite.namespace,
        name: composite.name,
      }
    : // The `|`-free test is load-bearing: cdkd's own composite STARTS with
      // the bucket ARN, so an `arn:` prefix alone would route a MALFORMED
      // composite (`<bucketArn>|ns`) into the by-ARN lookup and adopt the
      // wrong thing. A real table ARN never contains `|`.
      !known.includes('|') && known.startsWith('arn:')
      ? { tableArn: known }
      : undefined;

  if (!request) {
    this.logger.warn(
      `S3 Tables Table ${input.logicalId}: physical id '${known}' is neither cdkd's ` +
        `'<tableBucketARN>|<namespace>|<name>' composite nor a table ARN (CloudFormation's ` +
        `physicalId for this type), so it names no table cdkd can verify; skipping import.`
    );
    return null;
  }

  let response;
  try {
    response = await this.getClient().send(new GetTableCommand(request));
  } catch (err) {
    if (err instanceof NotFoundException) return null;
    throw err;
  }

  // Treat a response without an ARN as UNVERIFIABLE rather than adopting it:
  // `createTable` hard-errors on exactly this condition, and the ARN is what
  // the bucket-ARN derivation and the attribute cache both depend on.
  const tableARN = response.tableARN;
  if (!tableARN) {
    this.logger.warn(
      `S3 Tables Table ${input.logicalId}: GetTable returned no tableARN for '${known}', ` +
        `so the table's identity cannot be confirmed; skipping import.`
    );
    return null;
  }

  const identity =
    composite ?? tableIdentityFromGetTable(tableARN, response.namespace, response.name);
  if (!identity) {
    this.logger.warn(
      `S3 Tables Table ${input.logicalId}: GetTable('${known}') did not return a usable ` +
        `namespace / name / bucket-ARN prefix; skipping import.`
    );
    return null;
  }

  // When the template carries a LITERAL bucket ARN, it must agree with the
  // one the ARN resolves to. (It is usually an unresolved intrinsic here, in
  // which case there is nothing to cross-check — see the note above.)
  // Only compare a LITERAL that looks like the same kind of value: a
  // name-shaped `--resource` override substituted into a `{Ref}` would
  // otherwise produce a false refusal.
  const mismatch = (
    [
      [
        'TableBucketARN',
        readStringProperty(input.properties, 'TableBucketARN'),
        identity.tableBucketARN,
      ],
      ['Namespace', readStringProperty(input.properties, 'Namespace'), identity.namespace],
      [
        'TableName',
        readStringProperty(input.properties, 'TableName') ??
          readStringProperty(input.properties, 'Name'),
        identity.name,
      ],
    ] as const
  ).find(([key, declared, resolved]) => {
    if (!declared) return false;
    if (key === 'TableBucketARN' && !declared.startsWith('arn:')) return false;
    // A `{Ref}` to a SIBLING resource is substituted with that resource's
    // PHYSICAL ID before `import()` runs, and for `AWS::S3Tables::Namespace`
    // that id is the 2-field composite `<bucketArn>|<namespace>` — the very
    // shape this PR documents. So the canonical CDK spelling
    // (`namespace: ns.ref`) declares `arn:...|analytics` where the resolved
    // field is `analytics`, and comparing them raw REFUSES the adoption on
    // exactly the migration path this fix targets. Compare the field, not
    // the id that carries it: neither a namespace nor a table name may
    // contain `|`, so the last segment is unambiguous.
    const declaredField = declared.includes('|')
      ? (declared.split('|').pop() ?? declared)
      : declared;
    return declaredField !== resolved;
  });
  if (mismatch) {
    const [key, declared, resolved] = mismatch;
    this.logger.warn(
      `S3 Tables Table ${input.logicalId}: the supplied physical id '${known}' resolves to ` +
        `${key} '${resolved}', but the template declares '${declared}'; refusing to adopt a ` +
        `different table than the one the template describes.`
    );
    return null;
  }

  // ROUTE-AWARE physicalId. A table whose template carries an SDK-unwired
  // property (none today: the last five were wired by go-to-k/cdkd#2762, but
  // a schema refresh can add one) is auto-routed to Cloud
  // Control by the #614 rule, and CC's Identifier for this type is the bare
  // `TableARN` — not cdkd's composite. `cdkd import` records
  // `provisionedBy: 'sdk'`, but ONLY `'cc-api'` is sticky, so the next
  // deploy / destroy re-derives the route from the template and such a table
  // lands on CC. Canonicalizing unconditionally would therefore hand Cloud
  // Control `arn|ns|name` and break exactly the tables the ARN form was
  // (accidentally) correct for before this PR.
  //
  // Schema-known drops only, deliberately: a key the snapshot does not know
  // routes on a deploy only when it differs from the record (issue #3713),
  // and the record this import writes carries the template's bag, so the
  // next deploy keeps such a table on the SDK route.
  const ccRouted = findSdkUnwiredProperties('AWS::S3Tables::Table', input.properties).length > 0;
  if (ccRouted) {
    this.logger.debug(
      `S3 Tables Table ${input.logicalId}: template carries a Cloud-Control-routing property, ` +
        `recording the bare TableARN (CC's identifier) rather than cdkd's composite.`
    );
    return { physicalId: tableARN, attributes: tableAttributes(tableARN, response) };
  }

  // Unlike `importNamespace`, this identity is NOT always the product of a
  // fixed-arity split: when the supplied id was a bare table ARN the
  // namespace and name come from the `GetTable` RESPONSE, so they are
  // whatever AWS holds rather than something this method already validated
  // (issue #1672). Warn-and-SKIP for the same reason as the namespace arm —
  // `skipped-not-found` is this method's answer to every id it cannot use,
  // and adopting an ambiguous composite is the #1658 failure mode (a state
  // row that looks adopted and makes the stack undestroyable). Only the
  // composite arm needs it; the Cloud-Control-routed arm above records the
  // bare ARN, which has no segments.
  const tableRefusal = compositeIdSeparatorRefusal('AWS::S3Tables::Table', input.logicalId, [
    { name: 'tableBucketARN', value: identity.tableBucketARN },
    { name: 'namespace', value: identity.namespace },
    { name: 'name', value: identity.name },
  ]);
  if (tableRefusal !== undefined) {
    this.logger.warn(`${tableRefusal} Skipping import.`);
    return null;
  }

  return {
    physicalId: `${identity.tableBucketARN}|${identity.namespace}|${identity.name}`,
    // Cache the real ARN the same way `createTable` does, so a
    // `Fn::GetAtt: [Table, TableARN]` resolves for an imported table too —
    // and the read-only attributes beside it, so this is also the #1852
    // heal for a record written before they were cached (issue #6238).
    attributes: tableAttributes(tableARN, response),
  };
}
