/**
 * issue-classification-labels — mirror the `Severity:` / `Effort:` values an
 * issue BODY states onto the issue's LABELS.
 *
 * REPLACES: `.claude/hooks/issue-classification-label-gate.sh` (413 lines + a
 * 456-line suite).
 *
 * ## WHY (the hook's own rationale, unchanged)
 *
 * CLAUDE.md's four classification fields (`Session-fit` / `Severity` /
 * `Effort` / `Estimate`) live in the issue BODY as prose lines. That is the
 * right place for the one-line reason each carries. But prose is invisible to
 * every query the backlog is triaged with: `/work-issues` section 3's ranking
 * rule 3 ("higher `Severity` first") can only be applied by opening each body,
 * while `gh issue list --label severity:high` answers it in one call.
 *
 * So the two values with a CLOSED token set are mirrored onto labels:
 *
 *   Severity: high | medium | low    ->  severity:high | severity:medium | severity:low
 *   Effort:   small | medium | large ->  effort:small  | effort:medium  | effort:large
 *
 * ONLY those two, and the reasons are the hook's:
 *
 *   - `Session-fit` is RE-DECIDED when an issue is claimed, and a label that
 *     silently disagrees with the body is worse than no label at all.
 *   - `Estimate` is a free-form duration with NO closed value set -- CLAUDE.md's
 *     own rule that it "must name what actually eats the time" is exactly what
 *     a label cannot hold.
 *
 * The prefixed full words are CLAUDE.md's "no bare tokens" rule applied to a
 * label: `Severity` and `Effort` share the token `medium`, and their initials
 * collide in the dangerous direction (`L` is severity *low*, the least urgent
 * thing there is, and effort *large*, the biggest).
 *
 * ## THE SPACE RULE, and why it is load-bearing
 *
 * `KEY:` must be followed by AT LEAST ONE SPACE. In the hook this was not a
 * style choice: the hook's subject was the raw command TEXT, which carried both
 * the body AND the `--label severity:low` argument. The label spelling has NO
 * space after the colon and the body line does, so the space is the only thing
 * that stopped the scan from reading the gate's own `--label` argument as the
 * body's statement -- without it, `--label severity:low` SATISFIED ITS OWN
 * REQUIREMENT and every command passed vacuously.
 *
 * That exact self-satisfying shape cannot occur here: the subject is the body,
 * and the labels arrive as a separate array. The rule is preserved anyway,
 * because its OTHER effect survives intact and is the one a real body hits: a
 * body that MENTIONS a label spelling -- "add a `severity:high` label to the
 * tracker", a checklist row proposing one, a quoted `gh issue edit --add-label
 * effort:large` recipe -- is not a classification, and relaxing `+` to `*`
 * turns every such mention into a label this check would APPLY. Pinned by test.
 *
 * ## WHAT ELSE IS PRESERVED
 *
 *   - PRECEDENCE, in the form that survives. The hook read the body FILE ahead
 *     of the whole segment because a `--title 'Severity: high pages fail'` was
 *     measured OUTRANKING a body stating `Severity: low`, and the refusal then
 *     quoted a value the body never states. Here that becomes: the BODY is
 *     scanned and the TITLE is not, at all. Same rule, no parsing.
 *   - FIRST MATCH WINS, per key (the hook's `head -1`).
 *   - The DURATION carve-out. An old packed body writes `Effort: ~1-3 h`, a
 *     duration rather than one of the three verification-cycle kinds. No token
 *     matches, so nothing is demanded -- reading that field as the new `Effort`
 *     is the misreading /work-issues section 3 warns about.
 *   - Case-insensitive matching, value lower-cased (`Severity: HIGH` ->
 *     `severity:high`).
 *   - The value must be followed by a non-alphanumeric or end of line, so
 *     `Severity: highly unusual` states nothing.
 *   - Line-wise matching: `grep` is line-based, so the key and its value must
 *     share a line. `Severity:\nhigh` states nothing.
 *   - `gh issue comment` was NOT gated -- a comment is not the issue's
 *     classification. Here: the workflow runs this on `issues` events only.
 *
 * ## WHAT IS DROPPED
 *
 * All the shell parsing (see `gh-subject.ts`), and with it:
 *
 *   - `segment_labels`, the `--label` / `--add-label` / `-l` extraction with its
 *     comma-splitting and metacharacter termination. Labels are an array now.
 *   - `existing_labels`, the `gh issue view` lookup for the `gh issue edit`
 *     arm, its anchored issue-number extraction (an unanchored `/issues/N`
 *     scan used to read a link the body happened to cite and look up the WRONG
 *     issue), its `-R` repo extraction, and its FAIL-OPEN on a gh error. The
 *     workflow fetches the current labels server-side in one call.
 *   - the `.markgate.yml` repo OPT-IN. The hook fired on `gh issue create` in
 *     whatever repo the session's cwd was in, and had to refuse to impose this
 *     repo's discipline on an unrelated personal repo. A workflow file lives in
 *     exactly one repo, so the opt-in is structural and needs no code.
 *
 * ## WHAT GOT STRONGER — this check FIXES rather than refuses
 *
 * The hook could only say no: the body stated a value, no label carried it, the
 * command was blocked, and a human retyped the value onto a flag. CI can read
 * the body, derive the label, and APPLY it. Same two values, copied by the
 * thing that already read them.
 *
 * The ONE case where applying is wrong is a CONTRADICTION: the body says
 * `Severity: high` and the issue already carries `severity:low`. Someone
 * deliberately chose that label, or the body was edited without it; either way
 * silently overwriting a human's judgement is worse than the problem. So a
 * contradiction is REPORTED (comment + failing job) and never applied. That
 * split is the whole difference between this and a label bot.
 *
 * ## WHAT GOT WEAKER
 *
 *   - TIMING. The hook refused before the issue existed. This runs after, so an
 *     unlabelled issue is briefly visible unlabelled.
 *   - A label a human DELIBERATELY REMOVED looks identical, from here, to a
 *     label never applied -- so an `edited` event re-applies it. This is why
 *     the workflow does NOT trigger on `unlabeled`: re-adding a label the
 *     moment it is removed would be a fight nobody can win. Stated in
 *     `.claude/rules/layout-scripts.md` rather than left to be discovered.
 *
 * Run: `node scripts/check-issue-classification-labels.ts <subject.json> [--json|--comment]`
 *
 *   (no flag)   human-readable decisions on stdout
 *   --json      the decisions as JSON, for the workflow to act on
 *   --comment   the contradiction comment body, ready for `gh api -F body=@`
 *
 * Exit 0 = nothing to do or labels are derivable, 1 = contradiction, 2 = could
 * not run. `--comment` is a MODE of this script rather than a `node -e` bridge
 * in the workflow: the package is ESM and these files are type-stripped, so a
 * `-e` snippet reaching into the module is exactly the kind of shell-side
 * cleverness this whole port exists to delete.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSubject, type Subject } from './gh-subject.ts';

export type ClassificationField = 'severity' | 'effort';

/**
 * The CLOSED token sets. `Session-fit` and `Estimate` are deliberately absent;
 * see the header for why each one cannot be a label.
 */
