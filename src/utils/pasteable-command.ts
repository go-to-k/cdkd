/**
 * The way cdkd builds a `cdkd ...` command it tells an operator to PASTE.
 *
 * DERIVE its callers rather than reading a number here — `grep -rln
 * 'pasteableCommand(' src/` is the census, and the one this sentence used to
 * carry went stale twice in one PR, most recently when a site moved to
 * `commandHole`. The CATEGORIES it does not cover yet are at the end of this
 * header — categories, not a census, for the same reason: the population is
 * what go-to-k/cdkd#3436's greps return against the tree of the day, and a
 * list here would be read as complete.
 *
 * go-to-k/cdkd#3363 measured the class this module closes, and
 * [#3436](https://github.com/go-to-k/cdkd/issues/3436) records it repo-wide.
 * Three shapes, each of which a per-site discipline kept re-introducing:
 *
 * 1. **A command inside prose quotes.** `drop it whole with '<command>'` puts
 *    the command in a `'...'` span, so an interpolated value carrying `'`
 *    CLOSES that wrapper when the span is pasted WITH its quotes and the rest
 *    runs as shell: `'cdkd state orphan S --state-bucket 'b; printf X; #''`
 *    printed `X`. Quoting the value does not help — the wrapper is what
 *    inverts. So a command is printed UNWRAPPED on its own labelled line, and
 *    this module returns the text for exactly that.
 *
 *    **UNWRAPPED always; LAST only when the message prints ONE command.** A
 *    message offering a READ and a DESTRUCTIVE template prints one command per
 *    LINE, and there the read ends a line while the TEMPLATE is last — the
 *    rule `.claude/rules/state-malformed-containers.md` states for
 *    go-to-k/cdkd#3516, and a shape this module already serves twice:
 *    `deploy-engine.ts`'s `Inspect it with:` / `Drop the record with:` pair,
 *    and `destroy-runner.ts`'s through `hintFor`. In both, the read command is
 *    correctly NOT last. Collapsing such a pair onto one line is the defect
 *    that rule names: the read must end a line, and the template must be last
 *    with no substituted value after it.
 * 2. **A bare `<placeholder>`.** `<name>` is two redirections, not a word:
 *    `<name` reads stdin from a file and `>` truncates whatever word follows.
 *    {@link commandHole} quotes it, so it pastes as one literal argument.
 * 3. **A value whose quote context the PROSE already flipped.** An English
 *    apostrophe earlier in the sentence (`this stack's name`) opens a shell
 *    quote that closes at the value's own opening quote, leaving the value
 *    bare. This module cannot reach that one — a value in prose is not a
 *    command — which is why the rule it belongs to is "a shell-quoted value
 *    goes on a labelled trailing line, never inside a sentence", and why
 *    deleting apostrophes is NOT the remedy (the next sentence re-opens it).
 *
 * What this module owns is the ARGUMENT side of shape 1 and shape 2: every
 * user-controlled value is sanitized, gated on rendering EXACTLY, and either
 * shell-quoted or replaced by a quoted hole. A value sanitizing would ALTER is
 * never printed in its altered spelling — that addresses a DIFFERENT record
 * than the message means — and never silently dropped, which would resolve the
 * ambient default instead.
 *
 * {@link shellQuote} and {@link commandHole} live here rather than in
 * `../state/lock-contention-message.js`, which still re-exports them for its
 * own callers: `src/utils/**` imports nothing from `src/state/**`, so the
 * shared helper could not reach them the other way round.
 *
 * ## The CATEGORIES not covered yet, as of go-to-k/cdkd#3436's first half
 *
 * Re-derive the members with that issue's greps rather than trusting a list:
 * these are kinds of site, and each kind has more members than the examples.
 *
 * - **Its own copy of the gate.** `buildForceUnlockCommand`
 *   (`state/lock-contention-message.ts`), the `cdkd orphan` properties refusal
 *   (`state/malformed-resources-bag.ts`), `orphanCommandFor` (`cli/commands/
 *   export.ts`), and others in `deployment/deploy-engine.ts`,
 *   `deployment/rollback-executor.ts` and `cli/commands/gc.ts`. They behave the
 *   same way; they are not this function, so a rule change reaches them only by
 *   hand.
 * - **A command in prose quotes with a RAW value**, outside the modules
 *   migrated here — `provisioning/providers/**` (Route 53, DynamoDB),
 *   `cli/config-loader.ts` and `cli/commands/orphan.ts` are where the greps land
 *   today.
 *
 * Three entries left this list in go-to-k/cdkd#3613 and saying so is the point:
 * the `cdkd drift` sites of
 * [#3307](https://github.com/go-to-k/cdkd/issues/3307) ALL build through this
 * function now and `drift.ts`'s own `stackCommandFor` is gone; the S3 Tables
 * provider's raw-value prose was fixed there too; and a bare-`<hole>` synopsis
 * is no longer uncovered, because the source fence that finds that shape
 * EXISTS — `scripts/check-pasteable-command-shapes.ts`, whose unit test is its
 * enforcement. A list of what is not yet covered goes stale the moment
 * something is, so derive it rather than reading it: the fence reports the
 * shapes, and its `EXEMPTIONS` name the sites deliberately left for a
 * follow-up PR.
 */

