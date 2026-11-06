import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import {
  redactForState,
  carryLogOnlyValues,
  MIN_NEEDLE_LENGTH,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import { displayIdent, displayStackName } from '../../../utils/display-safe.js';
import type { StateImportEntry, StateOutputReadEntry } from '../../../types/state.js';
import { producerNameIsUnresolved } from '../recreate-downstream-consumers.js';
import { isWholeSecretReferenceToken } from '../../../analyzer/outputs-diff.js';

/**
 * Every secret plaintext this run recorded, from ANY position in the template
 * (issue #2005) — the outputs' own map plus every resource's, filtered to the
 * values long enough to be a safe needle.
 *
 * Built here rather than kept as each pass's input everywhere — `outputSecrets`
 * and `perResourceSecrets` are deliberately SEPARATE bags so one resource's
 * secret value cannot rewrite another's coinciding literal (the collision the
 * `SecretsRunState.perResourceSecrets` doc describes), and widening the bag the
 * RESOURCE walk uses would re-open exactly that.
 *
 * On a value collision the outputs' expression wins: it is written last, and an
 * output KEY is the closest kin of the bag this map is scanned against. Both
 * expressions resolve to the same plaintext by construction (that is what makes
 * them collide), so the choice costs precision, not correctness — the residual
 * documented for the ambiguous-key fallback one screen up. A resource-vs-
 * resource collision is NOT ordered by anything: `perResourceSecrets` is
 * iterated in map order and the LAST logical id wins, so between two resources
 * resolving one plaintext the surviving expression is whichever the walk
 * reached last. Same trade as above (both resolve to the same value), stated
 * because only the outputs-vs-resource half used to be.
 *
 * **The needle floor is the security half, and it looks like it contradicts
 * repo policy without doing so.** `redactSecretsForState`'s no-source arm
 * matches a WHOLE VALUE at ANY length; only its substring arm honors
 * {@link MIN_NEEDLE_LENGTH}. That is sound for a POSITION-SCOPED bag, where the
 * candidate leaf is already known to belong to the reference. This union has no
 * position source at all, so an unfiltered 1-3 character plaintext recorded by
 * ANY resource would whole-value-match an unrelated stored output and rewrite
 * it onto that resource's expression. Issues #2012 / #2036 do say that with no
 * evidence OVER-redaction is the right failure, because it is "visible,
 * recoverable, and not a disclosure" — but that asymmetry is about a DRIFT
 * BASELINE, and it does not transfer here: `state.outputs` is re-applied
 * VERBATIM to consumer stacks by the exports index
 * (`src/state/export-index-store.ts`) and by `Fn::ImportValue` /
 * `Fn::GetStackOutput` (`src/deployment/intrinsic-resolver/{cross-stack,stack-output}.ts`), so a
 * false redaction ships a literal `{{resolve:...}}` token into a consumer's own
 * AWS call — the #1934 class, a BREAK rather than a recoverable mismatch. (Two
 * readers, not the whole list: the module doc records a third that is out of
 * this command's reach, with the derivation.)
 *
 * The floor is applied to the WHOLE union, `outputSecrets` included, and that
 * narrows NOTHING that worked before. The positioning pass still runs FIRST
 * over the same bag with the UNFILTERED `outputSecrets`, whole-value-matching
 * at any length, and {@link redactUnaccountedOutputs} scans the STORED value —
 * so a sub-floor output secret it cannot see compares equal, falls through, and
 * the positioned leaf survives into `repaired ?? positioned`. Pinned by the
 * suite's "still repairs a SCALAR unaccounted key holding a sub-floor OUTPUT
 * secret" case (`ab1` -> its expression — the exact shape the false note
 * described) and by its non-scalar sibling "keeps the POSITIONED value". The
 * floor's effect is therefore confined to CROSS-RESOURCE needles: a sub-floor
 * plaintext recorded only by a RESOURCE never becomes a needle for the outputs
 * bag. Stated because an earlier revision claimed a narrowing here, and a false
 * "we gave this up" note is how a capability gets removed for real later.
 *
 * **What the floor does NOT bound, stated plainly because it is the residual a
 * reader will otherwise assume away.** `redactSecretsForState`'s SUBSTRING arm
 * runs over this union too, so a recorded plaintext of {@link
 * MIN_NEEDLE_LENGTH} characters or more occurring ANYWHERE inside an unrelated
 * unaccounted output WILL be rewritten. `secretValueFromJson('username')`
 * resolving `admin` turns a stored `https://admin.example.com` into
 * `https://{{resolve:secretsmanager:...}}.example.com`, which the exports index
 * republishes and a consumer's `Fn::ImportValue` then ships to AWS as a literal
 * token — the #1934 BREAK class, from a value that was never a secret.
 *
 * That arm is kept, and raising the floor for this union alone was considered
 * and REJECTED, on three grounds:
 *
 * - **Substring matching is what makes the repair work at all.** A connection
 *   string embedding a password is #2005's own target shape and this suite's
 *   own `DbUrl` case; gutting the arm would leave the motivating population
 *   unrepairable, which is the disclosure the command exists to remove.
 * - **Length is a weak proxy for the hazard, in both directions.** The values
 *   that collide with unrelated text are common tokens — `admin`, `prod`,
 *   `root` — and raising the bar to 8 admits `password`, `postgres`,
 *   `localhost`, which are longer AND likelier to occur inside a stored URL. A
 *   higher floor would refuse genuine short secrets while still admitting the
 *   colliding ones.
 * - **4 is the repo's ONE answer, and a second number would have no
 *   derivation.** `secret-redaction.ts`'s own needles, `stateKeySecretExposure`
 *   (#1919) and `drift.ts`'s `carriesRecordedSecret` all use it. A union-only 8
 *   would be the only such constant in the tree justified by taste, and a later
 *   reader could not tell which is authoritative.
 *
 * The trade is right for a GHSA repair command because the two failure
 * directions differ on REVERSIBILITY, not on likelihood. A fabricated rewrite
 * is loud and remediable: the consumer's next deploy fails on an unresolvable
 * token, and the operator fixes the template or edits the key out of state. An
 * unrepaired plaintext is silent and permanent — the key is one today's
 * template does not declare, so no redeploy ever rewrites it, and no other
 * command can. Refusing the substring arm here would trade the irreversible
 * failure for the reversible one in the wrong direction.
 */
export function allRecordedSecrets(
  outputSecrets: RecordedSecretValues,
  perResourceSecrets: ReadonlyMap<string, RecordedSecretValues>,
  /**
   * Orphan-record needles (issue go-to-k/cdkd#2943).
   *
   * REQUIRED, not optional: an optional parameter here invites a future call
   * site that silently omits it, and one of the three is the ERROR BOUNDARY,
   * which can run on a throw raised DURING the orphan loop with the map only
   * partly filled. Pass an empty map if a caller genuinely has none. Why the
   * boundary needs these needles at all:
   * `pinCrossRegionSecrets` can throw AFTER recording a foreign plaintext —
   * the resource loop says so in its own comment — and the region-ambiguous
   * rethrow is deliberately unmasked at the site, so both reach the boundary.
   * Without these needles the plaintext renders into `console.error`'s cause
   * chain.
   */
  orphanSecrets: ReadonlyMap<string, RecordedSecretValues>
): RecordedSecretValues {
  const union: RecordedSecretValues = new Map();
  // go-to-k/cdkd#1998: the LOG-ONLY needles (a `NoEcho` parameter's value) are
  // keyed by the bag INSTANCE, so the entry copies below drop them. Carried
  // for the two consumers that PRINT through this union — the error boundary
  // and the cross-stack producer line; every consumer that persists walks the
  // map alone and never reads them. Not from the orphan bags: an orphan pass
  // resolves persisted text, which holds no parameter `Ref` to record one.
  for (const recorded of perResourceSecrets.values()) {
    for (const [value, expression] of recorded) union.set(value, expression);
    carryLogOnlyValues(recorded, union);
  }
  // Folded BEFORE `outputSecrets`: two docs in this file promise the OUTPUTS'
  // expression wins a value collision "because it is written last", and
  // folding the orphan bags after made the orphan's win instead.
  //
  // Order reaches only the consumers that write the map's VALUES —
  // `redactUnaccountedOutputs` and the orphan-record rewrite. The error
  // boundary masks by KEY, so order cannot touch it.
  for (const recorded of orphanSecrets.values()) {
    for (const [value, expression] of recorded) union.set(value, expression);
  }
  for (const [value, expression] of outputSecrets) union.set(value, expression);
  carryLogOnlyValues(outputSecrets, union);
  for (const value of union.keys()) {
    if (value.length < MIN_NEEDLE_LENGTH) union.delete(value);
  }
  return union;
}

/**
 * Repair a stored output key today's template cannot ACCOUNT for (issue
 * [#2005](https://github.com/go-to-k/cdkd/issues/2005)) — the population `cdkd
 * scrub` is documented as the remedy for and could not actually remedy.
 *
 * `outputSecrets` is built from today's DECLARED outputs, and the outputs
 * redaction above is gated on it being non-empty. An output DELETED from the
 * template contributes nothing to that set, so a record whose only
 * secret-bearing output has since been removed was reported CLEAN by the
 * command whose job is to clean it, while the plaintext stayed in
 * `state.outputs` until an unrelated deploy happened to rewrite the bag. That
 * is precisely the record `cdkd diff` withholds from display
 * ([#1948](https://github.com/go-to-k/cdkd/issues/1948)): correctly hidden, and
 * until now not repairable.
 *
 * TWO scope decisions, and both are load-bearing.
 *
 * 1. **WHICH keys.** Only keys today's template cannot name — not in
 *    `accountedKeys` (every declared output name plus every `Export.Name` this
 *    run could compute). A key the template DOES name is left exactly as the
 *    pass above leaves it, deliberately, because that pass POSITIONS it against
 *    the template and this one cannot: scanning an accounted key against the
 *    union bag would let one resource's secret plaintext rewrite a declared
 *    output's coinciding literal onto that resource's expression — a value
 *    state was never meant to hold, in the command that exists to make state
 *    trustworthy. The accepted residual, stated because narrowing is what buys
 *    the safety: a DECLARED output whose template value no longer resolves a
 *    secret, but whose STORED value is still the stale plaintext of one a
 *    resource carries, is not repaired here either. A redeploy rewrites it.
 *
 * 2. **WHAT may be rewritten.** Only a value that genuinely MATCHES a recorded
 *    plaintext — `redactSecretsForState`'s value scan with no source, i.e. a
 *    whole-value match and an embedded one, both bounded at
 *    {@link MIN_NEEDLE_LENGTH} by {@link allRecordedSecrets}. A scrub that
 *    cannot identify the needle must not guess: `state.outputs` is re-applied
 *    VERBATIM to consumer stacks by the exports index and by `Fn::ImportValue`
 *    / `Fn::GetStackOutput` (and by one more reader out of this command's
 *    reach — see the module doc), so a fabricated redaction ships a literal
 *    `{{resolve:...}}` token into a consumer's AWS call. No key is invented for
 *    the same reason. When nothing this run recorded the plaintext (the secret
 *    was deleted, rotated away, or the reference is gone from the template too)
 *    this pass LEAVES the value alone, and `planUnnamedOutputDrop` decides
 *    whether the key is then dropped (go-to-k/cdkd#4120) — but note that behavior
 *    does NOT live in this function's `secrets.size === 0` guard, which is one
 *    of three redundant reasons and fences none of them; see the guard's own
 *    comment for what actually reaches it.
 *
 * **The scanned VALUE is the STORED one, never the positioned pass's output**
 * (blocker found in review). Scanning an already-positioned leaf means scanning
 * an expression the first pass just INSERTED, and `redactSecretsForState`'s
 * token guard protects only a WHOLE-VALUE token — so a MIXED leaf
 * (`postgres://admin:{{resolve:secretsmanager:prod/db:...}}@app-db`, the
 * `Fn::Join` shape CDK emits) gets re-scanned and any union needle occurring
 * INSIDE the inserted reference is spliced into it, corrupting the expression
 * into one no service can resolve (the corruption `secret-redaction.ts`'s own
 * token guard documents). A single union scan of the STORED value subsumes the
 * first pass for these keys rather than composing with it: the union is a
 * superset of `outputSecrets` with the outputs' expression winning a collision,
 * and an unaccounted key by construction has no position source in
 * `outputsTemplateSource` (every key that bag carries — a declared output name
 * or a literal `Export.Name` — is in `accountedKeys`), so the first pass could
 * only ever have value-scanned it too.
 *
 * **The repaired population is WIDER than "an output you deleted."** Any stored
 * key today's template cannot COMPUTE is in it, and a parameterized
 * `Export.Name` is the standing example: `scrub` has only template defaults, so
 * a name resolving to the literal `prefix-${Foo}` leaves the REAL alias key the
 * deploy wrote unaccounted on EVERY run, and that key gets cross-resource value
 * matching for as long as the parameter stays unresolvable here. That is the
 * accepted cost of not being able to reproduce the key — the alternative is
 * leaving a permanently unrepairable key — but it is a standing exposure to the
 * fabrication risk above rather than a one-off after a refactor.
 *
 * Returns the input by IDENTITY when nothing changed. That is worth doing on
 * its own terms (no churn, no needless clone), but it is NOT what keeps the
 * caller honest: the caller compares with `JSON.stringify` unconditionally, so
 * an identity return cannot make it cheaper and a fresh-but-equal object could
 * not make it report a repair it did not perform.
 */
export function redactUnaccountedOutputs(
  positioned: Record<string, unknown> | undefined,
  stored: Record<string, unknown> | undefined,
  accountedKeys: ReadonlySet<string>,
  secrets: RecordedSecretValues
): Record<string, unknown> | undefined {
  // `?? {}` nowhere: this must be able to return its input by identity, and
  // every other consumer treats the field as optional, so an absent bag is
  // returned untouched rather than materialized into an empty object. The
  // parameter and return types say `| undefined` because that is what the
  // runtime accepts and returns — `state.outputs` is optional in practice on a
  // state file that simply has no outputs.
  //
  // `!stored` cannot fire independently of `!positioned` and is a TYPE
  // narrowing rather than a second guard: `positioned` is DERIVED from
  // `stored`, and `redactSecretsForState` returns `undefined` for an absent bag
  // on both its arms (measured, with and without a position source). Stated so
  // nobody reads it as covering a case the other half does not.
  //
  // `secrets.size === 0` IS reachable, and its trigger is narrower than
  // "nothing was recorded this run". `scrubStack` early-returns at
  // `totalSecrets === 0`, but `totalSecrets` counts the RAW maps while this
  // union is additionally filtered to {@link MIN_NEEDLE_LENGTH} — so a stack
  // whose every recorded plaintext is SUB-FLOOR (a SecureString holding `ab1`
  // gives `totalSecrets === 1`) walks past that return and arrives here with an
  // empty union. That is the line's real trigger; an earlier revision of this
  // comment called it unreachable, which was true only before the floor existed
  // and which would have suppressed the retest that found this shape.
  //
  // It is still not the thing that protects an unrecoverable needle, and that
  // part is measured rather than assumed: delete this guard, or delete the
  // early return, and the record still comes out byte-identical, because an
  // empty secrets map makes every scan the identity. Three redundant reasons,
  // no single fence — stated because a comment claiming one would suppress the
  // next retest.
  if (secrets.size === 0 || !positioned || !stored) return positioned;
  let repaired: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(stored)) {
    if (accountedKeys.has(key)) continue;
    const next = redactForState(value, { provenance: 'value-scan', secrets: secrets });
    // NOT `next === value`: the value scan returns a string by identity when
    // nothing matched, but it CLONES every object / array it walks (an output
    // can hold a JSON array — a list-valued `Fn::GetAtt`), so an identity test
    // would rewrite `repaired[key]` for every non-scalar output. Harmless for
    // the reported COUNT (the caller re-compares by value), but it would
    // replace the positioned bag's clone with this pass's clone for keys this
    // pass did not change — churn in the persisted record for no reason, and a
    // needless divergence between two bags that should stay the same object.
    if (JSON.stringify(next) === JSON.stringify(value)) continue;
    repaired ??= { ...positioned };
    repaired[key] = next;
  }
  return repaired ?? positioned;
}

