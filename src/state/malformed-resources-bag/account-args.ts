/**
 * The account flags (`--profile` / `--state-bucket` / `--state-prefix`) and the record listing pointers a pasteable command carries.
 *
 * Part of `src/state/malformed-resources-bag.ts`, which re-exports every public name here.
 */
import { isPasteableIdent } from '../../utils/display-safe.js';
import {
  pasteableCommand,
  type CommandArg,
  type WithheldValue,
  SHELL_ACTIVE_WHY,
  type WithholdReason,
} from '../../utils/pasteable-command.js';
import type { LockRecoveryContext } from '../lock-contention-message.js';
import { DEFAULT_STATE_PREFIX } from '../state-prefix.js';

/**
 * The destructive template, in the three messages that offer one.
 *
 * ONE spelling, because copies are what drift, and they carry it byte-identically
 * on purpose — a reader who has met one must recognise the others. Two wrap it
 * in {@link dropRecordLine}'s label; `divergentRecordRegionRefusalMessage`
 * ends on it bare. The two holes are LITERAL: nothing may substitute them, for
 * the reason {@link malformedDestroyResourcesRefusalMessage}'s note gives.
 *
 * They are {@link commandHole}'s QUOTED form rather than a bare `<stack>`, and
 * the difference is not cosmetic. A bare `<name>` is two shell redirections:
 * pasted, `<stack` reads stdin from a file and the `>` takes the NEXT WORD as
 * an output target and CREATES it. The bare spelling this template once had was
 * inert only because it ended on its second hole, so the trailing `>` faced the
 * newline and bash refused the line — a property of where the command happened
 * to stop, not a decision anyone made, and it would have gone away the moment a
 * flag was appended. That is how go-to-k/cdkd#3363 met this shape (M4 of its
 * review). The quoted form redirects nothing, whatever follows it. Measured on
 * go-to-k/cdkd#3436: the quoted form passes both holes through as literal
 * argv (`ARGV: state orphan <stack> --stack-region <region>`).
 *
 * The caller's account flags follow the holes ({@link accountArgs},
 * go-to-k/cdkd#3909): the identity is the hole, not the account, and an
 * operator who fills only the holes would otherwise delete from the DEFAULT
 * profile's bucket — the reason {@link dropRecordCommand} carries them too.
 */
export function dropRecordTemplate(recovery: LockRecoveryContext | undefined): string {
  return pasteableCommand('cdkd state orphan', [
    { hole: 'stack' },
    { flag: '--stack-region', hole: 'region' },
    ...accountArgs(recovery),
  ]).command;
}

/**
 * The same template as a LABELLED line, for the two messages that carry their
 * commands one per line. The COMMAND is the atom rather than the line, because
 * the command is what drifts: `divergentRecordRegionRefusalMessage` ends on it
 * with no label, so THIS PAIR cannot half-land a `--stack-region` rename.
 * {@link dropRecordCommand} still spells it separately for the `cdkd orphan`
 * messages, which substitute into it — that one is not covered here.
 */
export function dropRecordLine(recovery: LockRecoveryContext | undefined): string {
  return `Drop the record: ${dropRecordTemplate(recovery)}`;
}

/**
 * What fills a hole from a `cdkd state list --json` value, completing "with "
 * (go-to-k/cdkd#3908). That listing is JSON, not raw text: `JSON.stringify`
 * escapes `"` and `\`, and `stringifyJsonPayload` escapes the control, format
 * and separator class as `\uXXXX` (go-to-k/cdkd#3163) — the very names the
 * withhold arms exist for. Shell-quoting the value as printed quotes the
 * ESCAPE, which names a different, nonexistent record, so the value is decoded
 * first. What the pointer relies on is that the listing DECODES back to the
 * stored name — padding and all — which is the machine contract #3163 chose
 * over replacing characters, and which `tests/unit/cli/state-list.test.ts`
 * pins. Exported so `cdkd export`'s own holes say the same thing.
 */