export const TOKENS: Record<ClassificationField, readonly string[]> = {
  severity: ['high', 'medium', 'low'],
  effort: ['small', 'medium', 'large'],
};

export const FIELDS: readonly ClassificationField[] = ['severity', 'effort'];

/**
 * The value the body STATES for one key, or null.
 *
 * Faithful port of the hook's `classification_value`:
 *
 *   grep -oiE "${key}:[[:space:]]+(${allowed})([^[:alnum:]]|$)" | head -1 \
 *     | grep -oiE "(${allowed})" | head -1 | tr '[:upper:]' '[:lower:]'
 *
 * with three spellings translated rather than reinterpreted:
 *
 *   - `[[:space:]]+` becomes `[^\S\n]+`. The bash class includes a newline, but
 *     `grep` is LINE-BASED so it could never match one; the JS regex is not, so
 *     the newline has to be excluded explicitly or `Severity:\nhigh` would
 *     start matching and the port would be silently more permissive.
 *   - `([^[:alnum:]]|$)` becomes the lookahead `(?![A-Za-z0-9])`, which is the
 *     same predicate without consuming the character. `$` in the bash version
 *     is end-of-LINE (grep), and the lookahead covers end-of-line and
 *     end-of-string alike.
 *   - the second `grep -oiE` is folded into a capture group. It re-scanned the
 *     first match for the token; neither key (`severity`, `effort`) contains
 *     any token as a substring, so the capture is exactly equivalent.
 *
 * POSIX ERE is leftmost-LONGEST while JS alternation is leftmost-FIRST. It does
 * not matter for either token set -- no token is a prefix of another -- and
 * that is a property of these two closed sets, not a general licence.
 */