/**
 * The stored output keys a scrub of this record DROPS, and the ones it cannot
 * classify and so leaves as they are (issue go-to-k/cdkd#4120).
 *
 * A key today's template cannot name that {@link redactUnaccountedOutputs} did
 * NOT rewrite holds a value scrub cannot identify: most often the output was
 * deleted from the template, and its value may be a plaintext an older binary
 * stored. Leaving it beside the `{{resolve:ssm:...}}` token scrub writes
 * elsewhere in the bag is the defect: that token is the evidence `cdkd diff`'s
 * issue #1948 exoneration reads as "this bag is redacted", so the unnamed value
 * printed on its REMOVE row. So scrub removes it; the deploy that next writes
 * the record would not re-create it either, since the template no longer
 * declares it. Kept instead: a key the widened pass rewrote, whole or in part
 * (its value now carries the reference, and the exports-index step converges
 * an entry against it); one no string of which can be a plaintext (only whole
 * secret-reference tokens, or no string at all), which a drop would rewrite a
 * clean record over; and one in `reportedKeys`. The caller also keeps a key
 * another stack still reads (`findDroppedOutputReaders`).
 *
 * What may NOT be dropped is a LIVE export alias whose name this run could not
 * reproduce — a parameterized `Export.Name` resolved from template defaults, or
 * one that did not resolve at all. From the key alone that alias and a deleted
 * output's alias look the same, so the decision rests on two facts:
 *
 * - a key the record's `exportNames` (schema v9+) does NOT list is a plain
 *   Output name, and every Output name today's template declares is in
 *   `accountedKeys` literally, so it is a deleted output: DROP;
 * - a key that is, or may be (a record whose `exportNames` is absent or holds
 *   anything but names makes every key importable), an alias is dropped only when every `Export.Name`
 *   today's template declares was REPRODUCED — resolved to a key the record
 *   holds. Then every live alias is accounted and this one is not live.
 *   Otherwise it is KEPT, and the caller says so.
 *
 * `rewritten` is the bag after both redaction passes; `stored` is the record's.
 */
