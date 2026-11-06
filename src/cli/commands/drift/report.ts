/**
 * `cdkd drift`: the human-readable report.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { Option } from 'commander';
import { parseStackRegion } from '../../options.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';
import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import {
  truncateCodePoints,
  safeMsg,
  STACK_REF_MAX_CODE_POINTS,
  IDENT_MAX_CODE_POINTS,
  SAFE_MSG_ALTERED_CHAR,
  isPasteableIdent,
} from '../../../utils/display-safe.js';
import { shellQuote } from '../../../state/lock-contention-message.js';
import {
  type RecordedSecretValues,
  hasMaskableValues,
  maskSecretsInText,
} from '../../../deployment/secret-redaction.js';
import {
  type StackDriftReport,
  type DriftedOutcome,
  type DriftOutcome,
  matchOutcome,
  notComparedOutcomes,
  ANY_OF_IT_COMPARED,
  UNCOMPARED_REASONS,
  type UncomparedReason,
  type NotComparedCause,
} from './outcome.js';
import { nestedRecordMissingClause } from './command.js';
import { notComparedReason } from './read-failure.js';
import { unsettledRowsOf } from './report-json.js';

/**
 * An identifier on a row of the human report — the stack name and region of
 * a heading, a logical id, a resource type, a property path — CAPPED the way
 * `malformed-resources-bag.ts`'s `safeIdentifier` caps (issue
 * go-to-k/cdkd#3232): it bounds how much of the reader's screen a planted
 * multi-kilobyte state key can take — a bound on length, not a guarantee that
 * the rows after it stay in view, since a name can still wrap within the cap
 * (`writeHumanReport`'s doc names that class). The cap is a required parameter for the
 * reason that helper's doc gives — a defaulted one silently cut every site
 * that forgot to pass the wider one. `truncateCodePoints` rather than `slice`,
 * so the cut never lands inside a surrogate pair.
 *
 * Sanitizing is deliberately NOT done here: every row of the report is a
 * `safeMsg` template, which flattens each interpolated value to one line and
 * strips terminal control from it, identifier and property value alike,
 * applied where the row is built. Nothing is trimmed either: `displaySafe`
 * would trim, and a property value's padding is the whole difference between
 * `" value "` and `"value"` on a real drift — which is why a change line
 * quotes such a value first (`reportValue`), so its edges show.
 */
export function reportIdent(value: string, maxCodePoints: number): string {
  const { text, truncated } = truncateCodePoints(value, maxCodePoints);
  return truncated ? `${text}...` : text;
}

/** `<stack> (<region>)`, the identity every heading of the report opens with. */
export function reportHeading(report: StackDriftReport): string {
  return safeMsg`${reportIdent(report.stackName, STACK_REF_MAX_CODE_POINTS)} (${reportIdent(report.region, IDENT_MAX_CODE_POINTS)})`;
}

/** `<logicalId> (<resourceType>)`, the identity every per-resource row carries. */
export function reportResource(outcome: { logicalId: string; resourceType: string }): string {
  return safeMsg`${reportIdent(outcome.logicalId, IDENT_MAX_CODE_POINTS)} (${reportIdent(outcome.resourceType, IDENT_MAX_CODE_POINTS)})`;
}

/**
 * The characters `safeMsg` acts on in a value (`SAFE_MSG_ALTERED_CHAR`: C0 —
 * newline, tab and ESC among them — DEL, C1, U+2028 / U+2029 and the bidi
 * overrides), plus an UNPAIRED surrogate, which `safeMsg` passes through but
 * stdout's UTF-8 encoding turns into U+FFFD, so `"a\uD800"` and `"a\uFFFD"`
 * would print alike. The `u` flag makes `[\uD800-\uDFFF]` match only a lone
 * surrogate; a paired one is a single code point outside the class.
 */
const ALTERED_BY_SAFE_MSG = new RegExp(`${SAFE_MSG_ALTERED_CHAR.source}|[\\uD800-\\uDFFF]`, 'u');

/**
 * JSON text with every character `SAFE_MSG_ALTERED_CHAR` names written as its
 * `\uXXXX` escape. `JSON.stringify` escapes only the C0 range (and an unpaired
 * surrogate, the other half of `ALTERED_BY_SAFE_MSG`); DEL, C1, U+2028 /
 * U+2029 and the bidi overrides it leaves literal, and `safeMsg` would then
 * replace each with a space — so `"a\u2028"` and `"a "` would still print
 * alike. Escaped, the text is still valid JSON for the same value.
 */
