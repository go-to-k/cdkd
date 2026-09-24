/**
 * The way cdkd builds a `cdkd ...` command it tells an operator to PASTE.
 *
 * Thirteen message modules route through it today. The CATEGORIES it does not
 * cover yet are at the end of this header — categories, not a census: the
 * population is what go-to-k/cdkd#3436's greps return against the tree of the
 * day, and a list here would be read as complete and go stale.
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
 *    inverts. So a command is printed LAST and UNWRAPPED on its own labelled
 *    line, and this module returns the text for exactly that.
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
 *   migrated here — `provisioning/providers/**` (S3 Tables, Route 53, DynamoDB),
 *   `cli/config-loader.ts` and `cli/commands/orphan.ts` are where the greps land
 *   today.
 * - **The `cdkd drift` sites of
 *   [#3307](https://github.com/go-to-k/cdkd/issues/3307)**, which take their own
 *   gate in that PR. Note a `cdkd drift` command also appears OUTSIDE that file.
 * - **A spelled-out template or usage synopsis printing a BARE `<hole>`**, and
 *   the source fence that would find them.
 */

import { displaySafe, STACK_REF_MAX_CODE_POINTS, truncateCodePoints } from './display-safe.js';

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
  | 'pattern-shaped';

/** One value the command could not name, and why. */
export interface WithheldValue {
  /** The hole printed in its place. */
  readonly hole: string;
  readonly reason: WithholdReason;
}

/** What {@link pasteableCommand} returns. */
export interface PasteableCommand {
  /**
   * The command, ready to print LAST and UNWRAPPED on a labelled line. Never
   * put it back inside quotes — that is the shape this module exists to close.
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
 * `option-shaped`, `pattern-shaped` (m21 of the go-to-k/cdkd#3499 review). A
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
