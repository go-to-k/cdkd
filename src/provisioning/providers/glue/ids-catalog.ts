import {
  compositeIdFormatMessage,
  segmentAfterAnchor,
  type CompositeIdFormat,
} from '../../composite-id.js';
import { carriesSecretMask } from '../../../deployment/secret-redaction.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { type ResourceNotFound, RESOURCE_NOT_FOUND } from '../../../types/resource.js';

/** Shape of an `AWS::Glue::Table` physicalId, for every decode site (issue #1657). */
const GLUE_TABLE_ID_FORMAT: CompositeIdFormat = {
  label: 'Glue Table',
  segments: ['databaseName', 'tableName'],
};

/**
 * Decode an `AWS::Glue::Table` physicalId `<databaseName>|<tableName>`.
 *
 * The separator is unescaped (issue #1672), so a bare split of an id whose
 * table or database name carries a `|` returns a DIFFERENT table — `mydb|a|b`
 * splits to `mydb.a`, both halves non-empty, and a delete of it would hit the
 * wrong table. Such ids are ordinary since `createTable` accepts a `|` in the
 * table name (issue #1672) and in the database name (#3892), and older ones
 * exist too: binaries before the #1719 refusal recorded them. The recorded `DatabaseName`
 * disambiguates the id without re-deriving the identity from the bag: it is
 * used only when the id starts with it, and the table name is the remainder
 * ({@link segmentAfterAnchor}). The `Ref` resolver anchors the same way
 * (`glueTableRefFromPhysicalId` in `intrinsic-resolver/ref-values.ts`), so a
 * `{Ref: <Table>}` names the table these sites address.
 *
 * `bags` are tried in order, so pass the one describing what was DEPLOYED
 * first. With no usable anchor only an id with exactly one separator decodes;
 * anything longer returns `undefined`, the malformed-id arm every caller
 * already has. That is deliberately stricter than the `Ref` fallback (which
 * takes everything after the FIRST `|`): these sites WRITE — `deleteTable`
 * deletes what they decode — and a database name may carry the `|` (#3892),
 * where the first-`|` reading names a different table. A loud skip is the safe
 * failure for a write.
 */
/**
 * The message for an id {@link decodeTableId} could not place.
 *
 * An id with ONE `|` that fails is malformed (an empty half), and the shared
 * wording's remedy — repair the id — is right. An id with MORE than one `|`
 * whose bags carry no string `DatabaseName` is usually NOT malformed: cdkd
 * places it by that value, and `cdkd import` can record it as an unresolved
 * intrinsic. There the remedy is the property, not the id, and saying
 * otherwise would send the user to edit a correct id.
 */
export function tableIdDecodeFailure(
  logicalId: string,
  physicalId: string,
  bags: readonly (Record<string, unknown> | undefined)[],
  options?: { readonly skipping?: boolean; readonly mask?: MaskerFn }
): string {
  // The id is masked RAW before it joins the sentence (issue #2177): an update
  // passes its operation's masker, a delete its `DeleteContext.maskSecrets`
  // (#2007).
  const shownId = options?.mask ? options.mask(physicalId) : physicalId;
  const head = compositeIdFormatMessage(GLUE_TABLE_ID_FORMAT, logicalId, shownId, options);
  const longId = physicalId.indexOf('|') !== physicalId.lastIndexOf('|');
  // A MASKED string is no anchor either: it prefixes nothing.
  const anchorless = bags.every((bag) => {
    const databaseName = bag?.['DatabaseName'];
    return typeof databaseName !== 'string' || carriesSecretMask(databaseName);
  });
  if (!longId || !anchorless) return head;
  return (
    `${head}${head.endsWith('.') ? '' : '.'} NOTE: this id carries more than one '|', which ` +
    `cdkd places by the recorded DatabaseName, and this record's DatabaseName is not a usable ` +
    `string (an unresolved intrinsic, as cdkd import can record it, or a redaction mask). The ` +
    `id itself may be correct: set the record's properties.DatabaseName in state.json to the ` +
    `table's database, EXACTLY — cdkd takes the table name as everything after it, so a shorter ` +
    `prefix of the real name would address a different table.`
  );
}

