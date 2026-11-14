import {
  cdkdRemedy,
  pasteableCommand,
  proseQuoted,
  type CommandArg,
  type PasteableCommand,
  SHELL_ACTIVE_WHY,
  isInertUnquoted,
  type WithholdReason,
} from '../../../utils/pasteable-command.js';
import {
  STACK_REF_MAX_CODE_POINTS,
  cutMarker,
  displayIdent,
  displaySafe,
  truncateCodePoints,
} from '../../../utils/display-safe.js';
import { UNRENDERABLE } from '../../../state/lock-contention-message.js';
import {
  JSON_LISTING_HOLE_VALUE,
  accountArgs,
  withheldAccountClause,
} from '../../../state/malformed-resources-bag.js';
import { type LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { type StackState } from '../../../types/state.js';

/**
 * Recursive tree of cdkd-state stacks rooted at a parent. Mirror of
 * `CfnStackResourceTree` (in `retire-cfn-stack.ts`) for the cdkd-state
 * side: each node carries `(stackName, region, state)` plus `nestedChildren`
 * keyed by the child's `AWS::CloudFormation::Stack` logical id in the
 * parent's state.
 *
 * Built once per `cdkd export` invocation (issue
 * [#464](https://github.com/go-to-k/cdkd/issues/464) PR B1 + PR B2) so the
 * recursive walk over child state files happens up front, before any
 * AWS-side mutation. Loading the full tree eagerly catches missing-child
 * state inconsistencies before the orchestrator tries to plan-print or
 * submit anything.
 */
export interface CdkdStateStackTree {
  /**
   * For the root: the user-supplied cdkd stack name. For nested children:
   * the v6 state-key stack-name portion `<parent>~<childLogicalId>` (which
   * is what `stateBackend.getState(...)` accepts and what
   * `stateBackend.deleteState(...)` will reap during PR B2's state-cleanup
   * pass).
   */
  stackName: string;
  /**
   * Region of the state record. All children inherit the parent's region
   * today — AWS does not support cross-region nested stacks. The explicit
   * field is kept per the v6 schema design so a future cross-region
   * capability does not require another tree-shape bump.
   */
  region: string;
  /** The loaded state record for this node. */
  state: StackState;
  /** `childLogicalId → child tree node` for every direct nested child. Empty when the node has no nested children. */
  nestedChildren: Map<string, CdkdStateStackTree>;
}

/**
 * A state-record or template value for a sentence that quotes it: `'value'`
 * when it is empty, or has no whitespace and `displayIdent` renders it
 * unchanged, and `(not shown: it is not a plain identifier)` otherwise
 * (go-to-k/cdkd#3950). The whitespace test comes first, so a value that IS
 * `displayIdent`'s own cut output (`<1152 plain characters> [cut: N more
 * characters withheld, tail sha256:<hex>]`) is refused without resting on the
 * marker's tail digest, the only thing that keeps the round-trip from
 * admitting it (go-to-k/cdkd#4002). A non-string is never plain.
 *
 * These messages wrapped a stack name, a logical id or a record value in a
 * hand-written `'...'`, raw or through a sanitize-and-cap helper
 * (`safeSegment`, retired by go-to-k/cdkd#3371), which keeps `'`, `$`, `(` and
 * a space. A `'` in the value closed cdkd's quote, and the rest
 * of a pasted sentence ran as shell; several of these sentences also name a
 * `cdkd` command. `displayIdent`'s plain set is literal inside single quotes
 * and holds no whitespace, so a plain value cannot close the quote or put a
 * clause break inside it, and it prints exactly as it did. The cap is the
 * stack-ref one, so a legitimate multi-level nested-child name is not cut.
 * The value must also be inert with its quotes stripped (go-to-k/cdkd#4205):
 * `displayIdent`'s plain set admits `~root`, `=a`, `a=~b` and `a:~b`.
 */
export function quotedOrNotShown(value: unknown): string {
  // An empty string prints as `''`: it closes nothing, and an empty id is
  // worth seeing (`AWS reported '', <absent>`).
  return value === '' ||
    (typeof value === 'string' &&
      !/\s/.test(value) &&
      displayIdent(value, { maxCodePoints: STACK_REF_MAX_CODE_POINTS }) === value &&
      isInertUnquoted(value))
    ? `'${String(value)}'`
    : '(not shown: it is not a plain identifier)';
}

/** What a described identifier prints in place of its value. */
const NOT_SHOWN = '(not shown: it is not a plain identifier)';

/**
 * A region for a sentence: {@link quotedOrNotShown}, except that an EMPTY
 * region is described rather than printed as `''` — an empty region names
 * nothing, where an empty logical id is still worth seeing (review of
 * go-to-k/cdkd#4245).
 */
export function quotedRegion(region: unknown): string {
  return region === '' ? '(not shown: it is empty)' : quotedOrNotShown(region);
}

/**
 * A state record's BODY value (a physical id, a segment of one, a recorded
 * property) for a line that also carries a pasteable command: printed bare
 * only when it is {@link showRecordValue}'s plain shape AND inert on a
 * command line, and DESCRIBED otherwise. `showRecordValue`'s JSON quotes are
 * not inert: `$( )` and a backtick expand inside them, and an unpaired `"`
 * above the selection turns them inside out — the maintainer's decision on
 * go-to-k/cdkd#4229, the rule go-to-k/cdkd#4218 applied through
 * `proseIdentity`. So `$default` or a composite `a|b` is described here too.
 */
export function recordValueOrNotShown(value: unknown): string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= RECORD_VALUE_MAX_CODE_POINTS &&
    RECORD_VALUE_PLAIN.test(value) &&
    isInertUnquoted(value)
    ? value
    : NOT_SHOWN;
}

