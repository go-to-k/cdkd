import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { marked } from 'marked';

/**
 * `.claude/rules/*.md` files are LAZILY loaded by a native Claude Code feature:
 * a `paths:` glob in the YAML frontmatter injects the WHOLE file into the
 * agent's context the moment a file matching that glob enters context. There is
 * no partial load -- the unit is the file. So a rule file's byte size IS a
 * fixed token toll paid by every session that touches its glob, re-paid on
 * every context compaction, multiplied by every parallel agent.
 *
 * MEASURED on 2026-08-25, immediately before the split this fence guards:
 *
 *   .claude/rules/code-layout.md   394,994 B   paths: src/**\/*.ts      ~99k tokens
 *   .claude/rules/providers.md     166,062 B   paths: src/provisioning/** ~42k tokens
 *
 * i.e. reading ANY `src/**\/*.ts` file cost ~99k tokens before a single line of
 * the file itself was read, and any provider touch cost ~42k more. Both files
 * had accreted PR-by-PR narrative for months with no size feedback anywhere.
 * `code-layout.md` was 128 lines long because each bullet was ONE line: its
 * `- **src/local/** - ...` bullet alone was 47,795 characters.
 *
 * The bullets bucketed by the directory they described (measured, same day):
 *
 *   70,912 B  src/deployment      57,118 B  src/cli        54,602 B  src/provisioning
 *   58,617 B  scripts             47,583 B  src/local      32,946 B  src/utils
 *   24,659 B  src/analyzer         5,692 B  src/assets      4,793 B  src/synthesis
 *
 * The `scripts` bucket is the clearest case: 58 KB describing `scripts/**` and
 * `docs/_generated/**`, loaded on every `src/**` touch and on NO scripts touch,
 * because the glob was `src/**\/*.ts`. Pure waste in both directions.
 *
 * This fence does not try to judge whether a rule file's CONTENT is worth its
 * bytes -- that is a human call. It fences the three mechanical properties that
 * let the two files above get where they got without anyone noticing:
 *
 *   1. no rule file may exceed MAX_RULE_FILE_BYTES;
 *   2. every rule file must declare `paths:` (an always-on file is a toll on
 *      every session, so it must be an explicit, listed decision);
 *   3. long LINES are ratcheted -- both an absolute per-line ceiling and a
 *      repo-wide COUNT of lines over MAX_LINE_BYTES, so the "one bullet per
 *      area, forever" habit cannot re-establish itself silently.
 *
 * Plus 4: a per-touched-path PAYLOAD BAND, which is the property anyone
 * actually cares about. Caps 1-3 are per-file and a split can satisfy all three
 * while every satellite still shares one broad glob, which buys nothing. The
 * budgets below sum the matching rule files for a representative path in each
 * area, so widening a satellite's glob back out is what fails.
 *
 * The band's FLOOR is what makes the budgets symmetric with CORPUS_BYTES_MIN,
 * and it was missing until a review probe on 2026-08-25 showed why. Every
 * assertion here except the corpus floor is a one-sided UPPER bound, so the
 * cheapest way to "improve" any number in this file is to make an area load
 * LESS than it needs -- which is a worse outcome than the bloat the fence was
 * written against, and it read as an improvement. Two probes, both GREEN
 * against caps alone: narrowing `layout-local.md` from `src/local/**` to a
 * single file made 48,072 B invisible to 56 of the 57 files under `src/local/`;
 * and moving 27,912 B of `src/provisioning` text into `layout-scripts.md`
 * (`scripts/**`) cut the provisioning payload from 94,925 to 67,013 B while
 * leaving the corpus bytes and the file count untouched, so even the corpus
 * floor could not see it. A floor per row catches both, because both move
 * bytes AWAY from the path whose budget names them.
 *
 * Plus 5: routing hygiene -- no glob may be dead (matching no tracked file),
 * every satellite must be reachable from an index, and rule files must sit at
 * depth 1. A dead glob is the purest form of the same failure: the file's
 * bytes stop counting against every budget precisely because nothing loads it.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RULES_DIR = join(repoRoot, '.claude', 'rules');

/**
 * Headroom over the largest rule file today. Measured 2026-08-25 AFTER the
 * split: `hooks.md` at 115,520 B is the worst and is NOT part of the split (it
 * globs `.claude/**`, not `src/**`, so it is not on the hot path this fence was
 * written for); the largest file the split itself produced is
 * `layout-scripts.md` at 59,193 B. Lower this cap when hooks.md is split.
 */
const MAX_RULE_FILE_BYTES = 80_000; // RE-DERIVED DOWNWARD 120_000 -> 80_000 by the
// 2026-09-04 rules-corpus compression (rule + one-line citation form applied to
// the nine largest files). Largest is now hooks.md at 71,499 B (was 118,976), so
// this keeps ~11% headroom over the leader — the same ratio the old cap held.
// A compression pass re-derives caps DOWNWARD in its own commit; nothing raises
// them to fit an addition (the anti-regrowth rule in /work-issues retro 10-c).
// DELIBERATE, and recorded because it is now the tightest bound in this file.
// `hooks.md` measures 117,469 B against this cap on 2026-09-01 -- 2,531 B of
// headroom, where the hooks-stop.md split (go-to-k/cdkd#2391 / #2396) had left
// 6,578 B. Two consecutive hook lanes have spent that back, this one by ~1.3 KB
// of measured corrections to the main-tree-branch-gate entry (a live bypass in
// both directions, which is what a rules file is FOR).
//
// The cap is NOT raised and the file is NOT split here. Raising it weakens the
// only per-file guard; splitting costs a pointer, a CORPUS_FILE_COUNT bump and
// a re-derived payload FLOOR for every row that loads hooks.md, and the natural
// seam -- the `main-tree-branch-gate` entry -- is one a reader of the sibling
// `branch-gate.sh` still wants. So the decision is: the NEXT lane that needs
// more than 2,531 B in hooks.md splits it (the #2236 shape, for the fourth
// time), rather than trimming someone else's entry or nudging this constant.
// Stated here so that lane inherits a decision instead of a surprise.

/**
 * A single line over this is a bullet that has been appended to for months.
 * Not a hard failure on its own -- see LEGACY_LONG_LINE_BUDGET -- because the
 * split preserved every existing line VERBATIM rather than re-wrapping it.
 */
const MAX_LINE_BYTES = 4_000;

/**
 * Ratchet, not a target. Measured 2026-08-25 after the split: 24 lines across
 * all rule files exceed MAX_LINE_BYTES. A repo-wide total rather than a
 * per-file table so that concurrent lanes editing different rule files do not
 * collide on this fence; the cost is that one lane may spend headroom another
 * lane freed. Only ever lower it.
 */
const LEGACY_LONG_LINE_BUDGET = 7; // RATCHET: 24 -> 7, re-measured after the 2026-09-04 compression

/**
 * Hard ceiling on any single line. Measured 2026-08-25: the worst line in the
 * repo is the `- **src/local/** - ...` bullet at 47,795 B, preserved verbatim
 * in `layout-local.md`. This cap exists so that line cannot GROW; re-wrap it
 * and lower this number.
 */
const ABSOLUTE_MAX_LINE_BYTES = 48_000;

/**
 * Rule files deliberately loaded into EVERY session (no `paths:` key). Empty on
 * purpose: an always-on rule file is a toll on every session in the repo, so
 * adding one has to be a decision someone writes down here.
 */
const ALWAYS_ON_ALLOWLIST: readonly string[] = [];

/**
 * The share of tracked files a rule file may reach before it counts as
 * always-on. Requiring `paths:` to be a NON-EMPTY array is not the same as
 * requiring it to NARROW anything: a review probe gave `synthesis.md`
 * `paths: ['**']`, which loads it into every session in the repo, and the whole
 * suite stayed green.
 *
 * This was an ENUMERATION of always-on spellings (`**`, `**\/*`, `*`, `./**`)
 * and the second review round escaped it in four ways the list did not have --
 * `**\/**`, `**\/?*`, `*\/**` and `**.*` reach 3,739 / 3,739 / 3,719 / 3,719
 * files respectively. Two of the four listed entries were also simply wrong:
 * `*` reaches 20 files (repo root only) and `./**` reaches ZERO, so it was a
 * DEAD glob being reported as an always-on one. An enumeration of ways to spell
 * "everything" cannot be completed, and the population count this file already
 * computes answers the question directly. The separation is wide: the broadest
 * legitimate glob in the corpus is `testing.md` at 84.6%, and every always-on
 * spelling measured sits at 99.4% or above.
 */
const ALWAYS_ON_REACH_RATIO = 0.95;

/**
 * Per-touched-path payload budgets: the summed bytes of every rule file whose
 * `paths:` globs match that file. Measured 2026-08-25, before -> after the
 * split, with roughly 25-60% headroom left for the rule files this split did
 * not touch (`architecture.md`, `cli-internals.md`, `analyzer.md`, `assets.md`).
 *
 *   src/provisioning/providers/s3-bucket-provider.ts  573,721 ->  239,361
 *   src/deployment/deploy-engine.ts                   407,659 ->   48,937
 *   src/cli/commands/deploy.ts                        418,827 ->   47,570
 *   src/local/docker-runner.ts                        413,288 ->   68,543
 *   src/analyzer/dag-builder.ts                       413,531 ->   29,634
 *   scripts/gen-nested-key-coverage.ts                      0 ->   59,193
 *
 * The scripts row goes UP on purpose and is the only one that does: those notes
 * previously loaded on `src/**` touches and never on a scripts touch, so "0"
 * was the wrong number, not a saving.
 */
/**
 * How many TRACKED files each rule file's `paths:` globs reach, floored at
 * roughly 80% of the 2026-08-25 measurement.
 *
 * This is the assertion the payload band cannot make, and the review probe that
 * forced it is the one the band was supposed to catch and did not. Narrowing
 * `layout-local.md` from `src/local/**` to `src/local/docker-runner.ts` hides
 * 48,072 B from 56 of the 57 files under `src/local/` -- and every budget
 * stayed green, INCLUDING the floor, because the budget row for that area names
 * `src/local/docker-runner.ts`, which is precisely the one file the narrowed
 * glob still matches. A budget speaks for one representative path; a glob
 * narrowed around that path is invisible to it, and picking a second
 * representative only moves the blind spot. Counting the reached population
 * does not have a representative to be narrowed around.
 *
 * Raise a floor when a satellite legitimately covers more; lower one only with
 * the reason in the commit, because the usual cause is text going dark.
 *
 * The ~80% slack is what makes this survive ordinary renames -- but it is also
 * what a WILDCARD-FREE `paths:` list can spend. For a literal list, dropping one
 * entry IS the narrowing, and 80% of a 3- or 5-entry list pays for exactly one
 * of them. Second review round, both 172-green against the first version of
 * this table: dropping `src/cli/commands/export.ts` from
 * `layout-cli-import-export.md` took 24,465 B dark for a 316 KB source file
 * (reach 3 -> 2, floor 2), and dropping
 * `src/deployment/secret-region-classification.ts` from
 * `layout-deployment-secrets.md` took 52,459 B dark (reach 5 -> 4, floor 4).
 * Neither file is named by any payload budget, so no floor fired there either.
 * So a wildcard-free file's entry is asserted EXACTLY rather than as a floor:
 * it can only change by a deliberate edit, which should update this table in
 * the same commit.
 */
const REACH_FLOORS: ReadonlyMap<string, number> = new Map([
  ['analyzer.md', 12],
  ['architecture.md', 261],
  ['asset-bucket-region.md', 4], // literal list: EXACT, see below
  ['assets.md', 51],
  ['cli-internals.md', 48],
  ['code-layout.md', 261],
  ['delete-outcome.md', 5], // literal list: EXACT, see below
  // 5 -> 8 (issue go-to-k/cdkd#2623): the argv-redaction rule gained three
  // modules that spawn docker and were outside it -- `src/assets/docker-build.ts`
  // and `src/assets/docker-asset-publisher.ts` (the deploy-time ECR publish,
  // which also builds `cdkd local run-task`'s image) and `src/local/ecr-puller.ts`.
  // Widening, not narrowing: no path was dropped.
  ['docker-argv-redaction.md', 8], // literal list: EXACT, see below
  ['docs-page-template.md', 63], // `docs/**`; measured 79 tracked files (80%, per the convention above)
  ['hooks.md', 68],
  // 93 files: the 92 entries `.claude/hooks/*.sh` reaches at depth 1 -- 46
  // whose names end `.test.sh` and 46 that do not, which ONE glob covers
  // because a suite's name also ends in `.sh` -- plus `.claude/settings.json`.
  // The 46/46 is a coincidence of counts, NOT a pairing: `run-tests.sh` is a
  // runner rather than a hook, `post-merge-sync-reminder.sh` has no suite, and
  // `markgate-gate-name-class.test.sh` / `unresolved-target-class.test.sh` are
  // suites belonging to no single hook. That last path is not decoration -- the
  // "Why every Bash gate stays unconditional" section moved here is ABOUT
  // settings.json (the coarse `Bash` matcher, the absent per-hook `if:`), so a
  // `.claude/hooks/*.sh`-only glob took 1,226 B dark for the one file the text
  // describes, and no assertion here could see it: a floor is computed against
  // the satellite's OWN glob, so narrowing the glob narrows the floor with it.
  // Review caught it; that is the gap, not a fence. Floor at ~80% per the
  // convention above: this satellite is the AUTHORING half of hooks.md and
  // must never be narrowed to the handful of hooks a lane happens to edit.
  ['hooks-authoring.md', 74],
  // Two literal paths, the gate and its suite -- EXACT, like the other
  // two-path satellites below. Split off hooks.md when that file crossed the
  // per-file cap a second time this session (go-to-k/cdkd#2707); the content
  // is the gate's vocabulary, its body-CHANNEL precedence and its mutation
  // tallies, none of which a lane needs unless it has that gate open.
  ['hooks-class-fences.md', 6], // literal list: EXACT, see below
  // +1 (go-to-k/cdkd#2650): command-match-mutants.sh. The file already
  // DESCRIBED that harness while nothing made it load on an edit to it.
  ['hooks-main-tree-branch.md', 2], // literal list: EXACT, see below
  ['hooks-branch-gate.md', 2], // literal list: EXACT, see below
  ['hooks-cwd-detector.md', 2], // literal list: EXACT, see below
  ['hooks-main-tree-edit.md', 6], // literal list: EXACT, see below
  // +1 (go-to-k/cdkd#2650): lib/command-match.sh. This satellite now
  // asserts behaviour of the shared matcher (_gate_struct_next's
  // escaped-whitespace refusal), so it has to load when that file changes.
  // +1 again: main-tree-edit-oracle.test.sh, the differential oracle this file
  // now explains -- its tolerances and its self-check are described here.
  ['hooks-stop.md', 4], // literal list: EXACT, see below
  ['gate-sibling-repos.md', 8], // literal list: EXACT, see below
  ['proxy-support.md', 3], // literal list: EXACT, see below
  ['layout-analyzer.md', 12],
  ['layout-cli-import-export.md', 3], // literal list: EXACT, see below
  ['layout-cli.md', 48],
  // 5 -> 6 (issue #2748): added `src/deployment/intrinsic-function-resolver.ts`.
  // That file OWNS `maskSecretsForLog` and every masking site this rule
  // enumerates, and it was NOT claimed -- so a session editing the resolver
  // never had the rule loaded. The #2615 class, and why the same masking gap
  // was found twice (issues #2728 then #2748).
  ['layout-deployment-secrets.md', 6], // literal list: EXACT, see below
  ['layout-deployment.md', 12],
  ['layout-drift.md', 5],
  ['layout-local.md', 45],
  ['layout-misc.md', 30],
  ['layout-provisioning.md', 92],
  ['layout-scrub.md', 1], // literal list: EXACT, see below
  ['layout-scripts.md', 38],
  // Its `paths:` frontmatter lists 16 globs: 3 checker globs (two are wildcards,
  // covering the six checkers between them), the shared subject module, the
  // allow-list, the 3 workflows and 8 suite globs. An earlier revision said
  // "five suites", which is the only way the arithmetic reached 16. The
  // FLOOR is the reach (files matched), which is not the glob count; read it
  // off this assertion's failure message rather than from this comment, which
  // an earlier revision already got wrong.
  ['layout-ci-checks.md', 15],
  // The three PR-CONTENT checks, their allow-list and their three suites, the
  // one workflow that runs them, and the shared annotation fold plus its suite:
  // ten literal paths, no wildcard, so this is EXACT and a narrowed glob cannot
  // hide behind a floor (go-to-k/cdkd#2736).
  ['layout-ci-pr-content.md', 10],
  ['layout-utils.md', 19],
  ['provider-aws-response-reads.md', 65],
  ['provider-custom-resources.md', 1], // literal list: EXACT, see below
  ['provider-delete-path.md', 65],
  ['provider-diff-record-folds.md', 65],
  ['provider-masking.md', 65],
  ['provider-nested-key-divergence.md', 65],
  ['provider-property-fidelity.md', 65],
  ['provider-replay-and-refusals.md', 65],
  ['provider-resource-identity.md', 65],
  // Exactly one path by design: this satellite was split OUT of state-schema.md
  // (go-to-k/cdkd#2719) because its detail pushed src/types/state.ts over the
  // per-path budget, and a wider glob here would re-create that. EXACT.
  ['provisioning-sticky-routing.md', 1],
  ['providers.md', 92],
  ['session-report.md', 1], // literal list: EXACT, see below
  ['state-schema.md', 5],
  ['state-version-purge.md', 2], // literal list: EXACT, see below
  ['synthesis.md', 13],
  ['test-stream-fence.md', 3], // literal list: EXACT, see below
  ['testing.md', 2532],
]);