export function decodeTableId(
  physicalId: string,
  ...bags: (Record<string, unknown> | undefined)[]
): { databaseName: string; tableName: string } | undefined {
  for (const bag of bags) {
    const databaseName = bag?.['DatabaseName'];
    if (typeof databaseName !== 'string') continue;
    const tableName = segmentAfterAnchor(physicalId, databaseName);
    if (tableName !== undefined) return { databaseName, tableName };
  }
  const parts = physicalId.split('|');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { databaseName: parts[0], tableName: parts[1] };
}

/**
 * Read a template-borne value that is about to be forwarded to a Glue read
 * API as a string.
 *
 * `import()` runs against the template, where `cdkd import` resolves only the
 * `Ref`s in its overrides map and the intrinsics built from literals and the
 * account / region pseudo-parameters (issue #1897). So
 * `CatalogId: {Ref: AWS::AccountId}` (what `@aws-cdk/aws-glue-alpha` renders
 * for an environment-agnostic stack) normally arrives as the account id — but
 * survives as an OBJECT when the account is unknown (STS failed and no
 * `AWS_ACCOUNT_ID`, issue #1730). A bare `as string` cast then hands that object to
 * `GetTable` / `GetDatabase` as if it were an id. Dropping it instead matches
 * the API default (the caller's own account), which is what the intrinsic
 * would have resolved to anyway.
 */
export function importableString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The one pseudo parameter whose value IS the Glue API's `CatalogId` default. */
const ACCOUNT_ID_PSEUDO_PARAMETER = 'AWS::AccountId';

const ACCOUNT_ID_SUB_TEMPLATE = '${AWS::AccountId}';

/**
 * Is this unresolved intrinsic PROVABLY the caller's own account id?
 *
 * `@aws-cdk/aws-glue-alpha` sets `catalogId: Stack.of(this).account`, which
 * renders as `{Ref: AWS::AccountId}` (or an `Fn::Sub` wrapper) for an
 * environment-agnostic stack. A pseudo parameter is never in the import
 * overrides map, so a `cdkd import`-written state record holds the intrinsic
 * verbatim — but its resolved value is exactly what OMITTING `CatalogId` gives
 * the Glue API, so dropping it is not a loss and a NotFound afterwards is
 * ordinary idempotency, not the silent-leak shape.
 *
 * Kept deliberately narrow. An intrinsic object has exactly ONE key, and only
 * the two account-id spellings qualify: `{Ref: SomeParam}`, `Fn::ImportValue`,
 * an `Fn::Sub` of anything else, and every other shape stay UNUSABLE, because
 * their resolved value could be any catalog at all.
 */
export function isAccountIdPseudoParameter(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1) return false;
  const bag = value as Record<string, unknown>;
  if (keys[0] === 'Ref') return bag['Ref'] === ACCOUNT_ID_PSEUDO_PARAMETER;
  if (keys[0] === 'Fn::Sub') {
    const arg = bag['Fn::Sub'];
    if (typeof arg === 'string') return arg === ACCOUNT_ID_SUB_TEMPLATE;
    // 2-arg form `['${AWS::AccountId}', {vars}]`. CFn forbids shadowing a
    // pseudo parameter in the variable map, so the template alone decides.
    return Array.isArray(arg) && arg[0] === ACCOUNT_ID_SUB_TEMPLATE;
  }
  return false;
}

