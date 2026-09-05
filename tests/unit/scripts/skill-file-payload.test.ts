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

const MAX_SKILL_MD_BYTES = 23_000; // RE-DERIVED DOWNWARD 36_000 -> 23_000 by the 2026-09-04 token-diet
// pass: largest non-split skill is now verify-pr at 20,556 B (was 33,598 B),
// and leaving the old cap would let regrowth silently erode most of the
// verify-pr / run-integ compression gain -- the same fold-back erosion the
// MAX_REFERENCE_FILE_BYTES re-derivation below exists to prevent. ~12%
// headroom over the leader; per retro.md section 10-c a retro never raises
// this to fit an addition.
const MAX_ORCHESTRATOR_BYTES = 12_000; // work-issues orchestrator was ~6.5 KB at the 2026-08-28 split; its CURRENT size is asserted as MEASURED.orchestratorBytes below, never quoted here
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
// RE-DERIVED DOWNWARD 49_000 -> 30_000 by the 2026-09-04 corpus compression
// pass (rule + one-line citation form applied to every stage file; the
// narrative bodies moved out or were cut). Largest is asserted in
// MEASURED below rather than quoted here (the title has already swapped
// files twice). The cap
// keeps roughly the ~9-13% headroom ratio the original 64,000 held over
// 58,698 B, so the retro.md section 10-b fold-back loop cannot silently erode
// the compression's gain; per that section a retro NEVER buys room by raising
// this cap -- it compresses, displaces, or splits the stage
// (go-to-k/cdkd#2424 tracks the split option).
const MAX_REFERENCE_FILE_BYTES = 30_000;

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
const MEASURED: Record<string, { orchestratorBytes: number; corpusBytes: number; largest: { file: string; bytes: number }; runnerUp: { file: string; bytes: number } }> = {
  // Keyed by skill, NOT module-global: the assertion below is generated per
  // entry of SPLIT_SKILLS, so a second split skill would otherwise be measured
  // against work-issues' numbers -- permanently red, with a message naming the
  // wrong file.
  'work-issues': {
    // The orchestrator is here rather than in a comment because the comment
    // form drifted silently: it read 11,578 B / 422 B of slack from
    // go-to-k/cdkd#2417 until 2026-09-02, while SKILL.md had been 11,548 B
    // since c416ecb5. Nothing was wrong with the reasoning -- only nothing
    // checked it, which is the same failure the corpus figures had.
    orchestratorBytes: 11_752,
    corpusBytes: 173_051,
    largest: { file: 'implement.md', bytes: 28_240 },
    runnerUp: { file: 'verify.md', bytes: 28_154 },
  },
};