import {
  displaySafe,
  isPasteableIdent,
  STACK_REF_MAX_CODE_POINTS,
  truncateCodePoints,
} from './display-safe.js';

/**
 * Quote a value for a pasteable shell command.
 *
 * EXPORTED since issue [#2610]: `src/provisioning/replacement-protection-advice.ts`
 * prints `aws <service> ...` recovery commands naming a resource's physical id,
 * which is the same hazard one directory over. A second spelling of this
 * predicate is how the two would come to disagree about which values need
 * quoting -- the reason `display-safe.ts`'s header gives for not widening a
 * rule by hand. It is a pure function of its argument and imports nothing.
 */
export function shellQuote(value: string): string {
  // A profile / prefix / bucket with a space or a quote would otherwise produce
  // a suggestion that silently truncates when pasted.
  // `~` is deliberately NOT here. It was added for `Parent~Child` (every
  // nested-stack child name) when the command was still wrapped in `'...'` and
  // the two quotings composed into something unpastable. That wrapper is gone,
  // so a quoted `'Root~Child'` pastes fine and the widening bought nothing —
  // while costing tilde expansion on a value an S3 key can carry.
  return /^[A-Za-z0-9._/@:+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A placeholder for a value a pasteable command could not name, QUOTED.
 *
 * A bare `<profile>` is two shell redirections, not a word: pasted, `<profile`
 * reads stdin from a file named `profile` and `>` sends stdout to whatever
 * word follows. While the hole was the command's LAST word that was only a
 * syntax error; with flags appended after it (`--profile <profile>
 * --state-bucket b`) it ran the command with `--state-bucket` swallowed as a
 * redirect target and `b` as the profile — a delete against the ambient
 * bucket, with nothing printed (measured by the maintainer, M4 of the
 * go-to-k/cdkd#3363 review). Quoted, it pastes as one literal argument and
 * nothing else — no redirection, no swallowed flag. It is not refused: an
 * UNFILLED hole runs as that literal value (a stack named `<stack>`, a prefix
 * `<prefix>`).
 */
export function commandHole(name: string): string {
  return `'<${name}>'`;
}

/** One argument of a pasteable command. */
export type CommandArg =
  /**
   * A word the CODE chose — a subcommand, a flag with no value, a literal
   * cdkd itself spells (`--all`, `--json`). It is passed through untouched,
   * so nothing user-controlled may arrive this way. Nothing enforces that
   * today: the source fence is the follow-up half of
   * [#3436](https://github.com/go-to-k/cdkd/issues/3436).
   */
  | { literal: string }
  /**
   * A user-controlled positional value, with the name its hole takes when it
   * cannot be printed as itself.
   */
  | { value: string; hole: string; opts?: ValueGateOptions }
  /**
   * A flag and its user-controlled value, kept as a PAIR so the flag can never
   * survive its value: dropping `--stack-region`'s value while keeping the
   * flag would make the command address every region holding the name.
   */
  | { flag: string; value: string; hole: string; opts?: ValueGateOptions }
  /** A placeholder for a value the caller never had. */
  | { hole: string }
  /**
   * A flag whose value the caller never had — `--asset-bucket '<name>'`. The
   * pair is what makes the hole safe: a bare `<name>` after a flag is the
   * redirection shape {@link commandHole} exists to close.
   */
  | { flag: string; hole: string };

/** Per-value gates beyond "renders exactly". */
export interface ValueGateOptions {
  /**
   * True when the command matches its argument as a PATTERN
   * (`src/cli/stack-matcher.ts`), where `*` is a wildcard and `/` selects by
   * display path — so a value carrying either addresses stacks the message
   * never named.
   */
  readonly patternMatched?: boolean;
  /**
   * True when the command sits BESIDE a labelled line — the shape
   * `.claude/rules/state-malformed-containers.md` (go-to-k/cdkd#3328) governs —
   * so the value is ALSO held to `isPasteableIdent`, and refused as
   * `'not-plain'` when that predicate refuses it. Exactness keeps a space and
   * a `:`, so `Prod<60 spaces>Migrate with: cdkd destroy --all --force #`
   * passes every other arm and is NAMED, shell-quoted; once the terminal wraps
   * that quoted argument, a screen row reads `Migrate with: cdkd destroy --all
   * --force #'`, and the `#` comments out the stray quote — measured by the
   * maintainer (M17 of the go-to-k/cdkd#3613 review): `bash -c "echo cdkd
   * destroy --all --force #'"` prints the command at rc=0. The identity line
   * beside such a command already took the rule; this is the command's half,
   * so ONE predicate decides both lines.
   */
  readonly plainIdent?: boolean;
}

/**
 * Why {@link pasteableCommand} would not name a value.
 *
 * Returned rather than kept private because the SENTENCE around a command has
 * to say why the command names a hole, and a site that derives that from its
 * own predicate derives a DIFFERENT set. Measured on go-to-k/cdkd#3499's round
 * 4, where a site compared `displayIdent(name) === name` while the command
 * gated on this one: `Old;Stack` got a "does not render exactly" clause above a
 * command that named it exactly, and `--all` — which `PLAIN_IDENT` admits —
 * rendered bare and authoritative above an unexplained hole, inviting the
 * operator to type the name that deploys every stack in the app.
 *
 * One predicate, one reason, one sentence.
 */
export type WithholdReason =
  /** Sanitizing would change it: the altered spelling addresses a DIFFERENT record. */
  | 'altered'
  /** Empty: an empty argument is not "not supplied" to every reader. */
  | 'empty'
  /** Past `STACK_REF_MAX_CODE_POINTS`. */
  | 'too-long'
  /**
   * A leading `-`, refused CONSERVATIVELY rather than by parsing. `--all` and
   * `-x` are options to Commander whatever the shell quoting — quoting only
   * stops the shell, not the argument parser — while a BARE `-` it takes
   * positionally (measured). The gate does not distinguish them: the reason
   * a caller renders from this must therefore name the leading `-`, not
   * assert that every such value parses as a flag.
   */
  | 'option-shaped'
  /** `*` or `/` where the command matches PATTERNS rather than names. */
  | 'pattern-shaped'
  /**
   * Refused by `isPasteableIdent` under `plainIdent`, where the command sits
   * beside a labelled line. LAST in the order on purpose: the predicate is
   * strictly stronger than every other arm, so placed earlier it would take
   * their sentences and say "not a plain identifier" of `--all`, which has a
   * more specific true reason.
   */
  | 'not-plain';

/** One value the command could not name, and why. */
export interface WithheldValue {
  /** The hole printed in its place. */
  readonly hole: string;
  readonly reason: WithholdReason;
}

/** What {@link pasteableCommand} returns. */
export interface PasteableCommand {
  /**
   * The command, ready to print UNWRAPPED on a labelled line of its own. Never
   * put it back inside quotes — that is the shape this module exists to close.
   *
   * LAST is a property of the MESSAGE, not of this string. A message printing
   * one command prints it last; a message offering a read AND a destructive
   * template gives each its own line and ends on the TEMPLATE, so the READ is
   * legitimately not last (go-to-k/cdkd#3516, and M17 of go-to-k/cdkd#3499's
   * review — this JSDoc is what a caller building the `Inspect it with:` line
   * reads, and telling them LAST there is the wrong ordering).
   */
  readonly command: string;
  /**
   * Every value this command REFUSED, with the reason — the input a caller's
   * sentence is built from, so the sentence cannot be keyed on a different
   * predicate than the hole (M11 of the go-to-k/cdkd#3499 review).
   *
   * Only refusals. An argument the caller supplied as a bare `hole` carries no
   * value to judge, so it prints a hole and sets `exact` false while adding
   * nothing here — an empty `withheld` under `exact: false` means "the caller
   * asked for a placeholder", not "nothing was withheld".
   */
  readonly withheld: readonly WithheldValue[];
  /**
   * False when any user-controlled value printed as a HOLE rather than as
   * itself, and also when the caller asked for one — see `withheld` for the
   * narrower question of what the GATE refused.
   *
   * **Every caller in `src/` prints the hole.** The field exists for the
   * SENTENCE around it — a message that wants to say why it could not name the
   * record — not as a licence to suppress the command at one site and print it
   * at another. Per-site judgement about what is safe *here* is what kept
   * re-introducing this defect (M5 of the go-to-k/cdkd#3499 review), and the
   * fold-in of the older builders should land on that answer rather than
   * re-open the choice. The two older builders that
   * made that choice by hand — `buildForceUnlockCommand` and the `cdkd orphan`
   * properties refusal in `state/malformed-resources-bag.ts` — still carry
   * their own copies of this logic and do NOT consume this field yet; folding
   * them in is part of go-to-k/cdkd#3436's remaining half.
   */
  readonly exact: boolean;
}

/**
 * True when `value` reaches the terminal as itself — sanitizing changes
 * nothing, the cap does not cut it, and it is not empty.
 *
 * The comparison is against the RAW value, not against a second sanitizing
 * pass: `displaySafe` is idempotent, so comparing two sanitized spellings
 * would be satisfied by every input and the gate would pass vacuously.
 */
export function rendersExactly(value: string): boolean {
  const reason = withholdReason(value, undefined);
  return reason === undefined || reason === 'option-shaped';
}

/**
 * WHY a value must become a hole, or `undefined` when it may be NAMED.
 *
 * FIRST MATCH WINS, in the order written: `empty`, `altered`, `too-long`,
 * `option-shaped`, `pattern-shaped`, `not-plain` (m21 of the go-to-k/cdkd#3499
 * review; the sixth is M17 of go-to-k/cdkd#3613's, and sits last because it
 * subsumes the other five — see its member note). A
 * value can satisfy several — `-\u001b[x` is both option-shaped and altered —
 * and the caller renders ONE sentence, so the order decides which. It runs
 * cheapest-and-most-fundamental first: a value that does not survive rendering
 * cannot be reasoned about as a command argument at all, so saying "this would
 * be read as an option" about a spelling that is not what is stored would be
 * the more misleading of the two true sentences. The order is also the order
 * the two functions this replaced already applied, which is what keeps the
 * refactor behaviour-preserving.
 */
function withholdReason(
  value: string,
  opts: ValueGateOptions | undefined
): WithholdReason | undefined {
  if (value === '') return 'empty';
  const safe = displaySafe(value, { asciiOnly: true });
  if (safe !== value) return 'altered';
  if (truncateCodePoints(safe, STACK_REF_MAX_CODE_POINTS).truncated) return 'too-long';
  // See `WithholdReason`'s `'option-shaped'` member for why this refuses on the
  // LEADING `-` rather than on whether the value parses as an option. In short:
  // `--all` does parse as the flag — quoting stops the shell, not Commander,
  // which sees the same argv entry either way — while a bare `-` Commander
  // takes positionally, and this refuses it anyway.
  if (value.startsWith('-')) return 'option-shaped';
  if (opts?.patternMatched === true && (value.includes('*') || value.includes('/'))) {
    return 'pattern-shaped';
  }
  if (opts?.plainIdent === true && !isPasteableIdent(value)) return 'not-plain';
  return undefined;
}

/**
 * Build a pasteable `cdkd` command: every user-controlled value shell-quoted
 * behind an exactness gate, every placeholder quoted, nothing wrapped.
 *
 * `extraFlags` is where a caller appends the flags that pin the command to its
 * own account and key space — in practice `recoveryCommandFlags(recovery)`,
 * whose `exact` the caller folds into its own decision. They are appended
 * verbatim, LAST, because they are built by the same rules one layer up.
 */
export function pasteableCommand(
  verb: string,
  args: readonly CommandArg[] = [],
  extraFlags: readonly string[] = []
): PasteableCommand {
  let exact = true;
  const withheld: WithheldValue[] = [];
  const parts: string[] = [verb];
  for (const arg of args) {
    if ('literal' in arg) {
      parts.push(arg.literal);
      continue;
    }
    if (!('value' in arg)) {
      if ('flag' in arg) parts.push(arg.flag);
      parts.push(commandHole(arg.hole));
      exact = false;
      continue;
    }
    const reason = withholdReason(arg.value, arg.opts);
    let rendered: string;
    if (reason === undefined) {
      rendered = shellQuote(arg.value);
    } else {
      rendered = commandHole(arg.hole);
      exact = false;
      withheld.push({ hole: arg.hole, reason });
    }
    if ('flag' in arg) parts.push(arg.flag);
    parts.push(rendered);
  }
  parts.push(...extraFlags);
  return { command: parts.join(' '), exact, withheld };
}

/**
 * The sentence for a name `pasteableCommand` would not print, rendered from the
 * REASON it gave rather than from a predicate of this site's own — M11 of the
 * go-to-k/cdkd#3499 review. Keying it on a second predicate got both directions
 * wrong at once: `Old;Stack` renders exactly, so a rendering-based clause called
 * a command that names it "not exact", and `--all` also renders exactly, so the
 * same clause said nothing above a hole the operator was then invited to fill
 * with the name printed beside it.
 *
 * SCOPE: the sentence is about a STATE RECORD's name — it opens "This record's
 * name" and ends by pointing at `cdkd state list --long` — so it fits a caller
 * whose value is a state-key stack segment and nothing else. Both live callers
 * are exactly that (the two legacy-key migrate refusals); a caller naming
 * anything else needs its own sentence, not this one with a different verb.
 *
 * WHICH reasons are reachable is the CALLER's question, not this function's,
 * and every arm is answered here because the gate can return any of them. For
 * a name that comes from an S3 key segment — `state refresh-observed`'s legacy
 * refusal and `drift`'s — four of the six are reachable and two are bounded
 * out by the key itself:
 *
 * - `altered`, `option-shaped` and `pattern-shaped` are all reachable: a
 *   planted key can spell a name any of those ways in a handful of bytes.
 * - `not-plain` is reachable only from a caller passing `plainIdent` —
 *   `drift`'s site does (M17 of the go-to-k/cdkd#3613 review), `state.ts`'s
 *   three do not yet (go-to-k/cdkd#3696) — and there it is the reason for
 *   every name the five arms above admit but `isPasteableIdent` refuses:
 *   `$(printf INJECTED)`, or a padded name spelling a labelled line.
 * - `empty` is not. `listStacks` drops a key whose stack segment is empty
 *   (`s3-state-backend.ts`'s `if (!stackName) continue`), so `target.stackName`
 *   is non-empty by the time the refusal is built.
 * - `too-long` is not either, and the bound is not obvious: the cap is
 *   `STACK_REF_MAX_CODE_POINTS` (1152), while S3 caps the WHOLE key at 1024
 *   bytes, leaving at most 1008 for the name inside `cdkd/<name>/state.json`.
 *   A multi-byte character only lowers the code-point count further, so a name
 *   arriving through `listStacks` can never reach the cap.
 *
 * Both unreachable arms stay, and are covered, because the REASON is the
 * gate's and not this site's: `pasteableCommand` can return either to a caller
 * whose value comes from somewhere else. A missing arm is no longer a silent
 * fall-through — the `switch` below is exhaustive over `WithholdReason`, so
 * dropping one is a compile error (M13). What the cases buy on top of that is
 * the SENTENCE: the type checker knows an arm exists, not that it says the
 * right thing, and substituting one arm's text for another's is exactly the
 * disagreement M11 closed.
 */
export function withheldTargetClause(
  built: PasteableCommand,
  hole: string,
  /**
   * The verb the two shape-specific arms name — `'cdkd deploy'` at the legacy
   * region-less refusals, `'cdkd destroy'` at `state orphan`'s warning
   * (go-to-k/cdkd#3696). A PARAMETER since M13 of the go-to-k/cdkd#3613
   * review: a hardcoded verb would name the wrong command at any caller
   * building a different one, silently, with the message still well-formed.
   */
  verb: string
): string {
  // Keyed on the hole NAME the caller passes, which couples the two (m22 of
  // the go-to-k/cdkd#3499 review). Renaming the hole at the call site would
  // drop this sentence while the hole itself still printed — silently, since
  // the message stays well-formed. Taking the name as an ARGUMENT is what
  // keeps the two spellings from drifting apart across MODULES, now that two
  // files render this clause. `state-refresh-observed.test.ts` pins the
  // PAIRING per REASON — not per case: each of the five reasons that site
  // can return has at least one case asserting both the hole in the command
  // and the sentence about it, so a lookup that stopped matching cannot leave
  // the suite green; `drift.test.ts` pins the sixth, `not-plain`, which only
  // a `plainIdent` caller reaches. (The hostile-name loop asserts the hole
  // alone; it is about the gate, not about the sentence.)
  const reason = built.withheld.find((w) => w.hole === hole)?.reason;
  if (reason === undefined) return '';
  // A `switch` with a `never` default, not a ternary chain with a catch-all
  // (M13 of the go-to-k/cdkd#3499 review). A sixth `WithholdReason` member
  // typechecks fine against a catch-all and then silently renders whatever
  // sentence the catch-all holds — the header above used to describe that as
  // a hazard it had identified and left undefended. Here it is a COMPILE
  // error, which is the enforcement this change is about: the reason comes
  // from one predicate, and every reason that predicate can return has to be
  // answered on purpose.
  let why: string;
  switch (reason) {
    case 'altered':
      why = `does NOT render exactly, so another record may render identically`;
      break;
    case 'empty':
      why = `is empty`;
      break;
    case 'too-long':
      why = `is too long to print`;
      break;
    case 'option-shaped':
      why =
        `begins with a '-', so it is not safe to print as an argument to '${verb}' — a ` +
        `name like '--all' is parsed as the FLAG and targets every stack`;
      break;
    case 'pattern-shaped':
      why = `would be read as a PATTERN by '${verb}', which can match other stacks`;
      break;
    case 'not-plain':
      // The clause names the SHAPE the operator can check by eye, because the
      // command line beside it shows a hole and nothing else: no line of this
      // message prints the name, so the sentence is the only place the reader
      // learns what disqualified it. It states the RULE and why the rule
      // exists, not a hazard of this value (M22 of the go-to-k/cdkd#3613
      // review): a padded name can wrap into a labelled line and `$(...)` can
      // run, but `_x` reaches this arm too and does neither, and a reason
      // that is true of only part of the population misleads the rest.
      why =
        `is not a plain identifier (a letter or digit, then letters, digits, '~', '_', '.' ` +
        `or '-'), the only shape named in a command here, since a name outside it can run as ` +
        `shell or read as a line of this message once the terminal wraps`;
      break;
    default: {
      // `throw`, not `return _exhaustive` (m25 of the go-to-k/cdkd#3499
      // review). TypeScript proves this is unreachable, and the assignment is
      // what proves it — but a sixth reason arriving from JS or through a cast
      // would have spliced the raw token in as the WHOLE clause, so the one
      // path that can only be reached when the type system was bypassed would
      // have failed by printing something plausible. It fails loudly instead.
      const _exhaustive: never = reason;
      throw new Error(`withheldTargetClause: unhandled WithholdReason ${String(_exhaustive)}`);
    }
  }
  return (
    ` This record's name ${why} — so it is not named in the command below; ` +
    `list the records as stored with 'cdkd state list --long' and act on the one whose key ` +
    `matches.`
  );
}