/**
 * Coerce a template-borne `CatalogId` into the string the Glue API wants, or
 * `undefined` when no usable value is present (issue
 * [#1675](https://github.com/go-to-k/cdkd/issues/1675)).
 *
 * This is {@link importableString} plus a NUMBER arm, and the number arm is
 * load-bearing rather than defensive, and the reason is NOT the one this
 * comment gave for three revisions. It claimed
 * `cdkd import --migrate-from-cloudformation` (earlier: `cdkd migrate`) read
 * the source stack's ORIGINAL CloudFormation template and handed those raw
 * properties to providers. It never did. Both commands take properties from
 * the SYNTH assembly; `cdkd migrate` reached `runImport` with
 * `app: <assemblyDir>` plus a logical-id mapping, and the ORIGINAL template it
 * fetched was consumed only by transform detection and by the Pass-2
 * property-equality MATCH, never forwarded. The `GetTemplate` that survives in
 * `retire-cfn-stack.ts` feeds Retain injection and the re-upload, and reaches
 * no properties bag either. Do not restore any of that.
 *
 * The two producers that ARE real, both current:
 *
 *  1. A numeric literal in the synth template itself — `new CfnResource({
 *     properties: { CatalogId: 123456789012 } })`, or an
 *     `addPropertyOverride`. CDK emits the number verbatim; nothing between
 *     synth and this provider stringifies it.
 *  2. The macro-expanded deploy template. `src/synthesis/macro-expander.ts`
 *     fetches `GetTemplate` at `TemplateStage: 'Processed'` and parses the
 *     JSON body as the template deploy / diff / import then use, so a macro
 *     that emits an unquoted number lands here as a number.
 *
 * The DELETE path reaches it too, from the other side: `destroy-runner.ts`
 * hands the recorded `resource.properties` straight to `provider.delete`, so a
 * state row holding either shape above replays it at teardown. Rejecting it
 * as "not a string" would drop the field and silently retarget the call at the
 * account's DEFAULT catalog — which on a DELETE can destroy a same-named
 * resource that happens to live there. `Number.isFinite` keeps `NaN` /
 * `Infinity` out (they fall through to the unusable arm, where they are
 * reported); a non-integer is stringified and AWS rejects it loudly, which is
 * the right failure.
 *
 * The coercion lives HERE rather than inside `importableString`: that helper is
 * shared with `DatabaseName` / `TableInput.Name` reads, where a number is a
 * malformed template rather than a YAML scalar to recover.
 */
export function catalogIdForApi(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return importableString(value);
}

/**
 * The Data Catalog a Glue call must address, read out of a properties bag.
 *
 * `CatalogId` selects the Data Catalog; OMITTING it means the caller's own
 * account's DEFAULT catalog. So for a table / database / connection that lives
 * in a NON-default catalog (a cross-account Data Catalog, a Lake Formation
 * federated catalog) a call that drops the field targets the wrong catalog. On
 * a DELETE that is the issue-#1675 defect: AWS answers
 * `EntityNotFoundException`, the delete path's warn-and-continue idempotency
 * treats it as "already gone", and `cdkd destroy` reports SUCCESS while the
 * resource is still there — a silent LEAK, not a loud failure.
 *
 * cdkd's physical ids for these types encode no catalog (`<db>|<table>` for a
 * table, the bare name for a database / connection), so the id cannot carry it
 * — but the properties bag can, and `CatalogId` is a declared property of all
 * three types.
 *
 * `declaredButUnusable` is what lets the DELETE's NotFound arm DISCRIMINATE: a
 * NotFound after a correctly-targeted delete is legitimately idempotent, while
 * a NotFound after cdkd knowingly fell back to the default catalog is not
 * evidence of anything. It is deliberately FALSE for the account-id pseudo
 * parameter (see {@link isAccountIdPseudoParameter}) — dropping that one is
 * provably harmless, so warning about it would fire a leak alarm on every
 * ordinary destroy of an environment-agnostic CDK stack.
 *
 * SCOPE — the guard is applied to every read whose bag can be a RAW template:
 * the three deletes, the three `readCurrentState` readers, and the three
 * `import()` probes. The CREATE / UPDATE reads deliberately keep their bare
 * `as string | undefined` cast: the deploy engine resolves intrinsics before
 * the provider sees them, so guarding there is the separate issue-#1513
 * decision that #1651 already recorded. The one residual is a rollback replay
 * (`rollback-executor.ts` calls `update(..., previousState.properties, ...)`),
 * where an IMPORTED stack's raw bag does reach the update path — narrow enough
 * to leave to #1513 rather than widen this change into the deploy path.
 */
