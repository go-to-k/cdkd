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

const MAX_SKILL_MD_BYTES = 36_000; // largest non-split skill measured 33,598 B (verify-pr, 2026-09-02)
const MAX_ORCHESTRATOR_BYTES = 12_000; // work-issues orchestrator was ~6.5 KB at the 2026-08-28 split; re-measured 11,459 B on 2026-09-01 (review round 6), leaving 541 B
// That number is the point, not trivia: the orchestrator has repeatedly grown to
// within a few hundred bytes of its cap while this comment still quoted the
// at-split figure, so nobody adding a paragraph could see how little room was
// left. Round 6 added the whole parent-runs-the-probe design and still came out
// 87 B SMALLER than round 4's 11,546 B, by putting the new material in
// references/launch-mode.md (7,376 B, read once before stage 0) and leaving a
// pointer here -- the direction this cap exists to force. Re-measure this
// comment whenever the orchestrator is edited: a cap with an unmeasured margin
// is a cap nobody can plan against.
// Set 2026-08-28 after the rule+citation compression (PR #2377), when the
// largest stage file was implement.md at 44,875 B; the cap keeps the same ~9%
// headroom ratio the original 64,000 held over 58,698 B, so the retro.md §10-b
// fold-back loop cannot silently erode the compression's gain. Re-measured
// 2026-09-01 (review round 6): the largest is implement.md at 46,771 B, with
// verify.md 3,242 B behind it. The two have already swapped the title once
// (6.4 KB moved out of implement.md into filing.md on 2026-08-31 and the
// owner-probe text moved back in), which is exactly why "largest" is re-derived
// here and never carried forward. The cap is UNCHANGED; only the measurement it
// was set against is restated, so the next reader compares against a true
// number. Headroom is now 2,229 B (4.5%), down from the ~9% the cap was
// originally sized for -- worth watching, not worth loosening an upper bound
// over.
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
// biggest stage file still passes and the guard is silent about it. That
// property is now ASSERTED at the bottom of this file rather than only
// described here -- it had lapsed silently more than once, each time found by a
// human re-deriving it by hand from a comment.
// Re-derived 2026-09-01 at the FINAL tree of review round 6: 10 stage files,
// corpus 220,152 B, largest implement.md 46,771 B, so the property needs a floor
// above 220,152 - 46,771 = 173,381. The worst case is not that number, though:
// verify.md is 43,529 B, only 3,242 B behind, and the two have already swapped
// the title once, so the floor must also survive verify.md becoming largest --
// 220,152 - 43,529 = 176,623. 180_000 clears the binding number by 6,619 B and
// the either-largest one by 3,377 B, is strictly TIGHTER than the 170_000 it
// replaces (no upper bound is touched), and still leaves ~40 KB
// (220,152 - 180,000 = 40,152 B) of narrative compression headroom below it.
//
// What this floor does NOT catch, stated plainly because the comment used to
// imply otherwise: gutting a NON-largest stage file. Deleting the whole of
// triage.md (34,955 B) leaves 185,197 B, still over the floor. A byte floor
// cannot see that, and raising it until it could would forbid legitimate
// compression. The per-file guards are elsewhere and are about CONTENT rather
// than size: work-issues-skill-refs.test.ts pins the document COUNT, and
// work-issues-launch-mode.test.ts pins that each arm-bearing stage file still
// names the mode it branches on and that the probe still exists exactly once.
const MIN_REFERENCE_CORPUS_BYTES = 180_000;

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

      // The floor's OWN invariant, asserted rather than described. Everything
      // above only says "the corpus is big enough"; what the floor is FOR is
      // that deleting the single largest stage file cannot pass, which holds
      // only while the floor sits above `corpus - largest`. That property
      // decays silently as the other files grow -- it has lapsed at least once
      // per repo, each time discovered by a human re-deriving it by hand from
      // the comment above. Asserting it makes the next lapse a red test at the
      // commit that causes it, and the failure message carries the number to
      // raise the floor to.
      const largest = Math.max(...refs.map((f) => statSync(f).size));
      expect(
        MIN_REFERENCE_CORPUS_BYTES,
        `MIN_REFERENCE_CORPUS_BYTES (${MIN_REFERENCE_CORPUS_BYTES}) has lapsed: the ` +
          `${name} corpus is ${total} B and its largest stage file is ${largest} B, so ` +
          `deleting that one file would leave ${total - largest} B and still pass. Raise ` +
          `the floor above ${total - largest} (and re-derive the comment beside it), or ` +
          `re-derive it DOWNWARD in the same commit as a genuine compression pass.`,
      ).toBeGreaterThan(total - largest);
    });
  }
});
