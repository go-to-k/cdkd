/**
 * Fence the "Cost is not a tiebreaker for verification depth" rule.
 *
 * The rule itself is prose (CLAUDE.md -> Workflow Rules, plus the skills that
 * make the decision it governs). Prose erodes: the wording this checker exists
 * to keep out is exactly what the repo carried BEFORE the rule — `/review-pr`
 * opened with "Running all 3 reviewer agents on every PR is expensive (~25 min)"
 * and CLAUDE.md said a 3-axis review "is overkill ... the cost exceeds the catch",
 * which is a standing licence to under-verify that no test would ever fail on.
 *
 * Memory cannot carry this: it is per-machine, and the maintainer runs several
 * terminals. So it lives in the repo and is enforced here.
 *
 * TWO checks, deliberately narrow so this cannot become a thesaurus lint:
 *
 * 1. PRESENCE — CLAUDE.md must still carry the rule anchor. This is what makes
 *    the rule survive a CLAUDE.md rewrite / size-trim; the file is auto-loaded
 *    into every session, so losing the anchor silently restores the old default.
 *
 * 2. NO COST-BASED DOWNSCALING in the skills that CHOOSE a verification depth.
 *    Scoped to that decision-making set (`GOVERNED_SKILLS`) rather than every
 *    skill, because "cost" is a legitimate word elsewhere: `/cleanup` ranks
 *    cost-BEARING leftovers and `/hunt-bugs` is explicitly a cost-is-no-object
 *    sweep. Those are arguments FOR spending, and flagging them would train the
 *    next author to delete a true statement. (`/run-integ` IS governed, and its
 *    NAT-gateway-cost line survives because the phrase list matches arguments
 *    for doing LESS, not the word `cost`.)
 *
 * The phrase list matches ARGUMENTS, not the word "cost": each entry is a
 * construction whose only use is to justify doing LESS verification. A governed
 * skill that needs to QUOTE one (e.g. `/review-pr` restating the retired
 * rationale in order to override it) takes the per-line allow marker below --
 * there is no file-level exemption, for the reason recorded beside
 * `GOVERNED_SKILLS`.
 *
 * Escape hatch: `<!-- allow-cost-downscale: <reason> -->` on the line or the
 * line above. The reason is mandatory; a bare marker is rejected, matching the
 * `allow-mode-gated-drop` convention in `check-integ-mode-gated-resources.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** CLAUDE.md must still carry this exact anchor. */
export const RULE_ANCHOR = 'Cost is not a tiebreaker for verification depth';

/*
 * There is deliberately NO file-level exemption. The first cut skipped any file
 * carrying a "FLOOR, not a cap" disclaimer, so `review-pr` and `pick-integ` --
 * the two skills this rule exists for, both of which carry it -- were never
 * pattern-scanned at all: appending the exact banned sentence to the real
 * `review-pr/SKILL.md` produced ZERO violations. The probe that was supposed to
 * catch that had stripped the disclaimer first, i.e. it exercised a path the
 * real tree never takes -- the shared-blind-spot failure `.claude/rules/
 * testing.md` warns about. A quoted rationale now takes the per-LINE allow
 * marker like any other, which is the same granularity and cannot go vacuous.
 */

/**
 * Skills whose job is to CHOOSE how much verification a change gets. Only
 * these are scanned — see the header for why the scope is not "every skill".
 */
export const GOVERNED_SKILLS = ['review-pr', 'pick-integ', 'run-integ', 'verify-pr'] as const;

/**
 * `CLAUDE.md` is pattern-scanned too, not merely checked for the anchor. It is
 * half the motivating regression (it carried "is overkill ... the cost exceeds
 * the catch ... skip the reviewers"), and the first cut fenced only its anchor
 * — so restoring that exact sentence produced ZERO violations while
 * `anchorPresent` stayed true. It is also auto-loaded into every session, which
 * makes it the highest-leverage place for the wording to come back.
 */
export const GOVERNED_ROOT_DOCS = ['CLAUDE.md'] as const;

/**
 * Constructions whose only use is to justify LESS verification. Each is an
 * argument, not a topic word — `cost` / `expensive` alone are deliberately NOT
 * here, because both appear in arguments FOR spending elsewhere in the tree.
 */
