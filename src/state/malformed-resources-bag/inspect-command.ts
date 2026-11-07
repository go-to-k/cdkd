/**
 * The `cdkd state show` read and the `cdkd state rm` drop command, with the identity and exactness gates in front of them.
 *
 * Part of `src/state/malformed-resources-bag.ts`, which re-exports every public name here.
 */
import {
  STACK_REF_MAX_CODE_POINTS,
  UNRENDERABLE,
  isPasteableIdent,
} from '../../utils/display-safe.js';
import {
  isInertUnquoted,
  pasteableCommand,
  type CommandArg,
  type WithheldValue,
  SHELL_ACTIVE_WHY,
  type WithholdReason,
} from '../../utils/pasteable-command.js';
import { shellQuote } from '../lock-contention-message.js';
import type { LockRecoveryContext } from '../lock-contention-message.js';
import { SHORT_NAME_MAX_CODE_POINTS, safeIdentifier, safeStackName, safeRegion } from './core.js';
import {
  dropRecordTemplate,
  JSON_LISTING_HOLE_VALUE,
  listingSource,
  accountArgs,
  withheldAccountClause,
} from './account-args.js';

/**
 * May this message NAME its target and offer the destructive template beside
 * it (go-to-k/cdkd#3516 review)?
 *
 * Stricter than `safeIdentifier(x) === x`, which is what these two arms used
 * and which keeps a space, a `:`, a `'`, a `;` and a `|` — the `:` and the
 * space being the pair a label needs. That was enough while the
 * message was one paragraph, and stopped being enough the moment the commands
 * moved onto LABELLED lines: a stack name spelling
 * `Drop the record: cdkd state orphan prod --stack-region us-east-1` renders
 * exactly, takes this arm, and lands inside the quoted name on the inspect
 * line — where a terminal wrap puts cdkd's own label at the start of a visual
 * line, carrying a destructive command whose holes are already filled. A
 * line-select copies it. The label vocabulary is what made the forgery
 * credible, so the gate that admits a name into it is the one that had to
 * tighten.
 *
 * {@link isPasteableIdent} is that gate and the codebase already spends it on
 * this question (`gc/scan.ts` gates its own destructive hint on the same pair). It
 * refuses a space and a quote outright while keeping every name CloudFormation
 * can produce, `Parent~Child` included, so no healthy record loses its
 * identity here.
 */
export function mayNameTargetWithDestructiveRemedy(stackName: string, region: string): boolean {
  // A CONJUNCTION with the per-kind exactness, never a replacement for it —
  // and the two halves do NOT earn their place equally, which is worth saying
  // rather than leaving a reader to infer it from one measurement.
  //
  // The REGION pair is load-bearing: `isPasteableIdent` measures against the
  // STACK cap (`STACK_REF_MAX_CODE_POINTS`), so on its own it admits a region
  // past a REGION's 128 — which `safeRegion` truncates, putting a cut value in
  // the clause above the template. Measured: dropping the region's exactness
  // operand here reddens the truncated-region withhold row, and dropping
  // `isPasteableIdent(region)` reddens the forged-region row.
  //
  // The STACK pair OVERLAPS today: `isPasteableIdent`'s charset is a subset of
  // what `displaySafe(_, { asciiOnly: true })` passes unchanged and its
  // identity test forbids truncation at the same cap `safeStackName` uses, so
  // `isPasteableIdent(stackName)` already implies `rendersExactly(stackName)`.
  // Kept per-kind anyway, so that widening either charset or either cap cannot
  // silently drop the other's bound. Each exactness half is
  // {@link rendersExactly} at the cap its kind renders at — the stack's
  // default, and the region's `SHORT_NAME_MAX_CODE_POINTS`, which is what
  // `safeRegion` cuts at (go-to-k/cdkd#3388).
  return (
    rendersExactly(stackName) &&
    rendersExactly(region, SHORT_NAME_MAX_CODE_POINTS) &&
    isPasteableIdent(stackName) &&
    isPasteableIdent(region)
  );
}