const SPLIT_SKILLS = ['work-issues'];
const MIN_REFERENCE_FILES = 6;
// The floor must sit ABOVE `corpus - largest`, or hollowing out the single
// biggest stage file still passes and the guard is silent about it. That
// property is ASSERTED at the bottom of this file rather than only described
// here.
// RE-DERIVED DOWNWARD 208_000 -> 145_000 by the 2026-09-04 corpus compression
// pass, exactly the move the assertion's failure message prescribes for a
// genuine compression ("re-derive it DOWNWARD in the same commit"). Inputs are
// in MEASURED and asserted: corpus 171,399 B, largest verify.md 27,036 B,
// runner-up implement.md 26,541 B. The floor must clear `corpus - largest`
// (144,363) and `corpus - runnerUp` (144,858, the binding direction);
// 145,000 clears them by 637 and 142 B. Growth in a NON-leader file erodes
// the either-largest margin first -- MEASURED's failure message reports both
// margins, so the next lapse reds this file at the commit that causes it.
// The 2026-09-04 retro (go-to-k/cdkd#2514's run) spent most of the 3,366 B the
// compression pass had left: it added rules to filing.md, launch-mode.md,
// retro.md, ship.md and verify.md, paid for them by merging a duplicated count
// rule, relocating a repo-wide one to `.claude/rules/hooks.md`, and
// compressing, and left 581 B; the 2026-09-04 go-to-k/cdkd#2553 retro added a
// reviewer-absence-claim rule to verify.md and paid for it there in full,
// leaving 586 B. The 2026-09-04 go-to-k/cdkd#2558 retro added five rules
// (verify.md 8-d/8-i, launch-mode.md, filing.md, retro.md) and paid for them
// by DISPLACING two blocks verify.md was carrying for another skill -- the
// Docker-hang diagnosis and the real-AWS watchdog recipe now live in
// .claude/skills/run-integ/SKILL.md, where the commands they wrap are run --
// plus a de-duplicated blocked-run rule, leaving 142 B. The 2026-09-05
// go-to-k/cdkd#2578 + go-to-k/cdkd#2566 retro added a rejected-alternative
// probe rule to implement.md (+367 B) and a `gh pr checks --watch` correction
// to ship.md (net -23 B), deleting three restatements of rules that live
// elsewhere -- implement.md's `vp test run` bullet (CLAUDE.md plus
// vp-run-test-path-gate.sh), ship.md's release-flow paragraph and its
// squash-only code comment (both CLAUDE.md) -- plus merging implement.md's two
// unearned-count bullets into one. Margin 142 -> 165 B, and the arithmetic is
// worth stating because it is counter-intuitive: the corpus GREW 344 B, and
// the margin widened ONLY because ship.md shrank. implement.md's +367 B is
// invisible to this bound -- it IS the runner-up, so `corpus - runnerUp` moves
// by zero for anything added there, until it overtakes verify.md (128 B of
// room at this writing) and the bound snaps tighter. Read a widening margin as
// evidence about the file that shrank, never as room the additions created.
// The 2026-09-05 go-to-k/cdkd#2571 retro then added ONE rule to verify.md 8-h
// -- a nit is not a work item, measured over four review rounds -- and paid
// for it entirely inside 8-h by compressing six neighbouring bullets, landing
// +113 B net on the LARGEST file. Margin 165 -> 52 B. That confirms the
// paragraph above from the other side: an addition to the largest file moves
// the binding bound one-for-one, while the same bytes in the runner-up move it
// not at all.
// The 2026-09-05 go-to-k/cdkd#2595 retro is the first to end NET NEGATIVE here:
// it added 83 B to filing.md (a hint at the point where a deferral reason is
// written) and paid by MERGING retro.md's two adjacent stale-reason bullets
// into one that POINTS at .claude/rules/session-report.md. Note what "points"
// had to mean: the first attempt kept the incident and the classify-once
// sentence beside the pointer, which a review round called out as copying
// rather than moving -- neither phrase now appears in both files (grepped).
// filing.md 12,870 -> 12,953, retro.md 17,190 -> 16,995; corpus
// 171,877 -> 171,765; margin 31 -> 143 B. Its other three
// lessons landed OUTSIDE this corpus on purpose
// (.claude/rules/{session-report,testing}.md and
// .claude/skills/review-pr/SKILL.md), which is why they cost it nothing.
// The 2026-09-05 go-to-k/cdkd#2333 retro added four rules (implement.md's
// probe-matrix and pinned-non-action rules, verify.md's cost-fence and
// merge-worth rules) and paid ~500 B for them by deleting a cross-reference
// 8-a duplicated out of 8-g, two CLAUDE.md restatements (the post-integ
// leftover check, the never-run-raw-cdkd rule), a `/run-integ` pointer 8-e
// and 8-f both carried, and an appendix restatement of the cwd-reset trap.
// implement.md 26,908 -> 27,238 and verify.md 27,149 -> 27,205, which SWAPS
// which of the two is the leader; corpus 171,765 -> 172,151, margin
// 143 -> 54 B. The margin tracks the LEADER alone, so verify.md's own +56 B
// cost nothing -- it is the runner-up now, and stays free until it overtakes
// implement.md (33 B of room).
// The 2026-09-05 go-to-k/cdkd#2607 / go-to-k/cdkd#2620 retro added four rules
// here (triage.md's budget-disjointness rule, implement.md's orchestrator-side
// tree rule, verify.md's fence-POPULATION rider, gotchas.md's chat-language
// rider) costing 1,904 B, and paid 1,752 B of it by deleting five passages
// that only RESTATED CLAUDE.md or .claude/rules/session-report.md and now
// point at them instead: gates-and-pr.md's gate-liveness probe, plus
// gotchas.md's four-field template, not-this-session paragraph, WAITING
// narrative and cross-repo-framing bullet. Corpus 172,151 -> 172,303 (+152 net
// for four rules), verify.md 27,205 -> 27,876 takes the lead back from
// implement.md 27,238 -> 27,713, and the margin goes 54 -> 410 B. The leader
// swap is why implement.md's +475 B was free: an addition to the RUNNER-UP
// does not move `corpus - runnerUp` at all, and neither does trimming the
// leader below it, so every byte of the payment had to come from the other
// eight files.
// The 2026-09-05 batching/area-priority pass added three rules to triage.md --
// rank `local` LAST, how to recognise it, and batching as the DEFAULT rather
// than a permission -- and ended NET NEGATIVE here: triage.md 26,048 ->
// 26,105 while section 0 and section 3-b each shed more than they gained,
// for -299 B on the corpus and margin 410 -> 709 B over the go-to-k/cdkd#2607
// round above (measured after rebasing onto it, not before). Re-measured
// three times across two rebases while this branch was open, and the leader
// swapped between implement.md and verify.md twice in the process -- the
// binding bound moves under a branch that touches neither file, so derive it
// from the tree at the sha you push, never from the tree you cut. Two of the three payments were displacement rather than
// compression, which is why the round could absorb a review that made the
// additions LONGER: section 0 became a pointer at CLAUDE.md's
// untrusted-content rule, which it had restated at length, and section 3-b
// became a pointer at .claude/rules/session-report.md, which already carried
// the bar, all four failure modes, the go-to-k/cdk-local#560 measurement and
// the own-PR criterion -- section 3-b now holds only the two checks it adds at
// PICK time. Read that as a warning as much as a result: 850 B of this file's
// corpus was a second copy of a rule file, and the reviewer had to find it.
// The orchestrator paid 111 B for one stage-table clause, one corrected row
// and the two "a few issues" phrasings the new default contradicted, leaving
// 248 B.
// The 2026-09-05 go-to-k/cdkd#2554 + go-to-k/cdkd#2615 retro added two rules
// (implement.md's aim-the-mutation receipt, retro.md's promotion-routing and
// mirror-aims-back clauses) plus a consequential rewrite in gates-and-pr.md,
// and came out at 172,004 -> 172,746 with implement.md 27,713 -> 28,079
// taking the lead back from verify.md 27,876 (unchanged); margin 709 -> 130 B.
// The three components sum to the total and are stated so that they can be
// checked rather than believed: implement.md +366, retro.md +254,
// gates-and-pr.md +122, = +742. (An earlier revision of this paragraph said
// +38 for the last of those, which reconciled with nothing; two reviewers
// caught it, on the file whose whole subject is a byte figure going stale.)
// Note what "paid for" does and does not mean here: every edited stage file
// still GREW, so the payment was partial -- implement.md folded its
// multi-copy-anchor clause into the receipt rather than keeping both, and
// retro.md compressed six passages that carried an incident at paragraph
// length where section 10-c asks for one line, the largest being 10-b's
// restatement of 10-c's own byte-cap rationale. Contrast the
// go-to-k/cdkd#2595 round and the batching pass below it, the two
// that ended NET NEGATIVE.
// implement.md's +366 B was NOT free, and this file predicted why: the
// crossover the comment above forecast ("128 B of room at this writing") has
// now happened twice, so implement.md is the leader and every byte added to
// it moves the binding bound one for one -- the free direction described at
// the go-to-k/cdkd#2607 entry applies only while a file is the RUNNER-UP.
// Its other two lessons landed OUTSIDE this corpus on purpose --
// .claude/skills/check-docs/SKILL.md (route a src change to the
// .claude/rules satellites whose `paths:` glob matches it) and
// .claude/rules/testing.md (a reworded string that becomes LESS specific
// blunts a sentinel in a fixture the diff never opens). Free to THIS corpus,
// but not free: the second spent 678 B of the `tests/setup.ts` payload band
// in rule-file-payload.test.ts, whose three governing figures are re-derived
// there in the same commit.
// The 2026-09-05 go-to-k/cdkd#2438 + go-to-k/cdkd#2447 retro added five rules
// -- filing.md's ask-the-worktree-question-HERE timing, gates-and-pr.md's
// re-run-the-generators clause, ship.md's `gh pr checks` parsing rule,
// verify.md's what-COUNTS-as-a-bypass clause, and retro.md's
// read-the-SENTENCE-before-believing-a-hit rider -- and came out 172,746 ->
// 172,952, i.e. +206 for the round, with verify.md 27,876 -> 28,154 taking
// the lead from implement.md 28,079 (untouched); margin 130 -> 127 B.
// Components, stated so they can be checked rather than believed:
// filing.md +640, gates-and-pr.md +276, retro.md +376,
// ship.md +325, verify.md +278, gotchas.md -1,689, = +206. All of the payment
// came from ONE file, and by DISPLACEMENT rather than compression: gotchas.md
// is the appendix, so every rule in it that only restated CLAUDE.md or another
// stage was either pointed at or moved to the step where it fires (the
// deferral trap to filing.md, the unique-stack-name rule to 8-i, the
// what-counts-as-a-bypass half to 8-c, the IN-PLACE restore recipe to
// section 9). Read that as the appendix's standing hazard: an "existing rules
// this skill leans on" list is where duplication accumulates without ever
// looking like growth.
// The retro.md rule is the one worth re-reading before the next fold-back,
// because of HOW it was arrived at, which the commit log carries in full: the
// chain ran cited-the-wrong-fixture -> blamed a basename collision (also
// wrong; the body names the sibling by FULL path) -> escalated to a recipe
// printing the body line -> that recipe paired a basename hit with the wrong
// sentence, reproducing the original error inside the mechanism built to
// prevent it. So the recipe went to go-to-k/cdkd#2655 with both measured
// defects and only the narrow certain part shipped.
// The 2026-09-06 ranking-criteria pass (maintainer-directed) rewrote three rows
// of triage.md section 3-a -- rule 5 now sorts AGENT-TOOLING issues
// (`.claude/**`, CLAUDE.md) below every other area, rule 7 flipped from
// newest-first to OLDEST-first because the outcome the ranking exists to
// prevent is an old deploy defect in a major AWS service that no run ever
// reaches, and rule 4 stopped claiming a fallback population the same day's
// label sweep had emptied. Corpus 172,952 -> 172,956, +4; margin 127 -> 123 B.
// Components: triage.md -204, claim.md +191, filing.md +17, = +4; no other
// stage file was touched, and neither the leader (verify.md 28,154) nor the
// runner-up (implement.md 28,079) moved, so every byte is charged in full.
//
// HOW that came out near zero is the part worth carrying, because three review
// rounds each cost a rewrite to get here. The rules the rows added were paid
// for by DISPLACEMENT before compression: the derived-label semantics the
// sweep created live in .claude/rules/session-report.md's Labels section, and
// rule 3 carries a pointer, so the stage file holds the ranking and the rules
// corpus holds the definition. Section 1's REST rationale went (section 0
// carries it) and the batching paragraph's second copy of go-to-k/cdkd#2417's
// stand-down shape went; section 3-0's copy of section 2's never-claim-absence
// ban and the Session-fit bullet's copy of section 3-0's presumed-free rule
// became POINTERS that still say a sentence of what they point at; section 2's
// contested-file descriptions and several paragraphs across sections 1-3 were
// compressed, losing description but no rule. Two clauses were DELETED as
// stale: the security bullet's "never loses its place for being older" (true
// only while rule 7 rewarded recency) and rule 5's "rule 1 decides those"
// rider, derivable from the table's stated in-order application. One figure
// was de-authorised in place -- the budget-disjointness paragraph's 247 B of
// rules-corpus headroom now reads as a disclaimed anecdote, having been
// obsolete within a day of CORPUS_BYTES_MAX being re-derived.
//
// Read the first deletion as the shape to look for whenever a ranking rule is
// REVERSED: the rows are cross-referenced from prose that never names the rule
// number, so `grep "rule 7"` does not find them -- grep the PROPERTY the rule
// ranked on (age, recency, "loses its place"). Round 1 also caught a defect the
// flip EXPOSED and nothing here would have: section 1's backlog listing had no
// `--paginate`, so it returned the newest page only -- 79 of 180 open issues,
// measured -- harmless while rule 7 preferred NEW issues and load-bearing the
// moment it preferred OLD ones. A ranking change can invalidate the QUERY that
// feeds it.
//
// Rounds 2 and 3 then found the same class of defect twice IN THIS COMMENT:
// derived counts (a rows-cost figure, a paragraph tally) measured one commit
// before the last edit and stale by the time they were pushed. The fix is not
// a fourth re-derivation -- it is to quote only what something ASSERTS. What
// survives here is MEASURED's four fields and the per-file components, both
// checkable with `wc -c` against origin/main; every count that was merely
// counted has been dropped.
// The 2026-09-05 deploy-batch retro (go-to-k/cdkd#2634 / go-to-k/cdkd#2649 /
// go-to-k/cdkd#2674) landed TWO rules here for +95 B: triage.md section 2's
// worktree probe now ranges over `origin/main...HEAD` (`show --stat HEAD`
// reads one commit, and read 1 of the 5 files a ten-commit lane held), and
// implement.md section 5-g's fan-out sentence now names the REPORT SHAPE.
// Components, stated so they can be checked rather than believed: triage.md
// 26,084 -> 26,218 (+134), implement.md 28,079 -> 28,240 (+161), gotchas.md
// 8,045 -> 7,845 (-200), = +95. Corpus 172,956 -> 173,051; margin 123 -> 103 B.
// The payment is the appendix again, and for the reason the go-to-k/cdkd#2438
// entry above records: gotchas.md was restating section 2's two live-lane
// probes AND CLAUDE.md's arm-the-signal-first rule, and now points at both.
// NOTE THE LEADER FLIP: implement.md 28,240 overtakes verify.md 28,154, so
// `largest` and `runnerUp` SWAP in MEASURED above and the binding bound is now
// `corpus - verify.md`. Both figures are POST-REVIEW. The round's first draft
// was +7 B, and two reviewers reading the same diff independently found that
// its compression had re-bound go-to-k/cdkd#2270 to the wrong one of that
// bullet's two incidents; restoring the dropped clause with its citation is
// most of the extra 88 B, and it is why a compression payment is never free --
// the bytes it saves can be a citation's antecedent.
// The retro's third lesson landed OUTSIDE this corpus, in
// `.claude/rules/testing.md` -- a guard's uses are its CALL SITES, not the
// first one -- which is free to THIS corpus but spent 116 B of the
// `tests/setup.ts` band in rule-file-payload.test.ts, re-derived there in the
// same commit (the band moved 242 -> 126 B; an earlier draft said 159, which
// reconciled with nothing -- the go-to-k/cdkd#2554 entry's `+38` incident,
// repeated in the file whose whole subject is a figure going stale).
// The next addition here has to be paid for by compression FIRST -- retro.md
// section 10-c forbids buying the room by raising this floor, and note that
// SPLITTING a stage file makes this bound tighter, not looser (a smaller
// runner-up raises `corpus - runnerUp`).
// History worth keeping: the floor was RAISED 206_000 -> 208_000 by the
// 2026-09-02 retro (go-to-k/cdkd#2459) to fit its additions; retro.md
// section 10-c now forbids that direction outright -- a retro pays for its
// bytes by compression or displacement, and the floor moves DOWN with
// compression passes, never up to accommodate growth.
//
// What this floor does NOT catch, stated plainly: gutting a NON-largest stage
// file (deleting the whole of a mid-sized file leaves a total the floor still
// clears). A byte floor cannot see that, and raising it until it could would
// forbid legitimate compression. The per-file guards are elsewhere and are
// about CONTENT rather than size: work-issues-skill-refs.test.ts pins the
// document COUNT, and work-issues-launch-mode.test.ts pins that each
// arm-bearing stage file still names the mode it branches on and that the
// probe still exists exactly once.
const MIN_REFERENCE_CORPUS_BYTES = 145_000;

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
        orchestratorBytes: statSync(join(skillsDir, name, 'SKILL.md')).size,
        corpusBytes: sized.reduce((n, e) => n + e.bytes, 0),
        largest: sized[0]!,
        runnerUp: sized[1]!,
      };
      const capHeadroom = MAX_REFERENCE_FILE_BYTES - actual.largest.bytes;
      expect(
        actual,
        `The MEASURED record at the top of this file no longer matches the tree.\n` +
          `  SKILL.md   ${expected!.orchestratorBytes} -> ${actual.orchestratorBytes} ` +
          `(${MAX_ORCHESTRATOR_BYTES - actual.orchestratorBytes} B under its cap)\n` +
          `  corpus     ${expected!.corpusBytes} -> ${actual.corpusBytes}\n` +
          `  largest    ${expected!.largest.file} ${expected!.largest.bytes} -> ` +
          `${actual.largest.file} ${actual.largest.bytes}\n` +
          `  runner-up  ${expected!.runnerUp.file} ${expected!.runnerUp.bytes} -> ` +
          `${actual.runnerUp.file} ${actual.runnerUp.bytes}\n` +
          `  floor margins: ${MIN_REFERENCE_CORPUS_BYTES - (actual.corpusBytes - actual.largest.bytes)} ` +
          `(largest-side) / ${MIN_REFERENCE_CORPUS_BYTES - (actual.corpusBytes - actual.runnerUp.bytes)} ` +
          `(runner-up side, the BINDING direction)\n` +
          `  ${actual.largest.file} has ${capHeadroom} B left under the ` +
          `${MAX_REFERENCE_FILE_BYTES} B per-file cap.\n` +
          `Update MEASURED and re-read the comments that cite it -- every byte claim in ` +
          `this file is derived from these four numbers, and a stale one silently ` +
          `misleads the next author into planning against room that is not there. If the ` +
          `either-largest margin has gone small or negative, raise ` +
          `MIN_REFERENCE_CORPUS_BYTES in the same commit.`
      ).toEqual({
        orchestratorBytes: expected!.orchestratorBytes,
        corpusBytes: expected!.corpusBytes,
        largest: { file: expected!.largest.file, bytes: expected!.largest.bytes },
        runnerUp: { file: expected!.runnerUp.file, bytes: expected!.runnerUp.bytes },
      });
    });
  }
});
