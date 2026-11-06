import { GlueClient } from '@aws-sdk/client-glue';
import { STSClient } from '@aws-sdk/client-sts';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { segmentAfterAnchor } from '../../composite-id.js';
import {
  createMaskedLogSinks,
  isSecretDerivedValue,
  MASK_WALK_DEPTH_CAP_MARKER,
  withDerivedNameMasks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../../masked-retry-logger.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';
import {
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import {
  type TableReading,
  importableString,
  catalogIdForApi,
  isAccountIdPseudoParameter,
  describeCatalog,
} from './ids-catalog.js';
import { resolveAccountId } from './shared.js';

/** Glue's `NameString` limit: a longer table name cannot exist, so is never probed. */
const GLUE_NAME_MAX_LENGTH = 255;

type TableIdentityResult =
  | { ok: true; candidates: readonly TableReading[] }
  /**
   * The id cannot be placed: a `|`-bearing id that the template's
   * `DatabaseName` neither anchors nor pairs with has more than two segments,
   * or equals the template's table name with no usable `DatabaseName`.
   */
  | { ok: false; reason: 'pipe-in-name' }
  /** An id was supplied but no usable `(database, table)` pair came out of it. */
  | { ok: false; reason: 'unpairable' }
  /** Nothing identified the table: no override and no usable template names. */
  | { ok: false; reason: 'unidentified' };

export function resolveTableIdentity(input: {
  knownPhysicalId: string | undefined;
  templateDatabaseName: string | undefined;
  templateTableName: string | undefined;
}): TableIdentityResult {
  const { knownPhysicalId, templateDatabaseName, templateTableName } = input;

  const candidates: TableReading[] = [];
  let sawPipeInName = false;
  // Every pair goes through here.
  //
  // The one condition a record needs — a `|` in EITHER name must be paired
  // with the TEMPLATE's `DatabaseName`, the value later readers anchor on —
  // holds by construction rather than by a check here: the only branches that
  // can yield such a name (template, anchored, bare) all pair it with
  // `templateDatabaseName`, and the two-segment composite yields pipe-free
  // halves. A new branch must keep it so. (`importTable` records the probed
  // database as an attribute too, so the `Ref` resolver can anchor even when
  // `cdkd import` records the property unresolved.)
  const consider = (
    databaseName: string | undefined,
    tableName: string | undefined,
    reading: TableReading['reading']
  ): void => {
    if (databaseName === undefined || tableName === undefined) return;
    candidates.push({ databaseName, tableName, reading });
  };

  if (knownPhysicalId === undefined) {
    consider(templateDatabaseName, templateTableName, 'template');
  } else if (knownPhysicalId.includes('|') && knownPhysicalId === templateTableName) {
    // The id IS the template's own table name: CloudFormation's bare id for a
    // table named `a|b`, which auto-mode import passes verbatim. Read it only
    // as that name, in the template's database. Splitting it too would adopt
    // an unrelated table `b` in a database `a` whenever one exists, and the
    // template would then describe a table the record does not name.
    //
    // Without a usable template `DatabaseName` there is nothing to pair it
    // with, and the composite `--resource '<db>|a|b'` the `unpairable` message
    // would suggest is itself unanchored (refused below as `pipe-in-name`).
    // So this reports `pipe-in-name`, whose message names the one remedy that
    // works: set the template's DatabaseName.
    if (templateDatabaseName === undefined) sawPipeInName = true;
    else consider(templateDatabaseName, knownPhysicalId, 'bare');
  } else if (knownPhysicalId.includes('|')) {
    const parts = knownPhysicalId.split('|');
    const anchored = segmentAfterAnchor(knownPhysicalId, templateDatabaseName);
    if (anchored !== undefined) {
      consider(templateDatabaseName, anchored, 'anchored');
    } else if (parts.length === 2) {
      consider(parts[0] || undefined, parts[1] || undefined, 'composite');
    } else {
      // Never destructure the first two of three segments: `mydb|a|b` read as
      // database `mydb`, table `a` is a DIFFERENT table, adopted under an id
      // that round-trips cleanly and therefore never looks wrong again. The
      // anchored arm above is what reads that id.
      sawPipeInName = true;
    }
    // The bare reading, beside whichever reading the id also has: the whole id
    // is a table name in the template's database. CloudFormation's id for a
    // table named `mydb|a` is `mydb|a`, and with a template `DatabaseName` of
    // `mydb` the anchored reading alone would adopt an unrelated table `a` —
    // which `cdkd destroy` would then delete. Probing both lets `importTable`
    // refuse when both exist. Skipped for an id with an EMPTY segment (`db|`,
    // `|t`: the missing half of a composite, whose `unpairable` guidance a
    // silent not-found would replace) and for one longer than Glue's name
    // limit, which no table can be named.
    if (
      templateDatabaseName !== undefined &&
      parts.every((part) => part !== '') &&
      knownPhysicalId.length <= GLUE_NAME_MAX_LENGTH
    ) {
      consider(templateDatabaseName, knownPhysicalId, 'bare');
    }
  } else {
    // Bare CloudFormation id: the table name. The database comes from the
    // template, where CDK renders `DatabaseName` as a `Ref` to the sibling
    // `AWS::Glue::Database` — whose CFn physicalId IS the database name, so the
    // overrides map resolves it to a literal before `import()` is called.
    //
    // The override wins over the template's `TableInput.Name`: the user named a
    // specific resource to adopt, and probing a different one would adopt the
    // wrong table. `importableString` rejects the empty string, so a
    // `--resource-mapping` entry of `""` (which `parseMappingJson` accepts,
    // unlike the `--resource` flag) still returns not-found rather than sending
    // `GetTable({Name: ''})`, whose `InvalidInputException` is not
    // `EntityNotFoundException` and would abort the whole import.
    consider(templateDatabaseName, importableString(knownPhysicalId), 'template');
  }

  if (candidates.length > 0) return { ok: true, candidates };
  if (sawPipeInName) return { ok: false, reason: 'pipe-in-name' };
  return { ok: false, reason: knownPhysicalId === undefined ? 'unidentified' : 'unpairable' };
}

/**
 * Describe an unresolved name by SHAPE only. Its leaves can be resolved
 * secrets, and the engine's masker matches a secret's full plaintext, which a
 * JSON rendering (escaping) or a cut (a fragment) would defeat.
 */
export function describeUnresolvedName(value: unknown, mask: MaskerFn = (text) => text): string {
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object' && value !== null) {
    // Each key RAW through the operation's masker (issue #2177): a resolved
    // secret used as a map key would otherwise print here.
    const keys = Object.keys(value)
      .slice(0, 5)
      .map((key) => mask(key));
    return keys.length === 0 ? 'an empty object' : `an object with keys [${keys.join(', ')}]`;
  }
  if (typeof value === 'number') return 'a number that is not a safe integer';
  return `a ${typeof value}`;
}

/**
 * Refuse an UPDATE whose nested `Name` renames the recorded Glue entity
 * (issue #3724).
 *
 * CDK emits the NESTED name (`TableInput.Name`, `DatabaseInput.Name`,
 * `ConnectionInput.Name`). Since issue #3750 the diff plans a Table or
 * Connection rename as a REPLACEMENT, as CloudFormation does (a
 * `replacement-rules.ts` rule for the Table, the schema's nested createOnly
 * path for the Connection), so for those two this is a BACKSTOP for the
 * paths that still reach `update()` with a changed name: a name the diff
 * could not compare, `drift --revert`, a rollback replay. A Database rename
 * is not a replacement (CloudFormation's update FAILS on it), so for a
 * Database this is the answer, not a backstop. For a table the update would
 * be a wrong-target write: `UpdateTable` addresses the
 * table BY `TableInput.Name`, so it would rewrite whichever table holds the new
 * name — possibly one cdkd does not manage — while the state record kept the
 * old id. `UpdateDatabase` / `UpdateConnection` address the recorded name, but
 * whatever AWS does with a different name inside the definition, cdkd keeps
 * recording the old one. No arm is licensed to downgrade this on a replay: the
 * alternative is a write to a resource the record does not name.
 *
 * `ResourceUpdateNotSupportedError` is what the deploy engine's `--replace`
 * fallback reacts to, so the remedy it names is a real path. An ABSENT name
 * passes: the builders then send the recorded one. Any other non-string value
 * still reaches the wire uncoerced, so a safe integer is compared by its string
 * form (the one spelling JS and Glue cannot disagree on) and anything else is
 * refused with an untyped error, since a `--replace` CREATE would carry the
 * same value — cdkd cannot tell which entity it addresses.
 * `foldCase` is set for tables and databases, whose names Glue folds to
 * lowercase: a case-only difference addresses the same entity, and a
 * `drift --revert` bag read back from AWS carries the folded spelling. Only
 * ASCII is folded, so a guess wrong about Glue's folding over-refuses rather
 * than letting a different entity through.
 */
export function refuseNestedRename(args: {
  resourceType: string;
  logicalId: string;
  field: string;
  noun: string;
  recordedName: string;
  desiredName: unknown;
  foldCase: boolean;
  /** Receives the desired name already masked through {@link mask}. */
  consequence: (shownDesiredName: string) => string;
  stateful: boolean;
  /**
   * The update's masker (issue #2177). Both names are masked RAW before they
   * join the sentence, the only arm a secret shorter than the substring floor
   * reaches.
   */
  mask: MaskerFn;
}): void {
  const { desiredName: raw, recordedName, mask } = args;
  if (raw == null) return;
  const comparable =
    typeof raw === 'string' || (typeof raw === 'number' && Number.isSafeInteger(raw));
  if (!comparable) {
    // NOT `ResourceUpdateNotSupportedError`: `--replace` reacts to that type, and
    // its DELETE would retire the recorded entity before a CREATE carrying the
    // same unaddressable value.
    throw markNonRetryable(
      new ProvisioningError(
        `${args.field} is not a resolved name (${describeUnresolvedName(raw, mask)}), so cdkd ` +
          `cannot tell which Glue ${args.noun} the update of ${args.logicalId} would address ` +
          `and will not send it. Declare ${args.field} as a string ('${mask(recordedName)}' ` +
          `keeps the recorded ${args.noun})`,
        args.resourceType,
        args.logicalId
      )
    );
  }
  const desiredName = String(raw);
  const fold = (name: string): string =>
    args.foldCase ? name.replace(/[A-Z]/g, (c) => c.toLowerCase()) : name;
  if (fold(desiredName) === fold(recordedName)) return;
  const remedyFlags = args.stateful ? '--replace --force-stateful-recreation' : '--replace';
  const shownRecorded = mask(recordedName);
  const shownDesired = mask(desiredName);
  throw new ResourceUpdateNotSupportedError(
    args.resourceType,
    args.logicalId,
    `${args.field} changed from '${shownRecorded}' to '${shownDesired}', and cdkd cannot rename ` +
      `a Glue ${args.noun} in place — ${args.consequence(shownDesired)}. To rename it, re-deploy ` +
      `with ${remedyFlags}, which DELETEs the ${args.noun} '${shownRecorded}' and then CREATEs ` +
      `'${shownDesired}' (under UpdateReplacePolicy: Retain the old one is kept instead); the ` +
      `CREATE fails if a ${args.noun} named '${shownDesired}' already exists, after the DELETE. ` +
      `If the template did not change this name, the state record was left by an earlier ` +
      `deploy that wrote to '${shownDesired}': check that ${args.noun} before ` +
      `re-deploying. Otherwise keep the name '${shownRecorded}'`
  );
}

/** A `[raw value, name to mask]` pair for {@link glueOperationSinks}. */
type NamePair = readonly [unknown, string | undefined];

/**
 * `[name, name]` pairs for {@link glueOperationSinks} (issue #2177): a name that
 * IS a secret of this deploy is masked as a needle, so it is hidden even inside
 * text cdkd did not write, such as an AWS error quoting it back, where the
 * masker's substring arm skips a secret shorter than `MIN_NEEDLE_LENGTH`. A
 * non-secret name is left alone.
 */
export function secretNamePairs(values: readonly unknown[]): NamePair[] {
  return values.map((value) => [value, typeof value === 'string' ? value : undefined] as const);
}

/**
 * Shortest name {@link glueOperationSinks} makes a SUBSTRING needle. A needle is
 * replaced wherever it occurs, cdkd's own fixed wording included, so a very
 * short secret would mask letters of `Creating Glue Database` and the masked
 * positions would hint at it. It narrows that rather than closing it (a
 * 3-character one such as `lue` still can).
 *
 * Below the floor a secret name is still hidden at every site cdkd interpolates
 * it: those sites mask the value RAW, and the sinks render a secret-derived name
 * as `***` by whole-value equality -- including a ROTATED recorded name, whose
 * old plaintext is in no bag of this deploy. Only an AWS echo of a 1-2
 * character name goes unmasked; a secret that short has almost no
 * confidentiality either way.
 */
const SELF_NEEDLE_MIN_LENGTH = 3;

/**
 * {@link secretNamePairs} for a recorded name, plus a `[previous raw value,
 * recorded name]` pair per property the recorded name can have come from.
 *
 * A Glue physical id IS the name the template declared, so on a plain deploy
 * the masker already knows it. What it cannot know is a name recorded from a
 * PREVIOUS secret: state persists that value as its `{{resolve:` reference (or
 * as `***`), and after a rotation the old plaintext is in no bag of this
 * deploy. The recorded name is then masked too.
 */
export function previousNamePairs(
  recordedName: string | undefined,
  previousValues: readonly unknown[]
): NamePair[] {
  return [
    ...secretNamePairs([recordedName]),
    ...previousValues.map((raw) => [raw, recordedName] as const),
  ];
}

/**
 * The masked sinks ONE Glue `create()` / `update()` logs through (issue #2177):
 * `createMaskedLogSinks` over the context's masker, extended by `pairs` (see
 * {@link secretNamePairs}, {@link previousNamePairs}). Each name whose raw value
 * is secret-derived (`isSecretDerivedValue`) is:
 *
 *  - rendered as `***` wherever a sink masks it as a WHOLE value -- every site
 *    cdkd interpolates a name through `value` / `mask`, at any length;
 *  - and, at {@link SELF_NEEDLE_MIN_LENGTH} or longer, a substring needle, so
 *    it is also masked where it OCCURS inside other text (an AWS echo).
 *
 * Built per call; never cached on the provider, which serves concurrent
 * resources.
 */
export function glueOperationSinks(
  logger: { debug(message: string): void; warn(message: string): void },
  maskSecrets: MaskerFn | undefined,
  pairs: readonly NamePair[]
): MaskedLogSinks {
  const base = createMaskedLogSinks(logger, maskSecrets);
  const secretNames = new Set<string>();
  for (const [raw, name] of pairs) {
    if (typeof name === 'string' && name !== '' && isSecretDerivedValue(raw, base.mask)) {
      secretNames.add(name);
    }
  }
  // The ORIGINAL pairs, not `[name, name]`: a ROTATED recorded name qualifies
  // only through its PREVIOUS raw value (`{{resolve:` / `***`) -- the old
  // plaintext itself is in no bag of this deploy, so the name alone would fail
  // the predicate and an AWS error quoting it would print it.
  const needled = withDerivedNameMasks(
    logger,
    base,
    pairs.filter(
      (pair): pair is readonly [unknown, string] =>
        typeof pair[1] === 'string' && pair[1].length >= SELF_NEEDLE_MIN_LENGTH
    )
  );
  if (secretNames.size === 0) return needled;
  const mask: MaskerFn = (text: string) =>
    secretNames.has(text) ? MASK_WALK_DEPTH_CAP_MARKER : needled.mask(text);
  return {
    mask,
    value: (value: unknown) => mask(String(value)),
    debug: (message: string) => logger.debug(mask(message)),
    warn: (message: string) => logger.warn(mask(message)),
  };
}

/**
 * The recorded `CatalogId` a `readCurrentState` snapshot carries back, so a
 * `drift --revert` built from that snapshot addresses the catalog the entity
 * was READ from (issue #3756). `GetDatabase` / `GetTable` / `GetConnection` do
 * not echo it, and a snapshot without it made the revert's update target this
 * account's DEFAULT catalog. Echoed only when usable: the raw value keeps drift
 * comparing like with like, and an unusable one (the account-id pseudo
 * parameter, another intrinsic) stays absent, which is what the reads
 * addressed for it.
 */
export function withRecordedCatalogId(
  snapshot: Record<string, unknown>,
  properties: Record<string, unknown> | undefined
): Record<string, unknown> {
  const raw = properties?.['CatalogId'];
  return catalogIdForApi(raw) === undefined ? snapshot : { ...snapshot, CatalogId: raw };
}

/**
 * The `CatalogId` an UPDATE sends. A finite number (a YAML-numeric account id,
 * which {@link withRecordedCatalogId} can now carry into a `drift --revert`
 * bag) is stringified the way the readers and deletes do; anything else keeps
 * the pre-existing cast, so an unresolved intrinsic still reaches AWS and is
 * rejected there rather than silently defaulting to this account's catalog.
 */
export function updateCatalogId(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : (value as string | undefined);
}

/** Which Data Catalog a `CatalogId` value addresses, as far as cdkd can tell offline. */
type CatalogSide = { kind: 'default' } | { kind: 'literal'; id: string } | { kind: 'unusable' };

/**
 * Classify a `CatalogId`. Absent and the account-id pseudo parameter both mean
 * the caller's own catalog ({@link isAccountIdPseudoParameter}); a usable
 * literal is itself; anything else (another intrinsic, a malformed value)
 * cannot be placed.
 */
function classifyCatalog(value: unknown): CatalogSide {
  if (value == null || isAccountIdPseudoParameter(value)) return { kind: 'default' };
  const id = catalogIdForApi(value);
  return id === undefined ? { kind: 'unusable' } : { kind: 'literal', id };
}

/**
 * Refuse an UPDATE whose `CatalogId` moves the entity to another Data Catalog
 * (issue #3756).
 *
 * Every Glue update sends the DESIRED `CatalogId` while the state record names
 * only the entity, so a changed catalog addresses the same-named entity in
 * ANOTHER catalog — rewriting it while the recorded one is left alone.
 * `AWS::Glue::Database` reaches this on every such edit (its registry schema
 * marks only `DatabaseName` createOnly); Table and Connection mark `CatalogId`
 * createOnly and reach it only when the createOnly lookup degrades.
 *
 * Equivalence is decided, not string-compared: absent and a literal equal to
 * the caller's own account are the SAME catalog, so the mixed case asks STS
 * (`callerAccountId`), which a CDK stack's `catalogId: Stack.of(this).account`
 * hits whenever the recorded side holds the pseudo parameter an import left.
 * An unusable DESIRED side is left to the wire as before, and an unusable
 * RECORDED side (an imported raw intrinsic) cannot be placed, so it warns and
 * proceeds: refusing would wedge every later deploy on a record the user
 * cannot edit.
 */
export async function refuseCatalogMove(args: {
  resourceType: string;
  logicalId: string;
  noun: string;
  entityName: string;
  recorded: unknown;
  desired: unknown;
  stateful: boolean;
  callerAccountId: () => Promise<string>;
  warn: (message: string) => void;
  /** Where AWS's own text for a failed STS call goes (go-to-k/cdkd#2319). */
  debug: (message: string) => void;
  /**
   * The update's masker (issue #2177): the entity name, every literal catalog
   * id and the STS failure text are masked RAW before they join a sentence.
   */
  mask: MaskerFn;
}): Promise<void> {
  const { mask } = args;
  const recorded = classifyCatalog(args.recorded);
  const desired = classifyCatalog(args.desired);
  const describe = (side: CatalogSide): string =>
    describeCatalog(side.kind === 'literal' ? side.id : undefined, mask);
  if (desired.kind === 'unusable') return;
  if (recorded.kind === 'unusable') {
    args.warn(
      `Glue ${args.noun} ${args.logicalId}: the recorded CatalogId is not a usable value ` +
        `(likely an unresolved intrinsic an import recorded), so cdkd cannot confirm the update ` +
        `addresses the Data Catalog the ${args.noun} was deployed to; it proceeds against ` +
        `${describe(desired)}.`
    );
    return;
  }
  if (recorded.kind === 'default' && desired.kind === 'default') return;
  if (recorded.kind === 'literal' && desired.kind === 'literal') {
    if (recorded.id === desired.id) return;
  } else {
    const literal = recorded.kind === 'literal' ? recorded.id : (desired as { id: string }).id;
    let callerAccount: string;
    try {
      callerAccount = await args.callerAccountId();
    } catch (error) {
      throw wrapGlueError(
        mask,
        args.debug,
        error,
        (text) =>
          new ProvisioningError(
            `Could not resolve the caller's account id (sts:GetCallerIdentity) to tell whether ` +
              `CatalogId ${mask(literal)} is this account's default Data Catalog, so cdkd did not ` +
              `update Glue ${args.noun} ${args.logicalId}: ${text}`,
            args.resourceType,
            args.logicalId,
            undefined,
            error instanceof Error ? error : undefined
          )
      );
    }
    if (literal === callerAccount) return;
  }
  const remedyFlags = args.stateful ? '--replace --force-stateful-recreation' : '--replace';
  throw new ResourceUpdateNotSupportedError(
    args.resourceType,
    args.logicalId,
    `CatalogId moves the ${args.noun} '${mask(args.entityName)}' from ${describe(recorded)} to ` +
      `${describe(desired)}, and an in-place update would address the same-named ${args.noun} ` +
      `in the NEW catalog while the state record kept the old one. To move it, re-deploy with ` +
      `${remedyFlags}, which DELETEs the ${args.noun} from ${describe(recorded)} and then ` +
      `CREATEs it in ${describe(desired)} (under UpdateReplacePolicy: Retain the old one is ` +
      `kept instead); or keep the recorded CatalogId`
  );
}

/**
 * A memoized "which account am I" for {@link refuseCatalogMove}'s mixed case,
 * built per provider instance so the STS call happens at most once and only
 * when a catalog comparison needs it. A failure is not cached.
 */
export function makeCallerAccountResolver(region: string | undefined): () => Promise<string> {
  let stsClient: STSClient | undefined;
  let cached: string | undefined;
  return async () => {
    if (cached) return cached;
    stsClient ??= new STSClient({ ...ambientClientDefaults(), ...(region ? { region } : {}) });
    cached = await resolveAccountId(stsClient);
    return cached;
  };
}

/**
 * A Glue provider's two clients, built in ONE synchronous step so both capture
 * the region and identity active at that call: `client` for every call, and
 * `createClient` for the provider's main create only -- SDK retries on, except
 * a 5xx (`withoutServerErrorRetries`, issue #4639).
 *
 * None of `CreateDatabase`, `CreateTable`, `CreateWorkflow`,
 * `CreateSecurityConfiguration`, `CreateJob`, `CreateCrawler`,
 * `CreateConnection` or `CreateTrigger` carries an idempotency token, and each
 * name is unique in its scope (catalog, database, account and region), so the
 * SDK's own replay of a 5xx whose request had succeeded collides with what the
 * first send made, and that `AlreadyExistsException` surfaced from the
 * engine's FIRST attempt as a name somebody else holds. Refused here, the 5xx
 * reaches the deploy engine's retry, which marks the create as possibly
 * replayed (`withRetry`, #3978). Nothing is adopted on that collision: a name
 * is not attribution (`docs/provider-rules.md`, "Adopt only on EXACT
 * attribution").
 */
export function newGlueClients(region: string | undefined): {
  client: GlueClient;
  createClient: GlueClient;
} {
  return {
    client: new GlueClient({ ...ambientClientDefaults(), ...(region ? { region } : {}) }),
    createClient: withoutServerErrorRetries(
      new GlueClient({ ...ambientClientDefaults(), ...(region ? { region } : {}) })
    ),
  };
}

/**
 * Wrap what a Glue operation caught into the error it throws, keeping the
 * caller's identity out of the thrown message (go-to-k/cdkd#2319; the S3
 * bucket provider's twin is go-to-k/cdkd#2302).
 *
 * A thrown message is persisted to `deployments/{runId}.jsonl`, and Glue words
 * an `AccessDeniedException` as `User:
 * arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized to
 * perform: ...`. So an AWS-authored failure (`describeAwsFailure`) reaches
 * `build` as its CLASS, and the message `build` would have made from AWS's own
 * text goes to `debug`, through the operation's masker. A cdkd-authored or
 * transport error keeps its text and the masked-quote wrap it had
 * (`wrapMaskedAwsError`). A non-`Error` throw no longer out-throws a value
 * `String()` cannot convert.
 *
 * `build` must thread `error` as the wrap's `cause`: the redaction is stamped
 * so the retry classifiers read that chain, where the withheld `not authorized
 * to perform` still is. A non-`Error` throw has no chain, so it is not stamped.
 * An "already exists" is restated ({@link relayedNameCollision}), so a
 * create-first replacement still recognises the collision. Every delete checks
 * `EntityNotFoundException` by type before it wraps, and stamps a wrap naming
 * any other `NotFound` class `markNotGone`, which the destroy loop's "already
 * deleted" match refuses.
 */
export function wrapGlueError(
  mask: MaskerFn,
  debug: (message: string) => void,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
  // `build` runs twice here (debug text, then the throw), so it must stay a
  // side-effect-free constructor call.
  debug(mask(build(failure.detail).message));
  const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}
