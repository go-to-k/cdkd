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

  it('scans every governed skill that exists, not a subset', () => {
    const report = checkVerificationDepthRule(REPO_ROOT);
    // All four exist today. A rename must fail HERE (loudly) rather than
    // silently shrinking the scanned set to nothing — the vacuous-pass shape
    // `.claude/rules/testing.md` forbids.
    expect(report.scannedSkills).toEqual([...GOVERNED_SKILLS]);
  });

  it('actually reads the skill bodies (per-shape floor, not just a total)', () => {
    const report = checkVerificationDepthRule(REPO_ROOT);
    // The four governed skills are long documents; a broken read would yield a
    // near-zero count while `violations` stayed empty and everything above
    // still passed.
    expect(report.scannedLines).toBeGreaterThan(400);
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
      // Removing the floor disclaimer is what re-arms the scan — a governed
      // skill carrying the disclaimer is allowed to quote the old rationale.
      const stripped = body.replace(/\*\*The recommended tier is a FLOOR[^\n]*\n/, '');
      writeFileSync(
        p,
        `${stripped}\n\nRunning all 3 on every PR is overkill and the cost exceeds the catch.\n`
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
      const stripped = body.replace(/\*\*The ranking is a running ORDER[^\n]*\n/, '');
      writeFileSync(p, `${stripped}\n\nDrop the P2 rows to save a run.\n`);
    });
    expect(report.violations.some((v) => v.file.includes('pick-integ'))).toBe(true);
  });

  it('stays silent while the floor disclaimer is present, even beside the old wording', () => {
    // The DISCRIMINATION case: /review-pr legitimately quotes the cost argument
    // in order to override it. Without this the checker would force the rule's
    // own explanation out of the file it governs.
    const report = withRepoCopy((root) => {
      const p = join(root, '.claude', 'skills', 'review-pr', 'SKILL.md');
      const body = readFileSync(p, 'utf8');
      expect(body).toMatch(/FLOOR, not a cap/);
      writeFileSync(p, `${body}\n\nThe old rule said this is overkill; it no longer applies.\n`);
    });
    expect(report.violations).toEqual([]);
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