function escapeJsonLiterals(json: string): string {
  return json.replace(
    new RegExp(SAFE_MSG_ALTERED_CHAR.source, 'g'),
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/**
 * A change line's value, as `safeMsg` will be handed it.
 *
 * A STRING that carries a character `ALTERED_BY_SAFE_MSG` names (ESC included,
 * so even a colour code `safeMsg` would keep), whose edges are whitespace, or
 * that starts with `"`, is printed as its JSON string instead, with every such
 * character escaped (`escapeJsonLiterals`): flattened, `"abc\n"` and `"abc"`
 * (or `"a\tb"` and `"a b"`) would print the same `-` and `+` sides, and a
 * padded value's edges are invisible without the quotes. No character of that
 * set is then left between the quotes, so two strings that differ in one, or
 * in whether they have whitespace at an edge, print differently (a zero-width
 * or look-alike character, or one kind of space for another, is outside that
 * and prints as itself), and a value's colour code prints as escape text, not
 * as colour. The leading `"` rule means a value that merely SPELLS a quoted
 * string cannot pass for one. Any other string renders byte-for-byte as it
 * always did.
 *
 * Every non-string goes through `formatScalar` and the same escaping: a
 * structured value's JSON, so a control nested in it arrives as escape text
 * too; a number, boolean, `null` or `undefined`, which has nothing to escape.
 */
function reportValue(value: unknown): string {
  if (typeof value !== 'string') return escapeJsonLiterals(formatScalar(value));
  if (value === value.trim() && !value.startsWith('"') && !ALTERED_BY_SAFE_MSG.test(value)) {
    return value;
  }
  return escapeJsonLiterals(JSON.stringify(value));
}

/**
 * A drifted change's value as the report, `--json` and the accept / revert
 * plans render it (go-to-k/cdkd#3869): masked with the resource's printing
 * bag, so a reader's stored copy of a name derived from a secret (an instance
 * profile's `Roles`) prints as `***`. `redactDriftChanges` already masked the
 * recorded secrets; these needles are no recorded secret. The value itself is
 * returned when the bag holds nothing, so an ordinary report is unchanged.
 */
export function displayDriftValue(
  outcome: { readonly printingNeedles?: RecordedSecretValues },
  value: unknown
): unknown {
  const bag = outcome.printingNeedles;
  if (bag === undefined || !hasMaskableValues(bag)) return value;
  return maskDriftDisplayLeaves(value, (text) => maskSecretsInText(text, bag));
}

/**
 * A drifted change's PATH as the renderers print it (go-to-k/cdkd#3869): a
 * segment that is a map key spelling a secret-derived name is masked, as the
 * same key is inside a value.
 */
export function displayDriftPath(
  outcome: { readonly printingNeedles?: RecordedSecretValues },
  path: string
): string {
  const bag = outcome.printingNeedles;
  if (bag === undefined || !hasMaskableValues(bag)) return path;
  return maskSecretsInText(path, bag);
}

/**
 * `value` with every string leaf AND key passed through `mask`, keeping its
 * shape: no depth cap (a deep value is a drifted value, not one to truncate),
 * and a key that masks into one already taken gets a `#<n>` suffix, so two
 * keys masking alike stay two entries. A drift row's value is JSON read from
 * state or an AWS readback, so it is acyclic.
 */
function maskDriftDisplayLeaves(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((entry) => maskDriftDisplayLeaves(entry, mask));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = nullPrototypeRecord<unknown>();
    const entries = Object.entries(value as Record<string, unknown>);
    // Keys that print unchanged first, so a masked key never displaces one.
    const taken = new Set(entries.map(([key]) => key).filter((key) => mask(key) === key));
    for (const [key, entry] of entries) {
      let shown = mask(key);
      if (shown !== key) {
        for (let n = 2; taken.has(shown); n++) shown = `${mask(key)}#${n}`;
        taken.add(shown);
      }
      out[shown] = maskDriftDisplayLeaves(entry, mask);
    }
    return out;
  }
  return value;
}

/**
 * One `-` / `+` line of a drifted resource. The value goes through
 * `reportValue` and then `safeMsg` — never trimmed, never capped — so an
 * ordinary value renders byte-for-byte as it always did and a drift that
 * differs only by a control character, or by whether a value has whitespace
 * at an edge, still shows two different sides.
 */
function reportChangeLine(sign: '-' | '+', path: string, value: unknown): string {
  return safeMsg`    ${sign} ${reportIdent(path, IDENT_MAX_CODE_POINTS)}: ${reportValue(value)}\n`;
}

/**
 * A property path on a `--accept` / `--revert` plan line that prints no value
 * beside it (a `SKIPPED` row, a preserved-tag or unbaselined-value list entry),
 * capped and sanitized as `reportChangeLine` does its path (issue
 * go-to-k/cdkd#3949). A caller that masks the path does so FIRST, on the raw
 * text, so neither the cap nor the sanitizing can split a secret past the
 * masker.
 */
export function reportPath(path: string): string {
  return safeMsg`${reportIdent(path, IDENT_MAX_CODE_POINTS)}`;
}

/** The separator of a plan's `<from> → <to>` pair; see `reportPlanChangeLine`. */
const PLAN_ARROW = '→';

/**
 * One `<path>: <from> → <to>` line of a `--accept` / `--revert` plan, each
 * value through `reportPlanValue` and the whole row a `safeMsg` template, as a
 * `-` / `+` line of the report is (issue go-to-k/cdkd#3949). The revert plan
 * is printed directly above the confirmation prompt, so a forged row here
 * misstates what the operator is about to confirm.
 *
 * The separator is {@link PLAN_ARROW}, not ASCII `->` (issue
 * go-to-k/cdkd#4239): pasted into a shell, `->` is `-` plus a `>` redirect
 * onto the bare value after it, so a readback value would name a file to
 * truncate. `→` is an ordinary word character to bash and zsh.
 */
export function reportPlanChangeLine(path: string, from: unknown, to: unknown): string {
  return safeMsg`    ${reportIdent(path, IDENT_MAX_CODE_POINTS)}: ${reportPlanValue(from)} ${PLAN_ARROW} ${reportPlanValue(to)}\n`;
}

/**
 * Whether a plan value must be quoted so it cannot read as the separator: it
 * carries ASCII `->` or a character of one of these arrow ranges — Arrows
 * U+2190-21FF, the dingbat arrows U+2794-27BF, Supplemental Arrows-A
 * U+27F0-27FF and -B U+2900-297F, Miscellaneous Symbols and Arrows
 * U+2B00-2BFF, Supplemental Arrows-C U+1F800-1F8FF, and the halfwidth arrows
 * U+FFE9-FFEC.
 *
 * The ranges, not {@link PLAN_ARROW} alone: a look-alike (`⟶`, `➔`, `⮕`) in a
 * bare value reads as the separator just as `→` does, and `->` is the arrow
 * the separator itself used to be. The criterion is LOOKING like the
 * separator. That quoting `->` also keeps its `>` inside JSON's double quotes
 * is a side effect, not the rule: other redirect spellings in a value (a bare
 * `>`, `−>` with U+2212) print as they are, the value-display class of
 * go-to-k/cdkd#3950.
 */
const PLAN_ARROW_LIKE =
  /->|[\u2190-\u21FF\u2794-\u27BF\u27F0-\u27FF\u2900-\u297F\u2B00-\u2BFF\u{1F800}-\u{1F8FF}\uFFE9-\uFFEC]/u;

/**
 * `reportValue`, plus one more reason to quote a string: {@link PLAN_ARROW_LIKE}.
 * Unquoted, a readback value `prod → prod` would print
 * `Env: prod → prod → staging`, and the reader could not tell which value the
 * revert pushes. Matching the ARROW rather than ` → ` is what makes that hold:
 * `a →` / `b` and `a` / `→ b` would otherwise both print `a → → b` (the line
 * supplies the missing space), and a look-alike space around the arrow would
 * pass. With no unquoted value carrying an arrow, the only one outside quotes
 * after the path is the separator (the path itself is unquoted, as on the
 * report's rows). A structured value needs no rule: JSON has no arrow of its
 * own, so one inside it sits between JSON's quotes. The quoted form is
 * `reportValue`'s own, so a string it would quote anyway prints the same
 * either way.
 *
 * Only the arrow family is handled here. A value's OTHER shell characters
 * (a lone `>`, `;`, `$( )`) print as they are, as on the report's rows: that
 * is the value-display class of go-to-k/cdkd#3950.
 */
export function reportPlanValue(value: unknown): string {
  if (typeof value === 'string' && PLAN_ARROW_LIKE.test(value)) {
    return escapeJsonLiterals(JSON.stringify(value));
  }
  return reportValue(value);
}

/**
 * The human rendering of a drift run, to stdout.
 *
 * Every value it prints that came out of a state record or an AWS readback —
 * the stack name and region of a heading, each row's logical id and resource
 * type, each changed property's path and both of its values — goes through
 * {@link safeMsg} at the row that prints it (issue go-to-k/cdkd#3232). The
 * output is line-oriented, and this report is exactly the text a reader trusts
 * to say whether a stack matches AWS: a newline in a logical id invented a
 * `✓ ... no drift detected` row, and an escape sequence or a bidi override
 * could overwrite or reorder what the reader saw. `ConsoleLogger`'s sink does
 * not reach these writes, which go to `process.stdout` directly, so the guard
 * is at the call site — where `safeMsg` also closes the line-forging half the
 * sink cannot tell from cdkd's own newlines. What `safeMsg` keeps, it keeps
 * here too: an IDENTIFIER spelling one of cdkd's own colour codes
 * (`terminalSafe`'s SGR allowlist: cdkd's colours, bold, dim and reset) keeps
 * it, and an unreset one styles the rows after it as well — colour and text
 * styling are all such a sequence can do; it cannot move the cursor, clear the
 * screen or plant a link. A property VALUE carrying any control is JSON-quoted
 * first (`reportValue`), so its ESC prints as escape text instead.
 *
 * `--json` is untouched: a consumer of that mode wants the stored value. And
 * this is the control-character class only — a value that WRAPS into a line
 * that reads as a row (a padded name spelling `✓ Prod (us-east-1): ...`) is
 * go-to-k/cdkd#3328's class, which the cap bounds for an identifier, nothing
 * bounds for an uncapped property value, and neither closes.
 */
export function writeHumanReport(reports: StackDriftReport[]): void {
  for (const report of reports) {
    const drifted: DriftedOutcome[] = [];
    const deleted: Array<Extract<DriftOutcome, { kind: 'deleted' }>> = [];
    const unsupported: Array<Extract<DriftOutcome, { kind: 'unsupported' }>> = [];
    // Issue #323: `skipped` (`Custom::*`, and a nested row its own block covers) is intentionally
    // NOT counted as "checked" — drift on Custom Resources is not
    // actionable from `cdkd drift` (no read happens). Excluded from the
    // human-report count so "N resources checked" matches the user's
    // mental model. Skipped entries are still present in the outcomes
    // array and surface in `--json` output (as `skipped: [...]`).
    let inspectedCount = 0;
    let skippedCount = 0;
    // go-to-k/cdkd#4533: the `skipped` nested rows, each compared in its own
    // record's block below this one.
    let nestedCoveredCount = 0;
    // Issue #2135: ONE exhaustive pass, and `inspected` is COUNTED UP inside
    // it rather than subtracted from `outcomes.length` afterwards. Subtracting
    // is what let the old shape absorb an unnamed variant into "checked"
    // silently: a variant nobody named still landed in the total, because the
    // total did not come from the enumeration. Counting up means a variant
    // that arrives without an arm here is EXCLUDED rather than assumed
    // checked, so the arithmetic that states the claim is the arithmetic the
    // exhaustive pass drives. The `skipped` arm increments nothing, which IS
    // the #323 exclusion above -- it is not an omission, and there is no
    // separate skipped counter to keep in step with it.
    //
    // One honest limit, stated so the paragraph above is not read as more
    // than it is: `inspected` and `checked` are only ever READ inside the
    // `drifted.length === 0` branch, so the `drifted` arm's increment cannot
    // affect any number a user sees. It is kept because `inspected` means
    // "outcomes cdkd actually read", and an arm that silently stopped
    // maintaining that would be a trap for the next reader who moves the
    // read.
    //
    // Issue #2141: `unsupported` no longer increments. Two arms now
    // contribute nothing, for the same reason from opposite directions --
    // `skipped` because drift is not actionable there (#323) and
    // `unsupported` because no read is possible at all -- so `inspected`
    // counts exactly the outcomes a comparison was attempted for. A
    // one-unsupported-resource stack therefore prints `0 resources checked,
    // 1 unsupported` rather than claiming the resource was checked.
    for (const o of report.outcomes) {
      matchOutcome<void>(o, {
        drifted: (d) => {
          drifted.push(d);
          inspectedCount += 1;
        },
        // Issue #2141: NOT counted. `readCurrentState` is absent for this
        // type, so nothing was read and there is no comparison to report --
        // counting it made `N resources checked` state a read that never
        // happened. The resource is not lost: `unsupported.length` is printed
        // on the same line, and `--json` carries it as `notSupported`.
        unsupported: (u) => {
          unsupported.push(u);
        },
        // Issue #2154: COUNTED now, though still not `inspected`. The two are
        // different questions -- #323 keeps `skipped` out of "checked" because
        // drift is not actionable there, which is untouched -- but the new
        // NOTHING-was-compared line states a PARTITION of the stack, and a
        // partition that omits a population accounts for none of an
        // all-`Custom::*` stack (it printed `0 of 3 ... (0 unsupported)`).
        skipped: (sk) => {
          skippedCount += 1;
          if (sk.resourceType === NESTED_STACK_RESOURCE_TYPE) nestedCoveredCount += 1;
        },
        // Both counted as inspected, and told apart by `notCompared` below:
        // a `clean` one was checked, a `notCompared` one was not.
        clean: () => {
          inspectedCount += 1;
        },
        notCompared: () => {
          inspectedCount += 1;
        },
        // go-to-k/cdkd#4283: read, and AWS answered that it is gone — drift,
        // reported in the drift block below rather than as `drift unknown`.
        deleted: (del) => {
          deleted.push(del);
          inspectedCount += 1;
        },
      });
    }
    const inspected = inspectedCount;
    // Issue #2108: the `--json` `notCompared` roll-up, in the human report.
    // `✓ no drift detected` on a resource whose secret-bearing properties were
    // never compared is the same false reassurance the JSON field exists to
    // close, so it has to be said on BOTH renderings — the per-resource `NOT
    // compared` warning is a logger line, which a user reading stdout (or
    // piping it) does not necessarily see next to this summary.
    //
    // Computed HERE, above the summary line, because the count it produces is
    // subtracted from `checked` below: a not-compared resource was inspected but
    // NOT fully checked, and counting it as checked contradicted the block this
    // same list prints a few lines down.
    const notCompared = notComparedOutcomes(report);
    const checked = inspected - notCompared.length;

    if (drifted.length === 0 && deleted.length === 0) {
      // The glyph follows THIS REPORT's question — "was everything actually
      // compared" — and NOT the exit code, which asks the narrower "did cdkd
      // refuse anything" (issue #2108). The two differ for a stack whose only
      // uncompared properties hold a surviving `{{resolve:...}}` token cdkd
      // resolves for nobody: it warns here and still exits 0, deliberately.
      // Keying the glyph on the exit code's subset instead would put a ✓ and a
      // `1 resource checked` directly above a `PARTIALLY compared` block naming
      // that same resource, which is the contradiction this branch exists to
      // remove. The phrase `no drift detected` is kept in both spellings
      // because it stays true; what changes is the claim that everything was
      // looked at.
      if (
        notCompared.length === 0 &&
        nestedCoveredCount > 0 &&
        nestedCoveredCount === report.outcomes.length
      ) {
        // go-to-k/cdkd#4533: a parent holding only nested stacks. Its rows
        // were not compared HERE, but each one's resources are, in that
        // stack's own block in this run -- so `NOTHING was compared` would be false.
        process.stdout.write(
          `✓ ${reportHeading(report)}: no drift detected here — ` +
            `${nestedCoveredCount} nested stack${nestedCoveredCount === 1 ? '' : 's'}, ` +
            `each checked in its own block\n`
        );
      } else if (notCompared.length === 0 && checked === 0 && report.outcomes.length > 0) {
        // Issue [#2154](https://github.com/go-to-k/cdkd/issues/2154): a stack in
        // which NOTHING was compared must not get the reassuring glyph.
        //
        // The rule the glyph follows is stated in the branch below -- "was
        // everything actually compared" -- and a stack where the answer is
        // "none of it" is the extreme case of that question, which until now got
        // the OPPOSITE answer from the one the rule implies. #2135 made
        // `notCompared` a variant precisely so "cdkd never checked this" could
        // not be reported as "this is fine"; this is the same failure surviving
        // in the glyph rather than in the outcome type.
        //
        // COVERS `skipped`-ONLY STACKS TOO, and that is a deliberate call rather
        // than a side effect -- #2154 flagged it as a separate user-visible
        // decision. Taken because the sentence the glyph answers is true of them
        // in exactly the same way: a `Custom::*`-only stack was not compared, so
        // a ✓ over `0 resources checked` is the same false reassurance whether
        // the reason was #323 (not applicable), #2141 (no read path), or a read
        // that threw. #323's decision was that such a resource is not
        // ACTIONABLE, which is an argument for keeping it out of the counts --
        // it still is -- not for claiming it was checked.
        //
        // The EXIT CODE is untouched: `unsupported` and `skipped` both still
        // report `none` in `outcomeExitSignal`, so this stack still exits 0.
        // Only the claim printed about coverage changes, which is the same
        // split the ⚠ branch below already makes.
        //
        // `report.outcomes.length > 0` keeps a genuinely EMPTY stack on the ✓:
        // there was nothing to compare, so "everything was compared" is
        // vacuously true and a ⚠ would be noise no action can clear.
        process.stdout.write(
          `⚠ ${reportHeading(report)}: no drift detected, but NOTHING was ` +
            `compared — 0 of ${report.outcomes.length} ` +
            `resource${report.outcomes.length === 1 ? '' : 's'} checked ` +
            `(${unsupported.length} unsupported, ${skippedCount} skipped)\n`
        );
      } else if (notCompared.length > 0) {
        process.stdout.write(
          // `unsupported` sits OUTSIDE the parenthetical, unlike the `✓`
          // branch's trailing `, N unsupported`, and the asymmetry is the
          // point: here there is a DENOMINATOR, so the parenthetical reads as
          // a partition of it. Since issue #2141 took `unsupported` out of
          // `inspected`, keeping it inside printed `1 of 3 ... (2 only
          // partially compared, 1 unsupported)`, whose parts sum to 4 against
          // a stated total of 3. Outside the parens the paren still explains
          // exactly the `inspected - checked` gap and the numbers add up.
          `⚠ ${reportHeading(report)}: no drift detected, but ` +
            `${checked} of ${inspected} resource${inspected === 1 ? '' : 's'} fully checked ` +
            // Issues #2151 / #1945: the parenthetical is conditional for the
            // same reason the block heading below is. `only partially compared`
            // is FALSE of a `readFailed` resource -- none of its properties were
            // compared -- and this line sitting directly above a block that says
            // `not compared AT ALL` contradicted it in the reassuring direction.
            // Byte-identical to main when the new population is absent.
            // `baselineRefused` joins `readFailed` (issue #2952): for both,
            // NONE of the resource's properties were compared, so
            // `only partially compared` understates it in the reassuring
            // direction — the same argument #2151 made for `readFailed`.
            (notCompared.some((n) => !ANY_OF_IT_COMPARED[n.cause])
              ? `(${notCompared.length} not fully compared), `
              : `(${notCompared.length} only partially compared), `) +
            `${unsupported.length} unsupported\n`
        );
      } else {
        process.stdout.write(
          `✓ ${reportHeading(report)}: no drift detected ` +
            `(${checked} resource${checked === 1 ? '' : 's'} checked, ${unsupported.length} unsupported)\n`
        );
      }
    } else {
      const driftCount = drifted.length + deleted.length;
      const word = driftCount === 1 ? 'resource' : 'resources';
      process.stdout.write(
        `\n⚠ ${reportHeading(report)}: drift detected on ${driftCount} ${word}\n\n`
      );
      // go-to-k/cdkd#4283: a resource deleted outside cdkd has no property
      // changes to list — the whole resource is the change. Its own `-` glyph
      // and wording, never the `drift unknown` block it used to fall into.
      for (const o of deleted) {
        process.stdout.write(
          o.nestedStackRecordMissing === true
            ? `  - ${reportResource(o)} — RECORD MISSING: ${nestedRecordMissingClause(report, o)}\n\n`
            : `  - ${reportResource(o)} — DELETED outside cdkd: AWS reports it does not exist.\n\n`
        );
      }
      for (const o of drifted) {
        process.stdout.write(`  ~ ${reportResource(o)}\n`);
        for (const change of o.changes) {
          process.stdout.write(
            reportChangeLine(
              '-',
              displayDriftPath(o, change.path),
              displayDriftValue(o, change.stateValue)
            )
          );
          process.stdout.write(
            reportChangeLine(
              '+',
              displayDriftPath(o, change.path),
              displayDriftValue(o, change.awsValue)
            )
          );
        }
        process.stdout.write('\n');
      }
    }

    // go-to-k/cdkd#5380: what a failed deploy left unsettled, whatever the
    // comparison above found (AWS may since have finished either way).
    const unsettledRows = unsettledRowsOf(report);
    if (unsettledRows.length > 0) {
      process.stdout.write(
        `\n! ${reportHeading(report)}: a failed deploy left properties unsettled on ` +
          `${unsettledRows.length} resource${unsettledRows.length === 1 ? '' : 's'} ` +
          `(AWS may hold the recorded value or the attempted one). The next 'cdkd deploy' ` +
          `sends them again; a successful --accept or --revert of the resource clears them.\n`
      );
      for (const row of unsettledRows) {
        const names = row.properties
          .map((name) => safeMsg`${reportIdent(name, IDENT_MAX_CODE_POINTS)}`)
          .join(', ');
        process.stdout.write(
          `    ! ${reportResource({ logicalId: row.logicalId, resourceType: row.type })}: ${names}\n`
        );
      }
    }

    if (notCompared.length > 0) {
      // Issues #2151 / #1945 widened this population past dynamic references, so
      // the heading can no longer state ONE cause for all of it, and the entries
      // now name their own. `readFailed` is called out separately in the heading
      // because it is not "partially" anything: none of that resource's
      // properties were compared, and a heading claiming otherwise understates
      // it in the one direction that matters.
      // Issue #2952 widened this bucket past `readFailed`, so the NAME had to
      // move with it: `baselineRefused` is also "none of it was compared", but
      // nothing was read and nothing failed. A variable still called
      // `readFailed` is how the heading below came to assert a cause the
      // population does not have.
      const notComparedAtAll = notCompared.filter((n) => !ANY_OF_IT_COMPARED[n.cause]).length;
      const referenceCaused = notCompared.length - notComparedAtAll;
      // The partial clause names only the causes PRESENT (issue #3595): an
      // `uncertifiedBaseline` resolved every reference, so the reference
      // wording would be false for it. A run holding only the reference causes
      // keeps the long-standing wording byte for byte.
      const partialCauses = new Set(
        notCompared.filter((n) => ANY_OF_IT_COMPARED[n.cause]).map((n) => n.cause)
      );
      const hasReferencePartial =
        partialCauses.has('refused') || partialCauses.has('unresolvedToken');
      const hasUncertified = partialCauses.has('uncertifiedBaseline');
      const partialClause =
        hasReferencePartial && !hasUncertified
          ? `cdkd could not, or refused to, resolve a dynamic reference their state records, ` +
            `so their secret-bearing properties were NOT compared`
          : hasUncertified && !hasReferencePartial
            ? `their recorded baseline holds the redaction mask at a position cdkd could not ` +
              `certify, so that position was NOT compared`
            : `some of their properties were NOT compared; each entry below names why`;
      const partialClauseShort =
        hasReferencePartial && !hasUncertified
          ? 'a dynamic reference cdkd could not, or refused to, resolve'
          : hasUncertified && !hasReferencePartial
            ? 'a baseline position cdkd could not certify'
            : 'see each entry';
      // Names only the causes actually PRESENT, so a refused-baseline-only
      // stack no longer reads `the read or comparison failed`. DERIVED from
      // the two exhaustive records rather than listed by hand: which causes
      // compared nothing is `ANY_OF_IT_COMPARED`'s answer (the same one the
      // count beside it reads), and each cause's wording is its
      // `UNCOMPARED_REASONS` phrase. A hand list here was the fourth copy of
      // that partition, and a future `false` cause would have rendered
      // `N not compared AT ALL ()` with the count still right
      // (go-to-k/cdkd#3018 review, M10).
      //
      // The two records answer DIFFERENT questions here and the split is
      // deliberate: `UNCOMPARED_REASONS` decides the ORDER, which is what its
      // own doc promises ("the insertion ORDER is the order the phrases are
      // emitted in, so the line is deterministic without a second list to keep
      // in sync"), and `ANY_OF_IT_COMPARED` decides MEMBERSHIP, which is its
      // axis. Reading the order off the membership record instead put the two
      // in disagreement — they sort `unreadableRecord` and `baselineRefused`
      // opposite ways — which is a second ordering list under a doc that says
      // there is none.
      // The first filter is TYPE NARROWING and nothing more, stated rather than
      // pinned: `UncomparedReason` adds `unsupported` / `skipped`, which
      // `ANY_OF_IT_COMPARED` has no key for, and the `notCompared.some` test
      // below already excludes both — so deleting it changes no output and no
      // test can tell the two apart. It earns its place by letting the lookups
      // after it be indexed rather than cast.
      const atAllCause = (Object.keys(UNCOMPARED_REASONS) as UncomparedReason[])
        .filter((cause): cause is NotComparedCause => cause in ANY_OF_IT_COMPARED)
        .filter((cause) => !ANY_OF_IT_COMPARED[cause] && notCompared.some((n) => n.cause === cause))
        .map((cause) => UNCOMPARED_REASONS[cause].phrase.replace(/^not compared AT ALL: /, ''))
        .join('; ');
      process.stdout.write(
        notComparedAtAll === 0
          ? // BYTE-FOR-BYTE the pre-#2151 heading. The widened population is the
            // reason the wording had to become conditional, and leaving the old
            // one intact for the old population is not cosmetic: every existing
            // assertion anchors on `PARTIALLY compared`, and a heading that
            // moves for a stack containing none of the new population would
            // have made this lane's diff look like a rendering change to every
            // reader and every test, hiding the one case that actually changed.
            `\n  ${notCompared.length} resource(s) only PARTIALLY compared — ${partialClause}:\n`
          : // With a `readFailed` entry present the old heading is FALSE, not
            // merely incomplete: none of that resource's properties were
            // compared, so calling it "only PARTIALLY compared" understates it in
            // the reassuring direction — the same failure #2154 fixes in the
            // glyph. The two populations are counted separately rather than
            // summed under one phrase.
            `\n  ${notCompared.length} resource(s) NOT fully compared — ${notComparedAtAll} not ` +
              `compared AT ALL (${atAllCause})` +
              (referenceCaused > 0
                ? `, ${referenceCaused} only PARTIALLY compared (${partialClauseShort})`
                : '') +
              `:\n`
      );
      for (const { outcome, cause } of notCompared) {
        process.stdout.write(
          `    ! ${reportResource(outcome)} — ${notComparedReason(cause, report.state.resources?.[outcome.logicalId])}\n`
        );
      }
    }

    if (unsupported.length > 0) {
      process.stdout.write(
        `\n  ${unsupported.length} resource(s) reported as drift unknown — ` +
          `provider does not yet support drift detection:\n`
      );
      for (const o of unsupported) {
        process.stdout.write(`    ? ${reportResource(o)}\n`);
      }
    }
  }
}

/**
 * Render a value for the `+/-` lines in the human-readable diff. Scalars
 * pass through; structured values are JSON-encoded inline so a multi-line
 * value doesn't break the visual alignment.
 */
function formatScalar(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * The `Stack: '<name>'` line that carries a record's identity NEXT TO a
 * pasteable command, or `undefined` when the name cannot be printed at all.
 *
 * A labelled command line is a trusted-looking shape, and a stack name is an
 * S3 key segment `listStacks` validates only for non-emptiness — so a name
 * carrying a newline printed ABOVE one forges a second labelled line that the
 * operator has every reason to trust.
 *
 * `isPasteableIdent`, not the command gate's exactness — M16 of the
 * go-to-k/cdkd#3613 review. The command gate answers the shell: a `$(...)`
 * name is inert inside `'...'`. This line answers what an operator READS: it
 * sits beside a labelled command, so it takes `isPasteableIdent` per
 * `state-malformed-containers.md` (go-to-k/cdkd#3328), which refuses the
 * space and the `:` exactness keeps — the characters a name uses to spell a
 * fake `Migrate with:` row once the terminal wraps. Since M17 the COMMAND
 * beside this line takes the same predicate (`pasteableCommand`'s
 * `plainIdent`), so `$(printf INJECTED)` is withheld from BOTH — an earlier
 * version of this comment recorded it as named by the command and withheld
 * here, which was true between M16 and M17 and left the command line as the
 * forgery's carrier.
 *
 * USED BY SITE 1 ALONE, deliberately. Sites 2–4 also print labelled commands
 * now (through `mayNameTarget`, `isPasteableIdent` on both identifiers), but
 * their blocks ALSO display the stack name in their own headers, so a separate
 * identity line there would be a second copy of a value the block already
 * shows. An earlier version of this comment said those sites "keep their
 * command in prose"; they did until this PR, and the sentence outlived it.
 */
export function stackIdentityLine(
  stackName: string,
  /**
   * No production caller passes this, and NOTHING exercises it — this function
   * is private and its one caller omits the parameter, so deleting `${indent}`
   * reds nothing. Kept as a placeholder for a nested block that wants the line
   * indented; read it as that, not as a tested path. It was described as
   * go-to-k/cdkd#3436's landing place, which is now settled: that fold-in went
   * to the shared `pasteableCommand` rather than to this helper. Documented HERE rather than only in `stackCommandFor`'s
   * docblock, which is where round 5 found it: a dead parameter's
   * justification belongs on the parameter.
   */
  indent = ''
): string | undefined {
  // `isPasteableIdent`, not `rendersExactly` (M16 of the go-to-k/cdkd#3613
  // review). This line sits BESIDE a labelled command line, and that is the
  // shape `.claude/rules/state-malformed-containers.md` (go-to-k/cdkd#3328)
  // governs: exactness keeps a SPACE and a `:`, so a name such as
  // `Prod<60 spaces>Migrate with: cdkd destroy --all --force #` renders
  // exactly and wraps into a fake `Migrate with:` row once the terminal folds
  // it -- a row whose `#` comments out whatever closing quote rides after it,
  // so it RUNS as pasted (M17: an earlier example here ended in `*`, which
  // made the command gate withhold it too and hid that the command line was
  // the forgery's second carrier). The COMMAND beside this line takes the same
  // predicate through `pasteableCommand`'s `plainIdent` option, so the two
  // lines never disagree: a refused name prints no `Stack:` line and a hole
  // in the command, and the withheld clause says why. Sites 2-4 took the rule
  // as `mayNameTarget`; site 1 is go-to-k/cdkd#3307's own.
  return isPasteableIdent(stackName) ? `${indent}Stack: ${shellQuote(stackName)}` : undefined;
}

/**
 * Reusable `--stack-region <region>` option (mirrors `state show`).
 */
export function stackRegionOption(): Option {
  return new Option(
    '--stack-region <region>',
    'Region of the stack record to inspect. Required when the same stack name has state in multiple regions.'
  ).argParser(parseStackRegion);
}