const PAYLOAD_BUDGETS: ReadonlyArray<readonly [string, number, number]> = [
  // [touched path, floor, cap] -- see the "Plus 4" note above for why the floor
  // is not decoration. Floors sit ~12% under the 2026-08-25 measurement, so
  // ordinary editing is free and MOVING an area's notes out from under it is
  // not.
  // CLAUDE.md is the representative path for session-report.md (the wrap-report
  // field reference split out of CLAUDE.md by the 2026-09-04 token-diet pass);
  // the band is that one satellite's size.
  // Payload is session-report.md alone. Historical anchors, each fixed to its
  // date and unmovable: 12,483 at registration; 15,550 on 2026-09-05. NO
  // current-size figure is recorded -- the band above is the enforcement and
  // `wc -c` derives the live value, whereas a "now" figure here drifts on every
  // edit to that file and did so twice inside go-to-k/cdkd#2878 alone.
  ['CLAUDE.md', 10_000, 20_000],
  // The representative path for docs-page-template.md, whose glob is `docs/**`.
  // A plain docs page matches that file and nothing else, so the band is one
  // satellite's size; `docs/_generated/**` additionally pulls layout-scripts.md
  // in, which is why the representative path is an ordinary page rather than a
  // generated one.
  // Measured 5,383. The cap is ~30% over rather than the 2.5x a round number
  // would have given: at 12_000 there was room for a whole second `docs/**`
  // satellite to land unnoticed, which is the hazard the s3-bucket-provider row
  // above was re-derived to close.
  ['docs/cli-deploy.md', 4_800, 7_000],
  ['src/provisioning/providers/s3-bucket-provider.ts', 210_000, 265_000], // measured 239,539; the cap was 300_000, whose 60,639 B of slack silently absorbed a whole 59 KB satellite in a review probe
  // A provisioning path OUTSIDE `providers/**`, and it is the row that makes
  // the provider half of this table bind at all. Review probe, 2026-08-25:
  // widening all seven `provider-*.md` from `src/provisioning/providers/**`
  // back to `src/provisioning/**` restores the FULL pre-split payload here
  // (94,925 B -> 239,361 B) while failing ZERO budgets, because every other
  // provisioning row sits under `providers/**` and so is unaffected by exactly
  // the widening the budgets exist to catch. The 20-odd shared helpers under
  // `src/provisioning/*.ts` are the population that regression would hit.
  // 83_000 -> 78_000: issue #2274 moved the 20 KB `## Custom Resources`
  // section out of `providers.md` (glob `src/provisioning/**`) into
  // `provider-custom-resources.md`, whose glob names the ONE file it
  // describes. Every `src/provisioning/**` path lost those bytes; none of
  // them but the custom-resource provider needed them.
  ['src/provisioning/region-check.ts', 63_500, 102_000],
  ['src/deployment/deploy-engine.ts', 43_000, 61_000],
  ['src/cli/commands/deploy.ts', 41_000, 63_000],
  ['src/local/docker-runner.ts', 41_500, 67_000],
  ['src/analyzer/dag-builder.ts', 26_000, 35_000],
  ['scripts/gen-nested-key-coverage.ts', 52_000, 90_000],
  // Review probe, 2026-08-25: with only the six rows above, 9 of the 28 rule
  // files (355,718 B -- 45% of the corpus) were matched by NO budgeted path,
  // and the four heaviest paths in the repo were all among them. A budget table
  // that misses the heaviest paths is not bounding the payload, it is bounding
  // a sample. These rows put every rule file under at least one budget -- which
  // is asserted below rather than left as a claim -- and the number beside each
  // is its measured payload rounded out by roughly a tenth in each direction.
  ['src/deployment/secret-redaction.ts', 70_000, 101_000],   // 101,842 when the row was written; the cap was re-derived to 101,000 by go-to-k/cdkd#2310 after the payload had shrunk below it
  ['src/cli/commands/scrub.ts', 88_000, 118_000],            // measured 112,141 (see below)
  // 110,000 -> 118,000 (issue go-to-k/cdkd#2274). This path loads BOTH
  // `layout-deployment-secrets.md` and the new `layout-scrub.md` satellite, so the
  // split that satellite performed did not reduce THIS path -- it reduced every
  // OTHER path under the redaction glob, which is what the split was for. Dropping
  // `scrub.ts` from the redaction file's `paths:` was tried and REVERTED: that file
  // still documents `cdkd scrub --all`'s own behaviour against the redaction
  // internals (the cross-region cache-key defect among them), so narrowing the glob
  // is the under-loading this fence's own message warns about rather than a saving.
  // Issue #2274 split `provider-custom-resources.md` out of `providers.md`
  // (whose glob is `src/provisioning/**`, so every provider paid for the
  // Custom Resource notes) -- and that satellite's glob names exactly ONE
  // file, which no other budgeted path matches, so without this row it sits
  // under no budget and could go dark or grow unnoticed.
  // 290_000 -> 288_000. This row BINDS the per-area guarantee: its slack is the
  // largest a single rule file can grow anywhere in the table, so it alone
  // decides whether the replacement is at least as tight as the ceiling it
  // retires. At 290_000 it allowed 24,451 B against the ceiling's 22,458 B, and
  // review PROVED the gap real rather than rhetorical -- appending 24,451 B to
  // `provider-custom-resources.md` passed the whole suite while taking the
  // corpus over the retired ceiling, which the old fence caught. 287_000 leaves
  // 21,451 B. Deliberately tighter than this table's 15% convention (8.1% of a
  // 265,549 B payload): a row that sets a repo-wide guarantee is held to the
  // guarantee, not to the convention.
  //
  // 288_000 was the first cut and left SEVEN bytes of margin over the ceiling's
  // 22,458 B. Review caught it: main's corpus grew 3,585 B during one review
  // round, so any rebase adding 8 B re-inverted the claim -- which is exactly
  // how the stale figure got there in the first place. 287_000 buys 1,007 B for
  // nothing.
  //
  // AND THE GUARANTEE CANNOT BE FENCED, which is why the margin matters rather
  // than an assertion. It compares against `CORPUS_BYTES_MAX` on `origin/main`,
  // and this very change DELETES that constant -- once merged there is nothing
  // left to compare to. It is a one-time, at-merge claim; re-derive it by hand
  // if you ever need to restate it, and do not add a test that reads a constant
  // this PR removes.
  ['src/provisioning/providers/custom-resource-provider.ts', 225_000, 287_000],
  ['src/cli/commands/drift.ts', 87_000, 110_000],            // measured 104,268
  ['src/cli/commands/import.ts', 63_000, 80_000],            // measured  72,035
  ['src/utils/ip-protocol.ts', 83_000, 103_000],             // measured  95,005
  ['src/provisioning/cloud-control-provider.ts', 67_500, 105_000], // measured 94,925
  // The representative path for provisioning-sticky-routing.md, whose single
  // glob is exactly this file (go-to-k/cdkd#2719). Without a budgeted path the
  // satellite would be bounded by nothing but the per-file cap.
  ['src/provisioning/provider-registry.ts', 62_000, 105_000], // measured 87,763
  // 55_000 -> 57_000 (both rows): `code-layout.md` gained an index row for
  // `layout-scrub.md` (issue #2274), and that file is in EVERY payload, so a
  // cap with 100 B of headroom fails for a reason unrelated to the path it
  // names -- the same argument that moved the `rule-file-payload.test.ts` row.
  // Every `measured` figure on the rows below was RE-TAKEN on this branch
  // rather than carried forward: the #2274 mask-only paragraph in
  // `layout-deployment-secrets.md` and the new `code-layout.md` index row moved
  // several of them, and a `measured` comment that no longer matches the tree
  // reads as evidence while being none.
  // Ceiling 57_000 -> 58_000 by go-to-k/cdkd#2717. The growth is ONE TABLE ROW
  // in `code-layout.md`, the family index, for the `layout-ci-checks.md`
  // satellite. That is structural rather than incidental: the satellite
  // convention requires every area to be reachable from the index, so this
  // payload gains a row every time a rule file is split -- and a split is what
  // this fence ASKS FOR when a per-file cap is hit. Left at 57_000 the two
  // caps pull against each other: go-to-k/cdkd#2719 split `state-schema.md` to
  // get UNDER this one and left 96 B of headroom, which a single index row then
  // consumed. The FLOOR is what still catches a glob narrowing.
  ['src/state/s3-state-backend.ts', 43_000, 58_000],         // measured  57,019 on 2026-09-07 (55,319 before go-to-k/cdkd#2719's satellite and go-to-k/cdkd#2717's index row)
  // The representative path for state-version-purge.md, whose two-file glob
  // (the purge and its replication-gap detector, issue
  // go-to-k/cdkd#2447) matches nothing else. Without this row the satellite
  // sits under no budget at all: the `src/state/s3-state-backend.ts` row above
  // does NOT match it, which is the whole reason it was split out.
  ['src/state/s3-noncurrent-version-purge.ts', 53_000, 64_000], // measured 61,168
  // Ceiling 57_000 -> 58_000 by go-to-k/cdkd#2717. The growth is ONE TABLE ROW
  // in `code-layout.md`, the family index, for the `layout-ci-checks.md`
  // satellite. That is structural rather than incidental: the satellite
  // convention requires every area to be reachable from the index, so this
  // payload gains a row every time a rule file is split -- and a split is what
  // this fence ASKS FOR when a per-file cap is hit. Left at 57_000 the two
  // caps pull against each other: go-to-k/cdkd#2719 split `state-schema.md` to
  // get UNDER this one and left 96 B of headroom, which a single index row then
  // consumed. The FLOOR is what still catches a glob narrowing.
  ['src/types/state.ts', 43_000, 58_000],                    // measured  57,019 on 2026-09-07 (55,319 before go-to-k/cdkd#2719's satellite and go-to-k/cdkd#2717's index row)
  ['src/synthesis/synthesizer.ts', 30_000, 40_000], // measured 39_197 on 2026-09-07 (803 B under the cap, not the 2,152 an earlier figure implied)
  // 62_000 -> 68_000: payload is `testing.md` alone, which reached 61,358 B, so
  // the cap had 642 B of headroom and the next edit to that file would have
  // failed this row for a reason unrelated to itself -- the same argument that
  // moved the global corpus ceiling eleven times before it was retired (the
  // retirement note beside CORPUS_BYTES_MIN). Measured 61,358 B (the 55,681 B beside the old cap
  // was 5,677 B stale).
  // RE-DERIVED DOWNWARD 68_000 -> 52_000 on 2026-09-06, and the sibling
  // `tests/setup.ts` cap with it: both bound a payload that IS `testing.md`
  // (alone here, plus its satellite there), and both CAPS were left sized for
  // the pre-compression file. Only THIS row's `measured` note was stale; the
  // `tests/setup.ts` note tracked its payload correctly, and saying "both
  // notes" was itself the defect this round is about -- the slack condition the
  // s3-bucket-provider row above records as having "silently absorbed a whole
  // 59 KB satellite". ~12% over the live payload is this table's convention,
  // NOT a ratio recovered from this row's own history.
  //
  // Read both as dead-slack removal, not as the live fence. What actually
  // stops `testing.md` growing is the `tests/setup.ts` GUTTING case below,
  // which binds first and by a wide margin; a first draft of this comment
  // called this row "the binding fence on it" and review measured that false.
  // Caps move DOWN with a shrinking payload, never up to fit a growing one.
  ['tests/unit/scripts/rule-file-payload.test.ts', 38_000, 52_000], // measured 48,728 on 2026-09-06 (was 46,373 before the #2621 prefix-sweep entry)
  // hooks.md WAS this path's only matcher, and while that held the cap was
  // dominated by MAX_RULE_FILE_BYTES no matter where it sat: at 135_000 (as
  // shipped) it was 15,000 B past the per-file cap and could not fire at all;
  // anywhere under it, the two fired together. The row was here for its FLOOR,
  // which nothing else provides. Since 2026-09-03 the payload is hooks.md PLUS
  // `hooks-branch-gate.md`, so it has the two-file shape its siblings above
  // already have and the cap stops tracking the per-file cap -- the two now
  // measure different things again. The split happened for the reason the
  // main-tree-branch one did two days earlier: go-to-k/cdkd#2402's review round
  // added the measured `--abort` / HEAD table and the two stated bounds, which
  // put hooks.md at 119,803 B against the 120,000 B cap (197 B of headroom, the
  // landmine shape the retired corpus ceiling's history names) and its branch-gate bullet
  // one line past the >4000 B ratchet. Moved out verbatim, hooks.md is 115,030 B
  // and the satellite 6,454 B.
  // ---------------------------------------------------------------------
  // FLOORS LOWERED BY go-to-k/cdkd#2717, and this is the deliberate-drop case
  // the assertion's own message prescribes ("If the drop is deliberate, lower
  // this floor in the same commit and say what moved where").
  //
  // WHAT MOVED WHERE: nothing moved to a narrower glob -- it was DELETED.
  // go-to-k/cdkd#2717 retired nine PreToolUse gates (closes-paren-form,
  // internal-pr-labels, commit-prefix-scope, pr-title-prefix-scope,
  // non-english-text, gh-body-english, vp-run-test-path, issue-dup-check,
  // issue-classification-label), and their per-hook entries left hooks.md with
  // them: 78,437 B -> 54,365 B, 274 lines. Every row below is keyed on a
  // payload that INCLUDES hooks.md, so all eight lapsed at once from one cause.
  //
  // This is the one shape the failure message warns is usually wrong ("making
  // an area under-load is not a saving") and is NOT wrong here: the deleted
  // text described hooks that no longer exist, so no path is under-loaded --
  // the thing it would have loaded is gone. A floor left high would have
  // demanded prose about deleted files.
  //
  // Each new floor sits under its re-measurement with room to spare: 17.6-19.0%
  // for the eight hook rows, 25.1% for the workflow row.
  //
  // The number beside each row is a DATED SNAPSHOT, and it has gone stale THREE
  // times inside this one change -- twice because the figures were taken before
  // the same commit had finished editing `hooks.md`, which every hook row's
  // payload includes. Take them LAST, from the state you are about to commit;
  // this file is in no rule file's `paths:` glob, so writing them here cannot
  // move them. Re-derive rather than trust: sum the `.claude/rules/*.md` whose
  // frontmatter glob matches the path (branch-gate.sh = hooks-authoring 3,801 +
  // hooks-branch-gate 12,736 + hooks.md 59,133 = 75,670).
  // ---------------------------------------------------------------------
  // Representative path for the CI-checks satellite. A WORKFLOW path, not a
  // `scripts/` one: `layout-scripts.md`'s glob is `scripts/**`, so every checker
  // under it loads BOTH files and the payload there is the sum -- which measures
  // the split not happening. `.github/workflows/pr-title-check.yml` is matched by
  // the satellite alone, so a glob narrowed there shows up as a DROP here.
  ['.github/workflows/pr-title-check.yml', 12_000, 19_000], // measured 15_222 on 2026-09-07
  // Representative path for the PR-CONTENT satellite. A WORKFLOW path again,
  // for the reason above: `scripts/check-pr-closes-paren.ts` also matches
  // `layout-scripts.md`'s `scripts/**`, so budgeting there measures 93,728 B --
  // mostly a file this split has nothing to do with.
  //
  // Both rule files match this path deliberately: the satellite carries the
  // per-check detail and the parent carries the stopping rule and the shared
  // conventions its own header tells the reader to start from. So the FLOOR is
  // what matters here -- narrowing the satellite's glob drops this from 22,878
  // to the parent's 15,222 alone, which 18,000 catches.
  ['.github/workflows/pr-content-checks.yml', 18_000, 30_000], // measured 22_878 on 2026-09-07
  ['.claude/hooks/branch-gate.sh', 62_000, 100_000], // measured 75_670 on 2026-09-07
  // The shared matcher pulls hooks.md AND the class-fence satellite, which is
  // the only path that loads both. hooks.md outgrew the 120,000 per-file cap on
  // its own, so the two CLASS fences moved to a satellite of their own rather
  // than the cap being raised -- a cap that moves when it fires is not a cap.
  ['.claude/hooks/lib/command-match.sh', 64_000, 120_000], // measured 77_676 on 2026-09-07
  // The four `integ-*` gates were the heaviest UNBUDGETED paths once
  // `gate-sibling-repos.md` split out of hooks.md: this row is the only one
  // that names them, so without it the satellite sits under no budget at all
  // and could go dark or grow unnoticed. Payload is hooks.md + the satellite.
  // Deliberately NOT added to the command-match row above: that path already
  // carries hooks.md + hooks-class-fences.md and has ~15 KB of headroom, which
  // adding a third file would spend down to about 1 KB.
  ['.claude/hooks/integ-local-gate.sh', 64_000, 103_000], // measured 78_279 on 2026-09-07
  // The cwd-race detector's entry moved out of hooks.md when the #2363
  // widening pushed that file past the 120,000 B per-file cap (the #2236
  // precedent). This path is the representative one for the satellite
  // (its two globs are the hook and its .test.sh, per the REACH_FLOORS
  // entry above); without this row the satellite would sit under no
  // budget. Payload is hooks.md + hooks-cwd-detector.md.
  ['.claude/hooks/main-tree-git-cwd-detector.sh', 61_000, 99_000], // measured 74_955 on 2026-09-07
  // main-tree-edit-gate's entry, and its main-tree-dirty-detector backstop,
  // moved out of hooks.md on 2026-09-05 when go-to-k/cdkd#2614's entry took
  // that file to 80,352 B -- past the 80,000 B per-file cap, which had only
  // 109 B of headroom left after two parallel lanes had spent the rest.
  // Representative path for the satellite (its four globs are the two hooks
  // and their suites, per the REACH_FLOORS entry above). Payload is hooks.md +
  // hooks-main-tree-edit.md + hooks-authoring.md -- THREE files, not the two an
  // earlier revision of this comment named; `hooks-authoring.md`'s glob covers
  // every hook, so it has been in this payload since it split out.
  //
  // THE FLOOR IS DERIVED, not a percentage. It was 56_000 and fenced nothing:
  // its own comment claimed a looser floor "cannot notice the satellite going
  // dark, because hooks.md alone satisfies it unaided", which was true of 56_000
  // too -- hooks.md is 70,168 B, so BOTH satellites could go dark and the row
  // still passed. A floor here has exactly one job, so it has to sit above the
  // largest payload that job would let through: hooks.md alone (70,168). At
  // 78_000, hooks-main-tree-edit.md going dark leaves 73,969 and reds.
  //
  // The residual is named rather than papered over: hooks-authoring.md going
  // dark alone leaves 82,861 and still passes. It is 3,801 B against a 12,693 B
  // sibling, so no floor catches it without false-firing on ordinary edits to
  // the other two; that one is covered by its own REACH_FLOORS row.
  //
  // The figure below was `68_626` until 2026-09-08, and it was CORRECT when
  // written: at go-to-k/cdkd#2731 the three files measured 59,133 + 5,692 +
  // 3,801 = 68,626 exactly. It went stale by GROWTH, not by error. Derived per
  // commit rather than recalled -- hooks.md 59,133 -> 70,168 is #2738 +4,736,
  // #2766 +3,935, #2711 +1,016, #2760 +943 and this branch +405; the satellite
  // 5,692 -> 12,693 is #2711 +4,189 and this branch +2,812. An earlier revision
  // of this paragraph named three PRs from memory and omitted the two largest
  // contributors to hooks.md, in a comment whose whole subject is checking the
  // history instead of recalling it.
  //
  // Recorded because the first attempt to update it asserted the opposite: that
  // `68_626` was `86_662` with two digit pairs transposed and had never been a
  // payload this row could measure. That was invented to fit a digit
  // coincidence, and `git log -S'68_626'` refutes it in one command. Re-derive
  // the number from the assertion itself (drop the cap to 1 and read
  // `pulls in N B` off the failure) and check the HISTORY before explaining why
  // an old figure differs -- a hand-summed answer also has to reproduce
  // `globToRegExp`, and the obvious approximation picks a different file set.
  ['.claude/hooks/main-tree-edit-gate.sh', 78_000, 95_000], // measured 86_991 on 2026-09-08
  // main-tree-branch-gate's entry moved out of hooks.md on 2026-09-01, when the
  // argument-parse rewrite's measured before/after table pushed that file to
  // 122,862 B -- past the same 120,000 B per-file cap, and one line past the
  // long-line ratchet with it. Representative path for the satellite (its two
  // globs are the hook and its suite, per the REACH_FLOORS entry above);
  // without this row the satellite would sit under no budget at all. Payload is
  // hooks.md + hooks-main-tree-branch.md.
  ['.claude/hooks/main-tree-branch-gate.sh', 70_000, 111_000], // measured 85_174 on 2026-09-07
  //   The comment here read "measured 124,200" and the payload was already
  //   124,758 when it was written -- 558 B behind on the day it shipped, because
  //   the satellite kept being edited after the figure was taken. Re-measured at
  //   the tree that ships it: 135,138 B (hooks.md 114,602 B, unchanged, plus the
  //   satellite at 20,536 B, up from 10,156 B) after the second parse round's
  //   before/after table, its four causes and its two retired claims. The BAND
  //   moved with the measurement rather than the measurement being trimmed to
  //   the band: 140,000 left 4,862 B of headroom over the new figure, which is
  //   the landmine shape the retired corpus ceiling's own history names.
  // The Stop-hook entries moved out of hooks.md when issues #2391 / #2396 --
  // the nudge-cadence rule, the channel table and stop-warn's own suite --
  // pushed that file to 122,559 B, past the same cap. Representative path for
  // the satellite (its four globs are the two hooks and their suites, per the
  // REACH_FLOORS entry above). Payload is hooks.md + hooks-stop.md.
  ['.claude/hooks/stop-warn.sh', 65_000, 104_000], // measured 79_357 on 2026-09-07
  // Second review round, 2026-08-25: three heavy paths still carried no budget
  // at all. `masked-retry-logger.ts` is the 2nd-heaviest path in the repo and
  // was covered only by prose, in the `region-check.ts` row's claim to speak
  // for "the 20-odd shared helpers" -- it does not, because that row's payload
  // is 52,459 B lighter.
  ['src/provisioning/masked-retry-logger.ts', 94_500, 148_000], // measured 126,979
  ['src/analyzer/drift-protocol-normalize.ts', 71_000, 85_000],  // measured  81,242
  ['src/assets/asset-publisher.ts', 32_000, 42_000],             // measured  40,238 (was 37,183 before the go-to-k/cdkd#2447 pointer landed in layout-misc.md)
  // Ceiling 48_000 -> 49_000 by go-to-k/cdkd#2717. The growth is in
  // `code-layout.md`, the family INDEX, which gained one table row because the
  // repo gained an area (the CI checks that replaced retired PreToolUse gates,
  // documented in `layout-ci-checks.md`). An index that lists every area is
  // what the satellite convention rests on, so this path's payload grows by a
  // row every time a satellite is added -- the ceiling tracks that, and the
  // FLOOR is what still catches a glob narrowing.
  ['src/assets/asset-storage.ts', 34_000, 49_000],               // measured  48,113 on 2026-09-07 (asset-bucket-region.md, issue #2240; was 43,787 before the go-to-k/cdkd#2447 pointer landed in layout-misc.md, and 46,764 before go-to-k/cdkd#2717's index row)
  // proxy-support.md's glob names three literal files (issue #2388); without a
  // row here the satellite would sit under no budget, which is the state the
  // 2026-08-25 review probe showed a rule file can reach unnoticed.
  ['src/utils/aws-client-defaults.ts', 46_000, 58_000],  // measured  52,845
  ['src/utils/logger.ts', 38_000, 50_000],                       // measured  43,397
  ['vite.config.ts', 14_000, 21_000],                            // measured  19,581 (was 16,712 before the go-to-k/cdkd#2447 pointer landed in layout-misc.md)
  // The representative path for `test-stream-fence.md`: the only paths its
  // literal glob list names are the fence, its suite, and the setup file that
  // installs it, and none of them is named by any other row. Without this the
  // satellite sits under no budget at all. Payload is testing.md + the satellite.
  ['tests/setup.ts', 54_000, 56_000],                            // measured  54,624 on 2026-09-09 (floor 51,000 -> 54,000 by go-to-k/cdkd#2839's testing.md entry, the third time the GUTTED-satellite case below has prescribed this re-derivation: 46,000 -> 48,000 -> 51,000 -> 54,000)
  // 46_000 -> 48_000 on 2026-09-05: the go-to-k/cdkd#2595 retro added 1,126 B of
  // mutation-probe rules to `testing.md`, and the discriminate case below went
  // red exactly as its comment predicts ("testing.md growing spends it from the
  // other side"). Re-derived, not debugged away: the floor sits between
  // `testing.md + SUBSTANTIVE_MIN_BYTES` (the gutting case it must reject) and
  // the live payload (which it must accept), and 48_000 split that band nearly
  // in half rather than sitting 47 B off one edge as 46_000 had come to.
  // RE-MEASURED 2026-09-05 in the same day, after the go-to-k/cdkd#2554 retro
  // added a sentinel-blunting rule to `testing.md` (45,579 -> 46,257 B):
  // payload 48,999 -> 49,677, and the gutting bound 47,079 -> 47,757, so the
  // growth room this floor leaves `testing.md` fell 921 -> 243 B while the
  // shrink room rose 999 -> 1,677 B. The floor is NOT re-derived upward for
  // that -- moving a bound to fit the diff that spent it is the ratchet
  // `.claude/skills/work-issues/references/retro.md` 10-c forbids -- but the
  // asymmetry is now the live constraint: the bound is a strict `<`, so the
  // usable room is 771 B and an addition of 772 B reds the discriminate case
  // below. The fix is compression there,
  // not a bigger number here. Unlike the skill corpus, this file has no
  // MEASURED record, so these figures are the only thing that goes stale
  // silently; re-measure them in any commit that touches `testing.md` -- these,
  // plus the `measured` figure and the cap on the rule-file-payload.test.ts row
  // above and this row's own cap, and the `testing.md (48,728 B)` figure in
  // the gutting case below -- all of which bound, or are, a payload that IS
  // `testing.md`. Deliberately not stated as a COUNT: this sentence said
  // "three" while enumerating more, twice.
  // RE-MEASURED 2026-09-06 after issue #2621 added the destructive-prefix-sweep
  // entry to `testing.md` (46,373 -> 48,527 B): payload 49,793 -> 51,947,
  // gutting bound 47,873 -> 50,027. That crossed the old 48_000 floor TWICE as
  // the entry was reviewed, which is why the floor moved 48_000 -> 50_000 ->
  // 51_000 across this lane -- the move this file's own `GUTTED satellite` case
  // prescribes, not a ratchet.
  // RE-MEASURED 2026-09-06 by the work-issues retro, which added a probe-receipt
  // rule to `testing.md` (48,527 -> 48,728 B): payload 51,947 -> 52,148,
  // gutting bound 50,027 -> 50,228, usable room 972 -> 771 B. Segmented at the
  // BULLET boundary, as the 2026-09-05 entry above prescribes: the receipt
  // bullet +288 B (already net of one compression inside it) and the
  // neighbouring probe-disposition bullet -87 B, summing to the +201. Stated
  // as DELTAS and not as before/after absolutes on purpose: two independent
  // measurements of the same two bullets agreed on both deltas and differed
  // by one byte on the disposition bullet's absolutes, because that bullet
  // is the LAST before a heading, so whether the blank line separating them
  // belongs to it is a choice. (The receipt bullet abuts the next bullet and
  // has no such ambiguity.) A delta is invariant under that choice; an
  // absolute is not, so only the delta is checkable everywhere. An earlier
  // revision also quoted
  // 586/874 and 572/485, which were CHARACTER counts short by the em-dashes
  // and the section sign -- caught in review, on the page whose whole subject
  // is a byte figure going stale. Derived
  // by RUNNING the glob command below, not by hand -- which is also how the
  // `testing.md` figure in the gutting case was found sitting at 48,169 B,
  // stale by 358 B before this commit touched anything.
  //
  // EVERY FIGURE ABOVE IS RE-DERIVED FROM ONE MEASUREMENT of the final tree,
  // never carried forward by hand: three consecutive review rounds shipped
  // arithmetic that had drifted from the files. Derive the file set BY GLOB, as
  // the row and the discriminate case both do -- naming `testing.md` and
  // `test-stream-fence.md` is correct only until a satellite is split out of
  // either, and that is exactly how a stale figure gets re-introduced:
  //
  //   node --input-type=module -e '
  //     import { readdirSync, readFileSync, statSync } from "node:fs";
  //     const T = "tests/setup.ts", MIN = 1500;
  //     const re = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  //       .replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*") + "$");
  //     let sum = 0; const rows = [];
  //     for (const f of readdirSync(".claude/rules").filter((n) => n.endsWith(".md"))) {
  //       const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(".claude/rules/" + f, "utf8"));
  //       const globs = fm ? [...fm[1].matchAll(/^\s*-\s*[\x27"](.+?)[\x27"]\s*$/gm)].map((m) => m[1]) : [];
  //       if (!globs.some((g) => re(g).test(T))) continue;
  //       const b = statSync(".claude/rules/" + f).size; sum += b; rows.push([f, b]);
  //     }
  //     console.log("payload", sum);
  //     for (const [f, b] of rows) console.log("bound if", f, "gutted", sum - b + MIN);
  //   '
  //
  // then floor must satisfy: bound < floor <= payload <= cap, and usable room
  // is floor - bound - 1.
  //
  // RE-MEASURED 2026-09-05 after the work-issues retro escalated its
  // one-sided-fence rule into `testing.md` (+256 B of rule, 140 B of it paid
  // back by compressing three neighbouring mutation bullets, 46,257 -> 46,373 B
  // net): payload 49,677 -> 49,793, gutting bound 47,757 -> 47,873, usable
  // room 242 -> 126 B. Compression there is the only way to buy that back.
  // The two components are segmented at the BULLET boundary (the rule's own
  // bullet 113 -> 369 B; the three compressed ones 1,595 -> 1,455 B) and sum
  // to the net -- an earlier draft said 207/91, which summed to the right 116
  // by luck and matched no definition of either part. Both review axes caught
  // it independently, on the file that exists to stop exactly this.
  // This floor is set by a PROPERTY rather than by the table's usual ~12%-under
  // convention, and `the tests/setup.ts floor still discriminates` below
  // RECOMPUTES that property instead of trusting this number. It must sit above
  // `testing.md` (48,728 B) plus SUBSTANTIVE_MIN_BYTES, so that gutting
  // `test-stream-fence.md` down to the smallest size the `substantive content`
  // case still allows fails HERE. 51_000, 57_000 and 62_000 were each chosen by
  // hand and each failed to add signal: the first two sat below `testing.md`
  // alone, and 62_000 was strictly subsumed -- it fired only under 642 B of
  // satellite, where `substantive content` already fires at 1,500 B, so a
  // satellite gutted to 1,501 B passed every check in this file. Note the three
  // hooks rows do NOT have this property -- floored at 108_000 against a
  // 114,298 B hooks.md -- so they are not a precedent for it; they bound growth,
  // this one also bounds loss.
];

