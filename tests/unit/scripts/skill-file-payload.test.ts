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
const MAX_ORCHESTRATOR_BYTES = 12_000; // work-issues orchestrator was ~6.5 KB at the 2026-08-28 split; re-measured 11,578 B on 2026-09-02 (go-to-k/cdkd#2417), leaving 422 B
// That number is the point, not trivia: the orchestrator has repeatedly grown to
// within a few hundred bytes of its cap while this comment still quoted the
// at-split figure, so nobody adding a paragraph could see how little room was
// left. Round 6 added the whole parent-runs-the-probe design and still came out
// 87 B SMALLER than round 4's 11,546 B, by putting the new material in
// references/launch-mode.md (7,376 B, read once before stage 0) and leaving a
// pointer here -- the direction this cap exists to force. Re-measure this
// comment whenever the orchestrator is edited: a cap with an unmeasured margin
// is a cap nobody can plan against.
// go-to-k/cdkd#2417 added a FOURTH probe value (LAUNCH_BRANCH) and spent ~120 B
// here saying so. Its rules -- what the value is, why it is never re-derived,
// and the section 9 restore it drives -- went to
// references/{launch-mode,claim,ship,retro,gotchas,implement,triage}.md, which
// is why a change touching a dozen files cost the always-loaded one three
// clauses. Every number in this file is now ASSERTED against the tree by the
// MEASURED record below, not merely written down: it drifted twice inside that
// single change (once when a later edit grew a stage file, once after a rebase
// pulled in go-to-k/cdkd#2418) and both times a human had to catch it.
// Set 2026-08-28 after the rule+citation compression (PR #2377), when the
// largest stage file was implement.md at 44,875 B; the cap keeps the same ~9%
// headroom ratio the original 64,000 held over 58,698 B, so the retro.md §10-b
// fold-back loop cannot silently erode the compression's gain. Re-measured
// 2026-09-02 (go-to-k/cdkd#2417): the largest is STILL implement.md -- see
// MEASURED below for its size, which is asserted rather than quoted. THIS FILE
// IS EFFECTIVELY FULL: the next lesson landing in implement.md must pay for
// itself by retiring stale text in the same file (this run retired the
// go-to-k/cdkd#2401 interim hedge, now settled by go-to-k/cdkd#2406) or the
// stage needs splitting -- go-to-k/cdkd#2424. The two have already swapped the title once
// (6.4 KB moved out of implement.md into filing.md on 2026-08-31 and the
// owner-probe text moved back in), which is exactly why "largest" is re-derived
// here and never carried forward. The cap is UNCHANGED; only the measurement it
// was set against is restated, so the next reader compares against a true
// number -- and MEASURED below makes that mechanical instead of aspirational,
// reporting the leader's remaining headroom in its own failure message. Down
// from the ~9% the cap was originally sized for -- worth watching,
// not worth loosening an upper bound
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
/**
 * The measurements every comment in this file reasons from, ASSERTED against the
 * tree rather than quoted in prose.
 *
 * WHY: each byte figure here used to live only in a comment, and comments drift
 * in the one direction that matters -- silently, while every assertion stays
 * green. Inside go-to-k/cdkd#2417 alone the stated corpus went stale TWICE (a
 * later edit grew a stage file; a rebase pulled in go-to-k/cdkd#2418), and both
 * times a reviewer, not the suite, caught it. The floor below already had a
 * self-checking invariant; the per-file cap and the corpus figures did not, and
 * that asymmetry is what this closes.
 *
 * It also surfaces the leader's remaining HEADROOM in its failure message, so an
 * eroding cap is visible BEFORE it is breached -- MAX_REFERENCE_FILE_BYTES is a
 * bare upper bound and can only report a file that is already over.
 */
