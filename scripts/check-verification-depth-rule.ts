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
 *    cost-BEARING leftovers, `/hunt-bugs` is explicitly a cost-is-no-object
 *    sweep, `/run-integ` cites NAT-gateway cost as a reason cleanup is
 *    non-negotiable. Those are arguments FOR spending, and flagging them would
 *    train the next author to delete a true statement.
 *
 * The phrase list matches ARGUMENTS, not the word "cost": each entry is a
 * construction whose only use is to justify doing LESS verification. A governed
 * skill may still use one when it also carries the floor disclaimer (the
 * `FLOOR_DISCLAIMER` anchor), which is how `/review-pr` legitimately quotes the
 * old rationale while overriding it.
 *
 * Escape hatch: `<!-- allow-cost-downscale: <reason> -->` on the line or the
 * line above. The reason is mandatory; a bare marker is rejected, matching the
 * `allow-mode-gated-drop` convention in `check-integ-mode-gated-resources.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** CLAUDE.md must still carry this exact anchor. */
export const RULE_ANCHOR = 'Cost is not a tiebreaker for verification depth';

/**
 * A governed skill may quote a cost argument when it ALSO says the tier is a
 * floor. Matching on the shared phrase keeps the two in one place.
 */
export const FLOOR_DISCLAIMER = /FLOOR, not a cap|running ORDER, not a budget/i;

/**
 * Skills whose job is to CHOOSE how much verification a change gets. Only
 * these are scanned — see the header for why the scope is not "every skill".
 */
export const GOVERNED_SKILLS = ['review-pr', 'pick-integ', 'run-integ', 'verify-pr'] as const;

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
];

export interface DepthRuleViolation {
  file: string;
  line: number;
  text: string;
  why: string;
}

export interface DepthRuleReport {
  anchorPresent: boolean;
  scannedSkills: string[];
  scannedLines: number;
  violations: DepthRuleViolation[];
}

const ALLOW_RE = /<!--\s*allow-cost-downscale:\s*(\S.*?)\s*-->/;

/** True when `lines[i]` (or the line above it) carries a REASONED allow marker. */
function isAllowed(lines: string[], i: number): boolean {
  for (const candidate of [lines[i], i > 0 ? lines[i - 1] : undefined]) {
    const m = candidate?.match(ALLOW_RE);
    // A bare marker with no reason does not count — same bar as
    // `allow-mode-gated-drop`.
    if (m && m[1] && m[1].length > 0) return true;
  }
  return false;
}

export function checkVerificationDepthRule(repoRoot: string): DepthRuleReport {
  const claudeMd = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  const violations: DepthRuleViolation[] = [];
  const scannedSkills: string[] = [];
  let scannedLines = 0;

  for (const skill of GOVERNED_SKILLS) {
    const rel = join('.claude', 'skills', skill, 'SKILL.md');
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

    const hasDisclaimer = FLOOR_DISCLAIMER.test(body);
    const lines = body.split('\n');
    scannedLines += lines.length;
    if (hasDisclaimer) continue;

    lines.forEach((text, i) => {
      for (const { pattern, why } of DOWNSCALE_PATTERNS) {
        if (pattern.test(text) && !isAllowed(lines, i)) {
          violations.push({ file: rel, line: i + 1, text: text.trim(), why });
          return;
        }
      }
    });
  }

  return {
    anchorPresent: claudeMd.includes(RULE_ANCHOR),
    scannedSkills,
    scannedLines,
    violations,
  };
}