/** A rule file at or under this is frontmatter and little else -- see the `substantive content` case. */
const SUBSTANTIVE_MIN_BYTES = 1_500;

const SPLIT_ADVICE =
  'Move the detail into a NEW .claude/rules/<area>.md satellite whose `paths:` glob is as narrow as the content, and leave a one-line pointer behind. Do not summarise or delete the text.';

/**
 * The remedy for a LINE-length bound, which is not the same remedy and was for a
 * while printed as if it were.
 *
 * Issue go-to-k/cdkd#2310 was filed because the corpus assertion printed
 * SPLIT_ADVICE, and splitting is byte-NEUTRAL on a sum -- a reader who followed
 * the message did work that could not possibly fix the failure. Retiring that
 * assertion fixed the instance; this constant fixes the CLASS, because the same
 * mismatch survived on both line bounds:
 *
 *   - the repo-wide long-line COUNT is a count. Moving a 4,000 B line into a
 *     satellite carries the line with it and the count is unchanged.
 *   - the per-line ceiling measures ONE line. The same move relocates it intact.
 *
 * Both are fixed by REFLOWING the line and neither by splitting a file, so the
 * message says so. Splitting stays the right advice for the per-file cap and the
 * per-path payload caps, where it genuinely reduces the number being asserted.
 */
const REFLOW_ADVICE =
  'Break the line into ordinary paragraphs. Splitting the file does NOT help here -- both line bounds travel with the line, so a satellite just moves the same long line somewhere else. Reflow it; do not summarise or delete the text.';

/**
 * The `.md` link targets a reader can actually SEE and follow, taken from the
 * RENDERED page rather than inferred from the source.
 *
 * This RENDERS the Markdown and reads the anchors out, because the hand-rolled
 * scanner it replaces could not be made correct. Four review rounds found four
 * silent passes in it, three of them inside the previous round's fix: a
 * 3-backtick marker closing a 4-backtick fence; a list-context exemption that
 * disabled the indent rule where the fence regex was already blind; a comment
 * ending inside a code block, forging a close out of code content; and a
 * blockquote strip doing the same thing one commit after that bug was fixed.
 *
 * The pattern was structural, not bad luck. CommonMark block structure is a
 * CONTAINER STACK -- quote depth by fence state by indent width -- and a flat
 * per-line state machine models one dimension at a time, so each fix added a
 * dimension and created a fresh cross-term for the next round to find. A
 * parser has the stack already.
 *
 * `marked` does not produce an anchor for a link inside a code block, so
 * every residual the old implementation had to document -- tabs, blockquotes,
 * nested fences, comments, reference and collapsed and shortcut link forms,
 * titles, angle brackets, link text containing brackets -- is gone with it.
 *
 * What is NOT true is the tempting summary, that "extract every `<a href>`" IS
 * the visibility question. Review found three places where it is not, each now
 * handled in the code below and named here so the claim stays honest: YAML
 * frontmatter is metadata a reader never sees; an anchor with empty link text
 * renders as nothing to click; and a stray unclosed `<table>` would pair with
 * a later table's close and lend prose the strength a table index withholds.
 * The first revision of this paragraph said the residuals were "simply gone",
 * which was the overclaim this file elsewhere warns about -- and it was
 * written in the same commit that deleted a false "everything fails closed"
 * claim for the same reason.
 *
 * It is a devDependency used by this one test and never bundled: `vp pack`
 * does not see it. It was already in the tree transitively through mermaid at
 * this exact version, so declaring it added nothing to install (`pnpm add`
 * reported `downloaded 0, added 0`) and no new supply-chain surface.
 */
/**
 * Does this Markdown render with a raw HTML comment still in it?
 *
 * `marked` passes a raw comment through verbatim, so a raw `<a href>` inside
 * one would reach `visibleLinkTargets` while a reader sees nothing. That
 * function deliberately does NOT strip comments -- three attempts at stripping
 * were each wrong in a different direction -- so this predicate is what makes
 * the absence safe, and the corpus case below asserts it holds everywhere.
 */
function rendersSurvivingComment(markdown: string): boolean {
  // Comments are not the only raw passthrough. CommonMark HTML block types
  // 1/3/4/5 -- `<script>`/`<style>`/`<textarea>`, `<?...?>`, `<!DOCTYPE ...>`,
  // `<![CDATA[...]]>` -- also reach the
  // output verbatim, and a browser's bogus-comment parse ends them at the
  // first `>` (inside the `<a` tag), so an anchor inside one is invisible to a
  // reader exactly like one inside a comment. Detecting only `<!--` would have
  // left the docblock's claim -- that this predicate is what makes the absent
  // stripper safe -- true of one shape out of four.
  return /<(?:!--|\?|![A-Za-z]|!\[CDATA\[|(?:script|style|textarea)\b)/i.test(
    marked.parse(markdown, { async: false }),
  );
}

// NAMED entities stay a hand list, and saying otherwise would repeat the
// mistake above. There is no built-in named-entity decoder, and the full
// HTML table is ~2,200 entries; what matters here is only which ones
// render BLANK. The aliases are the trap -- `&ZeroWidthSpace;` is another
// spelling of the very U+200B the transposition bug was about -- so they
// are listed beside their short forms rather than left to be rediscovered.
// Residual, stated plainly: a blank-rendering named entity outside this
// map is credited over an empty cell. It fails in the crediting direction,
// it needs an author to write one deliberately, and none appears in the
// corpus.
const NAMED_BLANK: Record<string, string> = {
  nbsp: '\u00a0',
  nonbreakingspace: '\u00a0',
  shy: '\u00ad',
  zwnj: '\u200c',
  zwj: '\u200d',
  zerowidthspace: '\u200b',
  nobreak: '\u2060',
  af: '\u2061',
  applyfunction: '\u2061',
  it: '\u2062',
  invisibletimes: '\u2062',
  ic: '\u2063',
  invisiblecomma: '\u2063',
  negativethinspace: '\u200b',
  negativeverythinspace: '\u200b',
  negativemediumspace: '\u200b',
  negativethickspace: '\u200b',
  thickspace: '\u205f',
  ensp: '\u2002',
  emsp: '\u2003',
  emsp13: '\u2004',
  emsp14: '\u2005',
  thinsp: '\u2009',
  thinspace: '\u2009',
  verythinspace: '\u200a',
  mediumspace: '\u205f',
  numsp: '\u2007',
  puncsp: '\u2008',
  hairsp: '\u200a',
};

/** `String.fromCodePoint` without the throw: out-of-range keeps the raw text. */
function codePoint(value: number, raw: string): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : raw;
}

function visibleLinkTargets(lines: readonly string[], rowsOnly = false): string[] {
  // YAML frontmatter is METADATA, not page content -- GitHub strips it and no
  // reader sees a link inside `description:`. Feeding it to the renderer let a
  // pointer moved out of the body and into the frontmatter keep a satellite
  // "reachable" while the page showed nothing.
  const body = [...lines];
  if (body[0]?.trim() === '---') {
    const close = body.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (close !== -1) body.splice(0, close + 1);
  }
  // NO comment-stripping. Three successive attempts at one were each wrong in
  // a different direction -- the unbounded form let CommonMark's abbreviated
  // `<!-->` reach past a later comment and drop the span between them, and
  // bounding it with `(?!<!--)` then made a genuine comment containing an
  // anchor followed by an inner `<!--` credit that anchor, which is the
  // forbidden direction. Each attempt shipped a comment asserting the residual
  // was safe, and each of those was false.
  //
  // What the strip existed for was a RAW `<a href>` written inside an HTML
  // comment, which marked passes through verbatim. That is now a checked
  // PRECONDITION rather than a heuristic: the case below asserts no rule file
  // renders a surviving `<!--` at all, so nothing can hide inside one. A
  // markdown link inside a comment never becomes an anchor in the first place.
  // Measured before removing it: the strip changed the anchor set in ZERO of
  // the 47 files. It was inert, three times wrong about why, and is gone.
  const html = marked.parse(body.join('\n'), { async: false });
  // `rowsOnly` is the table-index contract, asked literally: is the anchor
  // inside a TABLE? The old source-side form tested whether a line began with a
  // pipe, which a blockquoted pipe-line satisfied while rendering as a
  // paragraph. `(?!<table)` stops a stray unclosed `<table>` from pairing with
  // a LATER table's close and swallowing the prose between them.
  const scope = rowsOnly
    ? [...html.matchAll(/<table(?:(?!<table)[\s\S])*?<\/table>/g)].map((m) => m[0]).join('\n')
    : html;
  const targets: string[] = [];
  for (const m of scope.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    // An anchor with nothing VISIBLE in it is not a pointer a reader can
    // follow: `[](layout-utils.md)` renders zero-width with nothing to click.
    // So "every <a href>" is nearly, but not exactly, the visibility question.
    //
    // An IMAGE counts as content -- a badge link is clickable. The first cut
    // stripped every tag before testing, which dropped an image-only anchor
    // and so stopped the dangling-pointer half from reporting a badge that
    // pointed at a file that does not exist: a narrowing that fails quiet,
    // which is the one direction this fence must never fail in.
    //
    // Emptiness is judged after decoding the spaces that do not look like
    // spaces. `String.trim()` removes White_Space only, so a zero-width space
    // or an `&nbsp;` left a cell blank on the page while still crediting the
    // pointer.
    // DECODE, then ask whether anything is left that a reader could see.
    //
    // The first cut was an alternation of entity spellings, and review found
    // it had `&#x2028;` where `&#x200b;` belonged -- a transposition, so the
    // hex zero-width space was credited over a blank cell. Patching the list
    // would not have helped: `&#x00a0;`, `&#0160;` and `&#08203;` are all
    // legal spellings of characters the list already named, so any hand list
    // is wrong by construction. Decoding numerically removes the whole class,
    // and it is why this is a decoder rather than a longer alternation.
    const visible = m[2]!
      // Media renders on its own, so an image-only anchor IS clickable and
      // must count. `object` is here because an `<object data=...>` DOES
      // render -- an earlier revision dropped it claiming the opposite, which
      // was simply false. `picture` stays out: it is a container that renders
      // only through its children, and a `<picture>` wrapping an `<img>` is
      // caught by the `img` arm anyway.
      .replace(/<(?:img|svg|video|canvas|object)\b[^>]*>/gi, 'x')
      .replace(/<[^>]*>/g, '')
      // Guarded, because `String.fromCodePoint` THROWS above U+10FFFF and
      // marked passes 1-6 hex / 1-7 decimal digits through unescaped: a rule
      // file containing `[&#x110000;](x.md)` would abort this case with a
      // RangeError instead of failing with its own message. Out of range is
      // left as written, which is what a browser shows.
      // ONE pass over all three spellings. Three sequential passes let the
      // output of one be re-read by the next: `&#x26;#8203;` decoded to `&`,
      // which the decimal pass then read as `&#8203;` and blanked, dropping a
      // pointer a browser renders as the literal text `&#8203;`. Same class as
      // the `&amp;`-LAST ordering on the href decoder, and one pass is a fix
      // that cannot recur rather than an ordering that must be argued again.
      .replace(
        /&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi,
        (whole: string, hex?: string, dec?: string, name?: string) => {
          if (hex !== undefined) return codePoint(parseInt(hex, 16), whole);
          if (dec !== undefined) return codePoint(Number(dec), whole);
          return NAMED_BLANK[name!.toLowerCase()] ?? whole;
        },
      )
      // Everything here is zero-width or a separator: nothing a reader sees.
      // `trim()` alone would not do it -- it removes White_Space only, and a
      // zero-width space is not White_Space.
      // Only the ones `trim()` does NOT already remove. U+2028/2029 are
      // LineTerminators and U+FEFF is WhiteSpace, so listing them here was
      // inert -- deleting them passed the whole table, which is the "guard
      // with nothing under it" shape this file keeps rediscovering. What is
      // load-bearing is U+00AD, the U+200B-200F range (LRM/RLM included) and
      // U+2060.
      // U+2060-2064 as a RANGE, not just the word joiner: the invisible
      // operators (function application, times, separator, plus) render as
      // nothing too. Found by the round-trip check below, which flagged `&af;`
      // as an inert map key the moment it was written -- the map named the
      // entity while this class did not cover what it decodes to, so the
      // entry did nothing and nothing said so.
      .replace(/[\u00ad\u200b-\u200f\u2060-\u2064]/g, '');
    if (visible.trim() === '') continue;
    targets.push(
      m[1]!
        // `&amp;` LAST: decoding it first would turn `&amp;lt;` into `&lt;` and
        // then into `<`, inventing a character the author never wrote.
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(?:39|x27);/gi, "'")
        .replace(/&amp;/g, '&')
        .split('#')[0]!,
    );
  }
  return targets;
}

/**
 * The `.claude/rules` file a raw link target denotes, or undefined when it
 * points somewhere else.
 *
 * Two spellings reach the same file and both count: a BARE name, which is how
 * one rule file links a sibling, and any path ending `.claude/rules/<name>`,
 * which is how CLAUDE.md writes it. Everything else -- `docs/import.md`,
 * `../../docs/provider-rules.md`, `docs/design/463-cfn-macros.md` -- is a
 * pointer out of the corpus and is none of this fence's business. Getting this
 * wrong in the permissive direction is not cosmetic: basenaming every `.md`
 * link makes `docs/state-management.md` look like a missing rule file, and the
 * resulting noise is what trains someone to stop reading the failure.
 */
function ruleTarget(raw: string): string | undefined {
  // The renderer hands back EVERY href, including ones the old regex filtered
  // by construction: `https://` pointers, and GFM autolinks -- `marked` turns
  // the bare text `cdk-local@0.10.0` in layout-local.md into a `mailto:`. The
  // `.md` test therefore belongs here, at the one place that decides what a
  // target denotes, rather than back in the extraction.
  if (!raw.endsWith('.md')) return undefined;
  if (!raw.includes('/')) return raw;
  const m = /(?:^|\/)\.claude\/rules\/([^/]+\.md)$/.exec(raw);
  return m?.[1];
}

interface RuleFile {
  name: string;
  text: string;
  bytes: number;
  description: string | undefined;
  paths: string[] | undefined;
  frontmatterError: string | undefined;
  lines: string[];
}

/**
 * The frontmatter is read with the real YAML parser, not a regex, because the
 * failure this catches is a YAML one: an unquoted `description:` whose value
 * itself contains `": "` is a mapping-value-not-allowed error, and a regex
 * reader happily returns a string for a file Claude Code would refuse to load.
 */
function parseRuleFile(name: string): RuleFile {
  return parseRuleText(name, readFileSync(join(RULES_DIR, name), 'utf-8'));
}

/**
 * The same parse against text from anywhere, so the merge PROJECTION below can
 * read a rule file out of a git rev with `git show` and get a payload computed
 * the identical way. Splitting this out is not a tidy-up: the projection has to
 * resolve each historical file's `paths:` globs to sum a per-path payload, and a
 * second frontmatter reader written for that job would disagree with this one on
 * exactly the malformed files the disagreement matters for.
 */
