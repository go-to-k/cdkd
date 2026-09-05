import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

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
  ['docker-argv-redaction.md', 5], // literal list: EXACT, see below
  ['docs-page-template.md', 63], // `docs/**`; measured 79 tracked files (80%, per the convention above)
  ['hooks.md', 68],
  ['hooks-class-fences.md', 5], // literal list: EXACT, see below
  ['hooks-main-tree-branch.md', 2], // literal list: EXACT, see below
  ['hooks-branch-gate.md', 2], // literal list: EXACT, see below
  ['hooks-cwd-detector.md', 2], // literal list: EXACT, see below
  ['hooks-stop.md', 4], // literal list: EXACT, see below
  ['gate-sibling-repos.md', 8], // literal list: EXACT, see below
  ['proxy-support.md', 3], // literal list: EXACT, see below
  ['layout-analyzer.md', 12],
  ['layout-cli-import-export.md', 3], // literal list: EXACT, see below
  ['layout-cli.md', 48],
  ['layout-deployment-secrets.md', 5], // literal list: EXACT, see below
  ['layout-deployment.md', 12],
  ['layout-drift.md', 5],
  ['layout-local.md', 45],
  ['layout-misc.md', 30],
  ['layout-provisioning.md', 92],
  ['layout-scrub.md', 1], // literal list: EXACT, see below
  ['layout-scripts.md', 38],
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
  ['CLAUDE.md', 10_000, 20_000], // 12,483 at registration; 15,550 on 2026-09-05 (session-report.md alone; re-measure on edit)
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
  ['src/provisioning/region-check.ts', 63_500, 120_000],
  ['src/deployment/deploy-engine.ts', 43_000, 80_000],
  ['src/cli/commands/deploy.ts', 41_000, 80_000],
  ['src/local/docker-runner.ts', 41_500, 100_000],
  ['src/analyzer/dag-builder.ts', 26_000, 60_000],
  ['scripts/gen-nested-key-coverage.ts', 52_000, 90_000],
  // Review probe, 2026-08-25: with only the six rows above, 9 of the 28 rule
  // files (355,718 B -- 45% of the corpus) were matched by NO budgeted path,
  // and the four heaviest paths in the repo were all among them. A budget table
  // that misses the heaviest paths is not bounding the payload, it is bounding
  // a sample. These rows put every rule file under at least one budget -- which
  // is asserted below rather than left as a claim -- and the number beside each
  // is its measured payload rounded out by roughly a tenth in each direction.
  ['src/deployment/secret-redaction.ts', 70_000, 112_000],   // measured 101,842
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
  ['src/provisioning/providers/custom-resource-provider.ts', 225_000, 290_000],
  ['src/cli/commands/drift.ts', 87_000, 110_000],            // measured 104,268
  ['src/cli/commands/import.ts', 63_000, 80_000],            // measured  72,035
  ['src/utils/ip-protocol.ts', 83_000, 105_000],             // measured  95,005
  ['src/provisioning/cloud-control-provider.ts', 67_500, 105_000], // measured 94,925
  // 55_000 -> 57_000 (both rows): `code-layout.md` gained an index row for
  // `layout-scrub.md` (issue #2274), and that file is in EVERY payload, so a
  // cap with 100 B of headroom fails for a reason unrelated to the path it
  // names -- the same argument that moved the `rule-file-payload.test.ts` row.
  // Every `measured` figure on the rows below was RE-TAKEN on this branch
  // rather than carried forward: the #2274 mask-only paragraph in
  // `layout-deployment-secrets.md` and the new `code-layout.md` index row moved
  // several of them, and a `measured` comment that no longer matches the tree
  // reads as evidence while being none.
  ['src/state/s3-state-backend.ts', 43_000, 57_000],         // measured  55,319 (was 55,030 before the go-to-k/cdkd#2447 pointer landed in layout-misc.md)
  // The representative path for state-version-purge.md, whose two-file glob
  // (the purge and its replication-gap detector, issue
  // go-to-k/cdkd#2447) matches nothing else. Without this row the satellite
  // sits under no budget at all: the `src/state/s3-state-backend.ts` row above
  // does NOT match it, which is the whole reason it was split out.
  ['src/state/s3-noncurrent-version-purge.ts', 53_000, 64_000], // measured 61,168
  ['src/types/state.ts', 43_000, 57_000],                    // measured  55,319 (was 55,030 before the go-to-k/cdkd#2447 pointer landed in layout-misc.md)
  ['src/synthesis/synthesizer.ts', 30_000, 40_000],          // measured  37,848 (was 34,889 before the go-to-k/cdkd#2447 pointer landed in layout-misc.md)
  // 62_000 -> 68_000: payload is `testing.md` alone, which reached 61,358 B, so
  // the cap had 642 B of headroom and the next edit to that file would have
  // failed this row for a reason unrelated to itself -- the same argument that
  // moved CORPUS_BYTES_MAX. Measured 61,358 B (the 55,681 B beside the old cap
  // was 5,677 B stale).
  ['tests/unit/scripts/rule-file-payload.test.ts', 38_000, 68_000], // measured 61,358
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
  // landmine shape CORPUS_BYTES_MAX's comment names) and its branch-gate bullet
  // one line past the >4000 B ratchet. Moved out verbatim, hooks.md is 115,030 B
  // and the satellite 6,454 B.
  ['.claude/hooks/branch-gate.sh', 74_000, 140_000], // measured 121,484
  // The shared matcher pulls hooks.md AND the class-fence satellite, which is
  // the only path that loads both. hooks.md outgrew the 120,000 per-file cap on
  // its own, so the two CLASS fences moved to a satellite of their own rather
  // than the cap being raised -- a cap that moves when it fires is not a cap.
  ['.claude/hooks/lib/command-match.sh', 76_000, 140_000], // measured 132,187
  // The four `integ-*` gates were the heaviest UNBUDGETED paths once
  // `gate-sibling-repos.md` split out of hooks.md: this row is the only one
  // that names them, so without it the satellite sits under no budget at all
  // and could go dark or grow unnoticed. Payload is hooks.md + the satellite.
  // Deliberately NOT added to the command-match row above: that path already
  // carries hooks.md + hooks-class-fences.md and has ~15 KB of headroom, which
  // adding a third file would spend down to about 1 KB.
  ['.claude/hooks/integ-local-gate.sh', 76_000, 140_000], // measured 132,814
  // The cwd-race detector's entry moved out of hooks.md when the #2363
  // widening pushed that file past the 120,000 B per-file cap (the #2236
  // precedent). This path is the representative one for the satellite
  // (its two globs are the hook and its .test.sh, per the REACH_FLOORS
  // entry above); without this row the satellite would sit under no
  // budget. Payload is hooks.md + hooks-cwd-detector.md.
  ['.claude/hooks/main-tree-git-cwd-detector.sh', 73_000, 140_000], // measured 129,490
  // main-tree-branch-gate's entry moved out of hooks.md on 2026-09-01, when the
  // argument-parse rewrite's measured before/after table pushed that file to
  // 122,862 B -- past the same 120,000 B per-file cap, and one line past the
  // long-line ratchet with it. Representative path for the satellite (its two
  // globs are the hook and its suite, per the REACH_FLOORS entry above);
  // without this row the satellite would sit under no budget at all. Payload is
  // hooks.md + hooks-main-tree-branch.md.
  ['.claude/hooks/main-tree-branch-gate.sh', 82_000, 152_000], // measured 135,138
  //   The comment here read "measured 124,200" and the payload was already
  //   124,758 when it was written -- 558 B behind on the day it shipped, because
  //   the satellite kept being edited after the figure was taken. Re-measured at
  //   the tree that ships it: 135,138 B (hooks.md 114,602 B, unchanged, plus the
  //   satellite at 20,536 B, up from 10,156 B) after the second parse round's
  //   before/after table, its four causes and its two retired claims. The BAND
  //   moved with the measurement rather than the measurement being trimmed to
  //   the band: 140,000 left 4,862 B of headroom over the new figure, which is
  //   the landmine shape CORPUS_BYTES_MAX's own comment names.
  // The Stop-hook entries moved out of hooks.md when issues #2391 / #2396 --
  // the nudge-cadence rule, the channel table and stop-warn's own suite --
  // pushed that file to 122,559 B, past the same cap. Representative path for
  // the satellite (its four globs are the two hooks and their suites, per the
  // REACH_FLOORS entry above). Payload is hooks.md + hooks-stop.md.
  ['.claude/hooks/stop-warn.sh', 77_000, 140_000], // measured 133,753
  // Second review round, 2026-08-25: three heavy paths still carried no budget
  // at all. `masked-retry-logger.ts` is the 2nd-heaviest path in the repo and
  // was covered only by prose, in the `region-check.ts` row's claim to speak
  // for "the 20-odd shared helpers" -- it does not, because that row's payload
  // is 52,459 B lighter.
  ['src/provisioning/masked-retry-logger.ts', 94_500, 162_000], // measured 126,979
  ['src/analyzer/drift-protocol-normalize.ts', 71_000, 92_000],  // measured  81,242
  ['src/assets/asset-publisher.ts', 32_000, 42_000],             // measured  40,238 (was 37,183 before the go-to-k/cdkd#2447 pointer landed in layout-misc.md)
  ['src/assets/asset-storage.ts', 34_000, 48_000],               // measured  46,764 (asset-bucket-region.md, issue #2240; was 43,787 before the go-to-k/cdkd#2447 pointer landed in layout-misc.md)
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
  ['tests/setup.ts', 48_000, 72_000],                            // measured  49,709 on 2026-09-05 (was 64,742 before the 2026-09-04 compression)
  // 46_000 -> 48_000 on 2026-09-05: the go-to-k/cdkd#2595 retro added 1,126 B of
  // mutation-probe rules to `testing.md`, and the discriminate case below went
  // red exactly as its comment predicts ("testing.md growing spends it from the
  // other side"). Re-derived, not debugged away: the floor sits between
  // `testing.md + SUBSTANTIVE_MIN_BYTES` (the gutting case it must reject) and
  // the live payload (which it must accept), and 48_000 split that band nearly
  // in half rather than sitting 47 B off one edge as 46_000 had come to.
  // RE-MEASURED 2026-09-05 in the same day, after the go-to-k/cdkd#2554 retro
  // added a sentinel-blunting rule to `testing.md` (45,579 -> 46,289 B):
  // payload 48,999 -> 49,709, and the gutting bound 47,079 -> 47,789, so the
  // growth room this floor leaves `testing.md` fell 921 -> 211 B while the
  // shrink room rose 999 -> 1,709 B. The floor is NOT re-derived upward for
  // that -- moving a bound to fit the diff that spent it is the ratchet
  // `.claude/skills/work-issues/references/retro.md` 10-c forbids -- but the
  // asymmetry is now the live constraint: the next `testing.md` addition over
  // 211 B reds the discriminate case below, and the fix is compression there,
  // not a bigger number here. Unlike the skill corpus, this file has no
  // MEASURED record, so these three figures are the only thing that goes
  // stale silently; re-measure them in any commit that touches `testing.md`.
  // This floor is set by a PROPERTY rather than by the table's usual ~12%-under
  // convention, and `the tests/setup.ts floor still discriminates` below
  // RECOMPUTES that property instead of trusting this number. It must sit above
  // `testing.md` (46,289 B) plus SUBSTANTIVE_MIN_BYTES, so that gutting
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
  const text = readFileSync(join(RULES_DIR, name), 'utf-8');
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