interface CatalogTarget {
  /** The value to send, or `undefined` to let the API default to this account. */
  catalogId: string | undefined;
  /** A catalog WAS declared, cdkd could not use it, and the drop is not provably safe. */
  declaredButUnusable: boolean;
}

export function deleteCatalogId(properties: Record<string, unknown> | undefined): CatalogTarget {
  const raw = properties?.['CatalogId'];
  const catalogId = catalogIdForApi(raw);
  return {
    catalogId,
    declaredButUnusable: catalogId === undefined && raw != null && !isAccountIdPseudoParameter(raw),
  };
}

/**
 * The readCurrentState answer for an `EntityNotFoundException` on a
 * catalog-scoped read: `RESOURCE_NOT_FOUND`, except when a declared `CatalogId`
 * was unusable and the read fell back to the default catalog — that NotFound
 * proves nothing about the declared one (the delete's same discrimination), so
 * it stays `undefined`.
 */
export function notFoundInCatalog(
  properties: Record<string, unknown> | undefined
): ResourceNotFound | undefined {
  return deleteCatalogId(properties).declaredButUnusable ? undefined : RESOURCE_NOT_FOUND;
}

/**
 * Human-readable name for the catalog a call addressed, for log messages. A
 * create / update passes its operation's masker, which sees the id RAW
 * (issue #2177). The delete path names only a catalog id it could not use (an
 * unresolved intrinsic), which no masker would change.
 */
export function describeCatalog(
  catalogId: string | undefined,
  mask: MaskerFn = (text) => text
): string {
  return catalogId === undefined
    ? "this account's default Data Catalog"
    : `Data Catalog ${mask(String(catalogId))}`;
}

/**
 * Report the `EntityNotFoundException` arm of a Glue delete, at the severity
 * the evidence supports (issue #1675).
 *
 * With a correctly-targeted delete a NotFound means the resource is already
 * gone and the skip is ordinary idempotency — debug. When the template DECLARED
 * a `CatalogId` that {@link deleteCatalogId} could not use, cdkd addressed the
 * DEFAULT catalog instead, so a NotFound is equally consistent with "the
 * resource is alive in the declared catalog" — that is the silent-leak shape,
 * and it gets a warning.
 *
 * BOTH arms name the catalog actually addressed. A LITERAL-but-wrong
 * `CatalogId` (a typo, a stale account id) is otherwise indistinguishable from
 * an already-deleted resource in the log, and it takes the debug arm.
 */
export function logCatalogScopedDeleteSkip(
  logger: { debug: (message: string) => void; warn: (message: string) => void },
  target: CatalogTarget,
  kind: 'Database' | 'Table' | 'Connection',
  logicalId: string,
  physicalId: string
): void {
  const where = describeCatalog(target.catalogId);
  if (!target.declaredButUnusable) {
    logger.debug(`Glue ${kind} ${physicalId} does not exist in ${where}, skipping deletion`);
    return;
  }
  logger.warn(
    `Glue ${kind} ${logicalId} (${physicalId}) was not found, so cdkd skipped its deletion — ` +
      `but the recorded CatalogId is not a usable value (likely an unresolved intrinsic), so ` +
      `the delete targeted ${where}. If the resource lives in a different Data Catalog it ` +
      `still exists. cdkd cannot retry this delete: the state record is dropped once the ` +
      `destroy completes, so check the intended catalog (aws glue get-${kind.toLowerCase()} ` +
      `--catalog-id '<id>' ...) and delete the resource there by hand.`
  );
}