function parseRuleText(name: string, text: string): RuleFile {
  const lines = text.split('\n');
  const base = {
    name,
    text,
    bytes: Buffer.byteLength(text, 'utf-8'),
    lines,
    description: undefined,
    paths: undefined,
  };
  if (lines[0]?.trim() !== '---') {
    return { ...base, frontmatterError: 'no leading `---` frontmatter fence' };
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) return { ...base, frontmatterError: 'unterminated frontmatter fence' };
  let doc: unknown;
  try {
    doc = parseYaml(lines.slice(1, end).join('\n'));
  } catch (err) {
    return { ...base, frontmatterError: (err as Error).message };
  }
  if (typeof doc !== 'object' || doc === null) {
    return { ...base, frontmatterError: 'frontmatter is not a YAML mapping' };
  }
  const map = doc as Record<string, unknown>;
  const rawPaths = map['paths'];
  return {
    ...base,
    description: typeof map['description'] === 'string' ? map['description'] : undefined,
    paths:
      Array.isArray(rawPaths) && rawPaths.every((p) => typeof p === 'string')
        ? (rawPaths as string[])
        : undefined,
    frontmatterError: undefined,
  };
}

/**
 * Glob -> RegExp with the semantics the `paths:` frontmatter uses: `**` spans
 * directory separators, `*` does not. `a/**` matches everything under `a/`;
 * `a/**\/*.ts` matches `a/x.ts` as well as `a/b/c/x.ts`.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('**', i)) {
      out += '.*';
      i += 2;
      continue;
    }
    const ch = glob[i]!;
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

/**
 * The rule files a given touched path loads, and their byte total.
 *
 * SHARED by the live budget cases and the merge projection ON PURPOSE. They used
 * to carry the same filter+reduce separately, and review defeated the projection
 * by slicing the projection's copy alone (`.slice(0, 1)`) -- 312/312 green, since
 * the live cases computed their own answer and never noticed. Duplicated logic
 * makes each copy independently mutable, which is the same reason a checker's
 * comparand must not be built by the mechanism it guards: the second copy is a
 * place for the defect to hide. One definition means any mutation to it reds the
 * live cases too, loudly, whatever the projection's own arms do.
 */
function matchingRules(rules: readonly RuleFile[], touched: string): RuleFile[] {
  return rules.filter((rule) => (rule.paths ?? []).some((glob) => globToRegExp(glob).test(touched)));
}

function payloadFor(rules: readonly RuleFile[], touched: string): number {
  return matchingRules(rules, touched).reduce((sum, rule) => sum + rule.bytes, 0);
}

// RECURSIVE, because a non-recursive listing is a way to make this whole fence
// vacuous without touching it. Review probe, 2026-08-25: moving 10 satellites
// into `.claude/rules/layout/` hid 206,871 B, dropped the suite from 93 tests
// to 63, and it went GREEN -- every per-file cap on those 10 went unchecked
// while every budget DROPPED, so the fence rewarded the regression. The `>= 10`
// guard-the-guard floor could not see it either: there are 28 files, so a floor
// that low is unreachable in practice and only catches a totally wrong dir.
const ruleFiles: RuleFile[] = readdirSync(RULES_DIR, { recursive: true })
  .map((f) => String(f))
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map(parseRuleFile);

// The corpus as a whole, asserted as a FLOOR only. It was a RANGE until issue
// go-to-k/cdkd#2310 retired the ceiling (the note beside CORPUS_BYTES_MIN says
// why); growth is now bounded per BUDGETED PATH, which is what a session
// actually loads.
//   - the FLOOR is what notices CONTENT being DELETED corpus-wide. Every other
//     assertion here is an upper bound, so a review probe that removed
//     `layout-drift.md` outright, and one that gutted `layout-provisioning.md`
//     from 53,830 B to 203 B, both left the suite green. A split that "reduces
//     payload" by dropping text is the one outcome this refactor promised would
//     never happen.
//     Its reach is BOUNDED and the bound is measured, not assumed: it cannot see
//     a deletion smaller than its own slack, which today leaves 45 of the 51
//     files guttable. The case named "the corpus floor still discriminates the
//     deletion of the LARGEST satellite" carries the arithmetic; a per-file
//     floor is go-to-k/cdkd#2810.
// Update these deliberately, with the reason, when the corpus genuinely moves.
// 48 -> 50, by TWO independent satellite splits that landed in the same window
// and each read as "48 -> 49" on its own branch:
//   + provisioning-sticky-routing.md (go-to-k/cdkd#2719) -- state-schema.md shed
//     its sticky-routing detail after src/types/state.ts went 708 B over its
//     57,000 B budget;
//   + layout-ci-checks.md (go-to-k/cdkd#2717) -- layout-scripts.md shed the CI
//     checks that replaced retired PreToolUse gates, after the union with
//     go-to-k/cdkd#2718's entry took it past the 80,000 B per-file cap.
// Neither branch's figure is the merged one. That is the whole reason this
// count is asserted rather than described: two correct increments compose to a
// number neither author wrote.
const CORPUS_FILE_COUNT = 50; // -1 hooks-deferral-criteria.md (go-to-k/cdkd#2717, its gate retired). + layout-ci-pr-content.md (go-to-k/cdkd#2736): adding the
                              //  auto-close-form entry, plus the review round that followed
                              //  it, took layout-ci-checks.md to 20,839 B against the 20,000 B
                              //  ceiling its `pr-title-check.yml` path band asserts. (The entry
                              //  alone reached 19,672 B and would have fit; crediting it with the
                              //  whole overrun was wrong and is corrected here.) The three PR-CONTENT checks split off together because
                              //  they share one job and one subject (a pull request's diff or
                              //  body); the parent keeps the PR-TITLE check and the ISSUE checks,
                              //  which have different subjects and different workflows.
                              //
                              //  + hooks-deferral-criteria.md (go-to-k/cdkd#2707): hooks.md
                              //  crossed the per-file cap AGAIN, and the tell was a CI-only
                              //  failure -- the branch measured 79,289 B locally and 80,671 B
                              //  merged, because main had grown the same file meanwhile. Read a
                              //  near-cap number against origin/main, never against the branch.
                              //
                              //  + hooks-authoring.md (go-to-k/cdkd#2630): hooks.md crossed the
                              //  per-file cap again -- at least the seventh split off this one
                              //  file, counting the six satellites it already points at, so do not
                              //  read the ordinals in the older entries below as a running total.
                              //
                              //  A `hooks-flag-value-class.md` satellite was added on a branch and
                              //  REMOVED before merge: it restated the library note it pointed AT.
                              //  The parenthetical that stood here said splitting cannot fund an
                              //  addition because the global ceiling covers the whole tree, so a
                              //  new file spends its own frontmatter and pointer from the same
                              //  budget. That was true of the ceiling and is now OBSOLETE with it
                              //  (the retirement note beside CORPUS_BYTES_MIN): against the
                              //  per-path budgets, splitting into a NARROWER glob is exactly what
                              //  funds an addition, because the satellite's bytes stop counting
                              //  against every path the parent's glob reached. The frontmatter and
                              //  pointer are still a real cost, paid by the paths that keep
                              //  loading both.
                              //  The comment above this file's hooks.md row records the decision
                              //  that the next lane needing more room there splits rather than
                              //  trims someone else's entry or nudges the cap, and this is that
                              //  lane. (That comment's "2,531 B" was measured against the retired
                              //  120,000 cap; under the re-derived 80,000 one main's headroom was
                              //  109 B. The DECISION is what carried over, not the figure.) Two AUTHORING sections moved out verbatim under a
                              //  `.claude/hooks/*.sh` glob: "Why every Bash gate stays
                              //  unconditional" (already there) and the new refusal-message
                              //  heredoc rule. They belong together -- both answer "how do I
                              //  write a hook", which every OTHER section of hooks.md does not.
                              //  hooks.md was 79,891 B on origin/main with the new rule already
                              //  over the 80,000 cap; it is 78,844 B after the split, the
                              //  satellite is 3,187 B and the pointer left behind is 179 B.
                              //  That makes 46.
                              // + hooks-main-tree-edit.md (go-to-k/cdkd#2614), landed in
                              //  parallel and counted here because both lanes split a
                              //  satellite off hooks.md in the same window and each bumped
                              //  45 -> 46 on its own: main-tree-edit-gate's entry moved out
                              //  with its main-tree-dirty-detector backstop when the
                              //  `cd`-verb note took hooks.md past the cap. That makes 47 --
                              //  two independent splits, not one recounted twice.
                              // 29 + gate-sibling-repos.md (hooks.md crossed the per-file cap, so
                              //  its cross-repo gate-aliasing section moved out verbatim,
                              //  go-to-k/cdkd#2236) + asset-bucket-region.md (issue go-to-k/cdkd#2240
                              //  split out of assets.md). Both landed as 30 independently; merged
                              //  they made 31. + provider-resource-identity.md (issues
                              //  go-to-k/cdkd#2241 / go-to-k/cdkd#2245): providers.md's
                              //  resource-identity section moved out verbatim under a
                              //  `src/provisioning/providers/**` glob after it pushed the
                              //  cloud-control-provider.ts payload budget to 105,480 B against a
                              //  105,000 B cap -- a shared provisioning helper was paying for
                              //  provider-only detail. That makes 32.
                              //  + hooks-cwd-detector.md (go-to-k/cdkd#2363): the cwd-race
                              //  detector's entry moved out of hooks.md verbatim when the #2363
                              //  family widening pushed hooks.md past the per-file cap again --
                              //  the #2236 shape repeated. That makes 33.
                              //  + test-stream-fence.md: 876 B of stream-fence notes DID land in
                              //  testing.md first and fit; the file then grew to 1,442 B against
                              //  970 B of headroom under its payload row and had to move. (That
                              //  row's cap has since gone to 68_000 for an unrelated reason, so
                              //  the same text would fit today -- the split is kept because the
                              //  satellite's narrow `paths:` is the right home for it, not because
                              //  the cap forced it.) The
                              //  satellite is 3,384 B and the pointer left behind is 328 B,
                              //  which is why testing.md still grew
                              //  (61,030 -> 61,358 B) rather than shrinking -- a split that leaves
                              //  a pointer always costs the index file something. That makes 34.
                              //  + hooks-stop.md (go-to-k/cdkd#2391 / go-to-k/cdkd#2396): the two
                              //  Stop hooks' entries moved out of hooks.md verbatim -- the #2236
                              //  shape a third time -- when the shared nudge-cadence rule, the
                              //  output-channel table and `stop-warn`'s first suite pushed
                              //  hooks.md to 122,559 B against the 120,000 B cap. The satellite is
                              //  10,605 B under a four-path `paths:` list (the two hooks and their
                              //  suites) and hooks.md fell to 113,422 B. That makes 35.
                              //  + proxy-support.md (go-to-k/cdkd#2388): the two proxy modules,
                              //  the client-construction critic that fences them and the SDK-contract
                              //  fences were added to layout-utils.md and layout-scripts.md, and the
                              //  combined ~9 KB crossed the ceiling of the day. Moved out verbatim
                              //  under a glob naming the three files, so a session touching any
                              //  OTHER src/utils/** or scripts/** file stops paying for it -- the
                              //  #2236 / #2240 / #2363 shape again. That makes 36.
                              //  + hooks-main-tree-branch.md (2026-09-01): main-tree-branch-gate's
                              //  entry moved out of hooks.md verbatim -- the #2236 shape a fourth
                              //  time -- when the argument-parse rewrite's measured before/after
                              //  table pushed hooks.md to 122,862 B against the same 120,000 B cap,
                              //  and one line past the >4000 B long-line ratchet with it. The
                              //  satellite is 20,536 B under a two-path `paths:` list (the gate
                              //  and its suite) and hooks.md fell to 114,602 B. That makes 37.
                              //  (This line said 9,598 B while the file already measured 10,156 B,
                              //  and 20,536 B after the 2026-09-02 round. Re-measure at the tree
                              //  that SHIPS the figure: a size taken mid-edit and never re-read is
                              //  the same defect as a stale `want` in a table.)
                              //  + delete-outcome.md (go-to-k/cdkd#2301 item 3): the
                              //  `delete-outcome.ts` entry moved out of layout-deployment.md
                              //  verbatim when the suppressed-guard pair pushed the
                              //  secret-redaction.ts payload to 113,402 B against a 112,000 B cap
                              //  -- the #2241 shape, one directory over: every file under
                              //  `src/deployment/**` was paying for one module's return-value
                              //  contract. The satellite is 4,550 B under a five-path `paths:`
                              //  list (the module plus its four consumers) and
                              //  layout-deployment.md fell 1,231 B net, taking that payload to
                              //  110,697 B. No `code-layout.md` index row was added: at 261
                              //  reached files a ~186 B row took three OTHER budget rows over
                              //  their caps, so the pointer in layout-deployment.md is the only
                              //  entry point. That makes 38.
                              //  + hooks-branch-gate.md (2026-09-03): the SAME shape a fifth time,
                              //  on the sibling gate. go-to-k/cdkd#2402's review round added the
                              //  measured `--abort` / resulting-HEAD table and two stated bounds,
                              //  which put hooks.md at 119,803 B against the 120,000 B cap -- 197 B
                              //  of headroom -- and its branch-gate bullet one line past the
                              //  >4000 B ratchet. Moved out VERBATIM rather than trimmed, which is
                              //  what this file's own failure messages instruct: hooks.md fell to
                              //  115,030 B and the satellite is 6,454 B under a two-path `paths:`
                              //  list (the gate and its suite). That makes 41.
                              //  + session-report.md (2026-09-04 token-diet pass, PR #2493): the
                              //  session-wrap field reference moved OUT of CLAUDE.md, which is
                              //  injected into every context, into a satellite loaded on demand.
                              //  That makes 42.
                              //  + docs-page-template.md (2026-09-04): a NEW file rather than a
                              //  split -- the page shape and voice rules for `docs/**`, which is
                              //  the source of the public cdkd.dev site and had no written
                              //  convention at all. 5,383 B under a single `docs/**` glob, so it
                              //  loads only for a session editing the site and no existing file
                              //  shrank. That makes 43.
                              //  + docker-argv-redaction.md (2026-09-05, issue
                              //  go-to-k/cdkd#2440): the SAME split shape again, and this fence
                              //  is what demanded it -- the argv-redaction rule landed in
                              //  layout-utils.md and took the `src/utils/aws-client-defaults.ts`
                              //  budget to 58,091 B against its 58,000 B cap, 91 B over. Moved
                              //  out VERBATIM under a five-path `paths:` list (docker-cmd.ts plus
                              //  the four modules that exec docker), which is strictly narrower
                              //  than `src/utils/**`: layout-utils.md fell to 30,4xx B and the
                              //  rule now travels with the code it governs instead of with every
                              //  utils edit. That makes 44.
                              //  + state-version-purge.md (issue go-to-k/cdkd#2447): a NEW file
                              //  rather than a split in spirit, but a split in effect -- the
                              //  purge's replication gap and the three decisions behind its
                              //  detector went into layout-misc.md first and pushed the
                              //  `src/state/s3-state-backend.ts` payload to 57,197 B against its
                              //  57,000 B cap, taking `src/types/state.ts`, both `src/assets/`
                              //  rows and `vite.config.ts` over with it. Moved out under a
                              //  two-path glob (the purge and its detector) so that only a session
                              //  touching those two files pays for it -- the #2236 / #2240 / #2363
                              //  shape again -- leaving a one-line pointer in layout-misc.md.
                              //  That file GREW, 19,290 -> 19,581 B: neither module had an entry
                              //  before, so the split is against an intermediate draft rather
                              //  than against main, and a pointer always costs the index file
                              //  something. Measured on the tree that ships this line. That
                              //  makes 45.
const CORPUS_BYTES_MIN = 966_000;   // RE-DERIVED UPWARD 895_000 -> 966_000 (2026-09-08, issue
                                    // go-to-k/cdkd#2310): measured 1,003,542 B on the tree that
                                    // ships this line -- 37,542 B of slack. The constant was set
                                    // against a 999,957 B corpus (~34 KB, the margin every previous
                                    // setting used) and main grew 3,585 B under it during review, so
                                    // what SHIPS is 37.5 KB. Recorded rather than re-nudged: the
                                    // number a bound was DERIVED at, and the number it ships at, are
                                    // different facts and this file has been burned by conflating
                                    // them before.
                                    //
                                    // IT WAS VACUOUS AT 895_000 AND THE ROUND THAT RETIRED THE
                                    // CEILING IS WHY. The comment below records that the floor and
                                    // the ceiling were re-derived together; retiring the ceiling
                                    // removed the occasion that used to drag this number forward,
                                    // and the corpus had since grown to 999,957 B, leaving 104,957 B
                                    // of slack -- MORE than the largest rule file (79,173 B), so the
                                    // floor could not have noticed a whole satellite being deleted,
                                    // which is the one thing it is for. Review PROVED it live:
                                    // gutting `provider-delete-path.md` from 28,726 B to 1,512 B
                                    // left the suite 311/311 green. So the promotion of this floor
                                    // to a SURVIVING guard had to come with its re-derivation, not
                                    // merely with a note that it survives.
                                    //
                                    // The occasion is now MECHANICAL, not a habit: the case named
                                    // "the corpus floor still discriminates the deletion of the
                                    // LARGEST satellite" asserts
                                    // `corpus - largestRuleFile < CORPUS_BYTES_MIN`, so the slack
                                    // can never again exceed the LARGEST file -- which is what
                                    // stops the floor going wholly vacuous, and is strictly less
                                    // than "never misses a deletion": a deletion smaller than the
                                    // slack stays invisible, today 45 of the 51 files. That
                                    // residual is go-to-k/cdkd#2810 and no value of this constant
                                    // closes it. It is NOT a twin of the `tests/setup.ts` gutting
                                    // case, which does catch gutting for its one budgeted row.
                                    //
                                    // 895_000 was: // RE-DERIVED UPWARD 862_000 -> 895_000 (2026-09-06, issue
                                    // go-to-k/cdkd#2310): measured 929,171 B on the tree that
                                    // ships this line -- 34,171 B of slack, the same ~34 KB every
                                    // previous setting used. Moved in the SAME change that
                                    // re-derived the then-live corpus CEILING, because that change
                                    // is exactly what made this one stale: left at 862_000 it held
                                    // 67,171 B, double the slack its own comment claimed, and a
                                    // floor that drifts from its measurement stops being one.
                                    // That coupling is GONE with the ceiling (note below). This
                                    // floor is now re-derived on its own occasion: when the corpus
                                    // has grown enough that it would no longer notice a satellite
                                    // being deleted, which is the one thing it is for.
                                    // 862_000 was: // RE-DERIVED UPWARD 817_000 -> 862_000 (issue
                                    // go-to-k/cdkd#2447): measured 895,893 B on the REBASED tree
                                    // -- 33,893 B of slack, the same ~34 KB every previous setting
                                    // used. Re-derived rather than left alone because the old
                                    // figure had drifted to 79 KB of slack and would no longer
                                    // have noticed a whole satellite being deleted, which is the
                                    // one thing this bound is for. An earlier revision of this
                                    // line set 856_000 and claimed the same ~34 KB while actually
                                    // holding ~40 KB, because the bound was not moved when the
                                    // measurement went 890,757 -> 895,893 on the rebase: exactly
                                    // the drift the last paragraph below warns about, committed
                                    // inside the change that quotes it.
                                    // 817_000 was: // RE-DERIVED DOWNWARD 966_000 -> 817_000 by the 2026-09-04
                                    // compression: measured 851,451 B -- 34,451 B of slack, the
                                    // same ~34 KB every previous setting used.
                                    // 917_000 -> 966_000 (2026-09-03): re-measured with the same
                                    // ~34 KB of slack every previous setting used. The comment
                                    // beside 917_000 read "measured 951,706 B", 49 KB behind the
                                    // corpus after two parallel lanes landed their own splits.
                                    // 899_000 -> 917_000 (2026-09-02), re-measured with the same
                                    // ~34 KB of slack the previous bound was set with. The comment
                                    // beside 899_000 still read "measured 933,620 B", 18 KB behind
                                    // the corpus, which is how a floor stops being one.
                                    // 795_000 -> 899_000: the comment beside the old bound still
                                    // read "measured 808,384 B", 105 KB behind the corpus, so the
                                    // floor had ~119 KB of slack and would not have noticed a
                                    // whole satellite being deleted. Re-measured rather than
                                    // nudged, since a bound that drifts from its measurement stops
                                    // being one.