export function planUnnamedOutputDrop(input: {
  stored: Record<string, unknown>;
  rewritten: Record<string, unknown>;
  accountedKeys: ReadonlySet<string>;
  /**
   * Keys whose NAME holds a recorded secret (issue #1919): reported as leaks
   * scrub cannot rewrite, and never dropped — the exports index still
   * publishes that name, and the report is what keeps `--fail` red over it.
   */
  reportedKeys?: ReadonlySet<string>;
  /** The record's `exportNames`, as stored — any shape. */
  exportNames: unknown;
  /** Every declared `Export.Name` resolved to a key the record holds. */
  everyExportAliasReproduced: boolean;
}): { drop: string[]; keep: string[] } {
  const drop: string[] = [];
  const keep: string[] = [];
  const knownExportNames = knownExportNamesOf(input.exportNames);
  for (const key of Object.keys(input.stored)) {
    if (input.accountedKeys.has(key) || input.reportedKeys?.has(key)) continue;
    const value = input.stored[key];
    const now = Object.hasOwn(input.rewritten, key) ? input.rewritten[key] : undefined;
    // REWRITTEN by a redaction pass, whole or in part: KEPT. Its value now
    // carries the reference, which is what the exports-index step converges
    // an entry of this name to — dropping it sent that entry down the
    // `absent` arm, which writes nothing, and left the recorded secret's
    // plaintext in `exports.json`. The text a PARTLY rewritten value keeps
    // beside the reference is withheld by `cdkd diff` itself (its per-key
    // `ownValueHidesSecret`, issue #4101).
    if (JSON.stringify(now) !== JSON.stringify(value)) continue;
    // Nothing in it can be a plaintext: every string leaf is a whole
    // secret-reference token (a record a post-GHSA deploy wrote), or there is
    // no string at all. Dropping it would rewrite a clean record for nothing,
    // and turn `--dry-run --fail` red over it.
    if (!mayHoldPlaintext(value)) continue;
    const mayBeAlias = knownExportNames === undefined || knownExportNames.has(key);
    if (!mayBeAlias || input.everyExportAliasReproduced) drop.push(key);
    else keep.push(key);
  }
  return { drop, keep };
}