export const JSON_LISTING_HOLE_VALUE = 'the value decoded from its JSON string, then shell-quoted';

/**
 * Where a withheld identity is taken from, and why there: `cdkd state list
 * --json` prints each name JSON-encoded but never trimmed or sanitized. ONE
 * spelling, shared by {@link WITHHELD_LISTING_POINTER} and
 * {@link inspectClause}, so the two cannot drift (M3 of the go-to-k/cdkd#4011
 * review).
 */
const LISTING_SOURCE_TAIL =
  `which prints each name as a JSON string, escaped but never trimmed or sanitized, and act ` +
  `on the one whose stackName and region match (a legacy record that names no region lists it as null)`;
const LISTING_SOURCE = `'cdkd state list --json', ${LISTING_SOURCE_TAIL}`;

/**
 * {@link LISTING_SOURCE} for a caller whose command carries account flags
 * (go-to-k/cdkd#3909). The listing is still NAMED in prose, never printed with
 * a value in it — a value inside English is only as safe as the apostrophes
 * before it — so it says to run it with the flags the command beside it
 * carries, which a pasted `cdkd state list --json` would otherwise drop,
 * listing the DEFAULT profile's bucket instead of the one this run read.
 */
export function listingSource(flagged: boolean): string {
  return flagged
    ? `'cdkd state list --json' run with the same account flags as the command at the end of ` +
        `this line, ${LISTING_SOURCE_TAIL}`
    : LISTING_SOURCE;
}

/**
 * Where the three DESTROY withhold arms send the reader for the exact name
 * (go-to-k/cdkd#3420): {@link malformedDestroyResourcesRefusalMessage},
 * {@link malformedDestroyOrphansRefusalMessage} and
 * {@link divergentRecordRegionRefusalMessage}. Completes "List the records
 * with ".
 *
 * `--json`, never `--long`: each arm is reached exactly when the identity did
 * NOT render exactly, and `--long` renders through `displayIdent`, which TRIMS
 * — `'prod-api '` lists as `"prod-api"`, a healthy sibling's name, so the
 * pointer would hand back the very spelling the gate refused. `--json` keeps
 * the padding, the reason {@link withheldIdentityClause} gives for the same
 * pointer — but it is JSON, so the value is decoded before it is shell-quoted
 * ({@link JSON_LISTING_HOLE_VALUE}). The hole remedy is
 * that clause's too, deliberately NOT "shell-quote it": the command below each
 * arm already prints the hole quoted (`'<stack>'`), and shell-quoting INSIDE
 * those quotes splits a padded name into two words aimed at a different record
 * (go-to-k/cdkd#3363).
 *
 * With a `LockRecoveryContext` carrying any account flag the listing is no
 * longer named in prose but printed as its own `Find the exact name:` line
 * ({@link withheldListingPointer}), carrying the same flags as the `Inspect`
 * command beside it, so both read the bucket the refusing run read
 * (go-to-k/cdkd#3909). Without one, this text is unchanged and neither command
 * carries a flag, so the two still agree.
 */
export const WITHHELD_LISTING_POINTER =
  `${LISTING_SOURCE}, filling the Inspect command's holes from it — replacing each quoted ` +
  `hole, quotes included, with ${JSON_LISTING_HOLE_VALUE}`;

/**
 * {@link WITHHELD_LISTING_POINTER}, or — when `recovery` carries an account flag —
 * the same sentence pointing at the `Find the exact name:` line below, plus
 * that line. `line` is `undefined` exactly when the pointer is the prose form.
 */
export function withheldListingPointer(recovery: LockRecoveryContext | undefined): {
  readonly pointer: string;
  readonly line: string | undefined;
} {
  const args = accountArgs(recovery);
  if (args.length === 0) return { pointer: WITHHELD_LISTING_POINTER, line: undefined };
  return {
    pointer:
      `the 'Find the exact name' command below, ${LISTING_SOURCE_TAIL}, filling the Inspect ` +
      `command's holes from it — replacing each quoted hole, quotes included, with ` +
      JSON_LISTING_HOLE_VALUE,
    line: `Find the exact name: ${pasteableCommand('cdkd state list', [{ literal: '--json' }, ...args]).command}`,
  };
}

