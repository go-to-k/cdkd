import { describe, it, expect } from 'vite-plus/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkVerificationDepthRule,
  GOVERNED_SKILLS,
  RULE_ANCHOR,
} from '../../../scripts/check-verification-depth-rule.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * Fences the "Cost is not a tiebreaker for verification depth" rule
 * (CLAUDE.md -> Workflow Rules).
 *
 * Per `.claude/rules/testing.md`, a checker needs BOTH halves: floors that
 * prove it SEES its input, and real-code probes that prove it still REJECTS a
 * violation. The probes here mutate a COPY of the real tree (never `src/` or
 * `.claude/`), the same `--providers-dir=`-style seam the sibling checkers use.
 */
describe('verification-depth rule checker', () => {
  // ─── the real tree must be clean ──────────────────────────────────────

  it('the real repo carries the rule anchor and has no cost-based downscaling', () => {
    const report = checkVerificationDepthRule(REPO_ROOT);
    expect(report.anchorPresent).toBe(true);
    expect(report.violations).toEqual([]);
  });

  // ─── coverage floors: prove the checker SEES its input ────────────────

  it('PATTERN-scans every governed skill, not merely reads it', () => {
    const report = checkVerificationDepthRule(REPO_ROOT);
    expect(report.scannedSkills).toEqual([...GOVERNED_SKILLS]);
    // The load-bearing assertion is on the PATTERN-scanned set, not the read
    // set. The first cut counted a file as scanned and then skipped the
    // matching for it, so `scannedSkills` reported all four while two were
    // never inspected — floors on the read counters cannot see that.
    expect(report.patternScannedSkills).toEqual([...GOVERNED_SKILLS]);
  });

  it('actually matches against the skill bodies (floor on the PATTERN-scanned lines)', () => {
    const report = checkVerificationDepthRule(REPO_ROOT);
    expect(report.patternScannedLines).toBeGreaterThan(700);
    // Read and pattern-scanned must agree: any gap means some file was read
    // and then skipped, which is exactly the vacuity this floor exists for.
    expect(report.patternScannedLines).toBe(report.scannedLines);
  });

  // ─── real-code probes: prove the checker FAILS ────────────────────────

  function withRepoCopy(mutate: (root: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'cdkd-depth-rule-'));
    try {
      writeFileSync(join(root, 'CLAUDE.md'), readFileSync(join(REPO_ROOT, 'CLAUDE.md')));
      for (const skill of GOVERNED_SKILLS) {
        const dir = join(root, '.claude', 'skills', skill);
        mkdirSync(dir, { recursive: true });
        cpSync(join(REPO_ROOT, '.claude', 'skills', skill, 'SKILL.md'), join(dir, 'SKILL.md'));
      }
      mutate(root);
      return checkVerificationDepthRule(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('reports the anchor missing when CLAUDE.md drops the rule', () => {
    const report = withRepoCopy((root) => {
      const p = join(root, 'CLAUDE.md');
      const body = readFileSync(p, 'utf8');
      expect(body).toContain(RULE_ANCHOR);
      writeFileSync(p, body.replace(RULE_ANCHOR, 'Some unrelated heading'));
    });
    expect(report.anchorPresent).toBe(false);
  });

  it('flags the EXACT wording /review-pr carried before the rule', () => {
    // Not a synthetic phrase: this is the real pre-rule sentence, restored.
    const report = withRepoCopy((root) => {
      const p = join(root, '.claude', 'skills', 'review-pr', 'SKILL.md');
      const body = readFileSync(p, 'utf8');
      writeFileSync(
        p,
        `${body}\n\nRunning all 3 on every PR is overkill and the cost exceeds the catch.\n`
      );
    });
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.violations[0]!.file).toContain('review-pr');
    expect(report.violations.map((v) => v.why).join(' ')).toMatch(/overkill/);
  });

  it('flags a pick-integ plan narrowed to save a run', () => {
    const report = withRepoCopy((root) => {
      const p = join(root, '.claude', 'skills', 'pick-integ', 'SKILL.md');
      const body = readFileSync(p, 'utf8');
      writeFileSync(p, `${body}\n\nDrop the P2 rows to save a run.\n`);
    });
    expect(report.violations.some((v) => v.file.includes('pick-integ'))).toBe(true);
  });

  it('STILL flags banned wording in a skill that carries the floor disclaimer', () => {
    // The blocker the 1-reviewer pass found, inverted into a fence. The first
    // cut exempted the whole FILE when it carried the disclaimer, and both
    // `review-pr` and `pick-integ` carry it — so the two skills this rule
    // exists for were never pattern-scanned at all. Note this probe does NOT
    // strip the disclaimer: stripping it is what made the original probe pass
    // for the wrong reason, exercising a path the real tree never takes.
    const report = withRepoCopy((root) => {
      const p = join(root, '.claude', 'skills', 'review-pr', 'SKILL.md');
      const body = readFileSync(p, 'utf8');
      expect(body).toMatch(/FLOOR, not a cap/);
      writeFileSync(p, `${body}\n\nRunning all 3 on every PR is overkill; skip the reviewers.\n`);
    });
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.violations[0]!.file).toContain('review-pr');
  });

  it('flags the same wording in pick-integ, the other disclaimer-carrying skill', () => {
    const report = withRepoCopy((root) => {
      const p = join(root, '.claude', 'skills', 'pick-integ', 'SKILL.md');
      const body = readFileSync(p, 'utf8');
      expect(body).toMatch(/running ORDER, not a budget/);
      writeFileSync(p, `${body}\n\nDrop the P2 rows to save a run.\n`);
    });
    expect(report.violations.some((v) => v.file.includes('pick-integ'))).toBe(true);
  });

  it('honours a REASONED allow marker but rejects a bare one', () => {
    const reasoned = withRepoCopy((root) => {
      const p = join(root, '.claude', 'skills', 'verify-pr', 'SKILL.md');
      const body = readFileSync(p, 'utf8');
      writeFileSync(
        p,
        `${body}\n<!-- allow-cost-downscale: quoting the retired heuristic verbatim -->\nRunning all 3 is overkill.\n`
      );
    });
    expect(reasoned.violations).toEqual([]);

    const bare = withRepoCopy((root) => {
      const p = join(root, '.claude', 'skills', 'verify-pr', 'SKILL.md');
      const body = readFileSync(p, 'utf8');
      writeFileSync(p, `${body}\n<!-- allow-cost-downscale: -->\nRunning all 3 is overkill.\n`);
    });
    expect(bare.violations.length).toBeGreaterThan(0);

    // A placeholder is not a reason either.
    const token = withRepoCopy((root) => {
      const p = join(root, '.claude', 'skills', 'verify-pr', 'SKILL.md');
      const body = readFileSync(p, 'utf8');
      writeFileSync(p, `${body}\n<!-- allow-cost-downscale: n -->\nRunning all 3 is overkill.\n`);
    });
    expect(token.violations.length).toBeGreaterThan(0);
  });

  it('does NOT flag an argument FOR spending', () => {
    // `/run-integ` cites NAT-gateway cost as the reason cleanup is
    // non-negotiable, and `/cleanup` ranks cost-BEARING leftovers. Flagging the
    // word `cost` would train the next author to delete a true statement.
    const report = withRepoCopy((root) => {
      const p = join(root, '.claude', 'skills', 'run-integ', 'SKILL.md');
      const body = readFileSync(p, 'utf8');
      writeFileSync(
        p,
        `${body}\nCost (NAT GW alone is ~$1/hr) makes the orphan sweep non-negotiable.\n`
      );
    });
    expect(report.violations).toEqual([]);
  });
});