/**
 * The record's export set when it can be trusted, else `undefined`
 * (go-to-k/cdkd#4120). KNOWN only when it is a list of names: a set holding
 * anything else (`[0]`, `[null]`, `['Real', 0]`) is damaged, and what it failed
 * to list may be a live alias, so every undeclared key is then treated as one.
 * Stricter than `hasReadableExportSet`, which reads `['Real', 0]` as readable
 * for PUBLISHING; here an unknown member can only err toward keeping.
 */
export function knownExportNamesOf(exportNames: unknown): ReadonlySet<string> | undefined {
  return Array.isArray(exportNames) && exportNames.every((n) => typeof n === 'string')
    ? new Set(exportNames as string[])
    : undefined;
}

/**
 * Whether a stored value has a string leaf that is not one whole secret-bearing
 * `{{resolve:...}}` token — i.e. text that could be a plaintext.
 */
function mayHoldPlaintext(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0 && !isWholeSecretReferenceToken(value);
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some(mayHoldPlaintext);
}

/** Every non-empty string leaf of a stored value, as a display-corpus entry. */
export function addStoredStringLeaves(value: unknown, into: RecordedSecretValues): void {
  if (typeof value === 'string') {
    if (value.length > 0) into.set(value, '<stored output value withheld as possible plaintext>');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const member of Object.values(value as Record<string, unknown>)) {
    addStoredStringLeaves(member, into);
  }
}