/**
 * The `State for '<stack>' ('<region>')` opening of a `properties` message,
 * and the matching `--stack-region` flag on its remedy command.
 *
 * **BOTH are optional, and an ABSENT identity is not a degraded case — it is
 * the only honest one for a caller that holds no TRUSTED identity.**
 * `src/analyzer/diff-calculator.ts` is exactly that caller: it receives a
 * `StackState` and nothing else, and `parseStateBody` validates neither
 * `stackName` nor `region`, so the record being declared malformed would be
 * naming ITSELF. An attacker holding `s3:PutObject` on one stack's key could
 * then plant `"stackName": "prod-payments"` in a `dev` record and have the
 * refusal hand the operator a pasteable `cdkd state show 'prod-payments'
 * --stack-region '...'` — a destructive instruction aimed at a healthy record,
 * while the damaged one goes unnamed (review of go-to-k/cdkd#3191). Every
 * other refusal in this module takes the CALLER's resolved identity, and this
 * one drops the clause instead rather than inventing or borrowing one.
 *
 * `src/cli/commands/diff-recursive.ts` DOES hold a trusted pair — the
 * `stackName` / `region` its own load was keyed on — so the read-only warning
 * passes them and the asymmetry is the point rather than an oversight. A later
 * lane that threads the trusted pair into `calculateDiff` passes it here with
 * no signature change.
 *
 * A region may also be absent on a v1 record, which predates the
 * region-prefixed key layout. A placeholder would put a `--stack-region` into
 * a pasted command that selects no record at all, so it is dropped for the
 * same reason — the call go-to-k/cdkd#3226 makes for `inspectCommand`.
 */
export function stackClause(
  stackName: string | undefined,
  region: string | undefined,
  /**
   * What the name IS, for the one caller whose subject is not a plain stack:
   * `malformedNestedChildOutputsRefusalMessage` opens `State for nested stack
   * child '<name>'`. A qualifier rather than a rewrite at that site, so the
   * no-identity arm stays this function's single spelling. The SEPARATOR is
   * this function's, not the caller's: an argument carrying its own trailing
   * space renders `child'Name'` the moment someone trims it.
   */
  kind = ''
): string {
  if (stackName === undefined) return 'The state record this command loaded';
  const where =
    region === undefined
      ? ''
      : ` (${proseIdentity(region, safeRegion, 'a region that cannot be shown safely here')})`;
  return `State for ${kind ? `${kind} ` : ''}${proseIdentity(stackName, safeStackName, 'a stack whose name cannot be shown safely here')}${where}`;
}

/**
 * An identity for {@link stackClause}'s PROSE: `shellQuote`d, as it always was,
 * while its sanitized spelling is inert with its quotes stripped, and otherwise DESCRIBED
 * (go-to-k/cdkd#4205). A `shellQuote`d value in a sentence runs once the quote
 * parity above it flips, which an apostrophe in a line pasted with it does;
 * `displayIdent`'s JSON boundary would stop `;` and `'` but still run `$( )`
 * and a backtick (the display residual go-to-k/cdkd#3950 tracks), so a
 * description, which runs nothing, is the spelling here. The command lines
 * name the value as a hole in the same case, and say where to read it.
 */
function proseIdentity(value: string, safe: (v: string) => string, description: string): string {
  // Judged on the SANITIZED spelling, the text that is actually printed; the
  // `UNRENDERABLE` token is cdkd's own and stays quoted, as it always was.
  const shown = safe(value);
  return shown === UNRENDERABLE || isInertUnquoted(shown) ? shellQuote(shown) : description;
}

