import { describe, it, expect } from 'vite-plus/test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Byte budget for `.claude/skills/<name>/SKILL.md` — the skills-side sibling of
 * `rule-file-payload.test.ts`, guarding the SAME failure mode one directory
 * over: a file that is loaded WHOLE into an agent's context accreting
 * narrative PR-by-PR with no size feedback anywhere.
 *
 * A SKILL.md is injected in full the moment its skill is invoked, so its byte
 * size is a fixed token toll paid at every invocation, re-paid on every context
 * compaction. MEASURED on 2026-08-28: `work-issues/SKILL.md` was 231,172 B when
 * the split branched and 236,939 B by the time it landed (~83-85k tokens — over
 * half a context window spent before the run's first action), grown by its own
 * §10 fold-back loop: every run appended lessons to the file every future run
 * must load. The remedy was progressive disclosure — a thin SKILL.md orchestrator
 * plus per-stage `references/*.md` files read only when the run enters that
 * stage — and this fence is what keeps the orchestrator from growing back.
 *
 * Three mechanical properties are fenced; content-worth stays a human call:
 *
 *   1. no SKILL.md may exceed MAX_SKILL_MD_BYTES;
 *   2. a SPLIT skill (one with a `references/` dir) keeps its SKILL.md a thin
 *      orchestrator, under MAX_ORCHESTRATOR_BYTES — the fold-back loop's
 *      natural target is the file that is always loaded, so that file gets the
 *      tight cap while stage files get a looser one;
 *   3. no single reference file may exceed MAX_REFERENCE_FILE_BYTES — a stage
 *      file is still loaded whole at stage entry, so unbounded growth there
 *      re-creates the original problem one hop away.
 *
 * Plus a deletion floor scoped to the split skill: the split promised to MOVE
 * content, not drop it, and every other assertion here is a one-sided upper
 * bound — so without the floor, "reduce payload" by deleting the stage files
 * outright would read as an improvement.
 *
 * Working-tree measurement, deliberately NOT the merge projection
 * `rule-file-payload.test.ts` uses: that projection exists because the rules
 * corpus asserts a cumulative SUM two green branches can jointly exceed.
 * Every cap here is per-file, where a merge combines deltas to the SAME file
 * only when both lanes edited it — the ordinary conflict surface, not a
 * silent sum collision.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skillsDir = join(repoRoot, '.claude', 'skills');

const MAX_SKILL_MD_BYTES = 36_000; // largest non-split skill measured 32,132 B (verify-pr)
const MAX_ORCHESTRATOR_BYTES = 12_000; // work-issues orchestrator measured ~6.5 KB at the split
// Re-measured 2026-08-28 after the rule+citation compression (PR #2377):
// largest stage file is now implement.md at 44,875 B; the cap keeps the same
// ~9% headroom ratio the original 64,000 held over 58,698 B, so the retro.md
// §10-b fold-back loop cannot silently erode the compression's gain.
const MAX_REFERENCE_FILE_BYTES = 49_000;

// The split skill's stage files must still exist and still carry the moved
// content. 8 files / ~235 KB at the split, compressed to ~181 KB on
// 2026-08-28 (rule + citation form, PR #2377); the floor sits far enough
// below that narrative COMPRESSION stays legal while wholesale deletion
// fails — at ~181 KB the 100 KB floor is ~55% of the corpus, TIGHTER against
// content-gutting than the ~43% it was at the split, so it is deliberately
// kept rather than re-derived at ~50%. Division of labor, measured at the
// split: deleting ONE mid-sized stage file cleared both floors here — the
// per-file guard for that case is work-issues-skill-refs.test.ts's
// MIRRORED_DOCS count floor, which pins the exact document count. These
// floors exist for the WHOLESALE direction only.
const SPLIT_SKILLS = ['work-issues'];
const MIN_REFERENCE_FILES = 6;
const MIN_REFERENCE_CORPUS_BYTES = 100_000;

function skillNames(): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(skillsDir, name, 'SKILL.md')))
    .sort();
}

function referenceFiles(name: string): string[] {
  const dir = join(skillsDir, name, 'references');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => join(dir, f));
}

describe('skill file payload budget', () => {
  const names = skillNames();

  it('actually sees the skills (the scan is not vacuous)', () => {
    // 13 skills at the time of writing; a scan that stopped matching would
    // otherwise report "0 files over budget" as green.
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  for (const name of names) {
    const skillMd = join(skillsDir, name, 'SKILL.md');
    const isSplit = referenceFiles(name).length > 0;
    const cap = isSplit ? MAX_ORCHESTRATOR_BYTES : MAX_SKILL_MD_BYTES;

    it(`${name}/SKILL.md stays under ${cap} B`, () => {
      const size = statSync(skillMd).size;
      expect(
        size,
        `.claude/skills/${name}/SKILL.md is ${size} B, over the ${cap} B cap. ` +
          (isSplit
            ? `This skill is SPLIT: its SKILL.md is a thin orchestrator and lessons ` +
              `belong in the references/<stage>.md file where they fire ` +
              `(references/retro.md section 10-b) — not here.`
            : `Split it: move per-stage detail into references/*.md files read at ` +
              `stage entry (see work-issues for the shape), or trim narrative into ` +
              `the stage file it belongs to. Every byte here is loaded on every ` +
              `invocation of the skill.`),
      ).toBeLessThanOrEqual(cap);
    });
  }

  for (const name of names) {
    for (const ref of referenceFiles(name)) {
      it(`${name}/references/${ref.split('/').pop()} stays under ${MAX_REFERENCE_FILE_BYTES} B`, () => {
        const size = statSync(ref).size;
        expect(
          size,
          `${ref} is ${size} B, over the ${MAX_REFERENCE_FILE_BYTES} B cap. A stage file ` +
            `is loaded whole at stage entry, so it carries a cap too — compress the ` +
            `narrative (rule + one-line incident citation) or split the stage.`,
        ).toBeLessThanOrEqual(MAX_REFERENCE_FILE_BYTES);
      });
    }
  }

  for (const name of SPLIT_SKILLS) {
    it(`${name} keeps its stage files (the split moved content, it did not drop it)`, () => {
      const refs = referenceFiles(name);
      expect(
        refs.length,
        `.claude/skills/${name}/references/ holds ${refs.length} stage files, below the ` +
          `floor of ${MIN_REFERENCE_FILES}. The orchestrator SKILL.md points into these; ` +
          `a wholesale deletion strands every stage (single-file deletions are pinned ` +
          `by work-issues-skill-refs.test.ts's document-count floor).`,
      ).toBeGreaterThanOrEqual(MIN_REFERENCE_FILES);
      const total = refs.reduce((n, f) => n + statSync(f).size, 0);
      expect(
        total,
        `.claude/skills/${name}/references/ totals ${total} B, below the ` +
          `${MIN_REFERENCE_CORPUS_BYTES} B floor. Every upper bound in this file reads a ` +
          `wholesale deletion as an improvement; this floor is what notices content ` +
          `being DROPPED rather than moved or compressed.`,
      ).toBeGreaterThanOrEqual(MIN_REFERENCE_CORPUS_BYTES);
    });
  }
});