/** Another stack's recorded read of an output key scrub is about to drop. */
export interface DroppedOutputReader {
  consumerStack: string;
  consumerRegion: string;
  /** The key read; `undefined` when the stored entry's name is redacted and cannot be compared. */
  key: string | undefined;
  intrinsic: 'Fn::ImportValue' | 'Fn::GetStackOutput';
  /** Set when the entry is DAMAGED (a name that is not a string), not redacted. */
  damaged?: true;
  /**
   * Set when the record predates the schema field that records this kind of
   * read (`imports` v4, `outputReads` v8), so its reads are unknown.
   */
  legacy?: true;
}

/** One state record's cross-stack reads, as `findDroppedOutputReaders` reads them. */
export interface ConsumerRecord {
  stackName: string;
  region: string;
  /** The record's schema `version`, as stored — any shape. */
  version?: unknown;
  imports: unknown;
  outputReads: unknown;
}

/** The schema version that introduced `imports[]` (issue #650). */
const IMPORTS_SCHEMA_VERSION = 4;
/** The schema version that introduced `outputReads[]` (issue #668). */
const OUTPUT_READS_SCHEMA_VERSION = 8;
/** Parallel state GETs while reading every record for the drop's reader scan. */
const CONSUMER_RECORD_READ_CONCURRENCY = 16;