/**
 * Resolve the `(databaseName, tableName)` pairs an `AWS::Glue::Table` import
 * should probe, in order, from either physicalId shape (issue #1651).
 *
 * cdkd's physicalId for a Glue Table is the composite `<databaseName>|<tableName>`
 * (built by `createTable`), because `GetTable` / `UpdateTable` / `DeleteTable`
 * all need both while `ResourceProvider`'s read-side methods receive a single
 * string. CloudFormation's physicalId for the same type is the TABLE NAME
 * ALONE — `Ref` returns it. Auto-mode import merges CloudFormation-derived ids
 * into the overrides before the loop (#1128 / #1130), so `knownPhysicalId`
 * legitimately arrives in either shape and both must resolve; treating the bare
 * form as malformed reported every `cdk deploy`-managed table as not-found while
 * pointing the user at the very id it had just rejected.
 *
 * `|` is the usual discriminator, but it is not a clean one: the "lowercase
 * alphanumerics and underscore" rule usually quoted for Glue names is the Athena
 * / Data Catalog CONVENTION, not the API's constraint. Live probe (us-east-1,
 * 2026-08-12): `glue:CreateTable` ACCEPTS a table literally named `a|b`, and
 * CloudFormation manages it, reporting the bare `a|b` as its physical id.
 *
 * Such a table IS adoptable (issue #1672 for a table name, #3892 for a
 * database name; Glue accepts `|` in both), on one condition: the record must
 * decode back to the same table. A `|` in either name is decodable —
 * `updateTable` / `deleteTable` / `readTable` anchor on the recorded
 * `DatabaseName` ({@link decodeTableId}) and so does the `Ref` resolver — but
 * only when that recorded `DatabaseName` IS the database probed. Import records
 * the template's bag, so a name carrying `|` is accepted only paired with the
 * template's own `DatabaseName`; paired with anything else (a composite naming
 * another database, or an unresolved template intrinsic) the record would
 * carry no anchor, and without one the writers decode only the exact
 * two-segment form.
 *
 * A `|`-bearing known id that EQUALS the template's `TableInput.Name` is read
 * only as that bare name in the template's database: it is CloudFormation's id
 * for the table the template declares. Otherwise it yields:
 *
 * 1. `<templateDb>|<rest>` — anchored on the template's `DatabaseName`: the
 *    table is everything after it.
 * 2. Otherwise, for EXACTLY two segments, the composite `(<a>, <b>)` — the
 *    established contract, including a composite naming a database other than
 *    the template's.
 * 3. And, beside either, when the template's `DatabaseName` is usable, the
 *    BARE reading: the whole id is a table name in that database. This is the
 *    CloudFormation migration path for a table named `a|b`, whose CFn id is
 *    `a|b` — and for one named `mydb|a` in database `mydb`, whose id the
 *    anchored reading would otherwise take for table `a`. It costs an
 *    ordinary `<db>|<table>` import a second `GetTable`; correctness of the
 *    adopted table outweighs that.
 *
 * `importTable` probes them ALL and adopts a reading only when it is the one
 * that exists, or the one of several whose table name is the template's
 * `TableInput.Name`; otherwise it refuses as ambiguous. An id of
 * three or more segments that the template's `DatabaseName` does not anchor and
 * cannot pair with (it is unusable) is refused: `x|a|b` could be table `a|b` in
 * `x` or table `b` in a database `x|a`, and nothing says which. An earlier
 * revision of #1651 retried the bare reading and recorded an id the writers
 * could not decode — the #1658 failure mode (`AWS::Route53::RecordSet`
 * accepted CloudFormation's id verbatim and made the stack undestroyable). The
 * pairing condition above is what keeps reading 3 from repeating it.
 *
 * On failure it returns the REASON rather than a bare `undefined`, because the
 * three causes need three different messages and re-deriving the cause from the
 * inputs at the call site gets it wrong: `'db|'` contains a `|` but its real
 * defect is the empty segment, not the separator.
 */
/** One `(database, table)` pair an import probes, and which reading of the id produced it. */
export interface TableReading {
  readonly databaseName: string;
  readonly tableName: string;
  /** Named in the error when this reading's probe cannot answer. */
  readonly reading: 'template' | 'anchored' | 'composite' | 'bare';
}