/**
 * The flags that pin a command this module prints to the caller's account and
 * key space — `--profile`, the resolved `--state-bucket`, a NON-default
 * `--state-prefix` — as arguments to the SHARED gate (go-to-k/cdkd#3909). The
 * emit rules are `recoveryCommandFlags`': an empty profile or bucket is
 * omitted, the default prefix is omitted, and an EMPTY prefix is printed as
 * `--state-prefix ''`, since it selects a different key space.
 *
 * STRICTER than `recoveryCommandFlags`, on purpose: every value is held to
 * `plainIdent`, because each command it serves sits beside a labelled line —
 * the shape `.claude/rules/state-malformed-containers.md` governs — and
 * exactness alone keeps a space and a `:`, so a profile spelling
 * `Drop the record: ...` would print, quoted, where a terminal wrap starts a
 * visual line with it. A refused value prints as a quoted hole and is
 * DESCRIBED by {@link withheldAccountClause}, never echoed. Every command in
 * this module qualifies through it, the `cdkd orphan` refusals' included, and
 * so do the state commands other modules print (go-to-k/cdkd#4648), exported
 * for them with that clause; `recoveryCommandFlags` stays with
 * `cdkd force-unlock`'s hint, which suppresses its whole command instead.
 */
export function accountArgs(recovery: LockRecoveryContext | undefined): CommandArg[] {
  if (recovery === undefined) return [];
  const args: CommandArg[] = [];
  if (recovery.profile) {
    args.push({
      flag: '--profile',
      value: recovery.profile,
      hole: 'profile',
      opts: { plainIdent: true },
    });
  }
  if (recovery.stateBucket) {
    args.push({
      flag: '--state-bucket',
      value: recovery.stateBucket,
      hole: 'bucket',
      opts: { plainIdent: true },
    });
  }
  const prefix = recovery.statePrefix;
  if (prefix !== undefined && prefix !== DEFAULT_STATE_PREFIX) {
    args.push(
      prefix === ''
        ? { literal: `--state-prefix ''` }
        : { flag: '--state-prefix', value: prefix, hole: 'prefix', opts: prefixGate(prefix) }
    );
  }
  return args;
}

/**
 * The PREFIX is held per `/`-separated SEGMENT, not whole-value
 * (go-to-k/cdkd#4159 review m1): an S3 prefix legitimately spells `team/dev`,
 * which whole-value `plainIdent` holed — and since the flag is then present,
 * `pasteableCommand`'s run-context flags (#4177) skip the typed value too. The
 * same per-segment rule the legacy `Object key:` line applies
 * ({@link orphanInspectClause}). A prefix whose every segment passes
 * `isPasteableIdent` takes the default gate (still refusing a leading `-` and
 * anything not inert unquoted); any other keeps `plainIdent`, so it holes and is
 * described as before.
 */
function prefixGate(prefix: string): { plainIdent?: true } {
  return prefix.split('/').every((seg) => isPasteableIdent(seg)) ? {} : { plainIdent: true };
}

/** The flag each {@link accountArgs} hole stands in for. */
const ACCOUNT_FLAG_BY_HOLE: Readonly<Record<string, string>> = {
  profile: '--profile',
  bucket: '--state-bucket',
  prefix: '--state-prefix',
};

/**
 * The sentence explaining an account hole {@link accountArgs} printed, or `''`
 * when it withheld none. It names the FLAG and the gate's REASON and never the
 * value, which the operator already holds — it is their own argv — so no
 * listing would help and the value is not repeated here (go-to-k/cdkd#3909).
 * `where` is the subject and verb of the command(s) the hole is printed in.
 * Takes the context rather than the gate's verdicts so a held prefix's reason
 * can say whether it is about a `/`-separated part ({@link prefixGate}).
 */