/**
 * Every state record in the bucket, reduced to its cross-stack reads
 * (go-to-k/cdkd#4120). THROWS when the listing or any record cannot be read:
 * the caller keeps every key it meant to drop rather than trust an absent
 * answer. `scrubCommand` memoizes one load per run; a legacy ref with no region
 * is read in `fallbackRegion`, as the destroy-time scan does.
 */
export async function readConsumerRecords(
  stateBackend: Pick<S3StateBackend, 'getState' | 'listStacks'>,
  fallbackRegion: string
): Promise<ConsumerRecord[]> {
  const refs = await stateBackend.listStacks();
  const records: ConsumerRecord[] = [];
  let next = 0;
  // Once one read failed the answer is already "unverifiable": the other
  // workers stop taking refs rather than read the rest of the bucket.
  let failed = false;
  // BOUNDED: one GET per record in the bucket, CONSUMER_RECORD_READ_CONCURRENCY
  // at a time.
  const worker = async (): Promise<void> => {
    while (!failed && next < refs.length) {
      const ref = refs[next++]!;
      const region = ref.region ?? fallbackRegion;
      let got: Awaited<ReturnType<typeof stateBackend.getState>>;
      try {
        got = await stateBackend.getState(ref.stackName, region);
      } catch (err) {
        failed = true;
        throw err;
      }
      // A record the listing named that reads as ABSENT is UNREADABLE here,
      // not "no reads": the listing and the read disagree, and a concurrent
      // delete is the only benign cause. Fail closed.
      if (!got) {
        failed = true;
        throw new Error(
          `${displayStackName(ref.stackName)} (${displayIdent(region)}) is listed but its state record could not be read`
        );
      }
      records.push({
        stackName: ref.stackName,
        region,
        version: got.state.version,
        imports: got.state.imports,
        outputReads: got.state.outputReads,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONSUMER_RECORD_READ_CONCURRENCY, refs.length) }, worker)
  );
  // Completion order is arbitrary; sorted so the reader warnings are stable.
  return records.sort(
    (a, b) => a.stackName.localeCompare(b.stackName) || a.region.localeCompare(b.region)
  );
}