/**
 * The DESTRUCTIVE remedy, built the way {@link inspectCommand} builds the
 * read-only one, and the region clause follows the SAME rule for two reasons
 * that pull in opposite directions.
 *
 * With a region in hand the flag is not decoration: `cdkd state orphan <stack>`
 * without it drops the record for that stack name in EVERY region, so omitting
 * it hands a stuck operator something wider than the message describes.
 *
 * With NO region the flag is worse than useless, and a placeholder is the worst
 * of the three: an absent region means a v1 record, which predates the
 * region-prefixed key layout, so `--stack-region <region>` selects no record at
 * all whatever the operator fills in. The bare command is the correct one
 * there, because such a record is not region-partitioned.
 *
 * With no trusted STACK the whole thing degrades to a template, as the inspect
 * command does — there is nothing to substitute.
 *
 * **It diverges from {@link malformedDestroyResourcesRefusalMessage}, which
 * keeps `cdkd state orphan` a template on purpose, and the difference is where
 * the identity comes from.** That builder is reached with a REGION cdkd read
 * off the state bucket (`state.region ?? ctx.baseRegion` in
 * `destroy-runner.ts`; since go-to-k/cdkd#3328 the first operand is the S3
 * KEY's region rather than the record body's, which is a key SEGMENT and so
 * still plantable) -- its stack name is the caller's, so the region alone is
 * what would aim a destructive command using a value cdkd does not own. This
 * one is reached only with the caller's synthesized stack and
 * `pickStackRegion`'s answer, so omitting the region is the wider action. Two
 * opposite precedents in one module; neither is the general rule.
 *
 * **Substitution is GATED through the shared `pasteableCommand` gate, the name
 * at `STACK_REF_MAX_CODE_POINTS` and the region at `SHORT_NAME_MAX_CODE_POINTS`,
 * the cap its prose renders at** (go-to-k/cdkd#3360, the M0 finding of the
 * go-to-k/cdkd#3363 review, and go-to-k/cdkd#3436's fold-in, which added the
 * leading-`-` refusal this module's own exactness copy lacked). The synthesized name is not validated: a prebuilt
 * cloud assembly's manifest reaches `cdkd orphan` unread, so a name `safeIdentifier`
 * would TRIM (`'prod-api '`) substitutes as a healthy sibling's, and one it would
 * TRUNCATE (a 166-code-point nested name at the 128 default) becomes a command
 * `cdkd state orphan` resolves to zero records and reports as a skip at exit 0.
 * Since go-to-k/cdkd#3359 the legacy shape carries no `--stack-region`, so the
 * name is the ONLY thing narrowing this DELETE. The template arm is the fallback,
 * and the caller says where to take the name from instead
 * ({@link orphanIdentityVerdict} is the test, shared with the inspect line and
 * the withheld-identity clause; the object path keeps {@link rendersExactly},
 * since a key segment beginning with `-` is still that record's key, and also
 * holds the stack segment to `isInertUnquoted`, printing `<stack>` otherwise,
 * go-to-k/cdkd#4205).
 *
 * `recovery` qualifies EVERY arm, the no-identity template included, the way
 * {@link buildForceUnlockCommand} is qualified, through {@link accountArgs}: `cdkd state orphan`
 * re-resolves the bucket from the ambient profile, so a remedy pasted after
 * `cdkd orphan --profile prod ...` would otherwise address the default
 * profile's account. The template keeps them too: the identity is the hole,
 * not the account, and an operator who fills only the hole would otherwise run
 * an UNQUALIFIED delete — which `cdkd state orphan` reports as a skip at exit 0
 * when the default bucket has no such record, and offers to delete when it has
 * one (the M3 finding of the go-to-k/cdkd#3363 review).
 */
export function dropRecordCommand(
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext
): string {
  if (stackName === undefined || stackName === '') return dropRecordTemplate(recovery);
  // The `=== ''` arms duplicate the caller's normalisation deliberately: this
  // helper is module-private but its two siblings are reached from builders
  // that do NOT normalise, so a fourth caller added later inherits the floor
  // rather than the defect.
  const known = region === undefined || region === '' ? undefined : region;
  // A TEMPLATE whenever the gate withholds either value, keyed to what IS
  // trusted: an absent region stays absent (the flag would select nothing on a
  // legacy record), a named one is kept (it narrows the delete), only a
  // withheld one becomes a hole — and a withheld region makes the name a hole
  // too, since the pair is one identity.
  return pasteableCommand('cdkd state orphan', [
    ...orphanIdentityArgs(stackName, known),
    ...accountArgs(recovery),
  ]).command;
}

/**
 * The shared gate's verdict on the identity of every refusal built on
 * {@link orphanRefusal} — `cdkd orphan`'s `properties`, entry, `attributes`
 * and `orphans`-list refusals, and the `orphans`-records refusals `cdkd
 * deploy`, `import`, `rollback`, `scrub` and `destroy` raise
 * (go-to-k/cdkd#3436's fold-in of this module's own copy): why it WITHHOLDS the
 * stack name and the region, each `undefined` when it would name it. The drop
 * command, the `cdkd state show` line and the withheld-identity clause all read
 * this ONE verdict, so no two of them can disagree about a name (go-to-k/cdkd#3363
 * review, M0 and M2).
 *
 * What the gate adds over the {@link rendersExactly} copy it replaces is two
 * refusals. The leading `-`: `--all` renders exactly and was SUBSTITUTED, and
 * Commander reads that argv entry in `cdkd state orphan`'s positional as the
 * option whatever the quoting. And a value past the cap that ENDS in `...`:
 * `safeIdentifier` marks a cut with `...`, so `'q'.repeat(1152) + '...'`
 * compared equal to its own truncation and was named in full, where the gate
 * measures the cap itself and says `too-long`. The stack name keeps
 * `STACK_REF_MAX_CODE_POINTS`; the region now takes `SHORT_NAME_MAX_CODE_POINTS`,
 * the cap its prose renders at (see `orphanRegionArg`), where the copy used
 * 1152 for both. No `plainIdent`, but the gate's DEFAULT now withholds any
 * value that would not be inert with its quotes stripped (go-to-k/cdkd#4205),
 * so `It's Legacy` is a hole here too: the go-to-k/cdkd#3359 path that named
 * such a name exactly (kept by go-to-k/cdkd#3523) is retired on purpose, since
 * a quoted name runs as shell once anything pasted before it flips the quote
 * parity, and cdkd cannot control what that is.
 */