/**
 * {@link quotedOrNotShown} without the quotes, for a template or record
 * identifier in a SENTENCE that also carries a recovery command, where the
 * name has always printed bare (`pre-delete of HandlerPolicy (AWS::IAM::Policy,
 * ...)`). A value passing the same test is inert whether or not a pasted
 * selection flipped the quote parity above it, so it needs no quotes; any
 * other is described (the review of go-to-k/cdkd#4245).
 */
export function plainOrNotShown(value: unknown): string {
  const quoted = quotedOrNotShown(value);
  return quoted.startsWith("'") && quoted !== "''" ? quoted.slice(1, -1) : quoted;
}

/**
 * The head of the nested-child adoption-preparation failure, which ends on the
 * resume tail's recovery commands, so the row's logical id goes through
 * {@link plainOrNotShown}. Exported for unit testing: the tree fixtures
 * hard-wire the child row's id, and a non-plain one reaches the loop only
 * through a `--cfn-child-stack-name` override.
 */
export function adoptionPreparingLabel(logicalId: string): string {
  return `Preparing the adoption of nested child ${plainOrNotShown(logicalId)}`;
}

/**
 * Free-form untrusted text — an AWS error message, a failure reason — for a
 * message a terminal will render: sanitized with the ASCII allowlist and
 * capped at the state-record grammar's bound, with `displayIdent`'s cut
 * marker. NOT for an identifier: a stack name, region or logical id takes
 * {@link quotedOrNotShown}, which also gives it a boundary and withholds a
 * value that would run once its quotes were stripped (go-to-k/cdkd#4205);
 * this function gives free text neither, because free text has no plain
 * shape to test against.
 */
export function safeDetail(value: unknown): string {
  // `displaySafe` directly, NOT `String(value)` first: `String` is not total —
  // a JSON-derived `{"toString": null}` makes it throw (issue #2947), and a
  // display helper that throws takes the whole render with it. The `Error`
  // extraction stays, because an `Error`'s own `toString` is not its message.
  const safe = displaySafe(value instanceof Error ? value.message : value, { asciiOnly: true });
  if (!safe) return UNRENDERABLE;
  const { text, truncated } = truncateCodePoints(safe, STACK_REF_MAX_CODE_POINTS);
  // No tail digest: a message is not an identity, and its tail can hold an
  // echoed payload a bounded masker missed (`cutMarker`).
  return truncated ? `${text} ${cutMarker(safe.length - text.length)}` : text;
}