// The corpus as a whole, asserted as a RANGE rather than a floor. Both bounds
// are load-bearing and they fail in opposite directions:
//   - the LOWER bound is the only thing in this file that notices CONTENT being
//     DELETED. Every other assertion is a one-sided upper bound, so a review
//     probe that removed `layout-drift.md` outright, and one that gutted
//     `layout-provisioning.md` from 53,830 B to 203 B, both left the suite
//     green. A split that "reduces payload" by dropping text is the one
//     outcome this refactor promised would never happen.
//   - the UPPER bound catches growth that spreads thinly enough to stay under
//     every per-file cap.
// Update these deliberately, with the reason, when the corpus genuinely moves.
const CORPUS_FILE_COUNT = 45; // 29 + gate-sibling-repos.md (hooks.md crossed the per-file cap, so
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
const CORPUS_BYTES_MIN = 862_000;   // RE-DERIVED UPWARD 817_000 -> 862_000 (issue
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
const CORPUS_BYTES_MAX = 929_000; // RE-DERIVED UPWARD 890_000 -> 929_000 (issue go-to-k/cdkd#2447):
                                  // measured 895,893 on the REBASED tree + 33,107 B of headroom
                                  // -- NARROWER than the ~39 KB the previous ceiling held, which
                                  // is deliberate and is why it is not described as "the same".
                                  // The corpus crossed
                                  // the old 890,000 ceiling on a lane that added ONE satellite,
                                  // already trimmed once; past that the remaining text is the
                                  // load-bearing decisions themselves, and this file's own
                                  // instruction is not to summarise or delete it. Note the figure
                                  // includes `docker-argv-redaction.md`, which landed on main
                                  // while this branch was open -- FOUR earlier revisions of this
                                  // comment quoted a draft or a pre-rebase tree and went stale.
                                  // 890_000 was: // RE-DERIVED DOWNWARD 1_040_000 -> 890_000 (measured 851,451 + the ~39 KB of headroom the old ceiling held). // growth is the norm here; this catches bulk growth that stays under every per-file cap.
                                    // 1_000_000 -> 1_040_000 (2026-09-03, go-to-k/cdkd#2402's
                                    // third review round): measured 1,000,819 B. The previous
                                    // bound was set at 12,808 B of slack and TWO lanes spent it
                                    // between the setting and this one -- `origin/main` alone was
                                    // already at 993,403 B before this branch added a byte, so a
                                    // rebase onto it fails this assertion on someone else's text.
                                    // Raised to ~39 KB, the same margin the 946_000 -> 985_000
                                    // raise chose, because a bound whose headroom is smaller than
                                    // one ordinary lane fails for a reason unrelated to whoever
                                    // trips it.
                                    // 985_000 -> 1_000_000 (2026-09-03, issue go-to-k/cdkd#2274's
                                    // fix round): measured 987,192 B. The #2274 lane had already
                                    // spent this bound down to 25 B of headroom, which is the
                                    // landmine shape this file names elsewhere -- the NEXT edit
                                    // fails for a reason unrelated to itself. Raised rather than
                                    // funded by trimming, because the bytes are the review round's
                                    // OWN corrections (the mask-only channel's needle floor, the
                                    // cdkd-supplied exclusion, the drift path-set split, and the
                                    // in-run cross-stack recovery), and cutting them would delete
                                    // the record of decisions the round was called to make. Band
                                    // set from the measurement (12,808 B of slack), the way
                                    // CORPUS_BYTES_MIN's own history prescribes -- not nudged to
                                    // just clear today's tree.
                                    // 946_000 -> 985_000, measured 951,706 B in the tree and
                                    // 961,037 B PROJECTED against origin/main (which is itself at
                                    // 942,951 B -- a parallel lane has spent part of the same
                                    // budget). The old bound had 4,674 B of headroom left over this
                                    // branch's 941,326 B -- 74% of the ~18 KB the previous raise
                                    // deliberately bought had been spent by this branch alone
                                    // -- which is the landmine the paragraph below already names.
                                    // Raised at the tree that spends it, rather than left for the
                                    // next lane to hit on a file it never opened. The bound is set
                                    // against the PROJECTION, not the working tree, since that is
                                    // the number the merge produces: 985,000 leaves ~24 KB over it.
                                    // What the bytes bought: a second parse round closing a
                                    // regression this branch had introduced (shell WORDS counted as
                                    // git ARGUMENTS) plus five more holes, with the before/after
                                    // table, the four causes and two retired claims. That rationale
                                    // is what a rules file is FOR.
                                    // 928_000 -> 946_000, measured 927,952 B: FORTY-EIGHT bytes of
                                    // headroom, which is a landmine rather than a bound -- the next
                                    // lane to add a paragraph anywhere in `.claude/rules/**` fails a
                                    // test about a file it never opened, and the cheapest way out of
                                    // that failure is to trim someone else's entry, which the corpus
                                    // FLOOR exists to forbid. Raised deliberately rather than paid
                                    // for by compression, and the reason is legible: this lane fixed
                                    // six hook defects (two of them live gate bypasses) and their
                                    // rationale is what a rules file is FOR. It was already
                                    // compressed four times to fit under the old bound, and the full
                                    // reasoning now lives in the hook comments, which this corpus
                                    // does not measure -- i.e. the bound was pushing text out of the
                                    // place a reader looks and into the place they do not.
                                    // 18,048 B of headroom restored, ~2% of the corpus, sized so an
                                    // ordinary docs lane fits without a second raise. This is a
                                    // CEILING, so raising it weakens the guard: re-measure before
                                    // touching it again, and prefer a narrower-`paths:` satellite
                                    // whenever the growth is per-area rather than corpus-wide.
                                    //
                                    // RE-MEASURED 2026-09-01 at 933,620 B: 12,380 B of headroom,
                                    // and NOT raised. Every "measured N" in this file was stale by
                                    // then -- including figures the previous lane had written --
                                    // which is the failure this file's own comment names ("a bound
                                    // that drifts from its measurement stops being one"), so the
                                    // numbers were re-derived at the final tree rather than
                                    // adjusted. The remaining headroom is roughly one ordinary
                                    // docs lane; the next one to need more should SPLIT rather
                                    // than raise.
                                    //
                                    // NOT raised again for go-to-k/cdkd#2388, and the decision is
                                    // worth recording because it cuts against the rule of thumb one
                                    // paragraph up. Measured at that branch's final tree: 36 files,
                                    // 942,951 B, which FITS with 3,049 B -- but the branch's own
                                    // delta is 9,331 B, so by the "your delta must be smaller than
                                    // the headroom you leave" argument it should raise. It does not,
                                    // for two reasons. The instruction directly above is to SPLIT
                                    // rather than raise, and that branch did: its ~9 KB is already
                                    // in a narrow-`paths:` satellite, with only one-line pointers
                                    // left in layout-utils.md and layout-scripts.md, so there is
                                    // nothing of its own left to move. And raising in two
                                    // consecutive lanes is the ratchet this comment exists to slow.
                                    // The residual is real: the next lane adding more than ~3 KB
                                    // fails here. Flagged on the PR rather than spent unilaterally.
                                    // 900_000 -> 915_000 (go-to-k/cdkd#2363): origin/main sat at 899,989 B --
                                    // 11 B of headroom -- so ANY rules addition tripped it. Measured after the
                                    // hooks-cwd-detector.md split: 902,381 B (the widening's net prose is
                                    // 1,422 B; the satellite's frontmatter + the pointer line are the rest).
                                    // 915_000 -> 928_000 (test-stream-fence.md): this branch added
                                    // 3,712 B, leaving 835 B of headroom -- the next rule-file
                                    // edit over 1 KB anywhere would have failed this suite for a
                                    // reason unrelated to itself. Measured 914,165 B.
                                    // 928_000 -> 940_000 (go-to-k/cdkd#2388): proxy-support.md
                                    // takes the corpus to 923,079 B, which FITS under 928_000 with
                                    // 4,921 B to spare -- and that is the reason to move it, not a
                                    // reason to leave it. This ceiling is a CUMULATIVE budget spent
                                    // by every open lane at once (see the merge-projection case
                                    // below, and the two lanes at 899,843 B and 899,902 B that were
                                    // each green in isolation and 25 B over together). This branch's
                                    // own delta is 8,284 B, larger than the 4,921 B it would leave,
                                    // so the next PR of the same shape could not land and a second
                                    // concurrent lane would collide with this one rather than with a
                                    // number anyone chose. 940_000 leaves 16,921 B, roughly what the
                                    // previous raise left. Measured on origin/main at 476c0ac8:
                                    // 34 files, 914,795 B -- which is also why the "914,165" above
                                    // is left as the record of what THAT raise measured rather than
                                    // silently corrected.

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
        'NEVER by summarising or deleting it -- this floor is the only assertion ' +
        'here that can tell the two apart.',
    ).toBeGreaterThanOrEqual(CORPUS_BYTES_MIN);
    expect(
      total,
      `The rules corpus is ${total} B, over the ${CORPUS_BYTES_MAX} B ceiling. ` +
        'This catches bulk growth that stays under every per-file cap by ' +
        'spreading itself thinly. ' +
        SPLIT_ADVICE,
    ).toBeLessThanOrEqual(CORPUS_BYTES_MAX);
  });

  // The ceiling above measures the WORKING TREE. That is the merge result only
  // when this branch is rebased onto current `origin/main` -- and a cumulative
  // budget is spent by every lane at once, so two branches can each be green in
  // isolation and land over the cap together. Neither branch's CI can see it,
  // and whichever merges SECOND is blamed for a budget the first one spent.
  //
  // Measured 2026-08-27, two lanes of one `/work-issues` run: go-to-k/cdkd#2291
  // at 899,843 B and go-to-k/cdkd#2330 at 899,902 B, both green, merging to
  // 900,025 B -- 25 B over. It was caught by hand, which is not a mechanism.
  //
  // So project the merge instead of assuming the rebase: `origin/main`'s corpus
  // plus THIS branch's delta against its own merge base. On a rebased branch
  // that equals the working tree and this assertion is a no-op; on a stale one
  // it is the only thing that sees the collision.
  it('the corpus still fits once this branch is merged into origin/main', () => {
    const corpusAt = (rev: string): number | undefined => {
      let names: string[];
      try {
        names = execFileSync('git', ['ls-tree', '-r', '--name-only', rev, '.claude/rules'], {
          cwd: repoRoot,
          encoding: 'utf-8',
        })
          .split('\n')
          .filter((n) => n.endsWith('.md'));
      } catch {
        return undefined; // rev unresolvable (shallow clone, never fetched)
      }
      let total = 0;
      for (const name of names) {
        total += execFileSync('git', ['show', `${rev}:${name}`, '--'], {
          cwd: repoRoot,
          maxBuffer: 64 * 1024 * 1024,
        }).length;
      }
      return total;
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

    const mainTotal = corpusAt('origin/main');
    const baseTotal = mergeBase === undefined ? undefined : corpusAt(mergeBase);

    // No `origin/main` to project against -- a shallow clone, or a fresh clone
    // that has never fetched. Skipping is right: this assertion is ABOUT the
    // relationship to that ref, so without it there is nothing to be wrong.
    // The working-tree ceiling above still applies either way.
    if (mainTotal === undefined || baseTotal === undefined) return;

    const worktreeTotal = ruleFiles.reduce((n, r) => n + r.bytes, 0);
    const delta = worktreeTotal - baseTotal;
    const projected = mainTotal + delta;

    expect(
      projected,
      `This branch adds ${delta} B to the rules corpus. Against origin/main's ` +
        `current ${mainTotal} B that projects to ${projected} B, over the ` +
        `${CORPUS_BYTES_MAX} B ceiling -- even though the working tree is ` +
        `${worktreeTotal} B and passes on its own.\n\n` +
        'A parallel lane has spent part of the same budget. Rebase onto ' +
        'origin/main and re-measure: the number this fails on is the one the ' +
        'merge produces. Then fund your addition by cutting what your own ' +
        'change made stale -- never by trimming another lane\'s entry, which ' +
        'is not yours to spend. ' +
        SPLIT_ADVICE,
    ).toBeLessThanOrEqual(CORPUS_BYTES_MAX);
  });

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
        `.claude/rules/${name} has a ${worst} B line, over the ${ABSOLUTE_MAX_LINE_BYTES} B ceiling. This is how a 47,795-char bullet happened: one line per area, appended to PR after PR. Break it into paragraphs or move it to a satellite. ${SPLIT_ADVICE}`,
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
        .join(', ')}. ${SPLIT_ADVICE}`,
    ).toBeLessThanOrEqual(LEGACY_LONG_LINE_BUDGET);
  });

  it.each(PAYLOAD_BUDGETS.map(([p, lo, hi]) => [p, lo, hi] as const))(
    'touching %s loads between %d and %d B of rule files',
    (touched, floor, cap) => {
      const matched = ruleFiles.filter((rule) =>
        (rule.paths ?? []).some((glob) => globToRegExp(glob).test(touched)),
      );
      const total = matched.reduce((sum, rule) => sum + rule.bytes, 0);
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

  it('the two corpus bounds are ordered, so neither can be satisfied by crossing', () => {
    // Redundant with the corpus case, which asserts the total against BOTH
    // bounds and so already fails when they cross. Kept only because it names
    // the cause directly instead of reporting a total that satisfies neither.
    expect(CORPUS_BYTES_MIN).toBeLessThan(CORPUS_BYTES_MAX);
  });

  it('every satellite is reachable from an index, and every index row resolves', () => {
    // The satellites load by their own globs, so an unindexed one still WORKS
    // -- which is why nothing noticed. It stops being findable by a human
    // reading code-layout.md, which is how the next split decides where text
    // belongs.
    const indexes = ['code-layout.md', 'providers.md'];
    const linked = new Set<string>();
    const broken: string[] = [];
    for (const idx of indexes) {
      // TABLE ROWS only, and only OUTSIDE fenced code blocks. A prose pointer
      // elsewhere in the file also makes a satellite findable, but it is not
      // the index -- a review probe deleted `layout-utils.md`'s row and the
      // assertion stayed green on the strength of a sentence further down. The
      // fence-stripping is the same hole one level down: the second review
      // round deleted the real row and left the identical text inside a
      // ```markdown block, and it went green again. `providers.md` already
      // contains fenced blocks, so this is reachable, not theoretical.
      const rows: string[] = [];
      let inFence = false;
      for (const line of ruleFiles.find((r) => r.name === idx)!.lines) {
        if (line.trimStart().startsWith('```')) {
          inFence = !inFence;
          continue;
        }
        if (!inFence && line.trimStart().startsWith('|')) rows.push(line);
      }
      // Link TEXT is unconstrained: a row reading `[utils](layout-utils.md)` is
      // a perfectly good index row, and an earlier form reported it as missing
      // because it required the text to repeat the filename.
      for (const m of rows.join('\n').matchAll(/\[[^\]]+\]\(([a-z0-9-]+\.md)\)/g)) {
        linked.add(m[1]!);
        if (!ruleFiles.some((r) => r.name === m[1]!)) broken.push(`${idx} -> ${m[1]!}`);
      }
    }
    expect(broken, `Index rows point at rule files that do not exist: ${broken.join(', ')}.`).toEqual(
      [],
    );
    const orphans = ruleFiles
      .map((r) => r.name)
      .filter((n) => /^(layout|provider)-/.test(n) && !linked.has(n));
    expect(
      orphans,
      `${orphans.join(', ')} are satellites that no index links to. They still load by their own \`paths:\`, so no budget notices -- but the next person deciding where a paragraph belongs reads the index, not the directory. Add a row to code-layout.md or providers.md.`,
    ).toEqual([]);
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