// THE GLOBAL CORPUS CEILING IS RETIRED (2026-09-08, issue go-to-k/cdkd#2310).
// `CORPUS_BYTES_MAX` used to sit here, asserted against the SUM over
// `.claude/rules/**` in the working tree and again in the merge projection
// below. Both assertions are gone; the projection remains, re-pointed at the
// per-path `PAYLOAD_BUDGETS` caps. This is option 3 of the three the issue put
// up, and the two facts that decided it are recorded here rather than in the
// issue, because this is the file the next person to want a global sum will
// open.
//
// WHY THE SUM WAS THE WRONG SUBJECT. The bound existed to cap what a session
// LOADS. No session loads the corpus: a rule file enters context when its
// `paths:` glob matches a file the session touched, so what a session pays is
// the sum over the MATCHING files. `PAYLOAD_BUDGETS` measures exactly that, per
// representative path, with a floor and a cap; and the "every rule file is
// covered by at least one budgeted path" case below proves the cover is total.
// So every byte in the corpus already counts against at least one cap that a
// real session actually pays, and the global sum added one more bound over a
// quantity nobody is charged for. That is why it was permanently full: it
// aggregated across globs that are never loaded together.
//
// The redundancy is exact, not approximate. Adding bytes to an existing rule
// file raises every budgeted path whose glob matches it. Adding a NEW satellite
// raises the paths its own glob matches, and it cannot escape by being narrow --
// the coverage case fails a file no budgeted path reaches. Widening a glob back
// out raises the paths it newly reaches, which is the regression the budgets
// were written for in the first place ("Plus 4" in the header).
//
// WHY NOT ANOTHER RAISE. Measured on 2026-09-08 by walking `origin/main` and
// recomputing the corpus at each commit that moved this constant:
//
//   08-25 23:20  #2201    900_000    corpus 799,693   headroom 100,307
//   08-28 17:41  #2365    915_000    corpus 902,461   headroom  12,539
//   08-30 23:26  #2393    928_000    corpus 914,165   headroom  13,835
//   09-01 20:10  #2401    946_000    corpus 933,620   headroom  12,380
//   09-02 15:53  #2406    985_000    corpus 970,423   headroom  14,577
//   09-03 02:58  #2462  1_000_000    corpus 989,636   headroom  10,364
//   09-03 16:30  #2431  1_040_000    corpus 1,000,819 headroom  39,181
//   09-04 12:00  #2507    890_000    corpus 853,212   headroom  36,788   (compression)
//   09-05 20:05  #2625    929_000    corpus 895,893   headroom  33,107
//   09-06 19:35  #2704    962_000    corpus 928,973   headroom  33,027
//   09-08 02:29  #2760    996_000    corpus 972,475   headroom  23,525
//   09-08 20:26  #2800  1_026_000    corpus 999,820   headroom  26,180
//
// Twelve settings in fourteen days: one introduction, TEN raises, one lowering
// (the 2026-09-04 compression). The last four raises each
// bought the ~33 KB their comments describe as "the same margin every previous
// setting used", and each was spent inside a day: main went 954,822 -> 995,881 B
// in the 22 hours after the 2026-09-07 raise, with no single lane responsible.
// Read down the `headroom` column and the mechanism is legible -- the bound is
// re-derived to whatever the corpus has already reached, so it never refuses
// anything; it only picks which lane pays the trim round.
//
// The cost landed on lanes with no allowance to fix it. `.claude/rules/**`
// budget config is outside a feature lane's file set, so the lane that arrives
// last trims its OWN entry to fit -- go-to-k/cdkd#2311 cut +1,689 B to +102 B,
// go-to-k/cdkd#2339 spent four rounds on a two-paragraph edit, go-to-k/cdkd#2616
// rewrote a four-line correction five times, and go-to-k/cdkd#2797 cut a 1,689 B
// bullet to 117 B. None of those trims made any session load less: the bytes
// they cut were under globs the complaining sum aggregates and no session loads
// together. Meanwhile the remedy the failure message printed was the per-file
// one, and splitting is byte-NEUTRAL on a sum -- the second half of #2310's
// title, and the specific way this cost people hours.
//
// Every raise was also made inside a PR about something else -- hooks, a state
// fix, a docs rewrite -- so the repo-wide bound moved twelve times without one
// review round that was ABOUT the bound. #2311's lane refused to raise it on
// exactly that reasoning and paid a trim round instead.
//
// THE CAPS WERE RE-DERIVED IN THIS SAME CHANGE, and without that step this
// would have been a removal of the guard dressed as a replacement. Review
// measured the first attempt: `PAYLOAD_BUDGETS` carried 720,045 B of unused cap
// across 40 rows -- eight rows at 36-56 KB each, one at 97% of its own payload
// -- because those caps were calibrated while the CEILING was the binding
// bound. Handing them the ceiling's job without re-deriving them let a single
// rule file grow by 55,423 B with every assertion green, against the 22,458 B
// the ceiling then allowed. Sound in kind, ~2x weaker in degree, and nothing
// said so.
//
// Every figure in this block is re-derived at the tree that ships it, against
// `origin/main`'s own cap values on that SAME tree -- not against the numbers
// the first draft measured. Two rebases moved the corpus underneath them
// (main grew `.claude/rules/hooks*.md` while this branch was open), and a
// before/after pair taken on two different trees compares two things at once.
//
// Caps that EXCEEDED `max(payload * 1.15, payload + 3000)` rounded up to the
// next 1,000 were lowered; of the 40 rows, 18 moved and 22 were left alone.
// Eight of the 18 landed BELOW the formula rather than at it (they were rounded
// down to a flat figure), and one -- the custom-resource-provider row above --
// was already tighter than the formula and was lowered anyway, because it binds
// the guarantee. Total unused cap 720,045 -> 332,045 B.
//
// An earlier revision said "28 of the 40 ... 17 rows moved", which sums to 45
// over a 40-row table: 28 is the AFTER count and 17 omitted the guarantee row.
// Two reviewers caught it and disagreed on the replacement (22 vs 23), so it was
// re-measured rather than copied. The number that matters is not that sum, though: a rule file sits
// in several rows at once, so what a lane can actually add is the MINIMUM slack
// over the rows its file reaches. Measured on the tree that ships this line:
//
//   most a single rule file can grow   before 55,423 B   after 21,451 B
//   retired ceiling allowed                              22,458 B
//
// AN EARLIER REVISION OF THIS BLOCK GOT THIS WRONG AND THE CORRECTION IS THE
// REASON THE LAST ROW OF THE TABLE MOVED. It claimed "tighter" off a 26,043 B
// figure taken before the last rebase; the corpus grew 3,585 B under it, the
// ceiling actually allowed 22,458 B, and at the then-current 24,451 B the
// replacement was ~2,000 B LOOSER. Review proved the gap was real and not
// rhetorical -- appending 24,451 B to one satellite passed the whole suite while
// putting the corpus over the retired ceiling. The fix was to close the gap
// (custom-resource-provider.ts 290_000 -> 287_000), not to soften the sentence.
//
// The comparison is still a rough one, which is worth keeping in view: the
// ceiling's 22,458 B was ONE POT shared by every lane and every area at once --
// the property that made it a treadmill, since whoever arrived last paid --
// while 21,451 B is what a single area may grow without touching any other. Two
// quantities of different kinds; holding the second at or under the first is a
// floor on the comparison, not proof the two are equivalent. The
// aggregate across all 40 rows (the 332,045 B above, if every row were spent at
// once) is deliberately NOT bounded, and that is the whole point rather than a
// residual: those bytes are never loaded together, so no session ever pays them
// together.
//
// WHAT STILL BOUNDS BULK GROWTH, so this is not a removal of the guard:
//   - `PAYLOAD_BUDGETS` caps every representative path (and its floor catches
//     text being moved OUT from under a path that needs it);
//   - the merge projection below now applies those caps to the MERGE, so the
//     cross-lane collision the global projection caught is still caught;
//   - `MAX_RULE_FILE_BYTES` caps each file, `CORPUS_FILE_COUNT` pins the count,
//     `REACH_FLOORS` pins each file's reached population, and the long-line
//     ratchet only goes down.
// `CORPUS_BYTES_MIN` stays: a FLOOR over the sum is sound in a way the ceiling
// was not, because deletion is a corpus-wide loss regardless of which glob the
// bytes sat under, and its pressure runs opposite to the treadmill above.
//
// WHY THE OLD PROJECTION DID NOT CATCH THE 2026-09-06 BREACH, kept because it
// applies unchanged to the per-path projection that replaces it: the comparison
// is against the LOCAL `origin/main` ref, and a CI run's copy of that ref is
// frozen when the RUN STARTS. go-to-k/cdkd#2695's run started 08:20:59Z;
// go-to-k/cdkd#2700 merged 08:22:04Z, 65 s later, spending part of the same
// budget; go-to-k/cdkd#2695 went green 08:31:43Z having never seen it, nothing
// re-ran it, and it merged 08:34:08Z. So a green check attests to the base at
// its START, not at your merge -- and no gate re-asks.
// `.claude/skills/check/SKILL.md` step 0 now fetches before the suite, which
// fixes the LOCAL half only; go-to-k/cdkd#2705 tracks the merge-time close.

/**
 * The repo's tracked files, read once. Memoised because two per-file suites
 * consult it and `git ls-files` is the slowest thing in this file.
 */
let trackedCache: string[] | undefined;
function trackedFiles(): string[] {
  if (!trackedCache) {
    const listed = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);
    // Guard the guard: a short listing would make the dead-glob and reach
    // assertions fail in opposite directions -- everything dead, everything
    // under floor -- and every one of those messages blames the corpus for a
    // broken environment. Validate BEFORE assigning: an earlier version cached
    // first, so the throw fired for the first consumer only and the other 28
    // failures misdiagnosed themselves (measured with a stub `git` returning 3
    // paths: 29 failures, exactly 1 of them naming the real cause).
    if (listed.length < 100) {
      throw new Error(
        `git ls-files returned ${listed.length} paths from ${repoRoot}; expected the cdkd tree. ` +
          'Every reach and dead-glob assertion in this file is measured against that listing, ' +
          'so their failures below (if any) are a symptom of this, not of the rules corpus.',
      );
    }
    trackedCache = listed;
  }
  return trackedCache;
}