export function classificationValue(text: string, field: ClassificationField): string | null {
  const allowed = TOKENS[field].join('|');
  const re = new RegExp(`${field}:[^\\S\\n]+(${allowed})(?![A-Za-z0-9])`, 'i');
  const m = re.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/** `severity:high`, the label spelling of a stated value. */
export function labelFor(field: ClassificationField, value: string): string {
  return `${field}:${value}`;
}

export type Action =
  /** The issue already carries exactly this label. Nothing to do. */
  | 'satisfied'
  /** No label of this family. Derive it and apply it. */
  | 'apply'
  /** A label of this family is present with a DIFFERENT value. Report only. */
  | 'conflict';

export interface Decision {
  field: ClassificationField;
  /** The value the body states. */
  stated: string;
  /** The label that value implies. */
  label: string;
  action: Action;
  /** On `conflict` / `satisfied`, the family labels already on the issue. */
  existing: string[];
}

/**
 * Family membership is decided CASE-INSENSITIVELY while satisfaction requires
 * an EXACT match (the hook's `grep -qFx`).
 *
 * The asymmetry is deliberate and it always errs toward NOT writing: an issue
 * carrying `Severity:High` is not satisfied (that is a different label from
 * `severity:high`) but it IS a member of the family, so the verdict is
 * `conflict` -- reported to a human -- rather than `apply`, which would add a
 * near-duplicate label beside the one someone already chose.
 */
function familyMembers(labels: string[], field: ClassificationField): string[] {
  const prefix = `${field}:`;
  return labels.filter((l) => l.toLowerCase().startsWith(prefix));
}

/**
 * What to do about one issue. Only fields the body actually STATES appear;
 * a body stating nothing yields an empty array, which is the ordinary case for
 * a feature request and must never be reported as anything.
 */
export function decide(body: string, labels: string[]): Decision[] {
  const out: Decision[] = [];
  for (const field of FIELDS) {
    const stated = classificationValue(body, field);
    if (!stated) continue;
    const label = labelFor(field, stated);
    const existing = familyMembers(labels, field);
    let action: Action;
    if (labels.includes(label)) action = 'satisfied';
    else if (existing.length > 0) action = 'conflict';
    else action = 'apply';
    out.push({ field, stated, label, action, existing });
  }
  return out;
}

/** The labels to POST, in the order the fields are declared. */
export function labelsToApply(decisions: Decision[]): string[] {
  return decisions.filter((d) => d.action === 'apply').map((d) => d.label);
}

export function conflicts(decisions: Decision[]): Decision[] {
  return decisions.filter((d) => d.action === 'conflict');
}

/**
 * The comment posted when the body and an existing label DISAGREE.
 *
 * It never says which side is right, because this check cannot know: the body
 * may have been edited after triage, or the label may have been set by someone
 * who read more than the body says. It states both and asks for one edit.
 */
export function formatConflictComment(decisions: Decision[]): string {
  const bad = conflicts(decisions);
  const lines: string[] = [];
  lines.push('**Classification body and labels disagree.**');
  lines.push('');
  for (const d of bad) {
    const key = d.field === 'severity' ? 'Severity' : 'Effort';
    lines.push(
      `- body says \`${key}: ${d.stated}\` (implying \`${d.label}\`), but this issue carries ` +
        `${d.existing.map((l) => `\`${l}\``).join(', ')}`,
    );
  }
  lines.push('');
  lines.push(
    'The label was NOT changed. A label someone chose deliberately is not overwritten from the body — ' +
      'this is the one case where applying the derived label would be wrong.',
  );
  lines.push('');
  lines.push('Fix whichever is stale:');
  lines.push('');
  lines.push('- edit the body line, or');
  lines.push('- swap the label (`gh issue edit <n> --remove-label ... --add-label ...`).');
  lines.push('');
  lines.push(
    'Only `Severity` and `Effort` are mirrored: `Session-fit` is re-decided at claim time and a stale ' +
      'label would be worse than none, and `Estimate` is a free-form duration with no closed value set.',
  );
  lines.push('');
  lines.push('Rule: CLAUDE.md -> the four TODO classification fields.');
  return lines.join('\n');
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const commentOnly = args.includes('--comment');
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error('usage: issue-classification-labels.ts <subject.json> [--json|--comment]');
    process.exit(2);
  }
  let subject: Subject;
  try {
    subject = parseSubject(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`issue-classification-labels: cannot read subject: ${(err as Error).message}`);
    process.exit(2);
  }
  // The BODY only. See PRECEDENCE in the header: a `Severity: high` in the
  // TITLE is not the issue's classification, and the hook was measured
  // refusing a command over exactly that.
  const decisions = decide(subject.body, subject.labels);
  if (commentOnly) {
    // Only meaningful when there IS a contradiction; printing nothing is the
    // right answer otherwise, and an empty file makes `-F body=@` fail loudly
    // rather than post an empty comment.
    if (conflicts(decisions).length > 0) console.log(formatConflictComment(decisions));
    process.exit(conflicts(decisions).length > 0 ? 1 : 0);
  }
  if (json) {
    console.log(
      JSON.stringify({
        apply: labelsToApply(decisions),
        conflicts: conflicts(decisions),
        decisions,
      }),
    );
  } else {
    for (const d of decisions) {
      console.log(`${d.field}: body says ${d.stated} -> ${d.label} [${d.action}]`);
    }
    if (decisions.length === 0) console.log('No Severity / Effort line in the body — nothing to do.');
  }
  process.exit(conflicts(decisions).length > 0 ? 1 : 0);
}