/**
 * Every OTHER record's recorded read of a key in `keys` on this producer
 * (go-to-k/cdkd#4120): `imports[]` for an `Fn::ImportValue`, `outputReads[]`
 * for an `Fn::GetStackOutput`.
 *
 * FAIL-CLOSED, unlike `findDownstreamConsumers`, whose caller only warns. What
 * cannot be ruled out counts as a read: an entry whose key or producer name is
 * stored REDACTED (`producerNameIsUnresolved`), or whose `sourceRegion` is not
 * a string. A list field that is present but not a list, or an entry that is
 * not an object, THROWS — the caller then treats the whole scan as unverified.
 */
export function findDroppedOutputReaders(
  producerStack: string,
  producerRegion: string,
  keys: ReadonlySet<string>,
  records: readonly ConsumerRecord[]
): DroppedOutputReader[] {
  const region = canonicalizeRegion(producerRegion);
  const regionMayMatch = (value: unknown): boolean =>
    typeof value !== 'string' || canonicalizeRegion(value) === region;
  const entriesOf = (value: unknown, field: string, stackName: string): object[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((e) => e === null || typeof e !== 'object')) {
      throw new Error(
        `the ${field} list of ${displayStackName(stackName)}'s state record is not readable`
      );
    }
    return value as object[];
  };
  const readers: DroppedOutputReader[] = [];
  for (const record of records) {
    if (record.stackName === producerStack && canonicalizeRegion(record.region) === region) {
      continue;
    }
    const reader = (
      key: string | undefined,
      intrinsic: DroppedOutputReader['intrinsic'],
      damaged = false,
      legacy = false
    ): void => {
      readers.push({
        consumerStack: record.stackName,
        consumerRegion: record.region,
        key,
        intrinsic,
        ...(damaged && { damaged: true as const }),
        ...(legacy && { legacy: true as const }),
      });
    };
    // A record older than the field records no reads of that kind at all, so
    // an absent list there is UNKNOWN rather than empty. A version that is not
    // a number is read as the oldest. TWO residuals, both documented in
    // docs/cli-scrub.md: it is FAIL-OPEN for a pre-v8 record a non-deploy
    // writer (scrub, drift, import, the state commands) has since rewritten —
    // `saveState` stamps the current version on every write, so that record
    // reads as current with no `outputReads` — and it OVER-REFUSES, since one
    // old unrelated record anywhere in the bucket keeps every producer's drop
    // candidates, and `--fail` red, until that record is redeployed.
    const version = typeof record.version === 'number' ? record.version : 0;
    if (version < IMPORTS_SCHEMA_VERSION) reader(undefined, 'Fn::ImportValue', false, true);
    if (version < OUTPUT_READS_SCHEMA_VERSION) {
      reader(undefined, 'Fn::GetStackOutput', false, true);
    }
    const matchKey = (name: unknown, intrinsic: DroppedOutputReader['intrinsic']): void => {
      if (typeof name === 'string' && keys.has(name)) reader(name, intrinsic);
      else if (typeof name !== 'string' || producerNameIsUnresolved(name)) {
        reader(undefined, intrinsic, typeof name !== 'string');
      }
    };
    for (const entry of entriesOf(record.imports, 'imports', record.stackName)) {
      const e = entry as Partial<StateImportEntry>;
      // `imports[].sourceStack` is stored verbatim, never redacted, so only a
      // damaged entry holds a non-string one: it cannot be ruled out.
      if (typeof e.sourceStack === 'string' && e.sourceStack !== producerStack) continue;
      if (!regionMayMatch(e.sourceRegion)) continue;
      if (typeof e.sourceStack !== 'string') {
        reader(undefined, 'Fn::ImportValue', true);
        continue;
      }
      matchKey(e.exportName, 'Fn::ImportValue');
    }
    for (const entry of entriesOf(record.outputReads, 'outputReads', record.stackName)) {
      const e = entry as Partial<StateOutputReadEntry>;
      if (!regionMayMatch(e.sourceRegion)) continue;
      const source = e.sourceStack;
      if (typeof source !== 'string') {
        reader(undefined, 'Fn::GetStackOutput', true);
        continue;
      }
      if (source !== producerStack && !producerNameIsUnresolved(source)) continue;
      matchKey(e.outputName, 'Fn::GetStackOutput');
    }
  }
  return readers;
}