describe('.claude/rules payload fence', () => {
  it('finds the rule files at all (guard the guard)', () => {
    // A wrong RULES_DIR would make every assertion below vacuously pass.
    expect(ruleFiles.length).toBeGreaterThanOrEqual(10);
    expect(ruleFiles.map((r) => r.name)).toContain('code-layout.md');
    expect(ruleFiles.map((r) => r.name)).toContain('providers.md');
  });

  it.each(ruleFiles.map((r) => [r.name] as const))(
    '%s still has substantive content',
    (name) => {
      const f = ruleFiles.find((r) => r.name === name)!;
      // The corpus floor below cannot see a SMALL file being gutted -- the
      // smallest satellite is ~3 KB, well inside the corpus slack. Review
      // probe, 2026-08-25: gutting `layout-provisioning.md` from 53,830 B to
      // 203 B (frontmatter kept) left the whole suite green.
      expect(
        f.bytes,
        `${name} is ${f.bytes} B -- barely more than frontmatter. Payload is ` +
          'reduced by moving text to a narrower-`paths:` satellite, never by ' +
          'deleting it. If this file is genuinely a stub, say so in the commit.',
      ).toBeGreaterThan(SUBSTANTIVE_MIN_BYTES);
    },
  );

  it('the corpus keeps its size and its file count', () => {
    const total = ruleFiles.reduce((n, r) => n + r.bytes, 0);
    expect(
      ruleFiles.length,
      `Expected ${CORPUS_FILE_COUNT} rule files, found ${ruleFiles.length}: ` +
        ruleFiles.map((r) => r.name).join(', ') +
        '. If you added or removed a satellite on purpose, update CORPUS_FILE_COUNT ' +
        'and the byte range beside it, and say why in the commit message.',
    ).toBe(CORPUS_FILE_COUNT);
    expect(
      total,
      `The rules corpus is ${total} B, below the ${CORPUS_BYTES_MIN} B floor. ` +
        'Payload is reduced by moving text into a narrower-`paths:` satellite, ' +
        'NEVER by summarising or deleting it. This floor is what tells those two ' +
        'apart CORPUS-WIDE: a move keeps the total, a deletion does not. It is ' +
        'not the only such assertion -- each PAYLOAD_BUDGETS row carries the same ' +
        'test for one path -- but it is the only one that sees text leaving the ' +
        'corpus altogether rather than moving between globs.',
    ).toBeGreaterThanOrEqual(CORPUS_BYTES_MIN);
    // There is deliberately NO ceiling here -- see the retirement note beside
    // CORPUS_BYTES_MIN. Bulk growth is bounded per BUDGETED PATH instead, which
    // is the quantity a session actually loads; a sum over globs no session
    // loads together could only ever be re-derived upward.
  });

  it('the corpus floor still discriminates the deletion of the LARGEST satellite', () => {
    // WHAT THIS DOES AND DOES NOT CLAIM, because an earlier revision of this
    // case claimed the whole gutting class and review disproved it in one probe.
    //
    // The floor's slack is `corpus - CORPUS_BYTES_MIN`. A deletion or gutting
    // SMALLER than that slack is invisible to it -- arithmetic, not calibration.
    // Measured on the tree that ships this line: 37,542 B of slack, and 45 of
    // the 51 rule files (658,337 B of the corpus) are small enough to be gutted
    // to `SUBSTANTIVE_MIN_BYTES` with this floor still green. Review demonstrated
    // exactly that, twice, on a 28,726 B file.
    //
    // Closing it with this bound is IMPOSSIBLE, which is why the claim is narrow
    // rather than the number being nudged: catching the SMALLEST file (2,659 B)
    // needs the floor at 1,002,384 -- the assertion is `>=`, so 1,002,383 would
    // still ACCEPT that corpus -- leaving 1,158 B of compression tolerance --
    // any ordinary reflow would red it. A single corpus-wide sum cannot both
    // permit compression and detect a small deletion; only a PER-FILE floor can,
    // and that is go-to-k/cdkd#2810, not this case.
    //
    // So what this asserts is the one thing a corpus floor CAN own: the largest
    // satellite cannot vanish silently. `CORPUS_FILE_COUNT` catches an outright
    // deletion of any file; the per-path `PAYLOAD_BUDGETS` floors catch text
    // moving out from under a path; this catches the biggest file being emptied.
    // Its real job is to stop the floor going VACUOUS again the way it did at
    // 895,000 (104,957 B of slack, larger than any file at all).
    const total = ruleFiles.reduce((n, r) => n + r.bytes, 0);
    expect(ruleFiles.length, 'no rule files, so there is no largest one').toBeGreaterThan(0);
    const largest = ruleFiles.reduce((a, b) => (a.bytes >= b.bytes ? a : b));
    expect(
      total - largest.bytes,
      `deleting ${largest.name} (${largest.bytes} B, the largest rule file) would leave ` +
        `${total - largest.bytes} B, which the ${CORPUS_BYTES_MIN} B floor must reject. ` +
        `The corpus is ${total} B, so the floor holds ${total - CORPUS_BYTES_MIN} B of ` +
        'slack -- once that exceeds the largest file, the floor cannot see ANY single ' +
        'file being emptied, which is when it stops being a check at all. Re-derive ' +
        'CORPUS_BYTES_MIN to ~34 KB under the measured corpus, the way its own history ' +
        'prescribes.\n\n' +
        'This case reds on GROWTH as well as on a bad floor, and that is expected: ' +
        'the ledger beside CORPUS_BYTES_MIN records main growing ~41 KB in 22 h, and ' +
        `this margin is ${CORPUS_BYTES_MIN - (total - largest.bytes)} B, so it comes due ` +
        'in about a day at that rate. Raising the floor is the whole remedy and it ' +
        'takes no judgement -- and unlike the corpus CEILING this change retired, ' +
        'raising a FLOOR sharpens the guard instead of weakening it, so this is a ' +
        'ratchet in the safe direction rather than the treadmill that ceiling was.',
    ).toBeLessThan(CORPUS_BYTES_MIN);
  });

  // The per-path budgets above measure the WORKING TREE. That is the merge
  // result only when this branch is rebased onto current `origin/main` -- and a
  // budgeted path's payload is spent by every lane at once, so two branches can
  // each be green in isolation and land over a cap together. Neither branch's
  // CI can see it, and whichever merges SECOND is blamed for a budget the first
  // one spent.
  //
  // Measured 2026-08-27, two lanes of one `/work-issues` run: go-to-k/cdkd#2291
  // and go-to-k/cdkd#2330 were both green and 25 B over together. It was caught
  // by hand, which is not a mechanism.
  //
  // THREE RESIDUALS, measured and stated rather than implied away. Each is a
  // ceiling on what this whole block can see, so read them before adding an arm
  // that claims to cover one.
  //
  // 1. THE MERGE BASE CANNOT BE FENCED BY VALUE. Replacing the `merge-base` call
  //    with `rev-parse origin/main` restores "assume the rebase" -- the defect
  //    this case exists to remove -- and every check still passes, because on a
  //    REBASED branch the two spellings resolve to the same commit and the
  //    substitution is a no-op. It is observable only on a STALE branch, which
  //    is exactly when the projection matters, so no assertion taken on a
  //    rebased tree can discriminate it. The stake, measured: main's corpus
  //    moved +11,375 B over 10 commits and +43,847 B over 25.
  // 2. A BOUNDED SILENT WINDOW. The count arm tolerates 3 missing names plus
  //    however many this branch ADDS (so up to 6 today), and the weight arms
  //    tolerate 10% -- but the BYTE ceiling is unaffected by the added-file
  //    term, since arm (e)'s denominator excludes those files. So what is
  //    invisible is a reader losing files that together carry under a tenth of
  //    the corpus: measured, one such trio
  //    is 92,391 B (9.21%) and passes. The measured WORST such trio is 100,350 B
  //    (10.00%) -- layout-provisioning.md + hooks-class-fences.md +
  //    architecture.md -- and that, not the example, is the ceiling on what
  //    slips through. The 213,562 B / 21.3% figure quoted below is the case that
  //    REDS.
  // 3. THE NAME SOURCE ALONE. The object-database cross-check further down
  //    compares the bytes behind the names the READER produced, so rewriting
  //    `ls-tree`'s rev argument by itself survives while the two revs hold the
  //    same name set -- true today, and measured green. That case leaves the
  //    content correct, which is why nothing else notices it either.
  //
  // So project the merge instead of assuming the rebase: `origin/main`'s payload
  // for each budgeted path, plus THIS branch's delta against its own merge base.
  // On a rebased branch that equals the working tree and every arm is a no-op;
  // on a stale one it is the only thing that sees the collision.
  //
  // It projects the CAPS only. The floors are per-path minimums a merge cannot
  // breach by ADDING, and a branch that removes text already fails its floor in
  // the working tree -- projecting them would red a branch for another lane's
  // deletion, which is the "blamed for a budget you did not spend" shape this
  // case exists to remove.
  it('every budgeted path still fits its cap once this branch is merged into origin/main', () => {
    // Memoised by RESOLVED sha, not by the name passed in: on a rebased branch
    // `origin/main` and the merge base ARE the same commit, so without this the
    // two calls below spawn `git show` once per rule file TWICE over.
    // The cached record carries the sha it was read AT, and the read below
    // verifies it. A bare `Map<sha, rules>` looks self-evidently correct and is
    // not: review re-keyed the lookup to a constant and BOTH revs returned the
    // same list, so `projected == worktreePayload` for every row and the
    // projection silently degenerated into a copy of the live budget case --
    // green, and suppressing an arm that had just fired. The entry stating its
    // own identity is what makes a mis-keyed lookup loud instead.
    const revCache = new Map<string, { sha: string; rules: RuleFile[] }>();
    // Records which sha each call actually read, so the caller can check it
    // against a SEPARATELY asked resolution. Without that, rewriting this
    // function's own `rev-parse` argument to `HEAD` makes both revs return
    // HEAD's tree: every delta is 0, `projected == worktreePayload`, and the
    // projection degenerates into a copy of the live budget case -- green, and
    // invisible to the memo's identity assert, which only compares the requested
    // sha with the recorded one and finds them equal because both are HEAD.
    const readShas = new Map<string, string>();
    const rulesAt = (rev: string): RuleFile[] | undefined => {
      let sha: string;
      try {
        sha = execFileSync('git', ['rev-parse', `${rev}^{commit}`], {
          cwd: repoRoot,
          encoding: 'utf-8',
        }).trim();
      } catch {
        return undefined; // rev unresolvable (shallow clone, never fetched)
      }
      readShas.set(rev, sha);
      const cached = revCache.get(sha);
      if (cached !== undefined) {
        expect(
          cached.sha,
          `the rule-file memo returned an entry read at ${cached.sha} for a request for ` +
            `${sha}. Every projected payload would then be computed against the wrong ` +
            'commit, and when the two revs collapse to one the projection reports the ' +
            'working tree back to itself.',
        ).toBe(sha);
        return cached.rules;
      }
      let read: RuleFile[];
      try {
        // `-z` is load-bearing. Without it `git ls-tree` QUOTES any name with a
        // non-ASCII byte (`core.quotePath`), so the name arrives ending in `"`,
        // `.endsWith('.md')` drops it, that file's bytes vanish from every
        // historical payload, and the projection goes GREEN with more room than
        // the merge really has -- an under-report in the direction that reads as
        // headroom. `-z` emits raw NUL-separated names.
        //
        // UNFENCED, and said out loud rather than left for the next reader to
        // discover: no rule filename is non-ASCII today, so reverting this to
        // `.split('\n')` leaves the suite fully green (measured in review). It
        // is defence in depth against a filename nobody has written yet, not a
        // fix for an observed break -- so do not read its presence as evidence
        // that something exercises it. A case would need a rule file with a
        // non-ASCII name, which the corpus has no reason to contain.
        const names = execFileSync(
          'git',
          ['ls-tree', '-r', '-z', '--name-only', sha, '.claude/rules'],
          { cwd: repoRoot, encoding: 'utf-8' },
        )
          .split('\0')
          .filter((n) => n.endsWith('.md'));
        read = names.map((name) =>
          parseRuleText(
            name.replace(/^\.claude\/rules\//, ''),
            execFileSync('git', ['show', `${sha}:${name}`, '--'], {
              cwd: repoRoot,
              maxBuffer: 64 * 1024 * 1024,
            }).toString('utf-8'),
          ),
        );
      } catch (err) {
        // The rev RESOLVED, so this is NOT the shallow-clone case the skip below
        // covers -- listing or reading a tree that exists failed. Returning
        // `undefined` here would route it into that skip and blame the checkout
        // depth, so it throws with the real cause instead.
        throw new Error(
          `could not read .claude/rules at ${rev} (${sha}): ${(err as Error).message}`,
        );
      }
      revCache.set(sha, { sha, rules: read });
      return read;
    };


    let mergeBase: string | undefined;
    try {
      mergeBase = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim();
    } catch {
      mergeBase = undefined;
    }

    // The merge base is an INPUT to every delta below and had no arm of its own.
    // Review replaced the `merge-base` call with `rev-parse HEAD`: on a clean
    // tree HEAD is the working tree, so `delta` became identically 0 for every
    // row, `projected == mainPayload`, and the branch's entire contribution went
    // invisible -- 312/312 green. A real merge base is an ancestor of BOTH
    // sides, which `rev-parse HEAD` is not (this branch carries a commit main
    // does not), and `--is-ancestor` answers it without going through anything
    // else this test computes.
    if (mergeBase !== undefined) {
      const isAncestor = (a: string, b: string): boolean => {
        try {
          execFileSync('git', ['merge-base', '--is-ancestor', a, b], {
            cwd: repoRoot,
            stdio: 'ignore',
          });
          return true;
        } catch {
          return false;
        }
      };
      // SELF-PROBE first: the helper must answer FALSE for a pair that is not an
      // ancestor pair. Dropping its second argument (`--is-ancestor a a`) makes
      // it unconditionally true and disarms the assert below with nothing to
      // show for it -- and `noUnusedParameters` is off, so the typecheck is
      // silent. Only meaningful when HEAD is actually ahead of the base; when
      // the branch carries no commits the two coincide and there is no
      // non-ancestor pair to ask about.
      if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim() !==
        mergeBase) {
        expect(
          isAncestor('HEAD', mergeBase),
          'HEAD is ahead of the merge base, so it cannot be an ancestor of it -- a helper ' +
            'that says otherwise answers true for everything and the merge-base assert ' +
            'below proves nothing.',
        ).toBe(false);
      }
      expect(
        isAncestor(mergeBase, 'origin/main') && isAncestor(mergeBase, 'HEAD'),
        `${mergeBase} is not an ancestor of both origin/main and HEAD, so it is not the ` +
          'merge base and every delta below is measured against the wrong tree. When it ' +
          'resolves to HEAD the deltas are all zero and this branch contributes nothing ' +
          'the projection can see.',
      ).toBe(true);
    }

    const mainRules = rulesAt('origin/main');
    const baseRules = mergeBase === undefined ? undefined : rulesAt(mergeBase);

    // The BYTES each read produced, cross-checked against the object database.
    //
    // The arm below fences the RESOLUTION step -- which sha `rulesAt` looked up
    // -- and review proved that is one step short: `ls-tree` and `git show` take
    // rev arguments of their own, so rewriting either to `HEAD` (or reassigning
    // `sha` after it has been recorded) leaves the recorded shas correct while
    // both revs return HEAD's tree. Every delta is then 0, `projected ===
    // worktreePayload`, and the projection is a copy of the live budget case.
    // Four separate one-line edits do it.
    //
    // `cat-file --batch-check` answers from the object DB in ONE spawn per rev,
    // bypassing `ls-tree`, `git show` AND `parseRuleText`, so it is independent
    // of every mechanism it checks. Blob size equals the decoded byte length for
    // this corpus (verified: 1,003,405 B both ways at origin/main), which is why
    // the two are comparable at all.
    //
    // BOUND: it compares the bytes behind the names the READER produced, so a
    // rewrite of the `ls-tree` rev ALONE survives when the two revs hold the
    // same name set -- true today. That case leaves content correct and is
    // caught by nothing here; it is the third residual, stated with the other
    // two above.
    // PER NAME, not per total: a sum lets growth in one rule file cancel a shrink
    // in another and report the right number for the wrong reason. Same single
    // spawn either way, so the weaker comparison bought nothing.
    //
    // The catch THROWS rather than returning a sentinel the caller skips on. A
    // silent skip disarms this whole arm on any `cat-file` failure -- review
    // renamed the flag to `--batch-chekc` and the suite stayed green with no
    // output at all. Unreachable in the field, since `rulesAt` reads every blob
    // with `git show` at the same sha and throws if THAT fails; but "unreachable"
    // is not a reason to leave a silent path in the one arm that fences the
    // reader.
    const blobBytesAt = (sha: string, names: readonly string[]): Map<string, number> => {
      const sizes = new Map<string, number>();
      if (names.length === 0) return sizes;
      let out: string;
      try {
        out = execFileSync('git', ['cat-file', '--batch-check=%(objectsize)'], {
          cwd: repoRoot,
          encoding: 'utf-8',
          input: names.map((n) => `${sha}:.claude/rules/${n}`).join('\n') + '\n',
        });
      } catch (err) {
        throw new Error(
          `could not read blob sizes at ${sha}: ${(err as Error).message}. That would leave ` +
            'the reader unfenced, so this fails rather than skipping.',
        );
      }
      const lines = out.trim().split('\n');
      expect(
        lines.length,
        `asked git for ${names.length} blob sizes at ${sha} and got ${lines.length} lines. ` +
          'A different count means the answers no longer line up with the names, so the ' +
          'per-name compare below would be reading the wrong sizes.',
      ).toBe(names.length);
      names.forEach((n, i) => sizes.set(n, Number.parseInt(lines[i] ?? '', 10)));
      return sizes;
    };
    for (const [label, rev, rules] of [
      ['origin/main', 'origin/main', mainRules],
      ...(mergeBase === undefined ? [] : [['the merge base', mergeBase, baseRules] as const]),
    ] as ReadonlyArray<readonly [string, string, RuleFile[] | undefined]>) {
      if (rules === undefined) continue;
      const want = blobBytesAt(
        execFileSync('git', ['rev-parse', `${rev}^{commit}`], {
          cwd: repoRoot,
          encoding: 'utf-8',
        }).trim(),
        rules.map((r) => r.name),
      );
      const mismatched = rules
        .filter((r) => r.bytes !== want.get(r.name))
        .map((r) => `${r.name}: read ${r.bytes} B, object database has ${want.get(r.name)} B`);
      expect(
        mismatched,
        `${mismatched.length} rule file(s) read for ${label} disagree with the object ` +
          `database at that commit:\n${mismatched.join('\n')}\n\nThe read came from a ` +
          'different tree than the one it claims -- and when both revs collapse to HEAD, ' +
          'every delta is zero and the projection compares the working tree with itself.',
      ).toEqual([]);
    }

    // Each read must have used the sha the caller asked for, resolved HERE and
    // not by `rulesAt`. Rewriting that function's own `rev-parse` argument is
    // otherwise invisible: both revs come back as HEAD, every delta is 0, and
    // the projection reports the working tree to itself.
    for (const [rev, expected] of [
      ['origin/main', 'origin/main'],
      ...(mergeBase === undefined ? [] : [['the merge base', mergeBase] as const]),
    ] as ReadonlyArray<readonly [string, string]>) {
      const used = readShas.get(rev === 'the merge base' ? mergeBase! : rev);
      if (used === undefined) continue; // the rev did not resolve; the skip below owns that
      let want: string;
      try {
        want = execFileSync('git', ['rev-parse', `${expected}^{commit}`], {
          cwd: repoRoot,
          encoding: 'utf-8',
        }).trim();
      } catch {
        continue;
      }
      expect(
        used,
        `the rule files for ${rev} were read at ${used}, but ${expected} resolves to ` +
          `${want}. Every projected payload below is then computed against the wrong ` +
          'commit -- and when both revs resolve to the same one, the projection compares ' +
          'the working tree with itself and passes unconditionally.',
      ).toBe(want);
    }

    // No `origin/main` to project against -- a shallow clone, or a fresh clone
    // that has never fetched. Locally that is a legitimate state and skipping is
    // right: this assertion is ABOUT the relationship to that ref, so without it
    // there is nothing to be wrong, and the per-path caps above still apply.
    //
    // In CI it is NOT legitimate, and the silence is the defect issue #2310
    // recorded on 2026-09-05: `actions/checkout` clones at depth 1 by default,
    // `origin/main` does not resolve, and this case returned before asserting on
    // every PR run for weeks -- so the projection existed only on developer
    // machines. The workflow now sets `fetch-depth: 0`; failing closed here is
    // what stops that regressing silently a second time, since a skipped
    // assertion and a passing one are the same green.
    //
    // `CI` is read by VALUE, not by presence. `CI=false` / `CI=0` / `CI=''` all
    // mean "not CI" (it is the spelling this repo's own toolchain tests), and a
    // presence check hard-reds a developer with a legitimately shallow clone,
    // telling them to go edit a workflow they are not running.
    const ci = process.env['CI'];
    const underCi = ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false';
    if (mainRules === undefined || baseRules === undefined || mergeBase === undefined) {
      expect(
        underCi,
        'origin/main (or this branch\'s merge base) does not resolve, so the merge ' +
          'projection cannot run. On a CI runner that means the checkout is shallow: ' +
          'set `fetch-depth: 0` on every job running this suite. Skipping here would ' +
          'be indistinguishable from passing, which is how this went unenforced on ' +
          'PR runs (issue go-to-k/cdkd#2310).',
      ).toBe(false);
      return;
    }

    // GUARD THE GUARD. If the historical read degenerates, every `mainPayload`
    // and `basePayload` is 0, `delta` becomes the whole working-tree payload,
    // `projected` equals it, and every cap passes because the live budget case
    // already passed -- the projection silently becomes a second copy of that
    // case. Three independent ways in, so three arms:
    //
    //   (a) the rev yields no files at all (an `ls-tree` path or filter that
    //       stopped matching);
    //   (b) the files are read but no `paths:` parses (the frontmatter reader
    //       disagreeing with itself across revs), so nothing matches any glob;
    //   (c) the NAMES stop lining up with `ruleFiles` -- the prefix strip
    //       regressing. This one needs its own arm rather than a comment,
    //       because `payloadFor` never reads `name`: it filters on `rule.paths`
    //       and sums `rule.bytes`. An earlier revision of this block asserted
    //       that a name regression would trip arm (a); review measured the
    //       opposite -- payloads stay correct and the name-dependent check just
    //       stops finding anything, which DISARMS a guard rather than firing it.
    // Names this BRANCH adds, asked of git DIRECTLY -- one `cat-file -e` per
    // candidate -- and deliberately NOT derived from `mainRules` / `baseRules`.
    //
    // The derived form is the same defect this block has spent five rounds
    // chasing, in its purest shape yet. A reader defect is SYMMETRIC across
    // revs, so every name it drops is "absent at both" and lands in this set --
    // which then removes those bytes from arm (e)'s numerator AND denominator
    // together, holding the ratio at 100%. Measured: dropping the three largest
    // files from the rev read, 213,562 B and 21.3% of the corpus, left the suite
    // green THROUGH the arm written to catch exactly that. Arm (e) had zero true
    // positives and only false-red exposure -- worse than no arm, because it
    // reads as coverage.
    //
    // `cat-file -e` does not go through `rulesAt`, so a defect in the listing,
    // the name strip or the parse cannot reach it: a file the reader loses is
    // still present in git, so it stays in the denominator and arm (e) fires.
    // One `cat-file -e` per rule file against origin/main (51 spawns, measured
    // 0.25 s); the merge-base call is short-circuited by `&&` for every name
    // already found there. An earlier revision of this sentence claimed only
    // MISSING names were asked about, which the `.filter` below plainly does
    // not do.
    const existsAtRev = (rev: string, name: string): boolean => {
      try {
        execFileSync('git', ['cat-file', '-e', `${rev}:.claude/rules/${name}`], {
          cwd: repoRoot,
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    };
    // `mergeBase` is in the skip condition above so it is narrowed to a string
    // here. It is listed there for the TYPE, not only for the guard: a
    // `baseRules === undefined` test already covers the case at runtime, but the
    // narrowing is what lets this pass the merge base to git without an
    // assertion -- and `vp run typecheck:test` is the only check that sees it,
    // since `vp check` does not type-check `tests/**` and the suite ran green
    // with the error present.
    // A branch adds a handful of satellites at most, and `ruleFiles.length` comes
    // from `readdirSync` -- so this bounds `existsAtRev` with a comparand that
    // helper cannot influence.
    //
    // It is the arm that stops the class moving one more time. `existsAtRev`
    // closed round 6's hole; review then collapsed IT to `return false`, which
    // puts every name in the added set, empties `accountableBytes`, and reduces
    // arm (e) to `expect(0).toBeGreaterThanOrEqual(0)` -- round 6's hole
    // restored through the very helper that closed it, with nothing observing
    // the collapse. The failure modes are NOT symmetric: always-TRUE only
    // enlarges the denominator (safe), always-FALSE empties it.
    const addedFileTolerance = 3;
    // Bounded so widening it is a visible decision rather than a quiet one: at
    // 51 it disarms both this arm and (c), which review demonstrated.
    expect(
      addedFileTolerance,
      'the added-file tolerance has been widened past a handful. It is the slack in two ' +
        'arms at once, and at the corpus size it stops bounding either.',
    ).toBeLessThanOrEqual(5);
    const branchAddedNames = new Set(
      ruleFiles
        .filter((r) => !existsAtRev('origin/main', r.name) && !existsAtRev(mergeBase, r.name))
        .map((r) => r.name),
    );
    expect(
      branchAddedNames.size,
      `${branchAddedNames.size} of the ${ruleFiles.length} rule files read as ADDED by ` +
        'this branch -- present in the working tree and at neither rev. A branch adds a ' +
        `handful of satellites at most. If this branch genuinely added that many, raise ` +
        `addedFileTolerance (itself capped at 5, so a larger split needs that cap re-derived ` +
        `too) and say so in the commit; a count near the corpus size means ` +
        'instead that `existsAtRev` stopped answering. Every name it swallows leaves arm ' +
        "(e)'s denominator, and at the limit that arm compares 0 against 0.",
    ).toBeLessThanOrEqual(addedFileTolerance);

    // On a REBASED branch the merge base IS origin/main, and `revCache` hands
    // back the same array object -- so the arms below would run twice on
    // identical input. The body spawns nothing (the reads happen above, memoised)
    // and a failing `expect` throws, so the cost is not doubled work or doubled
    // findings, as an earlier revision of this comment claimed: it is that the
    // second pass is provably vacuous, and a loop whose second iteration cannot
    // say anything new invites a reader to look for the difference.
    const revPasses: ReadonlyArray<readonly [string, RuleFile[]]> =
      mainRules === baseRules
        ? [['origin/main', mainRules]]
        : [
            ['origin/main', mainRules],
            ['the merge base', baseRules],
          ];
    for (const [rev, rules] of revPasses) {
      // THE RULE FOR EVERY ARM HERE, because this class has now recurred THREE
      // times in this one block: an arm's comparand must survive the failure the
      // arm exists to catch. Twice the convenient reference value was the one the
      // broken code also produces, and the arm passed on two zeroes --
      // `unexplainedZeros` built its match set with the suspect MATCHER, then
      // `rowsLoadingAtMain` compared against a worktree count computed with that
      // same matcher, then the parsable-`paths:` arm compared against a count
      // produced by the suspect PARSER (`parseRuleFile` IS `parseRuleText`;
      // forcing `paths` to undefined sent both sides to 0 and `0 >= -3` passed).
      // Each fix moved the defect one arm along. So each comparand is now named
      // with the mechanism it is independent OF:
      //
      //   (a) emptiness      -> literal 0
      //   (b) parsable paths -> `rules.length`, from `git ls-tree` (not the parser)
      //   (c) name overlap   -> `ruleFiles.length`, from `readdirSync` (not the strip)
      //   (d) glob reach     -> `PAYLOAD_BUDGETS.length`, a constant (not the matcher)
      //   (e) NAME weight    -> the WORKING TREE's bytes for the names the rev
      //                         produced; the added-set that scopes it comes from
      //                         `git cat-file -e`, NOT from the reader
      //   (f) CONTENT weight -> the rev's own bytes vs the working tree's, over
      //                         the names the two share
      //
      // Arm (e) exists because arms (b)-(d) are COUNTS and therefore unbounded in
      // bytes: review dropped the three LARGEST files -- 213,562 B, 21% of the
      // corpus -- and every count arm stayed green, since only three files went
      // missing. A first cut compared the rev's OWN byte sum at 80%, and review
      // defeated that twice: swapping the third-largest file for the fourth
      // dropped ~19.8% of the corpus and passed, and a file present-but-UNPARSABLE
      // kept its bytes in the sum while contributing nothing to any payload
      // (149,341 B invisible, suite green).
      //
      // So the weight comes from the WORKING TREE and the rev supplies only the
      // set of names it could both read and parse. A name the rev loses -- by
      // vanishing from the listing or by failing the prefix strip -- costs exactly
      // the bytes that name is worth here, which is the quantity the projection
      // actually loses. (A name it produces UNPARSABLE reds arm (b) first, which
      // is exact; arm (e) is the backstop for the case where a name never arrives
      // at all.) Bound, stated at the strength it has: neither (e) nor (f) can see
      // the byte FIELD being wrong for BOTH sides at once, since `RuleFile.bytes`
      // is one mechanism -- halving it reds 43 of the live payload cases instead,
      // which is where that shows up.
      //
      // The tolerances are three separate quantities and no longer share a
      // literal: FILES a branch may add (arm c), ROWS a branch may add (arm d),
      // and byte WEIGHT (arm e). Arm (b) has NO tolerance -- every rule file is
      // required to declare `paths:`, asserted separately, so at any rev the two
      // counts must agree exactly; the `- 2` that stood here was slack nothing
      // derived, and it was the hole review walked through.
      expect(
        rules.length,
        `${rev} yielded no .claude/rules/*.md files. The projection would then ` +
          'compare this branch against an empty corpus and pass unconditionally.',
      ).toBeGreaterThan(0);
      // ALWAYS_ON_ALLOWLIST is filtered out on BOTH sides, the way the
      // working-tree case does it. Without that, the moment anyone lands the
      // documented always-on hatch on main, every open branch's projection reds
      // and points at the branch. Empty today, which is exactly when the filter
      // is free to add and impossible to remember later.
      const declaring = rules.filter((r) => !ALWAYS_ON_ALLOWLIST.includes(r.name));
      const parsable = declaring.filter((r) => (r.paths ?? []).length > 0).length;
      expect(
        parsable,
        `${rev} yielded ${declaring.length} rule files that must declare a glob, but ` +
          `only ${parsable} with a parsable ` +
          '`paths:` list. A file whose frontmatter does not parse matches no glob, so ' +
          'its bytes vanish from every projected payload -- in the direction that reads ' +
          'as headroom. Every rule file is required to declare `paths:` (asserted ' +
          'separately for the working tree), so at any rev these two counts must ' +
          'agree exactly. Measured over all 464 revs that have touched ' +
          '.claude/rules: every file at every one of them parses with a non-empty ' +
          'list, so this is exact rather than tolerant. The one legitimate way to ' +
          'red it is ALWAYS_ON_ALLOWLIST, the documented always-on hatch, which is ' +
          'empty today -- a file added to it needs this arm to exclude it.',
      ).toBe(declaring.length);
      const overlap = rules.filter((r) => ruleFiles.some((live) => live.name === r.name)).length;
      expect(
        overlap,
        `only ${overlap} of ${rev}'s ${rules.length} rule-file names match a name in the ` +
          `working tree (which has ${ruleFiles.length}). Either the \`.claude/rules/\` ` +
          'prefix strip has regressed, or the historical listing stopped seeing most of ' +
          `the corpus. The threshold is ${ruleFiles.length - branchAddedNames.size - addedFileTolerance} ` +
          `(${ruleFiles.length} live, less ${branchAddedNames.size} this branch adds, less a ` +
          `${addedFileTolerance} tolerance). Payloads stay plausible under both -- what stops ` +
          'working is every name-keyed check here, silently.',
      ).toBeGreaterThanOrEqual(ruleFiles.length - branchAddedNames.size - addedFileTolerance);
      // (e) NAME weight and (f) CONTENT weight. Two arms, because review defeated
      // each single form in turn and they are complementary rather than
      // successive: (e) sees a name the rev never usably produced, (f) sees a
      // name it produced with the wrong bytes behind it. A first cut summed the
      // rev's own bytes over the listing -- blind to a present-but-unparsable
      // file. Replacing it with the name-weighted form alone then left NOTHING
      // reading the rev's bytes, and truncating `git show` to the frontmatter hid
      // 98.7% of the historical corpus with all five arms green.
      const usableNames = new Set(
        rules.filter((r) => (r.paths ?? []).length > 0).map((r) => r.name),
      );
      // Files this BRANCH adds are not evidence of a degraded read and must
      // leave the denominator -- otherwise a lane adding ~100 KB of satellites
      // reds this, and a "rebase" remedy cannot help, since a branch-added file
      // is at no rev to be found. That set is asked of git directly (see
      // `existsAtRev` above); deriving it from the reader is what made this arm
      // vacuous, and the note there carries the measurement.
      // ALWAYS_ON_ALLOWLIST leaves BOTH sides. Filtering it out of `usableNames`
      // alone (which the `paths:`-length test does implicitly, since an
      // always-on file declares none) while leaving its bytes in the
      // denominator is the very false-red the arm-(b) filter was added to
      // prevent, moved one arm along and capped by the 10% tolerance instead of
      // being loud.
      const accountableBytes = ruleFiles
        .filter((r) => !branchAddedNames.has(r.name) && !ALWAYS_ON_ALLOWLIST.includes(r.name))
        .reduce((n, r) => n + r.bytes, 0);
      const coveredBytes = ruleFiles
        .filter((r) => usableNames.has(r.name))
        .reduce((n, r) => n + r.bytes, 0);
      expect(
        coveredBytes,
        `the names ${rev} usably produced account for ${coveredBytes} B of the ` +
          `${accountableBytes} B of corpus that existed there ` +
          `(${((coveredBytes / accountableBytes) * 100).toFixed(1)}%), under 90%. That ` +
          'share contributes nothing to any projected payload, so the caps below pass on ' +
          'a fraction of the real merge. The count arms above cannot see it: a few LARGE ' +
          'names carry a fifth of the corpus between them.',
      ).toBeGreaterThanOrEqual(Math.floor(accountableBytes * 0.9));
      // (f) The bytes BEHIND those names. Restricted to names present at the rev
      // so a branch-added file cannot red it, and compared against the working
      // tree's own bytes for the same names -- so a rev whose CONTENT collapsed
      // (a truncated read, a decode that lost most of the file) fails here even
      // though every name and every `paths:` list survived.
      const sharedWorktreeBytes = ruleFiles
        .filter((r) => rules.some((h) => h.name === r.name))
        .reduce((n, r) => n + r.bytes, 0);
      const revSharedBytes = rules
        .filter((h) => ruleFiles.some((r) => r.name === h.name))
        .reduce((n, h) => n + h.bytes, 0);
      expect(
        revSharedBytes,
        `${rev} holds ${revSharedBytes} B behind the names it shares with the working ` +
          `tree, which holds ${sharedWorktreeBytes} B for the same names ` +
          `(${((revSharedBytes / sharedWorktreeBytes) * 100).toFixed(1)}%), under 90%. The ` +
          'names and their globs survived, so every arm keyed on those passes while the ' +
          'CONTENT behind them did not arrive -- a truncated `git show`, a decode that ' +
          'dropped most of each file. Every projected payload is then a fraction of the ' +
          'real one, in the direction that reads as headroom.',
      ).toBeGreaterThanOrEqual(Math.floor(sharedWorktreeBytes * 0.9));
    }

    const offenders: string[] = [];
    let rowsLoadingAtMain = 0;
    for (const [touched, , cap] of PAYLOAD_BUDGETS) {
      const mainPayload = payloadFor(mainRules, touched);
      const basePayload = payloadFor(baseRules, touched);
      const worktreePayload = payloadFor(ruleFiles, touched);
      if (mainPayload > 0) rowsLoadingAtMain += 1;
      const delta = worktreePayload - basePayload;
      const projected = mainPayload + delta;
      if (projected > cap) {
        // The "passes on its own" clause is CONDITIONAL, because it is false
        // whenever the working tree is over the cap too -- and that is the
        // ordinary case (a lane that simply added too much fails both this and
        // the live budget above). Printing it unconditionally told the reader
        // their tree was fine and only the merge was the problem, sending them
        // to rebase when the fix was to cut their own bytes.
        offenders.push(
          `\`${touched}\`: this branch adds ${delta} B to what that path loads. ` +
            `Against origin/main's current ${mainPayload} B that projects to ` +
            `${projected} B, over the ${cap} B cap` +
            // Branch on the DELTA, not on whether the tree is over. A branch
            // that rebased onto a main already over the cap has `delta <= 0`
            // and a tree over the cap, and telling that lane "this is your own
            // delta" is the same misattribution as the arm above, inverted.
            (delta <= 0
              ? `. This branch does not ADD to that path (delta ${delta} B) -- the ` +
                'overrun arrived on origin/main, so it is not yours to fund.'
              : worktreePayload <= cap
                ? ` -- even though the working tree loads ${worktreePayload} B there and ` +
                  "passes on its own, so a parallel lane has spent part of this path's budget."
                : `. The working tree is already over on its own (${worktreePayload} B), so ` +
                  'this is your own delta, not a collision.'),
        );
      }
    }

    // Fourth arm, and the one the three above cannot cover: the files are read,
    // parsed and named correctly, but the MATCHER stops reaching them, so every
    // payload is 0 again. Stated at the strength it actually has -- TOTAL
    // collapse, not per row.
    //
    // A per-row version was tried and withdrawn. It asked whether a row reading
    // 0 B at origin/main was explained by its matching files being ABSENT there,
    // which is wrong twice over: it false-fires on a lane that WIDENS an
    // existing file's glob onto a newly-budgeted path (file present at main, its
    // main-rev glob simply did not reach the row) and, worse, it computed
    // `liveMatches` with the very matcher under suspicion, so a broken matcher
    // left it empty and it never fired at all. Review demonstrated both.
    //
    // What it does NOT catch, said plainly rather than implied away: a PARTIAL
    // matcher break, which leaves some rows loading and under-reports the rest.
    // Nothing in this shape can -- a per-row check has no independent reference
    // value to compare against, and the live case's matcher is the same one.
    // The comparand is `PAYLOAD_BUDGETS.length`, a CONSTANT, and that is the
    // whole point. An earlier revision of this arm compared against the count of
    // rows loading in the WORKING TREE -- computed with `payloadFor`, i.e. with
    // the matcher under suspicion. Under the never-match mutation both sides
    // went to 0 and the arm passed: the same "comparand built from the suspect
    // mechanism" defect this block's own history already records one paragraph
    // up, reintroduced while fixing it. The class recurs because the convenient
    // reference value is always the one the broken code produces.
    //
    // `- 3` tolerates rows a branch legitimately adds along with the satellite
    // that reaches them. Every row loads something in the working tree today,
    // and what makes that observable is the per-row FLOOR in the `it.each` over
    // PAYLOAD_BUDGETS further down -- a row loading nothing fails it. NOT the
    // loop just above, which checks caps only, and NOT the coverage case below,
    // which is the CONVERSE (every FILE is reached by some row). Two earlier
    // revisions of this comment cited each of those in turn; the third names the
    // assertion that actually holds it up.
    expect(
      rowsLoadingAtMain,
      `only ${rowsLoadingAtMain} of the ${PAYLOAD_BUDGETS.length} budgeted paths load ` +
        'any rule file at origin/main. The glob matcher no longer reaches the ' +
        'historical corpus, so the caps above just passed on a payload of nothing.',
    ).toBeGreaterThanOrEqual(PAYLOAD_BUDGETS.length - 3);

    expect(
      offenders,
      `${offenders.join('\n')}\n\n` +
        'Rebase onto origin/main and re-measure: the number this fails on is the ' +
        'one the merge produces. Then fund your addition by cutting what your own ' +
        "change made stale -- never by trimming another lane's entry, which is not " +
        'yours to spend. ' +
        SPLIT_ADVICE,
    ).toEqual([]);
    // `.claude/rules/testing.md`: a case that SPAWNS subprocesses declares its
    // own bound, because vitest's 5 s default is an IN-PROCESS one. Measured
    // 737 ms here on a rebased branch; a STALE branch -- the only case this
    // projection exists for -- misses the memo on the merge-base read and adds
    // ~52 spawns, and a loaded CI runner is slower again. go-to-k/cdkd#2553 is
    // the precedent: 5 spawns, ~2 s locally, timed out at 5000 ms in CI. The
    // bound's job is to stop a HANG, not to police latency.
  }, 120_000);

  it.each(ruleFiles.map((r) => [r.name] as const))(
    '%s stays under the per-file byte cap',
    (name) => {
      const rule = ruleFiles.find((r) => r.name === name)!;
      expect(
        rule.bytes,
        `.claude/rules/${name} is ${rule.bytes} B, over the ${MAX_RULE_FILE_BYTES} B cap. A rule file is loaded WHOLE whenever its \`paths:\` glob matches, so its size is a fixed token toll on every such session. ${SPLIT_ADVICE}`,
      ).toBeLessThanOrEqual(MAX_RULE_FILE_BYTES);
    },
  );

  it.each(ruleFiles.map((r) => [r.name] as const))(
    '%s declares a description and a `paths:` glob that narrows something',
    (name) => {
      const rule = ruleFiles.find((r) => r.name === name)!;
      expect(
        rule.frontmatterError,
        `.claude/rules/${name} has unparseable YAML frontmatter: ${rule.frontmatterError}. Claude Code cannot read its \`paths:\` glob, so the file either never loads or always loads. The usual cause is an unquoted \`description:\` containing \`": "\` -- quote it or rewrite the value.`,
      ).toBeUndefined();
      expect(
        rule.description,
        `.claude/rules/${name} has no \`description:\` in its frontmatter; match the shape in .claude/rules/analyzer.md.`,
      ).toBeTruthy();
      if (ALWAYS_ON_ALLOWLIST.includes(name)) return;
      expect(
        rule.paths && rule.paths.length > 0,
        `.claude/rules/${name} declares no \`paths:\` globs, so it loads into EVERY session in the repo. Give it a glob as narrow as its content, or add it to ALWAYS_ON_ALLOWLIST with a written reason.`,
      ).toBe(true);
      const tracked = trackedFiles();
      const share =
        tracked.filter((f) => (rule.paths ?? []).some((g) => globToRegExp(g).test(f))).length /
        tracked.length;
      expect(
        share,
        `.claude/rules/${name} declares ${JSON.stringify(rule.paths)}, which reaches ${(share * 100).toFixed(1)}% of tracked files -- it is always-on with a \`paths:\` key for cover, and the non-empty check above cannot tell the difference. Narrow it to the area the file describes, or add the file to ALWAYS_ON_ALLOWLIST with a written reason. (The broadest legitimate glob in the corpus reaches 84.6%.)`,
      ).toBeLessThan(ALWAYS_ON_REACH_RATIO);
    },
  );

  it.each(ruleFiles.map((r) => [r.name] as const))(
    '%s has no line over the absolute per-line ceiling',
    (name) => {
      const rule = ruleFiles.find((r) => r.name === name)!;
      const worst = rule.lines.reduce(
        (max, line) => Math.max(max, Buffer.byteLength(line, 'utf-8')),
        0,
      );
      expect(
        worst,
        `.claude/rules/${name} has a ${worst} B line, over the ${ABSOLUTE_MAX_LINE_BYTES} B ceiling. This is how a 47,795-char bullet happened: one line per area, appended to PR after PR. ${REFLOW_ADVICE}`,
      ).toBeLessThanOrEqual(ABSOLUTE_MAX_LINE_BYTES);
    },
  );

  it('does not grow the repo-wide count of very long lines', () => {
    const offenders = ruleFiles.flatMap((rule) =>
      rule.lines
        .map((line, idx) => ({
          where: `${rule.name}:${idx + 1}`,
          bytes: Buffer.byteLength(line, 'utf-8'),
        }))
        .filter((l) => l.bytes > MAX_LINE_BYTES),
    );
    expect(
      offenders.length,
      `${offenders.length} lines across .claude/rules/ exceed ${MAX_LINE_BYTES} B, over the ratchet of ${LEGACY_LONG_LINE_BUDGET}. This budget only goes DOWN. Worst offenders: ${offenders
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5)
        .map((l) => `${l.where} (${l.bytes} B)`)
        .join(', ')}. ${REFLOW_ADVICE}`,
    ).toBeLessThanOrEqual(LEGACY_LONG_LINE_BUDGET);
  });

  it.each(PAYLOAD_BUDGETS.map(([p, lo, hi]) => [p, lo, hi] as const))(
    'touching %s loads between %d and %d B of rule files',
    (touched, floor, cap) => {
      const matched = matchingRules(ruleFiles, touched);
      const total = payloadFor(ruleFiles, touched);
      const from = matched
        .sort((a, b) => b.bytes - a.bytes)
        .map((r) => `${r.name} (${r.bytes} B)`)
        .join(', ');
      expect(
        total,
        `Touching \`${touched}\` now pulls in ${total} B of .claude/rules (cap ${cap} B) from: ${from}. Either a rule file grew, or a satellite's \`paths:\` glob was widened back out. ${SPLIT_ADVICE}`,
      ).toBeLessThanOrEqual(cap);
      expect(
        total,
        `Touching \`${touched}\` now pulls in only ${total} B of .claude/rules (floor ${floor} B) from: ${from}. Something this path NEEDS stopped loading -- a satellite's \`paths:\` glob was narrowed past it, its text was moved under a glob this path does not match, or the file was deleted. Payload goes down by moving text to a narrower glob that STILL COVERS the code it describes; making an area under-load is not a saving. If the drop is deliberate, lower this floor in the same commit and say what moved where.`,
      ).toBeGreaterThanOrEqual(floor);
    },
  );

  it('every rule file sits at the top of .claude/rules/', () => {
    // The listing above is recursive on purpose (a non-recursive one hid ten
    // satellites and went green), but recursion BLESSES subdirectories, and
    // nothing states that Claude Code's own loader descends into them. Until
    // something does, keep the corpus flat so the two cannot disagree.
    const nested = ruleFiles.map((r) => r.name).filter((n) => n.includes('/'));
    expect(
      nested,
      `${nested.join(', ')} live below .claude/rules/. This fence reads them recursively, but whether the LOADER does is unverified -- a rule file it cannot see is a rule file that never loads while every budget here reports an improvement. Move them back up, or verify the loader first and say so here.`,
    ).toEqual([]);
  });

  it.each(ruleFiles.map((r) => [r.name] as const))(
    '%s still reaches the population its globs claim',
    (name) => {
      const rule = ruleFiles.find((r) => r.name === name)!;
      if (ALWAYS_ON_ALLOWLIST.includes(name)) return; // deliberately always-on: no population to floor
      const floor = REACH_FLOORS.get(name);
      expect(
        floor,
        `.claude/rules/${name} has no REACH_FLOORS entry. Every rule file needs one: it is the only assertion that notices a \`paths:\` glob being narrowed around whichever single path a payload budget happens to name.`,
      ).toBeDefined();
      const reached = trackedFiles().filter((f) =>
        (rule.paths ?? []).some((glob) => globToRegExp(glob).test(f)),
      );
      const literal = !(rule.paths ?? []).some((glob) => /[*?]/.test(glob));
      if (literal) {
        // No wildcard means the reach IS the entry count, so an 80% floor buys
        // exactly one entry of slack. Assert it exactly instead -- in both
        // directions, so adding a path is a deliberate table update too.
        expect(
          reached.length,
          `.claude/rules/${name} lists ${rule.paths?.length} literal paths and now reaches ${reached.length} tracked files; this table records ${floor}. A wildcard-free \`paths:\` list only changes by a deliberate edit: if you added or removed an entry, update this number in the same commit. If you REMOVED one, say which code no longer needs this file's ${rule.bytes} B -- dropping an entry here is how 24,465 B went dark for a 316 KB source file in review.`,
        ).toBe(floor!);
        return;
      }
      expect(
        reached.length,
        `.claude/rules/${name} now reaches ${reached.length} tracked files, under its floor of ${floor}. Its \`paths:\` globs were narrowed, so its ${rule.bytes} B stopped loading for code that still needs them -- and the payload budgets cannot see this, because each speaks for one representative path. If the narrowing is deliberate, lower the floor in the same commit and say which code no longer needs this file.`,
      ).toBeGreaterThanOrEqual(floor!);
    },
  );

  it('no `paths:` glob is dead', () => {
    // A dead glob is the purest version of what the floors above catch: the
    // file's bytes stop counting against every budget precisely because
    // nothing loads it, so the table reports a saving for text that has gone
    // dark. Review probe, 2026-08-25: repointing `layout-drift.md` at
    // `src/analyzer/zzz-no-such-file.ts` hid 51,608 B and the suite stayed
    // green.
    const tracked = trackedFiles();
    const dead = ruleFiles.flatMap((rule) =>
      (rule.paths ?? [])
        .filter((glob) => !tracked.some((f) => globToRegExp(glob).test(f)))
        .map((glob) => `${rule.name}: ${glob}`),
    );
    expect(
      dead,
      `These \`paths:\` globs match no tracked file, so the rule file never loads for them: ${dead.join(', ')}. Either the glob has a typo, or the code it named was renamed or removed and the notes went with it.`,
    ).toEqual([]);
  });

  it('the tests/setup.ts floor still discriminates a GUTTED satellite', () => {
    // A floor that merely exists is not a check. This one has to be BELOW the
    // live payload and ABOVE the two ways `test-stream-fence.md` can stop
    // carrying its content, and the margin is recomputed here so it fails when
    // spent rather than when someone notices.
    //
    // Deletion is caught by `CORPUS_FILE_COUNT` and by index reachability
    // anyway, so it is the GUTTING case that this floor uniquely owns: a
    // satellite trimmed to just over `SUBSTANTIVE_MIN_BYTES` passes every other
    // assertion in this file.
    //
    // The usable band is structurally narrow -- `satellite - SUBSTANTIVE_MIN_BYTES`,
    // which is 1,920 B today -- and `testing.md` growing spends it from the
    // other side. It ran out on 2026-09-05 exactly as written: a 1,126 B
    // addition to `testing.md` reddened this case, and the floor was re-derived
    // 46_000 -> 48_000 in the same commit. That is the prescribed move -- not
    // slack to be debugged away, and not a reason to shrink the addition.
    const row = PAYLOAD_BUDGETS.find(([path]) => path === 'tests/setup.ts');
    expect(row, 'the tests/setup.ts budget row was removed').toBeDefined();
    const [, floor, cap] = row as readonly [string, number, number];

    // Computed the same way the row itself is -- by GLOB, not by naming the two
    // files. `testing.md` globs `tests/**`, so a future satellite split out of
    // it would also match this path and re-subsume the floor while a name-based
    // version of this case kept reporting green.
    const matched = ruleFiles.filter((rule) =>
      (rule.paths ?? []).some((glob) => globToRegExp(glob).test('tests/setup.ts'))
    );
    const satellite = matched.find((r) => r.name === 'test-stream-fence.md');
    expect(satellite, 'test-stream-fence.md no longer matches tests/setup.ts').toBeDefined();
    const live = matched.reduce((sum, r) => sum + r.bytes, 0);
    const withoutSatellite = live - (satellite as { bytes: number }).bytes;

    expect(
      withoutSatellite,
      `deleting test-stream-fence.md would leave ${withoutSatellite} B, which the ${floor} B ` +
        'floor must reject'
    ).toBeLessThan(floor);
    expect(
      withoutSatellite + SUBSTANTIVE_MIN_BYTES,
      `gutting test-stream-fence.md to ${SUBSTANTIVE_MIN_BYTES} B would leave ` +
        `${withoutSatellite + SUBSTANTIVE_MIN_BYTES} B, at or above the ${floor} B floor -- the ` +
        'floor no longer discriminates. Raise it (and the cap if needed), or say in the commit ' +
        'why the gutting case is now covered elsewhere.'
    ).toBeLessThan(floor);
    expect(
      live,
      `the live payload is ${live} B, under the ${floor} B floor this case just required`
    ).toBeGreaterThanOrEqual(floor);
    expect(
      live,
      `the live payload is ${live} B, over the row's ${cap} B cap`
    ).toBeLessThanOrEqual(cap);
  });

  it('every payload budget is a band, so no row can be satisfied by crossing', () => {
    // The corpus-bound version of this case (CORPUS_BYTES_MIN < CORPUS_BYTES_MAX)
    // went with the global ceiling. Its job moves here, where the two-sided
    // bounds now live: a row whose floor exceeds its cap is unsatisfiable, and
    // its per-path case would report a payload that fails both without naming
    // the cause.
    const crossed = PAYLOAD_BUDGETS.filter(([, floor, cap]) => floor >= cap).map(
      ([path, floor, cap]) => `${path} (floor ${floor} >= cap ${cap})`,
    );
    expect(
      crossed,
      `These budget rows are unsatisfiable: ${crossed.join(', ')}. A floor at or ` +
        'above its cap fails whatever the payload is, so the row stops measuring ' +
        'the path and starts measuring itself.',
    ).toEqual([]);
  });

  it('no rule file renders a surviving HTML comment, so nothing can hide in one', () => {
    // This is the PRECONDITION that lets `visibleLinkTargets` carry no
    // comment-stripping. `marked` passes a raw HTML comment through verbatim,
    // so a raw `<a href>` written inside one would reach the extractor
    // invisible to a reader. Three attempts at stripping comments were each
    // wrong in a different direction (go-to-k/cdkd#2672 rounds 5-7), so the
    // question is answered by ASSERTING the thing that makes stripping
    // unnecessary rather than by a fourth regex.
    //
    // A markdown link inside a comment never becomes an anchor, so this only
    // has to hold for comments that SURVIVE rendering -- and none does today,
    // because every `<!--` in the corpus is inside a code span.
    // BOTH POLARITIES, because the corpus case alone is vacuous: nothing trips
    // it today, so replacing the predicate with `() => false` left the whole
    // suite green when probed. These two are what make the corpus assertion
    // mean something.
    // All FOUR raw-passthrough block types, because the predicate's job is to
    // make the absent comment-stripper safe and a comment is only one of the
    // ways raw HTML reaches the output. Probing showed that reverting the
    // widening to `<!--` alone left the whole suite green: nothing in the
    // corpus carries the other three, so these are the only thing under them.
    for (const raw of [
      '<!-- <a href="ghost.md">x</a> -->',
      '<?x <a href="ghost.md">y</a> ?>',
      '<!X <a href="ghost.md">y</a> >',
      '<![CDATA[<a href="ghost.md">y</a>]]>',
      '<script><a href="ghost.md">y</a></script>',
      '<style><a href="ghost.md">y</a></style>',
      '<textarea><a href="ghost.md">y</a></textarea>',
    ]) {
      expect(rendersSurvivingComment(raw), `${raw} reaches the output raw`).toBe(true);
    }
    // ...and the negative, so the loop cannot pass by answering `true` always.
    // Every comment in this corpus is of this shape -- inside a code span.
    expect(rendersSurvivingComment('text with a `<!-- coded -->` span')).toBe(false);
    expect(rendersSurvivingComment('# plain\n\nsee [x](a.md)')).toBe(false);

    // CLAUDE.md is IN the population. It is not a rule file, but it is a link
    // SOURCE -- `topLevel` is derived from it and it seeds the reachability
    // walk -- so a raw comment there could hide an anchor that both promotes a
    // satellite to top-level and marks it reachable. The first cut of this
    // case checked 46 of the 47 files and omitted exactly the one the fence's
    // roots come from: a precondition applied to everything except the root is
    // not a precondition.
    const sources = [
      ...ruleFiles.map((r) => ({ name: r.name, text: r.text })),
      { name: 'CLAUDE.md', text: readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf-8') },
    ];
    // The POPULATION is asserted, not assumed. With a clean corpus, dropping
    // CLAUDE.md changes no verdict, so probing found that removal left the
    // suite green -- the population bug this case was just fixed for would
    // have been reintroducible in silence.
    expect(sources.map((r) => r.name)).toContain('CLAUDE.md');
    expect(sources.length).toBe(ruleFiles.length + 1);

    const surviving = sources.filter((r) => rendersSurvivingComment(r.text)).map((r) => r.name);
    expect(
      surviving,
      `${surviving.join(', ')} render a raw HTML comment. That is allowed in itself, but it means a raw <a href> could be written inside one and would be credited by visibleLinkTargets while a reader sees nothing. Either put the comment inside a code span, or give visibleLinkTargets a comment-stripper AND pin it -- read the note there first, three attempts at one were each wrong in a different direction.`,
    ).toEqual([]);
  });

  it('visibleLinkTargets judges what a READER sees, not what the source contains', () => {
    // Guard-the-guard, and the reason is measured: an A/B of this function
    // before and after the frontmatter / empty-text / table-bounding guards
    // landed showed ZERO difference across all 46 rule files plus CLAUDE.md in
    // both `rowsOnly` modes. Every one of them is latent on today's corpus, so
    // deleting or inverting any would leave the whole suite green -- exactly
    // the "a checker must prove it FAILS" gap this file enforces elsewhere.
    // The cases below are the only thing standing under them.
    const t = (src: string, rowsOnly = false): string[] =>
      visibleLinkTargets(src.split('\n'), rowsOnly);

    // FRONTMATTER is metadata; GitHub strips it and no reader sees a link in
    // `description:`. Without the skip, a pointer moved out of the body and
    // into the frontmatter keeps a satellite "reachable" over a blank page.
    expect(t('---\ndescription: see [x](ghost.md)\n---\n\nbody')).toEqual([]);
    expect(t('---\ndescription: d\n---\n\nsee [x](real.md)')).toEqual(['real.md']);
    // A body `---` is a thematic break, not a second frontmatter fence.
    expect(t('---\nd: 1\n---\n\nsee [x](real.md)\n\n---\n\nmore')).toEqual(['real.md']);
    // No frontmatter at all -- CLAUDE.md's shape.
    expect(t('# Title\n\nsee [x](real.md)')).toEqual(['real.md']);

    // A link inside a CODE BLOCK is not a pointer. This is the property the
    // whole renderer switch exists for: four hand-rolled attempts each let one
    // shape of this through.
    expect(t('```\n[x](ghost.md)\n```')).toEqual([]);
    expect(t('````markdown\n```bash\n```\n[x](ghost.md)\n````')).toEqual([]);
    expect(t('    [x](ghost.md)')).toEqual([]);
    expect(t('\t[x](ghost.md)')).toEqual([]);
    expect(t('> ```\n> [x](ghost.md)\n> ```')).toEqual([]);
    // ...but a quoted PLAIN link is visible, so it counts.
    expect(t('> see [x](real.md)')).toEqual(['real.md']);

    // EMPTY link text renders zero-width: nothing to click.
    expect(t('[](ghost.md)')).toEqual([]);
    expect(t('[​](ghost.md)')).toEqual([]);
    expect(t('[&nbsp;](ghost.md)')).toEqual([]);
    // An IMAGE is content. Dropping it silenced the dangling-pointer half for
    // badge links, which fails quiet.
    expect(t('[![alt](badge.svg)](real.md)')).toEqual(['real.md']);

    // A markdown link inside a comment is not an anchor, so the absent
    // comment-stripper costs nothing -- pinned here because the whole argument
    // for removing it rests on this.
    expect(t('<!--\n[x](ghost.md)\n-->\n\nsee [y](real.md)')).toEqual(['real.md']);
    // CommonMark's abbreviated `<!-->`, the shape that defeated the unbounded
    // stripper: a link AFTER it must still be seen, not swallowed.
    expect(t('<!-->\n\nsee [x](real.md)\n\n<!-- c -->')).toEqual(['real.md']);
    // Media other than <img> is clickable content too.
    expect(t('[<svg width="1"></svg>](real.md)')).toEqual(['real.md']);
    // Every invisible spelling is asserted, not a sample. Review measured that
    // 24 of the 26 alternatives in the hand-list this replaces were unpinned:
    // deleting them left the suite green, which is the "latent guard with
    // nothing under it" standard this same file asserts elsewhere. A table is
    // the only way that stays true as the set changes.
    for (const blank of [
      '', // no text at all
      '&#x200b;',
      '&#8203;',
      '&#x0200b;', // leading zeros are legal and defeated the old list
      '&#08203;',
      '&#x00a0;',
      '&#0160;',
      '&nbsp;',
      '&shy;',
      '&zwnj;',
      '&zwj;',
      '&ensp;',
      '&emsp;',
      '&thinsp;',
      '&numsp;',
      '&hairsp;',
      '&ZeroWidthSpace;', // the alias of the character the transposition bug was about
      '&NonBreakingSpace;',
      '&ThinSpace;',
      '&VeryThinSpace;',
      '&puncsp;',
      '&emsp13;',
      '&#x2060;', // word joiner
      '&#8288;',
      '&#x2061;', // function application -- outside the class until the
      '&#x2064;', // round-trip check flagged `&af;` as inert
      '&af;',
      '&#x2028;', // line separator -- deleted by the first correction, restored
      '&#x2029;',
      '&#x200e;', // LRM / RLM: in the class and, until review, untested
      '&#x200f;',
      '\u200b', // the literal characters, not just their entities
      '\u00ad',
      '\ufeff',
    ]) {
      expect(t(`[${blank}](ghost.md)`), `[${blank}](...) renders blank`).toEqual([]);
    }
    // ...and the visible controls, so the loop above cannot pass by rejecting
    // everything. A NON-breaking space is invisible; an ordinary letter is not.
    // `&#x41;` is the HEX arm's visible control and it is load-bearing: with
    // only `&#65;` here, replacing the hex decoder with `() => ''` -- i.e.
    // silently deleting every hex entity, so a link whose text is `&#x41;`
    // stops being a pointer -- passed all 23 blanks, all 4 media cases and
    // every other control. A decoder needs a case in BOTH directions or only
    // its over-stripping half is fenced.
    // `&#x110000;` / `&#1114112;` pin the codePoint GUARD, which review found
    // shipping unpinned: reverting it to a bare `String.fromCodePoint` threw a
    // RangeError on this input while leaving all 60 other assertions green.
    // Out of range stays literal text, which is what a browser shows.
    //
    // `&#x26;#8203;` pins the SINGLE-PASS decode: three sequential passes read
    // it as `&` then `&#8203;` and blanked it, dropping a pointer whose text a
    // browser renders literally.
    for (const seen of [
      'x',
      '&amp;',
      '&#65;',
      '&#x41;',
      '&#x110000;',
      '&#1114112;',
      '&#x26;#8203;',
      '&lt;',
      '0',
    ]) {
      expect(t(`[${seen}](real.md)`), `[${seen}](...) renders something`).toEqual(['real.md']);
    }
    // EVERY key in the map must actually blank a link, asserted by round-trip
    // rather than by inspection. Written after `noBreak:` sat in the map doing
    // nothing: the lookup lowercases the entity name, so a camelCase key can
    // never match, and a missed blank entity fails SILENTLY -- it just credits
    // the pointer. A casing check was tried first and was vacuous by
    // construction (with every key already lowercase, disabling it changed no
    // verdict). Deriving the cases from the map catches casing, a typo, and a
    // regex that stops matching some spelling, and it cannot go stale as the
    // map grows.
    // The control that proves the check below can FAIL at all. With every key
    // working, disabling the filter changes no verdict -- it is a
    // RE-INTRODUCTION guard, not a live discriminator, and this file insists
    // on knowing the difference. This line pins the mechanism: an entity the
    // map does not name leaves the link visible, which is exactly what a dead
    // key looks like to the filter.
    expect(t('[&NotAnEntity;](real.md)')).toEqual(['real.md']);

    const deadKeys = Object.keys(NAMED_BLANK).filter(
      (k) => t(`[&${k};](ghost.md)`).length !== 0,
    );
    expect(
      deadKeys,
      `these NAMED_BLANK keys do not blank a link, so they are inert: ${deadKeys.join(', ')}. The lookup lowercases the entity name, and the scan only matches /&[a-z][a-z0-9]*;/i.`,
    ).toEqual([]);

    // The generic tag strip, also found unpinned: without it an anchor whose
    // only content is an empty inline element is credited as a pointer.
    for (const empty of ['<b></b>', '<span></span>', '<kbd></kbd>']) {
      expect(t(`[${empty}](ghost.md)`), `${empty} renders nothing`).toEqual([]);
    }

    // Media that renders on its own is content; a container that renders
    // nothing without children is not.
    for (const media of [
      '<img src="i.png">',
      '<svg></svg>',
      '<video></video>',
      '<canvas></canvas>',
      '<object data="i.svg"></object>',
    ]) {
      expect(t(`[${media}](real.md)`), `${media} is visible content`).toEqual(['real.md']);
    }

    // `rowsOnly` asks whether the anchor is in a TABLE. A stray unclosed
    // `<table>` must not pair with a later table's close and lend the prose
    // between them the strength a table index withholds from prose.
    const strayTable = '<table>\n\nsee [x](stray.md)\n\n| h |\n| - |\n| [y](real.md) |';
    expect(t(strayTable, true)).toEqual(['real.md']);
    expect(t(strayTable, false)).toEqual(['stray.md', 'real.md']);
  });

  it('every satellite is reachable, and every markdown link in the corpus resolves', () => {
    // A satellite loads by its own glob, so an unindexed one still WORKS --
    // which is why nothing noticed. What it loses is discoverability: the next
    // person deciding where a paragraph belongs reads an index, not a
    // directory listing.
    //
    // The population used to be two filename PREFIXES while this case's name
    // claimed every satellite, so the six `hooks-*` files sat outside it and a
    // misplaced pointer went unreported (go-to-k/cdkd#2657). Prefixes are not
    // the right discriminator anyway -- eight satellites carry none, and
    // `docs-page-template.md` was a live orphan hiding behind that gap
    // (go-to-k/cdkd#2656).
    //
    // The discriminator is DERIVED instead: a rule file linked from CLAUDE.md
    // is TOP-LEVEL (CLAUDE.md is its index); anything else is a satellite and
    // needs a pointer from somewhere. Derived rather than hand-listed because
    // a hand list is what goes stale -- the failure this whole case exists to
    // catch. Measured through this predicate, not by grep: 46 files, 12 linked
    // from CLAUDE.md, 34 not -- and 35 satellites, because the union below
    // adds one of the twelve back. Counting the 34 and calling it the
    // population is off by exactly the file the union exists for.
    // The prefixed families are UNIONED in so the population can only widen:
    // `hooks-main-tree-branch.md` is BOTH prefixed and CLAUDE.md-linked, and
    // dropping it would have been a silent narrowing dressed up as a
    // generalisation.
    const claudeMd = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf-8').split('\n');
    const topLevel = new Set(
      visibleLinkTargets(claudeMd)
        .map(ruleTarget)
        .filter((t): t is string => t !== undefined),
    );
    const FAMILY_PREFIXES = [/^layout-/, /^provider-/, /^hooks-/];
    const isSatellite = (n: string): boolean =>
      !topLevel.has(n) || FAMILY_PREFIXES.some((p) => p.test(n));

    // Reachability asks a different question from the index-SHAPE case below,
    // so it reads every rule file rather than the three indexes: `assets.md`
    // points at `asset-bucket-region.md`, `testing.md` at
    // `test-stream-fence.md`, `layout-misc.md` at `state-version-purge.md`.
    // Those are real pointers and a human following them finds the file.
    //
    // It is a WALK from the roots, not an inbound-link count. "Something links
    // it" passes a pair of satellites that link only each other while nothing
    // reachable links either -- review demonstrated exactly that, and the
    // self-link exclusion the first cut relied on catches only the 1-cycle of
    // that same shape. A reader arrives from CLAUDE.md, so that is where the
    // walk starts; anything it cannot get to is unfindable however many
    // pointers it has.
    const linksOf = new Map<string, string[]>();
    const broken: string[] = [];
    const known = new Set(ruleFiles.map((r) => r.name));
    for (const source of [...ruleFiles, { name: 'CLAUDE.md', lines: claudeMd }]) {
      const out: string[] = [];
      for (const raw of visibleLinkTargets(source.lines)) {
        const target = ruleTarget(raw);
        if (target === undefined) continue;
        // Existence is asked of EVERY visible link, including one to a
        // top-level file and including a self-link. Filtering first is how an
        // earlier cut narrowed the dangling half live rather than latently.
        if (!known.has(target)) broken.push(`${source.name} -> ${target}`);
        else if (target !== source.name) out.push(target);
      }
      linksOf.set(source.name, out);
    }
    expect(
      [...new Set(broken)].sort(),
      `These markdown links point at .claude/rules files that do not exist: ${[...new Set(broken)].sort().join(', ')}. A rename moved the target and left the pointer behind.`,
    ).toEqual([]);

    const reached = new Set<string>();
    const queue = ['CLAUDE.md', ...topLevel];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of linksOf.get(cur) ?? []) {
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    const orphans = ruleFiles.map((r) => r.name).filter((n) => isSatellite(n) && !reached.has(n));
    expect(
      orphans,
      `${orphans.join(', ')} are satellites no reader can WALK to from CLAUDE.md. They still load by their own \`paths:\`, so no budget notices -- but the next person deciding where a paragraph belongs navigates from an index, not a directory listing. Add a pointer from the file the text belongs with, and make sure THAT file is itself reachable: a mutual pair of satellites pointing at each other is not reachable, and neither is a file that only names itself.`,
    ).toEqual([]);
  });

  it('a prefixed satellite is reached from its family index, in that index own shape', () => {
    // Reachability above accepts a pointer from anywhere, which is right for
    // discoverability and too weak for the three families that HAVE an index:
    // there, the index is the map, and a sentence buried in a sibling file is
    // not a substitute for a row in it. This case keeps that stricter contract
    // -- it is the one two review probes were written against.
    //
    // Two index SHAPES, because the corpus has two. `code-layout.md` and
    // `providers.md` index their families with a TABLE, so a ROW is required:
    // a probe deleted `layout-utils.md`'s row and the assertion stayed green
    // on the strength of a sentence further down, and a second probe left the
    // identical text inside a fenced block. The `hooks-*` family's index is
    // `hooks.md` itself, which has no table -- every one of its satellites is
    // reached by a PROSE sentence at the point the text was lifted from, the
    // right shape for that family and the only one available. Prose is the
    // weaker mode, so it is granted only to the family with no alternative.
    const indexes: readonly { file: string; prefix: RegExp; rowsOnly: boolean }[] = [
      { file: 'code-layout.md', prefix: /^layout-/, rowsOnly: true },
      { file: 'providers.md', prefix: /^provider-/, rowsOnly: true },
      { file: 'hooks.md', prefix: /^hooks-/, rowsOnly: false },
    ];
    const missing: string[] = [];
    for (const { file: idx, prefix } of indexes) {
      expect(
        prefix.test(idx),
        `${idx} now matches its own family prefix ${String(prefix)}, so it would be required to point at itself. Give this loop back its self-exclusion.`,
      ).toBe(false);
    }
    for (const { file: idx, prefix, rowsOnly } of indexes) {
      // Credit a link only to the family this index OWNS: without it a prose
      // sentence in hooks.md naming a `layout-*` file would satisfy
      // code-layout.md's requirement, silently granting prose mode to a table
      // index -- the thing the comment above says must never happen.
      const own = new Set(
        visibleLinkTargets(ruleFiles.find((r) => r.name === idx)!.lines, rowsOnly)
          .map(ruleTarget)
          .filter((t): t is string => t !== undefined && prefix.test(t)),
      );
      // No `name !== idx` guard: an index's own name does not match its own
      // family prefix, so the condition could not fire, and a guard that
      // cannot fire reads as protection that is not there. That is a property
      // of the three current names rather than of the structure, so it is
      // asserted here instead of claimed in a comment -- rename an index to
      // `hooks-index.md` and this fires rather than silently making the file
      // demand a pointer to itself.
      for (const { name } of ruleFiles) {
        if (prefix.test(name) && !own.has(name)) missing.push(`${name} (${idx})`);
      }
    }
    expect(
      missing,
      `${missing.join(', ')} -- each is a prefixed satellite absent from its family index, in the shape that index uses. For code-layout.md and providers.md that means a TABLE ROW outside any fenced or indented code block; for hooks.md a prose pointer at the point the text was lifted from.`,
    ).toEqual([]);
  });


  it('every REACH_FLOORS row names a rule file that exists', () => {
    // The forward direction -- every rule file has a row -- is asserted below.
    // This is the REVERSE, and without it a row for a DELETED file is silently
    // ignored: `REACH_FLOORS.get(name)` is only ever asked about files that
    // exist. Measured: adding a row for `does-not-exist.md` left the whole file
    // green, and a real deletion in this branch left its row behind for a full
    // review round. A stale row is not just clutter -- it is a floor nothing
    // enforces, next to rows that are load-bearing.
    const names = new Set(ruleFiles.map((r) => r.name));
    const dangling = [...REACH_FLOORS.keys()].filter((k) => !names.has(k));
    expect(dangling, `REACH_FLOORS rows for files that do not exist: ${dangling.join(', ')}`).toEqual(
      [],
    );
  });
  it('every rule file is covered by at least one budgeted path', () => {
    // This was measured once and written down as a claim in a comment. A claim
    // decays: a review probe on 2026-08-25 retyped `provider-masking.md`'s glob
    // to a directory that does not exist, which drops it out of every budget
    // AND out of the corpus's reach, and all 134 tests passed.
    const budgeted = new Set(
      ruleFiles
        .filter((rule) =>
          PAYLOAD_BUDGETS.some(([touched]) =>
            (rule.paths ?? []).some((glob) => globToRegExp(glob).test(touched)),
          ),
        )
        .map((r) => r.name),
    );
    const uncovered = ruleFiles.map((r) => r.name).filter((n) => !budgeted.has(n));
    expect(
      uncovered,
      `${uncovered.join(', ')} match none of the ${PAYLOAD_BUDGETS.length} budgeted paths, so their bytes are bounded by nothing but the per-file cap. Add a representative path for the area each one covers.`,
    ).toEqual([]);
  });

  it('every budgeted path names a file that exists', () => {
    // A budget on a path that does not exist still measures glob matching, so
    // it passes -- while its NAME, which is the only thing telling a reader
    // which area the row speaks for, is a lie. Two of the original rows
    // (`src/synthesis/cdk-synthesizer.ts`, `tests/unit/example.test.ts`) were
    // in this state.
    const missing = PAYLOAD_BUDGETS.map(([p]) => p).filter((p) => !existsSync(join(repoRoot, p)));
    expect(
      missing,
      `These budgeted paths do not exist: ${missing.join(', ')}. The row still measures something, but not the area its name claims. Point it at a real file in that area.`,
    ).toEqual([]);
  });

  it('the glob matcher itself behaves as the payload budgets assume', () => {
    // Guard the guard: a matcher that matched nothing would make every payload
    // budget above pass with a total of 0.
    expect(globToRegExp('src/**/*.ts').test('src/cli/commands/deploy.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/cli.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('scripts/gen.ts')).toBe(false);
    expect(globToRegExp('src/provisioning/**').test('src/provisioning/providers/s3.ts')).toBe(true);
    expect(globToRegExp('src/provisioning/**').test('src/deployment/x.ts')).toBe(false);
    expect(globToRegExp('src/analyzer/drift-*.ts').test('src/analyzer/drift-normalize.ts')).toBe(true);
    expect(globToRegExp('src/analyzer/drift-*.ts').test('src/analyzer/dag-builder.ts')).toBe(false);
    expect(globToRegExp('vite.config.ts').test('vite.config.ts')).toBe(true);

    for (const [touched] of PAYLOAD_BUDGETS) {
      const matched = ruleFiles.filter((rule) =>
        (rule.paths ?? []).some((glob) => globToRegExp(glob).test(touched)),
      );
      expect(matched.length, `no rule file matches ${touched}`).toBeGreaterThan(0);
    }
  });
});