export function orphanIdentityVerdict(
  stackName: string,
  region: string | undefined
): { readonly stack: WithholdReason | undefined; readonly region: WithholdReason | undefined } {
  const { withheld } = pasteableCommand('cdkd state orphan', [
    { value: stackName, hole: 'stack' },
    ...(region === undefined ? [] : [orphanRegionArg(region)]),
  ]);
  return {
    stack: withheld.find((w) => w.hole === 'stack')?.reason,
    region: withheld.find((w) => w.hole === 'region')?.reason,
  };
}

/**
 * The identity arguments of the orphan refusal's two commands. Each VALUE goes
 * to the gate, which holes whichever it withholds; the one thing added here is
 * that a withheld REGION makes the name a hole as well, since the pair is one
 * identity and a name beside an unreadable region may not be this record's.
 */
export function orphanIdentityArgs(stackName: string, region: string | undefined): CommandArg[] {
  if (region === undefined) return [{ value: stackName, hole: 'stack' }];
  const regionWithheld = orphanIdentityVerdict(stackName, region).region !== undefined;
  return [
    regionWithheld ? { hole: 'stack' } : { value: stackName, hole: 'stack' },
    orphanRegionArg(region),
  ];
}

/**
 * The region's argument, at the cap its PROSE renders it at: `safeRegion`
 * cuts at `SHORT_NAME_MAX_CODE_POINTS`, so a gate at the stack-ref cap would
 * name a 200-character region in full under a clause showing it cut — the
 * "borrowing a gate UPWARD" `.claude/rules/state-malformed-containers.md`
 * forbids, and what `maxCodePoints` exists for (review of go-to-k/cdkd#3973).
 */
function orphanRegionArg(region: string): CommandArg {
  return {
    flag: '--stack-region',
    value: region,
    hole: 'region',
    opts: { maxCodePoints: SHORT_NAME_MAX_CODE_POINTS },
  };
}

/**
 * Whether an identity survives {@link safeIdentifier} UNCHANGED at the
 * state-record grammar's cap, so a command or a key built from it addresses the
 * record the message is about. The cap is `STACK_REF_MAX_CODE_POINTS` — the cap
 * the prose also cuts a stack name at, never a region's 128 — because
 * `cdkd orphan` reads a PREBUILT assembly's stack name
 * unvalidated, so a manifest can carry one past 128 that is nonetheless the
 * record's real key, and truncating it names nothing — the same bound
 * `malformedDestroyResourcesRefusalMessage` uses, reached from a different
 * source.
 *
 * What it covers in the `cdkd orphan` properties refusal: the object path
 * ({@link orphanInspectClause}). Its two COMMANDS — the drop command
 * ({@link dropRecordCommand}) and the `cdkd state show` line
 * ({@link orphanInspectCommand}) — moved onto the shared gate through
 * {@link orphanIdentityVerdict} (go-to-k/cdkd#3436), which refuses everything
 * this does plus a leading `-`, a value past the cap ending in `...` (which
 * this compares equal to its own truncation) and a region of 129 to 1152
 * characters (the region's own cap is 128); a name beginning with `-` is still a real key,
 * so the object path may print it while both commands hole it. The shared {@link inspectCommand}
 * builds through the shared gate for its other callers, which offer a read
 * only: an altered, capped, empty, option-shaped or non-plain name is a quoted
 * hole there, never a sanitized spelling.
 *
 * It is NOT the module's gate for a DESTRUCTIVE remedy and must not be unified
 * with one: the three messages that offer a hole TEMPLATE are all stricter,
 * adding {@link isPasteableIdent} (go-to-k/cdkd#3516). The orphan refusal's
 * commands pass no `plainIdent`, so a name such as `Parent~Child.v2` that is
 * inert unquoted still substitutes; a name that needs quoting does not
 * (go-to-k/cdkd#4205 retired go-to-k/cdkd#3523's `It's Legacy` exception): its
 * drop command prints the hole, filled from `cdkd state list --json`.
 *
 * **The ONE spelling of the exactness test in this module** (go-to-k/cdkd#3388).
 * The two DESTROY gates measure through it too, each at the cap its own clause
 * renders at: {@link mayNameTargetWithDestructiveRemedy} passes a region's
 * `SHORT_NAME_MAX_CODE_POINTS`, and `divergentRecordRegionRefusalMessage`
 * this default for both identities. `safeStackName(x) === x` and
 * `safeRegion(x) === x` are this predicate at those two caps, so a site
 * wanting either says so here instead of re-spelling the comparison —
 * `tests/unit/state/malformed-resources-bag.test.ts` refuses a second inline
 * spelling.
 */
