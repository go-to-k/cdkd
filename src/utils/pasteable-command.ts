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

/** What {@link pasteableCommand} returns. */
export interface PasteableCommand {
  /**
   * The command, ready to print LAST and UNWRAPPED on a labelled line. Never
   * put it back inside quotes — that is the shape this module exists to close.
   */
  readonly command: string;
  /**
   * False when any user-controlled value printed as a HOLE rather than as
   * itself. What to do with an inexact command is the caller's call, and both
   * answers are legitimate: suppress the line entirely, or print the template
   * so the operator knows which shape to fill in. The two older builders that
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
  if (value === '') return false;
  const safe = displaySafe(value, { asciiOnly: true });
  if (safe !== value) return false;
  return !truncateCodePoints(safe, STACK_REF_MAX_CODE_POINTS).truncated;
}

/** Whether a value may be NAMED in a command, or must become a hole. */
function printable(value: string, opts: ValueGateOptions | undefined): boolean {
  if (!rendersExactly(value)) return false;
  // A leading `-` is an OPTION to every cdkd command: a state key named
  // `--all` survives sanitizing, the cap and quoting, and then addresses every
  // stack. Quoting does not save it — the shell passes `'--all'` through as
  // the same argv entry Commander then parses as a flag.
  if (value.startsWith('-')) return false;
  if (opts?.patternMatched === true && (value.includes('*') || value.includes('/'))) return false;
  return true;
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
    let rendered: string;
    if (printable(arg.value, arg.opts)) {
      rendered = shellQuote(arg.value);
    } else {
      rendered = commandHole(arg.hole);
      exact = false;
    }
    if ('flag' in arg) parts.push(arg.flag);
    parts.push(rendered);
  }
  parts.push(...extraFlags);
  return { command: parts.join(' '), exact };
}
