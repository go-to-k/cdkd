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

const MAX_SKILL_MD_BYTES = 36_000; // largest non-split skill measured 32,527 B (verify-pr, 2026-08-31)
const MAX_ORCHESTRATOR_BYTES = 12_000; // work-issues orchestrator was ~6.5 KB at the 2026-08-28 split; re-measured 11,277 B on 2026-09-01
// That number is the point, not trivia: the orchestrator has grown to within
// 723 B of its cap while the comment above still quoted the at-split figure, so
// nobody adding a paragraph could see how little room was left. It reached 11,634 B
// before this pass MOVED the launch-mode probe and its edge cases into
// references/triage.md (which already held the section that consumes the answer)
// rather than compressing them away. Re-measure this comment whenever the
// orchestrator is edited -- a cap with an unmeasured margin is a cap nobody can
// plan against.
// Set 2026-08-28 after the rule+citation compression (PR #2377), when the
// largest stage file was implement.md at 44,875 B; the cap keeps the same ~9%
// headroom ratio the original 64,000 held over 58,698 B, so the retro.md §10-b
// fold-back loop cannot silently erode the compression's gain. Re-measured
// 2026-09-01: the largest is implement.md again at 45,763 B -- it lost the title
// to verify.md when 6.4 KB moved out of it into filing.md on 2026-08-31 and took
// it back when this pass added the owner-probe and branch-recipe text, which is
// exactly why "largest" is re-derived here and never carried forward. The cap is
// UNCHANGED; only the measurement it was set against is restated, so the next
// reader compares against a true number. Headroom is now 3,237 B (6.6%), down
// from the ~9% the cap was originally sized for -- worth watching, not worth
// loosening an upper bound over.
const MAX_REFERENCE_FILE_BYTES = 49_000;

// The split skill's stage files must still exist and still carry the moved
// content. 8 files / ~235 KB at the split, compressed to ~181 KB on
// 2026-08-28 (rule + citation form, PR #2377); 9 files / ~202 KB on 2026-08-31,
// when the mid-lane filing rules moved out of implement.md into filing.md. The
// floor sits far enough below that narrative COMPRESSION stays legal while
// wholesale deletion fails — see the re-derivation beside
// MIN_REFERENCE_CORPUS_BYTES below. Division of labor, measured at the
// split: deleting ONE mid-sized stage file cleared both floors here — the
// per-file guard for that case is work-issues-skill-refs.test.ts's
// MIRRORED_DOCS count floor, which pins the exact document count. These
// floors exist for the WHOLESALE direction only.
const SPLIT_SKILLS = ['work-issues'];
const MIN_REFERENCE_FILES = 6;
// The floor must sit ABOVE `corpus - largest file`, or hollowing out the single
// biggest stage file still passes and the guard is silent about it. Re-measured
// 2026-08-31 AFTER the filing.md split: corpus 201,740 B, largest verify.md
// 43,529 B (implement.md was the largest until 6.4 KB moved out of it, which is
// exactly why "largest" is re-derived and never carried forward), so the
// property needs a floor above 201,740 - 43,529 = 158,211 -- which the 100_000
// held here had stopped providing as the corpus grew. 161_000 restored it (a
// strictly TIGHTER assertion; no upper bound was touched).
// Re-derived again 2026-09-01 (review round 3): corpus 208,772 B, largest
// implement.md 45,763 B, so the property needs a floor above 208,772 - 45,763 =
// 163,009, which 163_000 no longer clears -- by 9 B. Stated precisely, because
// the imprecise version ("it had already lapsed") reads as a silent decay
// BETWEEN rounds and that is not what happened: at the previous commit it held
// by 3,097 B, and this commit's own +5,340 B crossed it. That is the point
// rather than a mitigation -- one ordinary round of edits was enough to consume
// a margin raised one round earlier specifically so it would not be, so the
// raise is sized against the worst case rather than the current one.
// The worst case is not `corpus - largest`. implement.md (45,763 B) and
// verify.md (43,529 B) are 2,234 B apart and have already swapped the title
// once, so the floor must also survive verify.md becoming largest:
// 208,772 - 43,529 = 165,243. 168_000 clears BOTH -- 4,991 B of margin over
// today's binding number, 2,757 B over the either-largest one -- and still
// leaves ~40 KB (208,772 - 168,000 = 40,772 B) of narrative compression
// headroom below the floor. Re-measure BOTH files whenever a stage file changes
// size materially: a lapsed floor is not a weaker guard but a SILENT one.
const MIN_REFERENCE_CORPUS_BYTES = 168_000;

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