export function rendersExactly(
  value: string,
  maxCodePoints: number = STACK_REF_MAX_CODE_POINTS
): boolean {
  return safeIdentifier(value, maxCodePoints) === value;
}

/**
 * The remedy command a message ends ON — unless the message also offers the
 * destructive template, in which case it ends the READ's own LINE and
 * {@link dropRecordLine} is last (go-to-k/cdkd#3516) — the two DESTROY
 * refusals; the rest close their string with it, directly or through
 * {@link inspectTail}.
 */
export function inspectCommand(
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext
): string {
  return inspectGate(stackName, region, recovery).command;
}

/**
 * The sentence a caller of {@link inspectCommand} puts BEFORE its label when
 * the gate withheld a value it was handed, so the hole does not go unexplained
 * and the operator does not fill it with the spelling the prose shows (the
 * go-to-k/cdkd#3764 follow-up recorded on go-to-k/cdkd#3436). `''` when the
 * command names everything it was given, and for the no-identity template,
 * whose caller explains itself. A full sentence ending in a space, so a
 * caller writes `${inspectClause(s, r)}See the stored values with: ` and a
 * named command leaves the text byte-identical.
 *
 * Rendered from the gate's own reasons, per value. A STACK NAME beginning
 * with `-` must not be filled back in — Commander could read it in
 * `cdkd state show`'s positional as the option — so it gets no fill-in
 * instruction, keyed on the RAW `-` because the gate reports `altered` /
 * `too-long` first. The region is `--stack-region`'s VALUE, which Commander
 * takes as given, so its hole may be filled.
 */
export function inspectClause(
  stackName: string | undefined,
  region: string | undefined,
  /**
   * The caller's account flags (go-to-k/cdkd#3909). A withheld one is explained
   * after the identity sentence, and a named one makes the listing pointer say
   * to carry the same flags.
   */
  recovery?: LockRecoveryContext
): string {
  const accounts = withheldAccountClause(recovery, 'the command at the end of this line prints');
  // Subsumed, and kept for the type: `inspectGate` withholds no IDENTITY for an
  // absent name (its template arm), so the empty-`parts` return below would
  // answer the account clause alone too, but `stackName.startsWith` needs the
  // narrowing.
  if (stackName === undefined) return accounts;
  const { withheld } = inspectGate(stackName, region, recovery);
  const parts = [
    inspectWithheldPart('stack name above', withheld, 'stack', true),
    inspectWithheldPart('region above', withheld, 'region', false),
  ].filter((part) => part !== '');
  if (parts.length === 0) return accounts;
  // The command follows its label on the SAME line (`... Inspect it with:
  // cdkd state show ...`), so the sentence says "at the end of this line", not
  // "below" (M1 of the go-to-k/cdkd#4011 review).
  const holes = parts.length === 1 ? 'a quoted hole in its place' : 'quoted holes in their place';
  // The no-fill rule restates the option parse only when the stack's own
  // reason did not already say it (`altered` / `too-long` win first), m1.
  const stackReason = withheld.find((w) => w.hole === 'stack')?.reason;
  const noFill =
    (stackReason === 'option-shaped'
      ? ''
      : `A value beginning with '-' could parse as an option there, so `) +
    `do not fill the stack hole with it: repair or remove the record by hand. `;
  return (
    `The ${parts.join(', and the ')}, so the command at the end of this line prints ${holes}. ` +
    (stackName.startsWith('-')
      ? noFill.charAt(0).toUpperCase() + noFill.slice(1)
      : `Take the values from ${listingSource(accountArgs(recovery).length > 0)}, replacing ` +
        `each quoted hole in the command at the end of this line, quotes included, with ` +
        `${JSON_LISTING_HOLE_VALUE}. `) +
    accounts
  );
}