/**
 * The longest legitimate value {@link showRecordValue} renders uncut: AWS's
 * documented ARN ceiling. A physical id is a name, an id, a URL or an ARN, and
 * the ARN is the longest of them; a record carrying more than this is not one
 * of those.
 *
 * Counted in code points for a plain value and in ESCAPED characters for any
 * other, so a value escaping heavily is cut sooner: every BMP character past
 * ASCII costs six, an astral one twelve. A 255-character all-emoji name is
 * therefore cut, with the cut marked; a flood stop, not a formatting rule.
 */
const RECORD_VALUE_MAX_CODE_POINTS = 2048;

/**
 * The shape of a record value that renders BARE: `displayIdent`'s plain set
 * (`src/utils/display-safe.ts`) plus four characters real AWS identifiers carry
 * and that printed bare here before go-to-k/cdkd#3375, so quoting them would
 * change legitimate output (the `export` integ fixture greps
 * `Qualifier=$LATEST`):
 *
 * - `$`: a Lambda qualifier (`$LATEST`), an API Gateway v2 stage or route key
 *   (`$default`, `$connect`, `$disconnect`);
 * - `|`: cdkd's own composite physical ids (`<restApiId>|<resourceId>`);
 * - `#`: a CloudWatch Logs log-group name (`[.\-_/#A-Za-z0-9]+`);
 * - `*`: a Route 53 wildcard record name (`*.example.com`).
 *
 * A value holding one prints BARE only when it is also `isInertUnquoted`
 * (go-to-k/cdkd#4245 review): `$`, `|` and `*` are shell syntax, so a planted
 * `i-1|reboot` is JSON-quoted, and so is `$LATEST` / `$default` — the export
 * fixture's grep accepts the quoted spelling. `#` mid-word stays bare.
 * Not `displayIdent`'s own set widened, because that set also decides what
 * cdkd names bare beside a pasteable command, where `$` and `*` are shell
 * syntax.
 */