export const DOWNSCALE_PATTERNS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\bis overkill\b/i, why: 'calls a higher verification tier "overkill"' },
  { pattern: /\bcost exceeds the catch\b/i, why: 'weighs verification cost against its yield' },
  { pattern: /\bskip the reviewers\b/i, why: 'advises skipping review' },
  { pattern: /\btoo expensive to (?:run|verify|check)\b/i, why: 'declines verification on cost' },
  { pattern: /\bnot worth (?:the )?(?:a )?(?:full |real[- ]AWS )?(?:run|integ|review)\b/i, why: 'declines a run/review as not worth it' },
  { pattern: /\brun (?:only )?the cheapest\b/i, why: 'selects a verification step by cost' },
  { pattern: /\bto save (?:a|the|an) (?:run|integ|deploy)\b/i, why: 'narrows verification to save a run' },
  { pattern: /\btoo costly\b/i, why: 'declines verification as too costly' },
  { pattern: /\bfor little gain\b/i, why: 'weighs verification effort against its yield' },
  { pattern: /\b(?:one|a) narrow (?:fixture|integ|test) is enough\b/i, why: 'accepts narrow coverage as sufficient' },
  { pattern: /\bdrains attention\b/i, why: 'treats review effort as a cost to minimise' },
];

export interface DepthRuleViolation {
  file: string;
  line: number;
  text: string;
  why: string;
}

export interface DepthRuleReport {
  anchorPresent: boolean;
  /** Skills whose file was READ. */
  scannedSkills: string[];
  /** Lines READ. */
  scannedLines: number;
  /**
   * Skills whose lines were actually PATTERN-MATCHED, and how many. Separate
   * from the read counters on purpose: the first cut incremented the read
   * counters and then `continue`d past the matching, so a gutted skill still
   * satisfied a 400-line floor while nothing was inspected. Floor on THESE.
   */
  patternScannedSkills: string[];
  patternScannedLines: number;
  violations: DepthRuleViolation[];
}

const ALLOW_RE = /<!--\s*allow-cost-downscale:\s*(\S.*?)\s*-->/;

/**
 * A banned construction inside a PROHIBITION is the rule being stated, not
 * broken: the rule's own text says "Do not narrow an integ selection to save a
 * run", which matches `to save a run` verbatim. Scoped to the text BEFORE the
 * match so a trailing "... but never do X" cannot launder a real downscale
 * earlier in the same line.
 */
const PROHIBITION_RE = /\b(?:do not|don't|never|must not|rather than|instead of|no longer)\b/i;

function isProhibition(text: string, matchIndex: number): boolean {
  return PROHIBITION_RE.test(text.slice(0, matchIndex));
}

/** True when `lines[i]` (or the line above it) carries a REASONED allow marker. */
function isAllowed(lines: string[], i: number): boolean {
  for (const candidate of [lines[i], i > 0 ? lines[i - 1] : undefined]) {
    const m = candidate?.match(ALLOW_RE);
    // A bare marker with no reason does not count — same bar as
    // `allow-mode-gated-drop`.
    // A reason must be a real sentence fragment, not a placeholder: `\S.*?`
    // alone accepted a single character.
    if (m && m[1] && m[1].trim().length >= 12) return true;
  }
  return false;
}

export function checkVerificationDepthRule(repoRoot: string): DepthRuleReport {
  const claudeMd = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  const violations: DepthRuleViolation[] = [];
  const scannedSkills: string[] = [];
  const patternScannedSkills: string[] = [];
  let scannedLines = 0;
  let patternScannedLines = 0;

  const targets: Array<{ name: string; rel: string }> = [
    ...GOVERNED_SKILLS.map((skill) => ({
      name: skill,
      rel: join('.claude', 'skills', skill, 'SKILL.md'),
    })),
    ...GOVERNED_ROOT_DOCS.map((doc) => ({ name: doc, rel: doc })),
  ];

  for (const { name: skill, rel } of targets) {
    let body: string;
    try {
      body = readFileSync(join(repoRoot, rel), 'utf8');
    } catch {
      // A governed skill that no longer exists is not a violation — the set is
      // a list of decision points, and removing one removes its decision. It IS
      // reported as unscanned via `scannedSkills`, which the floors assert on,
      // so a rename cannot silently empty this checker.
      continue;
    }
    scannedSkills.push(skill);

    const lines = body.split('\n');
    scannedLines += lines.length;
    patternScannedSkills.push(skill);
    patternScannedLines += lines.length;

    lines.forEach((text, i) => {
      for (const { pattern, why } of DOWNSCALE_PATTERNS) {
        const m = pattern.exec(text);
        if (!m) continue;
        if (isProhibition(text, m.index)) continue;
        if (isAllowed(lines, i)) continue;
        violations.push({ file: rel, line: i + 1, text: text.trim(), why });
        return;
      }
    });
  }

  return {
    anchorPresent: claudeMd.includes(RULE_ANCHOR),
    scannedSkills,
    scannedLines,
    patternScannedSkills,
    patternScannedLines,
    violations,
  };
}