/** One value's half of {@link inspectClause}, or `''` when the gate named it. */
function inspectWithheldPart(
  what: string,
  withheld: readonly WithheldValue[],
  hole: string,
  positional: boolean
): string {
  const reason = withheld.find((w) => w.hole === hole)?.reason;
  if (reason === undefined) return '';
  switch (reason) {
    case 'altered':
      return `${what} did not render exactly`;
    // Unreachable through today's callers, which normalise `''` to absent
    // (`absentIfEmpty`) before this runs; a sentence rather than a throw
    // because this renders inside a refusal, where a throw would replace it.
    case 'empty':
      return `${what} is empty`;
    case 'too-long':
      return `${what} is too long to name in a command`;
    case 'option-shaped':
      return positional
        ? `${what} begins with a '-', which 'cdkd state show' could parse as an option`
        : `${what} begins with a '-', which cdkd refuses to print as an argument`;
    case 'not-plain':
      return (
        `${what} is not a plain identifier (a letter or digit, then letters, digits, '~', ` +
        `'_', '.' or '-'), the only shape the command at the end of this line names, since it sits beside a ` +
        `labelled line`
      );
    // Unreachable: `inspectGate` passes `plainIdent`, which answers
    // `not-plain` for every value this arm would take; a sentence rather than
    // a throw, because this renders inside a refusal.
    case 'shell-active':
      return `${what} ${SHELL_ACTIVE_WHY}`;
    // Unreachable: `inspectGate` passes no `patternMatched`.
    case 'pattern-shaped':
      throw new Error(
        `inspectWithheldPart: 'pattern-shaped' needs a gate option never passed here`
      );
    default: {
      const _exhaustive: never = reason;
      throw new Error(`inspectWithheldPart: unhandled WithholdReason ${String(_exhaustive)}`);
    }
  }
}

/** {@link inspectCommand}'s gate, returned whole so {@link inspectClause} reads the same verdict. */
function inspectGate(
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext
): { readonly command: string; readonly withheld: readonly WithheldValue[] } {
  // The caller's account flags ride LAST on both arms (go-to-k/cdkd#3909): the
  // identity may be a hole, the account never is one the operator must guess.
  const account = accountArgs(recovery);
  if (stackName === undefined) {
    // A TEMPLATE rather than a command, and it says so: substituting anything
    // here would be substituting the untrusted values the clause above drops.
    return pasteableCommand('cdkd state show', [
      { hole: 'stack' },
      { flag: '--stack-region', hole: 'region' },
      { literal: '--json' },
      ...account,
    ]);
  }
  // The SHARED gate since go-to-k/cdkd#3436's fold-in. The local form printed
  // `shellQuote(safeStackName(...))` -- the SANITIZED spelling, ungated -- so a
  // name rendering ALTERED was named rather than withheld, and the command then
  // addressed a different record than the message meant. The rule
  // `.claude/rules/state-malformed-containers.md` states for this arm is that
  // nothing here SUBSTITUTES a sanitized spelling: a value the gate refuses
  // prints as a HOLE rather than as a different name. The arm above is the
  // one deliberate TEMPLATE, taken when the caller had no name to gate — the
  // destroy refusals hand it an inexact identity that way.
  //
  // BOTH values are held to `plainIdent`: this command sits beside a labelled
  // line, the shape that rule governs, and exactness alone admits a name with
  // interior padding that spells a labelled line once the terminal wraps
  // (`Prod<60 spaces>Migrate with: cdkd destroy --all --force #`) — the
  // wrap-forge the option exists for (M2 of the go-to-k/cdkd#3764 review).
  // Real CDK names, `Parent~Child` included, pass `isPasteableIdent`.
  //
  // The region keeps ITS cap: this message displays it through `safeRegion`
  // at `SHORT_NAME_MAX_CODE_POINTS`, and a gate at the stack-name cap names a
  // 200-character region in full under a clause that renders it cut — the
  // exact "borrowing a gate UPWARD" the rule file forbids. `maxCodePoints` is
  // how the gate takes a caller's cap without the caller re-spelling the
  // comparison.
  return pasteableCommand('cdkd state show', [
    { value: stackName, hole: 'stack', opts: { plainIdent: true } },
    ...(region === undefined
      ? []
      : [
          {
            flag: '--stack-region',
            value: region,
            hole: 'region',
            opts: { plainIdent: true, maxCodePoints: SHORT_NAME_MAX_CODE_POINTS },
          },
        ]),
    { literal: '--json' },
    ...account,
  ]);
}