const MEASURED: Record<string, { corpusBytes: number; largest: { file: string; bytes: number }; runnerUp: { file: string; bytes: number } }> = {
  // Keyed by skill, NOT module-global: the assertion below is generated per
  // entry of SPLIT_SKILLS, so a second split skill would otherwise be measured
  // against work-issues' numbers -- permanently red, with a message naming the
  // wrong file.
  'work-issues': {
    corpusBytes: 249_677,
    largest: { file: 'implement.md', bytes: 48_340 },
    runnerUp: { file: 'verify.md', bytes: 46_945 },
  },
};

const SPLIT_SKILLS = ['work-issues'];
const MIN_REFERENCE_FILES = 6;
// The floor must sit ABOVE `corpus - largest file`, or hollowing out the single
// biggest stage file still passes and the guard is silent about it. That
// property is now ASSERTED at the bottom of this file rather than only
// described here -- it had lapsed silently more than once, each time found by a
// human re-deriving it by hand from a comment.
// Re-derived 2026-09-02 at the FINAL tree of go-to-k/cdkd#2417, AFTER rebasing
// onto go-to-k/cdkd#2418 (re-derive AFTER the rebase, not before, or every
// number is the pre-merge one). The inputs are in MEASURED below and asserted,
// so only the REASONING lives here: the floor must clear `corpus - largest`,
// and also `corpus - runnerUp` for the day the two swap places (they have
// swapped once already). 206_000 clears them by ~4.7k and ~3.3k -- the pair the
// 203_000 it replaces was sized to hold -- is strictly TIGHTER than that value
// (no upper bound is touched), and leaves ~44 KB of narrative compression
// headroom below it.
//
// The EITHER-LARGEST margin is the one that erodes, and the go-to-k/cdkd#2417
// run is why the warning is here rather than in a commit message: it grew SEVEN
// non-leader stage files, which moves `corpus - runnerUp` up without moving the
// leader at all, and the floor had to be re-derived FOUR times inside one change
// as successive review rounds landed. If you are adding to a stage file that is
// not the largest, expect to re-derive this line -- and MEASURED will tell you
// so rather than letting it slide.
//
// Which HALF a growth spends is not intuitive, and the retro of the
// go-to-k/cdkd#2410 / go-to-k/cdkd#2275 run got it wrong in this very comment
// before a reviewer re-derived it. Growing the RUNNER-UP moves `corpus` and
// `runnerUp` by the same amount, so it leaves `corpus - runnerUp` UNCHANGED and
// spends only the binding (largest-side) margin; the either-largest margin is
// spent by growth in every OTHER file. That run added 1,322 B to verify.md and
// 3,608 B across launch-mode / retro / ship, and it is the SECOND number that
// moved the either-largest margin -- from 3,876 B under the old 203_000 floor
// to 268 B -- and forced this raise.
//
// The two leaders are now 1,395 B apart -- less than that run's single 1,322 B
// edit to the runner-up -- so "the day the two swap places" is one ordinary
// stage-file edit away, not hypothetical. MEASURED names both files, so a swap
// reds it rather than passing quietly.
//
// What this floor does NOT catch, stated plainly because the comment used to
// imply otherwise: gutting a NON-largest stage file. Deleting the whole of
// triage.md (38,974 B) would leave 210,703 B, which the CURRENT floor does NOT
// catch. Earlier revisions of this comment recorded that it DID, "by where it
// landed rather than by design" -- and that coincidence has now expired exactly
// as predicted, the corpus having grown past it. A smaller file gutted the same
// way was never caught either. A byte floor
// cannot see that, and raising it until it could would forbid legitimate
// compression. The per-file guards are elsewhere and are about CONTENT rather
// than size: work-issues-skill-refs.test.ts pins the document COUNT, and
// work-issues-launch-mode.test.ts pins that each arm-bearing stage file still
// names the mode it branches on and that the probe still exists exactly once.
const MIN_REFERENCE_CORPUS_BYTES = 206_000;

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
      // ONE assertion, on the RUNNER-UP. `corpus - runnerUp >= corpus - largest`
      // always holds, so a separate check against `largest` could never fail
      // while this one passed -- keeping both looked like two guarantees and was
      // one. The runner-up is also the binding direction in practice: it is the
      // margin that erodes when a change grows NON-leader files, which is what
      // this one did, four times over.
      const bySize = refs.map((f) => statSync(f).size).sort((a, b) => b - a);
      const largest = bySize[0]!;
      const runnerUp = bySize[1]!;
      expect(
        MIN_REFERENCE_CORPUS_BYTES,
        `MIN_REFERENCE_CORPUS_BYTES (${MIN_REFERENCE_CORPUS_BYTES}) has lapsed. The ${name} ` +
          `corpus is ${total} B, largest ${largest} B, runner-up ${runnerUp} B. Deleting the ` +
          `largest would leave ${total - largest} B; deleting the runner-up once the two swap ` +
          `places would leave ${total - runnerUp} B, and the floor must clear BOTH. Raise it ` +
          `above ${total - runnerUp} (and re-derive the comment beside it), or re-derive it ` +
          `DOWNWARD in the same commit as a genuine compression pass.`
      ).toBeGreaterThan(total - runnerUp);
    });

    it(`${name}: the byte figures this file reasons from still match the tree`, () => {
      const expected = MEASURED[name];
      expect(
        expected,
        `SPLIT_SKILLS lists "${name}" but MEASURED has no entry for it. Add one (the ` +
          `numbers are printed by the assertion below once the key exists), or this ` +
          `skill's byte figures are unasserted.`
      ).toBeDefined();
      const sized = referenceFiles(name)
        .map((f) => ({ file: f.split('/').pop()!, bytes: statSync(f).size }))
        .sort((a, b) => b.bytes - a.bytes);
      // A split skill has at least MIN_REFERENCE_FILES stage files (asserted
      // above), but read defensively so a one-file skill fails with THIS
      // message rather than a TypeError from `sized[1]`.
      expect(sized.length, `${name} has too few stage files to have a runner-up`).toBeGreaterThan(1);
      const actual = {
        corpusBytes: sized.reduce((n, e) => n + e.bytes, 0),
        largest: sized[0]!,
        runnerUp: sized[1]!,
      };
      const capHeadroom = MAX_REFERENCE_FILE_BYTES - actual.largest.bytes;
      expect(
        actual,
        `The MEASURED record at the top of this file no longer matches the tree.\n` +
          `  corpus     ${expected!.corpusBytes} -> ${actual.corpusBytes}\n` +
          `  largest    ${expected!.largest.file} ${expected!.largest.bytes} -> ` +
          `${actual.largest.file} ${actual.largest.bytes}\n` +
          `  runner-up  ${expected!.runnerUp.file} ${expected!.runnerUp.bytes} -> ` +
          `${actual.runnerUp.file} ${actual.runnerUp.bytes}\n` +
          `  floor margins: ${MIN_REFERENCE_CORPUS_BYTES - (actual.corpusBytes - actual.largest.bytes)} ` +
          `(binding) / ${MIN_REFERENCE_CORPUS_BYTES - (actual.corpusBytes - actual.runnerUp.bytes)} ` +
          `(either-largest)\n` +
          `  ${actual.largest.file} has ${capHeadroom} B left under the ` +
          `${MAX_REFERENCE_FILE_BYTES} B per-file cap.\n` +
          `Update MEASURED and re-read the comments that cite it -- every byte claim in ` +
          `this file is derived from these three numbers, and a stale one silently ` +
          `misleads the next author into planning against room that is not there. If the ` +
          `either-largest margin has gone small or negative, raise ` +
          `MIN_REFERENCE_CORPUS_BYTES in the same commit.`
      ).toEqual({
        corpusBytes: expected!.corpusBytes,
        largest: { file: expected!.largest.file, bytes: expected!.largest.bytes },
        runnerUp: { file: expected!.runnerUp.file, bytes: expected!.runnerUp.bytes },
      });
    });
  }
});