export function withheldAccountClause(
  recovery: LockRecoveryContext | undefined,
  where: string
): string {
  const slashPrefix = recovery?.statePrefix?.includes('/') === true;
  const parts = withheldAccountValues(recovery)
    .filter((w) => ACCOUNT_FLAG_BY_HOLE[w.hole] !== undefined)
    .map(
      (w) =>
        `the '${ACCOUNT_FLAG_BY_HOLE[w.hole]}' value this run was given ${
          w.hole === 'prefix' && w.reason === 'not-plain' && slashPrefix
            ? PREFIX_NOT_PLAIN_WHY
            : accountReason(w.reason)
        }`
    );
  if (parts.length === 0) return '';
  const sentence = parts.join(', and ');
  const holes = parts.length === 1 ? 'a quoted hole in its place' : 'quoted holes in their place';
  return (
    `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}, so ${where} ${holes}: replace ` +
    `each such hole whole, quotes included, with the shell-quoted value you passed this run. `
  );
}

/**
 * A SLASH prefix's `not-plain` reason: it is gated per segment
 * ({@link prefixGate}). A prefix with no `/` keeps the ordinary sentence.
 */
const PREFIX_NOT_PLAIN_WHY =
  `has a '/'-separated part that is not a plain identifier (a letter or digit, then letters, ` +
  `digits, '~', '_', '.' or '-'), the only shape printed in a command beside a labelled line`;

/** Why {@link accountArgs} withheld a value, for {@link withheldAccountClause}. */
function accountReason(reason: WithholdReason): string {
  switch (reason) {
    case 'altered':
      return 'does not render exactly';
    // Unreachable: `accountArgs` omits an empty profile and bucket and prints
    // an empty prefix as a literal. A sentence rather than a throw, because this
    // renders inside a refusal, where a throw would replace it.
    case 'empty':
      return 'is empty';
    case 'too-long':
      return 'is too long to print';
    case 'option-shaped':
      return `begins with a '-', which cdkd refuses to print as an argument`;
    // Unreachable: `accountArgs` passes no `patternMatched`.
    case 'pattern-shaped':
      return 'would be read as a pattern';
    // Unreachable: `accountArgs` passes `plainIdent`, which answers `not-plain`
    // for every value this arm would take. A sentence rather than a throw, for
    // the reason the `empty` arm gives.
    case 'shell-active':
      return SHELL_ACTIVE_WHY;
    case 'not-plain':
      return (
        `is not a plain identifier (a letter or digit, then letters, digits, '~', '_', '.' or ` +
        `'-'), the only shape printed in a command beside a labelled line`
      );
    default: {
      const _exhaustive: never = reason;
      throw new Error(`accountReason: unhandled WithholdReason ${String(_exhaustive)}`);
    }
  }
}

/** The holes {@link accountArgs} would print for `recovery`, with the gate's reasons. */
function withheldAccountValues(
  recovery: LockRecoveryContext | undefined
): readonly WithheldValue[] {
  return pasteableCommand('cdkd', accountArgs(recovery)).withheld;
}

/**
 * How the two DESTROY refusals' EXACT arm names the key-confirming listing:
 * the fixed `'cdkd state list --long'`, told to carry the account flags the
 * command lines below carry when there are any (go-to-k/cdkd#3909). Named in
 * prose rather than printed as a line — this arm's own lines are the read and
 * the destructive template, and a third command would not be the one the
 * sentence is about.
 */
export function confirmKeyListing(recovery: LockRecoveryContext | undefined): string {
  return accountArgs(recovery).length === 0
    ? `'cdkd state list --long'`
    : `'cdkd state list --long' run with the same account flags as the command lines below`;
}

/**
 * {@link withheldAccountClause} for the two per-line DESTROY refusals, with the
 * leading space that joins it to the prose; `''` when nothing was withheld.
 */
export function destroyAccountClause(recovery: LockRecoveryContext | undefined): string {
  const clause = withheldAccountClause(recovery, 'the command lines below print');
  return clause === '' ? '' : ` ${clause.trimEnd()}`;
}