const RECORD_VALUE_PLAIN = /^[A-Za-z0-9:_@./+=,~$|#*-]+$/;

/**
 * Render a value read out of a state record's BODY — a `physicalId`, a
 * `properties` or `attributes` value, or a segment split out of one — into a
 * message (go-to-k/cdkd#3375). Nothing validates these on read, so the value
 * is anyone's who can write the record. The caller writes NO quotes of its own
 * around the result, since a hand-written `'...'` is exactly what a planted
 * `'` closes.
 *
 * A value in {@link RECORD_VALUE_PLAIN} within the cap that is also
 * `isInertUnquoted` renders bare. Anything else renders as a JSON string literal whose every character outside
 * printable ASCII is a `\uXXXX` escape: the boundary is visible, no byte can
 * move the cursor or reorder the line, and — unlike `displayIdent`'s
 * allowlist, which maps non-ASCII to a space — the value stays RECOVERABLE. A
 * legitimate id may be UTF-8 (a CloudWatch `AlarmName`, a Step Functions
 * state-machine name), and this is the plan an operator confirms a migration
 * from, so two distinct ids must never print as the same text. The cap bounds
 * the ESCAPED payload; the cut counts withheld code points and digests them,
 * in `displayIdent`'s marker (`cutMarker`).
 */
export function showRecordValue(value: unknown): string {
  const cap = { maxCodePoints: RECORD_VALUE_MAX_CODE_POINTS };
  // A non-string was never written as an id; `displayIdent`'s total coercion
  // is the right answer for it.
  if (typeof value !== 'string') return displayIdent(value, cap);
  // Bare only when also inert on a command line (the review of
  // go-to-k/cdkd#4245): `RECORD_VALUE_PLAIN` admits `|`, `$` and `*`, so a
  // planted `i-1|reboot` printed bare runs a command when pasted with no quote
  // flip at all. Such a value takes the JSON arm below instead.
  if (
    value.length <= RECORD_VALUE_MAX_CODE_POINTS &&
    RECORD_VALUE_PLAIN.test(value) &&
    isInertUnquoted(value)
  ) {
    // ASCII by construction, so `.length` counts code points.
    return value;
  }
  // The cap is on the ESCAPED text, so an escape cannot multiply it (a
  // non-ASCII code point escapes to six characters, an astral one to twelve).
  // Built one code point at a time, so the cut never splits an escape or a
  // surrogate pair.
  const codePoints = Array.from(value);
  const escape = (cp: string): string =>
    JSON.stringify(cp)
      .slice(1, -1)
      .replace(/[^ -~]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  let body = '';
  let kept = 0;
  for (const cp of codePoints) {
    const piece = escape(cp);
    if (body.length + piece.length > RECORD_VALUE_MAX_CODE_POINTS) break;
    body += piece;
    kept += 1;
  }
  const withheld = codePoints.length - kept;
  // The digest is over the withheld code points ESCAPED as the body escapes
  // them, so two distinct ids stay distinct past the cap too
  // (go-to-k/cdkd#4002). Not over the raw text: hashing encodes it as UTF-8,
  // which maps every lone surrogate to U+FFFD, so `\ud800` and `\udc00` tails
  // would digest alike. The escaped form is ASCII and injective.
  return withheld === 0
    ? `"${body}"`
    : `"${body}" ${cutMarker(withheld, codePoints.slice(kept).map(escape).join(''))}`;
}

/**
 * The success line for one pre-deleted `recreateBeforePhase2` resource, shared
 * by the single-stack and nested-stack paths so the two cannot render the
 * recorded physical id differently. Exported for the unit cases.
 */
export function preDeletedLine(physicalId: unknown): string {
  return `✓ deleted ${showRecordValue(physicalId)}`;
}

/**
 * A `cdkd state orphan` line for a record-derived stack name — PASTEABLE only
 * when that name renders EXACTLY, and a template otherwise (issue
 * [#3328](https://github.com/go-to-k/cdkd/issues/3328), review round 3).
 *
 * Three messages in this file suggested that command with a name minted from
 * `Object.keys(state.resources)` (`walkCdkdStateStackTree` builds
 * `` `${parent}~${logicalId}` ``), i.e. body content anyone able to write one
 * state key chooses. Two rendered it RAW, so a newline or a CSI sequence in a
 * logical id forged whole lines around a DELETE command; the third sanitized
 * but did not shell-quote, so `'`, `;`, `|` and `` ` `` survived into a line an
 * operator pastes into a shell.
 *
 * Both halves of `malformed-resources-bag.ts`'s rule, and for its reasons:
 * sanitize THEN shell-quote, and gate the substituted form on the identity
 * rendering exactly — `displaySafe` TRIMS, so a name ending in a space renders
 * byte-identically to a healthy sibling, and `state orphan` DELETES a record.
 * Every caller emits the command unwrapped on a line of its own so the quoting
 * composes (the layout is spelled out below); that is an instruction to the
 * CALLER and must not leak into the message it builds.
 *
 * `region` is REQUIRED even though the flag is optional on the command: omitting
 * `--stack-region` makes `state orphan` drop the record for that name in EVERY
 * region, which is wider than any of these messages describes. A helper whose
 * job is to make a destructive suggestion safe should not have an arm that
 * widens one.
 *
 * Built through the shared `pasteableCommand` gate (go-to-k/cdkd#3436), which
 * this function used to copy by hand — sanitize-and-compare against the raw
 * value, the stack-ref cap, and the leading-`-` refusal a record named
 * `--state-bucket=attacker` needs, since the shell strips `shellQuote`'s quotes
 * and Commander parses that argv entry as the FLAG.
 *
 * A withheld value names NO target, both holes rather than one: the identity
 * the message printed above may not be this record's. `note` says why, from
 * the gate's own reasons, and each caller puts it on the line ABOVE the
 * command, which is unwrapped on a line of its own — labelled and last in the
 * single-command messages, one per line in the nested-export tail's list. On
 * the same line as a sentence, an apostrophe in that sentence (`the parent's
 * record`) flips the shell quote so a pasted `'x; touch OWNED; #'` runs
 * (go-to-k/cdkd#3436's shape C, measured by this change's paste case).
 */
export function orphanCommandFor(
  stackName: unknown,
  region: unknown,
  /**
   * The run's account flags (go-to-k/cdkd#4648): `--profile`, the resolved
   * bucket, the prefix. They ride on the command, named or template, so a
   * pasted drop removes the record in the bucket this run read; a refused
   * one is a hole the note explains. The IDENTITY verdict below ignores them.
   */
  recovery?: LockRecoveryContext
): OrphanCommand {
  const account = accountArgs(recovery);
  const accountNote = spacedAccountClause(recovery, "the next line's command prints");
  // `unknown`, and handed to the gate UNCONVERTED (go-to-k/cdkd#3369): a
  // non-string is withheld as `altered`, since `displaySafe` renders it as a
  // different value. Never `String(x)` — that would make `123` exact and name
  // it.
  // ONE identity list (go-to-k/cdkd#4648 review): the verdict is taken from
  // it alone, and the printed command is it plus the account, so the two
  // cannot drift apart.
  const identity: CommandArg[] = [
    // `plainIdent` (go-to-k/cdkd#3997): the command sits on a labelled line
    // or in a list, the shape go-to-k/cdkd#3328 / #3696 gate that way, since
    // a name that renders exactly can still spell a second line when a
    // terminal wraps its padding.
    { value: stackName as string, hole: 'stack', opts: { plainIdent: true } },
    { flag: '--stack-region', value: region as string, hole: 'region', opts: { plainIdent: true } },
  ];
  const built = pasteableCommand('cdkd state orphan', identity);
  if (built.exact) {
    return {
      command: pasteableCommand('cdkd state orphan', [...identity, ...account]).command,
      note: accountNote,
    };
  }
  const reasons = [
    orphanWithheldPart('stack name', stackName, built, 'stack'),
    orphanWithheldPart('region', region, built, 'region'),
  ].filter((part) => part !== '');
  // A STACK NAME beginning with `-` must NOT be filled back in: quoted or
  // not, Commander reads `'--all'` in the positional as the option (a bare `-`
  // it takes positionally, but the gate refuses every leading `-`), so the
  // fill-in instruction would rebuild the command the gate refused. The
  // region is a flag's value, which Commander takes as given, so filling that
  // hole is safe; the other reasons are about a SPELLING the listing hands
  // back. Keyed on the RAW name's leading `-`, not on the reason: the gate
  // reports `altered` / `too-long` FIRST, so `'--' + 'x'.repeat(1153)` is
  // withheld as too long and would otherwise be handed the fill-in
  // instruction. `typeof` first, or a non-string record throws here — inside
  // the state-deletion warn's `catch`, where it would abort the cleanup loop.
  const dashName = typeof stackName === 'string' && stackName.startsWith('-');
  return {
    command: pasteableCommand('cdkd state orphan', [
      { hole: 'stack' },
      { flag: '--stack-region', hole: 'region' },
      ...account,
    ]).command,
    // Addressed to "the next line's command", not "this record": a caller
    // listing several records prints one note line above each command line.
    note:
      ` The next line's command names neither value, because its record's ` +
      `${reasons.join('; and its ')}. List the records with ` +
      // The listing reads the run's bucket only with the same flags
      // (go-to-k/cdkd#4648).
      (account.length > 0
        ? `${proseQuoted(cdkdRemedy('cdkd state list', '--json'))} run with the same account flags as the next line's command, and `
        : `${proseQuoted(cdkdRemedy('cdkd state list', '--json'))} and `) +
      (dashName
        ? `repair or remove the one whose stackName and region match by hand — this stack ` +
          `name begins with a '-' and could parse as an option in that position, so do not ` +
          `fill a hole with it.`
        : `act on the one whose stackName and region match, replacing each quoted hole, ` +
          `quotes included, with ${JSON_LISTING_HOLE_VALUE}.`) +
      accountNote,
  };
}

/** What {@link orphanCommandFor} returns. */
interface OrphanCommand {
  /** The command, on a line of its own after the note, unwrapped. */
  readonly command: string;
  /** `''` when the command names the record, else a sentence with a leading space. */
  readonly note: string;
}

/**
 * One value's half of {@link orphanCommandFor}'s note, from the gate's REASON
 * rather than from a predicate of this site's own, so the sentence cannot
 * disagree with the hole (M11 of the go-to-k/cdkd#3499 review). `''` when the
 * gate named the value.
 */
function orphanWithheldPart(
  what: string,
  raw: unknown,
  built: PasteableCommand,
  hole: string
): string {
  const reason = built.withheld.find((w) => w.hole === hole)?.reason;
  if (reason === undefined) return '';
  if (typeof raw !== 'string') return `${what} is not a string`;
  return `${what} ${orphanWithholdWhy(reason, hole === 'stack')}`;
}

/** Exported for unit testing: its `pattern-shaped` arm is unreachable through {@link orphanCommandFor}. */
export function orphanWithholdWhy(reason: WithholdReason, positional: boolean): string {
  switch (reason) {
    case 'altered':
      return 'does NOT render exactly (another record may render identically)';
    case 'empty':
      return 'is empty';
    case 'too-long':
      return 'is too long to print';
    // Only the POSITIONAL parses as a flag: Commander takes the word after
    // `--stack-region` as its value even when it begins with `-` (measured).
    // The gate refuses both anyway, conservatively, and the region's sentence
    // says that rather than claiming a parse that does not happen.
    case 'option-shaped':
      return positional
        ? `begins with a '-', which 'cdkd state orphan' could parse as a flag`
        : `begins with a '-', which cdkd refuses to print as an argument`;
    case 'not-plain':
      return (
        `is not a plain identifier (a letter or digit, then letters, digits, '~', '_', '.' or '-'), which cdkd does not ` +
        `print on a command line`
      );
    // Unreachable (this site does not pass `patternMatched`), and answered
    // with a TRUE sentence rather than a throw, as `refreshWithheldReason`
    // does: a throw here would escape the state-deletion warn's `catch`.
    case 'pattern-shaped':
      return `cannot be printed as an argument to 'cdkd state orphan'`;
    // Unreachable: `orphanCommandFor` passes `plainIdent`, which answers
    // `not-plain` for every value this arm would take.
    case 'shell-active':
      return SHELL_ACTIVE_WHY;
    default: {
      const _exhaustive: never = reason;
      throw new Error(`orphanWithholdWhy: unhandled WithholdReason ${String(_exhaustive)}`);
    }
  }
}

/**
 * A template- or record-derived identifier for a LIST ROW (go-to-k/cdkd#3371):
 * {@link plainOrNotShown}'s rule — bare when it is a plain identifier inert on
 * a command line, DESCRIBED otherwise. Not a JSON or shell-quoted display: a
 * JSON render still expands `$( )` and a backtick, and either quote style turns
 * inside out behind an unpaired `'` or `"` pasted above it (the maintainer's
 * decision on go-to-k/cdkd#4229; the review of go-to-k/cdkd#4245). Kept as its
 * own name so a row reads as a row at its call site.
 */
export function rowIdent(value: unknown): string {
  return plainOrNotShown(value);
}

/**
 * {@link withheldAccountClause}'s sentence with one leading space, or `''`
 * when no account value was withheld: the one spelling this file's messages
 * join it into prose with (go-to-k/cdkd#4648).
 */
export function spacedAccountClause(
  recovery: LockRecoveryContext | undefined,
  where: string
): string {
  const clause = withheldAccountClause(recovery, where).trimEnd();
  return clause === '' ? '' : ` ${clause}`;
}
