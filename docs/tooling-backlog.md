---
title: "Tooling backlog"
unlisted: true
---

# Tooling backlog

This file holds findings about cdkd's **own tooling** — Claude Code hooks,
markgate gates, `.claude/rules/**`, `.claude/skills/**`, CI fences and the
integration-test harness. None of them is a cdkd defect: no user can hit any
of these by running the CLI, so none of them belongs on the issue tracker,
which is for cdkd behaviour a user CAN hit.

**How an item gets here.** Write one row when a tooling weakness is observed.
That is all — nothing is built on a first occurrence. A new hook, markgate
gate, CI fence, rule paragraph or test-of-prose is added only on the SECOND
occurrence of the same failure. "Cost is not a tiebreaker for verification
depth" governs verifying PRODUCT changes and explicitly does not reach here.

**How an item graduates.** A row becomes a GitHub issue when someone actually
starts working it, and not before — the issue is then the working record, and
the row here says which issue took it. An unworked row stays a row.

**The criterion a hook has to clear to exist at all.** A PreToolUse hook may
BLOCK only when the harm completes at the moment of the action AND lands
irreversibly on a THIRD PARTY's artifact, on ANOTHER SESSION's work, or on the
MAINTAINER's AWS account. Everything else becomes a sentence in `AGENTS.md`, a
CI unit test, or nothing. The full statement, with the worked examples that
separate the clauses, is in
[.claude/rules/hooks.md](https://github.com/go-to-k/cdkd/blob/main/.claude/rules/hooks.md).

## Policy decisions recorded here

- **Hook fail-open on exotic shell shapes is ACCEPTED.** A gate's matcher can
  be walked past with quoting, heredocs, `$( )`, `bash -c`, `eval`, case arms
  or redirections. These hooks steer a COOPERATIVE agent away from foot-guns;
  they are not a security boundary, and `main` is protected server-side by a
  GitHub ruleset. Finding one more such shape is therefore **not issue-worthy**
  — the roughly twenty open bash-parsing issues in the table below are
  won't-fix under this decision. If a specific miss actually bites twice in
  practice, that is the second occurrence and it gets fixed.
- **The hook layer is NOT being moved off bash.** Rewriting the matcher in a
  real language was the proposal in issue
  [#2716](https://github.com/go-to-k/cdkd/issues/2716); it is declined. The
  layer is being SHRUNK instead, which removes the parsing problem for every
  gate that no longer exists rather than re-implementing it.
- **A hook that only restates the `main` ruleset is DELETED, not kept as a
  belt.** The ruleset (`gh api repos/go-to-k/cdkd/rulesets/14380501`) carries
  `deletion`, `non_fast_forward`, `required_status_checks` (`ci-ok`, `build`,
  `pr-content`, `check`, `prefix-scope`, `English-only (pull request)`) and
  `pull_request` (squash-only, 0 approvals), with ZERO bypass actors. So
  `git push origin main` is refused for any commit, and a merge is refused
  until those six pass. `branch-gate` and `ci-green-gate` restated that and were
  removed; the incident that created `ci-green-gate` (a merge over a failed
  check) predates the ruleset. Check the ruleset before proposing a gate against
  `main`.
- **What the ruleset still does NOT cover, recorded as first occurrences.** A
  commit on a LOCAL `main` is refused by nothing (move it with `git branch` +
  `git reset`). A red check outside the required set does not block a merge:
  `ci-ok` aggregates `check-build-test`, `once-leak-detect`, `runtime-compat`
  and `release-pr-not-stale`, but `hook-suites` notably sits outside, so a hooks
  PR with a red `hook-suites` merges. Neither is worth a hook; both are
  `AGENTS.md` rules. And `git push --dry-run` does NOT evaluate the ruleset, so
  it cannot probe any of it — against the local hooks it still works.
- **`require_extra_approval_for_unattributed_changes` is ON, and what trips it
  is NOT established.** The rule turns `required_approving_review_count: 0` into
  1 for a change GitHub cannot attribute, and no agent can supply that approval;
  the refusal reads as a permissions error. A first draft of this claimed a
  cherry-pick, a `Co-authored-by` trailer or a different git identity trips it —
  **withdrawn as unverified**: a cherry-pick preserves the original author, the
  trailer is not the author field, and a linked account is attributed either
  way. Measured instead: the last 100 commits on `main` are 100% attributed
  (`go-to-k` 70, `github-actions[bot]` 24, `nix-tkobayashi` 5,
  `dependabot[bot]` 1), so it is inert today. The observable test is
  `gh api repos/go-to-k/cdkd/commits/<sha> --jq .author` returning `null`. Left
  as a row rather than written into a rule file, because nobody has hit it and
  the predicate is guesswork until someone does.
- **Rule-file payload caps, measured-N annotations and prose-count fences are
  RETIRED.** A test whose subject is the wording, byte size or citation count of
  agent-instruction prose does not clear the criterion above: nothing a user can
  hit depends on it, and the machinery cost more to keep honest than the drift it
  caught. What survives is `rule-file-module-citations.test.ts` (a `.ts` module a
  rule file cites must EXIST), a single down-only byte cap on `AGENTS.md`, and
  everything whose subject is `src/**` or generated data. Do not reintroduce a
  prose fence; a recurring prose defect is recorded here and, on a SECOND
  occurrence, fixed in the prose.

## Coverage the prose-fence removal gave up

Recorded as first occurrences, per the rule above — each was verified clean by
hand at the time of removal, and none is rebuilt until it bites a second time.

| What is no longer checked | Was checked by | Verified clean when removed |
| --- | --- | --- |
| Every markdown link in `.claude/rules/**` and `.claude/skills/**` resolves | `rule-file-payload.test.ts`, `skill-file-payload.test.ts` | yes — 0 dangling |
| No `paths:` frontmatter glob is DEAD (a rule whose glob matches nothing never loads) | `rule-file-payload.test.ts` | yes — 0 dead globs |
| The security-surface list names only paths that exist, and the `/review-pr` copy matches `pr-security-reviewer.md`'s | `security-surface-list-sync.test.ts` | yes — in sync |
| `/check`'s collected-count shell block behaves (rc before count, ANSI summary, `Test Files` not `Tests`, refuses another project's RUN root) | `check-skill-suite-count-block.test.ts` | block unchanged by that PR |
| `/work-issues`'s launch-mode probe executes correctly, and no `.claude/**` site switches to `LAUNCH_BRANCH` without `--no-guess` | `work-issues-launch-mode.test.ts` | yes — probe and arms unchanged |

## Open tooling items

These are the issues currently on the tracker whose subject is the tooling
rather than cdkd. They are listed here so the record survives, and are to be
closed on the tracker. A finding recorded before anyone worked it has no issue
to link, and carries `—` in the Issue column; a row whose item has SHIPPED says
which PR took it, so nobody picks it up twice.

| Issue | Title |
| --- | --- |
| [#1393](https://github.com/go-to-k/cdkd/issues/1393) | audit: nested-key critic blind spots found by the 0809 sweep — mixed-case SDK models, file-global literal heuristic, missing targets, selective sub-key forwards |
| [#1865](https://github.com/go-to-k/cdkd/issues/1865) | docs: the wiring critic's third failure mode (evidence loss) is missing from code-layout.md and the ci.yml step comment |
| [#1891](https://github.com/go-to-k/cdkd/issues/1891) | fix(dynamodb): two provider comments still say the wiring critic cannot follow a NonNullExpression, which PR 1860 falsifies |
| [#1892](https://github.com/go-to-k/cdkd/issues/1892) | chore(audit): sameDir's dev conjunct is unfenced (fail-closed), plus four wording nits in gen-handled-property-wiring |
| [#1951](https://github.com/go-to-k/cdkd/issues/1951) | fix(scripts): the CLI-flag coverage scanner counts flags named only in COMMENTS, so a fixture can claim coverage it does not have |
| [#2077](https://github.com/go-to-k/cdkd/issues/2077) | chore(hooks): audit whether delete-outcome.ts and recreate-targets.ts belong in the integ gate scopes |
| [#2085](https://github.com/go-to-k/cdkd/issues/2085) | test(integ): the alb fixture's routing.http.response.server.enabled removal assertion fails reproducibly, and the code is not the discriminator |
| [#2089](https://github.com/go-to-k/cdkd/issues/2089) | chore(work-issues): a watchdog cancel that fires the watchdog, a pgrep that matches itself, and the one-file revert that attributes an integ failure |
| [#2105](https://github.com/go-to-k/cdkd/issues/2105) | test(scripts): coverage-matrix listFixtures counts ANY directory under tests/integration as a fixture, so a shared-helper dir silently becomes a 283rd row |
| [#2107](https://github.com/go-to-k/cdkd/issues/2107) | test(integ): the other 275 fixtures never sweep S3 object versions either - one stack prefix alone holds 1189 entries after a clean run |
| [#2110](https://github.com/go-to-k/cdkd/issues/2110) | test(scripts): six integ scanners each keep a private fixture walk, so the first shared helper was invisible to all six - two extended, four need a decision |
| [#2126](https://github.com/go-to-k/cdkd/issues/2126) | test(integ): destroy-interrupt fails ~1-in-3 at DEPLOY on a Lambda-sandbox urlopen transient, before reaching any destroy assertion |
| [#2191](https://github.com/go-to-k/cdkd/issues/2191) | test(local): local-invoke-agentcore fixture no longer synthesizes — aws-cdk-lib dropped the aws-bedrockagentcore L2 constructs |
| [#2210](https://github.com/go-to-k/cdkd/issues/2210) | hooks: a shell-CONCATENATED quoted path resolves to a target that does not exist, and strict resolution reports it readable |
| [#2262](https://github.com/go-to-k/cdkd/issues/2262) | test(integ): custom-resource-provider leaves six /aws/lambda log groups behind on a PASSING run, and no fixture sweeps them |
| [#2276](https://github.com/go-to-k/cdkd/issues/2276) | chore(scripts): widen check-local-reachability's default scope from src/local to src |
| [#2287](https://github.com/go-to-k/cdkd/issues/2287) | test(integ): 16 local-* fixtures declare no Lambda architecture, so their containers run under amd64 emulation on an arm64 host and the Go RIE segfaults |
| [#2288](https://github.com/go-to-k/cdkd/issues/2288) | chore(rules): the secret-redaction rule bundle sits 4 bytes under its payload cap, so every lane in that file must fund its own doc correction |
| [#2304](https://github.com/go-to-k/cdkd/issues/2304) | test(scripts): five shapes still slip past the integ sweep lint after the issue 2296 model change (one-line if, loop-iteration clobber, case arm, factored-out teardown) |
| [#2329](https://github.com/go-to-k/cdkd/issues/2329) | chore(hooks): non-english-text-gate scans whole files with no allow-list, so two repo files cannot be touched by any PR |
| [#2334](https://github.com/go-to-k/cdkd/issues/2334) | chore(hooks): GATE_RE_GH_PROSE_CARRIER and the strip helpers' tail sit outside both measurement harnesses, so only hand-picked cases fence them |
| [#2341](https://github.com/go-to-k/cdkd/issues/2341) | chore(work-issues): mirror three flow lessons — tier at the final sha, counts at the final sha, state x shape |
| [#2350](https://github.com/go-to-k/cdkd/issues/2350) | test(scripts): nine source-scanning fences decide code-vs-comment with a hand-rolled regex strip, which is a classifier and cannot be fenced by hand-picked cases |
| [#2354](https://github.com/go-to-k/cdkd/issues/2354) | chore(hooks): a QUOTED command LEADER evades the gate trigger, so `"sudo" git commit` reaches git ungated (go-to-k/cdkd#2333 residue) |
| [#2355](https://github.com/go-to-k/cdkd/issues/2355) | chore(hooks): nothing makes a claim LOSER re-read, so gate `git push` on a competing or stood-down claim |
| [#2360](https://github.com/go-to-k/cdkd/issues/2360) | chore(hooks): a ${VAR:+...} leader stops the wrapper strip, so bash -c is never unwrapped and a markgate set preamble is invisible |
| [#2395](https://github.com/go-to-k/cdkd/issues/2395) | chore(tests): 20 of 28 rule-file payload rows carry a stale `measured` comment, and three sit within 72 B of their cap |
| [#2413](https://github.com/go-to-k/cdkd/issues/2413) | chore(work-issues): retro for the 2026-09-02 rate-limit-interrupted mermaid run (5 lessons, evidence recorded) |
| [#2424](https://github.com/go-to-k/cdkd/issues/2424) | chore(work-issues): references/implement.md is 984 B under its 49,000 B cap — split the stage or the next lesson has nowhere to land |
| [#2433](https://github.com/go-to-k/cdkd/issues/2433) | chore(work-issues): the IN-PLACE detach fallback moves HEAD to origin/main instead of restoring where the tree was left |
| [#2434](https://github.com/go-to-k/cdkd/issues/2434) | chore(hooks): nothing stops a third unquoted-heredoc comment span from running as a command |
| [#2445](https://github.com/go-to-k/cdkd/issues/2445) | chore(run-integ): make "review first, integ last" mechanical — it has now been violated in two consecutive sessions on the same PR |
| [#2555](https://github.com/go-to-k/cdkd/issues/2555) | test(scripts): nothing checks a docs section citation from src/, tests/ or .claude/ — a split broke 71 of them silently |
| [#2582](https://github.com/go-to-k/cdkd/issues/2582) | test(integ): a verify.sh assertion of the form 'printf \| grep -q' is fail-open under pipefail |
| [#2641](https://github.com/go-to-k/cdkd/issues/2641) | chore(hooks): commit-prefix-scope-gate reads the index before the chained `git add` runs, so `git add -A && git commit -m "fix: ..."` is never evaluated |
| [#2643](https://github.com/go-to-k/cdkd/issues/2643) | test(provisioning): the stateful-reason sentinel fence misses new fixtures, regex needles, and substring-extended reasons |
| [#2679](https://github.com/go-to-k/cdkd/issues/2679) | chore(gates): integ-broad is bound only to a root sentinel, so serial lanes sharing one worktree inherit a marker for code no broad integ has seen |
| [#2682](https://github.com/go-to-k/cdkd/issues/2682) | test(integ): a sweep anchored at /aws/lambda/ still deletes every Lambda log group in the region when its scope is empty (24 sites, 23 unguarded) |
| [#2687](https://github.com/go-to-k/cdkd/issues/2687) | chore(hooks): commit-prefix-scope-gate resolves the wrong tree, the wrong file set and the wrong subject for shapes this repo writes |
| [#2690](https://github.com/go-to-k/cdkd/issues/2690) | test(integ): the destructive prefix-sweep convention has no checker — option 3 of go-to-k/cdkd#2621 |
| [#2694](https://github.com/go-to-k/cdkd/issues/2694) | test(scripts): nothing fences the .ts-extension rule for src modules on a scripts/ import closure |
| [#2701](https://github.com/go-to-k/cdkd/issues/2701) | test(unit): five tracked-only `git ls-files` populations skip untracked files, so a new file is unchecked until it is committed |
| [#2702](https://github.com/go-to-k/cdkd/issues/2702) | chore(hooks): substitution bodies emit before their line, so gated-command-preamble-gate misses a write preamble before a gated command |
| [#2703](https://github.com/go-to-k/cdkd/issues/2703) | chore(hooks): the two quote machines in command-match still disagree on multi-substitution lines, and a missed segment is a silent pass for branch-gate and the data-loss gate — PARTLY MOOT: branch-gate was retired, the data-loss gate remains |
| [#2705](https://github.com/go-to-k/cdkd/issues/2705) | chore(hooks): a green CI check attests to the base at RUN START, so a peer merge can invalidate it and no gate re-asks |
| [#2714](https://github.com/go-to-k/cdkd/issues/2714) | chore(hooks): guard the shared matcher against the edit that locks a session out of its own repository |
| [#2715](https://github.com/go-to-k/cdkd/issues/2715) | chore(hooks): twelve suites run under bash 3.2 while running their hook under 5.x, so their 3.2 coverage is a claim about the test |
| [#2716](https://github.com/go-to-k/cdkd/issues/2716) | chore(hooks): move the hook layer off bash — one runtime and a real parser, not types |
| [#2768](https://github.com/go-to-k/cdkd/issues/2768) | chore(hooks): main-tree-edit-gate misses five cd spellings that really move the shell (cd --, -P, -L, eval, pushd) — MOOT: the main-tree hook family was retired |
| [#2786](https://github.com/go-to-k/cdkd/issues/2786) | test(unit): three prose claims in check-scope-checker-inputs and .markgate.yml drift from the code beside them, and nothing fences the class |
| [#2796](https://github.com/go-to-k/cdkd/issues/2796) | test(integ): the export fixture's FIXED bucket name puts it in a ~58 min S3 cooldown, so it cannot run twice in an hour |
| [#2798](https://github.com/go-to-k/cdkd/issues/2798) | test(unit): the full suite intermittently exits 1 with "Worker exited unexpectedly" while every test passes |
| [#2806](https://github.com/go-to-k/cdkd/issues/2806) | chore(rules): the merge projection reads the branch's budget table, and a local run with no origin/main skips it silently |
| [#2810](https://github.com/go-to-k/cdkd/issues/2810) | chore(rules): the corpus byte floor cannot see 45 of 51 satellites being gutted, and no re-derivation fixes that |
| [#2818](https://github.com/go-to-k/cdkd/issues/2818) | test(payload): re-derive the stale measured-N annotations in PAYLOAD_BUDGETS |
| [#2823](https://github.com/go-to-k/cdkd/issues/2823) | chore(hooks): main-tree-edit-oracle is 10 commands over its 5s latency budget on origin/main too, so its red says nothing about the hook — MOOT: the main-tree hook family was retired |
| [#2824](https://github.com/go-to-k/cdkd/issues/2824) | test(hooks): fence GATE_RE_* constants that no hook or suite reads |
| [#2825](https://github.com/go-to-k/cdkd/issues/2825) | chore(process): the integ ledger is not a per-PR receipt, so a PR's own PASS can be erased by another lane's later FAIL of the same test |
| [#2826](https://github.com/go-to-k/cdkd/issues/2826) | chore(hooks): finish the constant-liveness CLASS fence, split out of the 2729 fix |
| [#2844](https://github.com/go-to-k/cdkd/issues/2844) | chore(rules): layout-scripts.md has 351 bytes of headroom, so its own generator/critic family can no longer be indexed |
| [#2853](https://github.com/go-to-k/cdkd/issues/2853) | chore(hooks): fence the no-shell-recipe shape across every refusal reachable when the matcher is broken |
| [#2923](https://github.com/go-to-k/cdkd/issues/2923) | chore(rules): the import.ts rule payload has ~500 bytes of headroom, so a lane touching cdkd import cannot record why its change is the way it is |
| [#2940](https://github.com/go-to-k/cdkd/issues/2940) | chore(rules): .claude/rules/testing.md is 39 bytes under the tests/** payload cap, so the next testing decision has nowhere to land |
| [#3040](https://github.com/go-to-k/cdkd/issues/3040) | chore(hooks): integ-local's scope is source paths only, so a cdk-local version bump — the change most certain to move local-execution behaviour — passes ungated — SHIPPED by [#3082](https://github.com/go-to-k/cdkd/pull/3082) |
| [#3043](https://github.com/go-to-k/cdkd/issues/3043) | chore(hooks): a missing jq makes every Bash gate exit 0, indistinguishable from a pass |
| [#3047](https://github.com/go-to-k/cdkd/issues/3047) | chore(hooks): a non-ASCII path is C-quoted by git, so integ-destroy's patterns never match it |
| [#3066](https://github.com/go-to-k/cdkd/issues/3066) | fix(hooks): a heredoc opener flushed from a substitution body leaks pending_tag into the top-level latch, which then swallows lines up to an unrelated later terminator — SHIPPED by [#3082](https://github.com/go-to-k/cdkd/pull/3082) |
| [#3081](https://github.com/go-to-k/cdkd/issues/3081) | hooks: close_paren / subst_open do not read `)#` as a comment, so a `cd` inside $( ) is emitted top-level |
| [#3099](https://github.com/go-to-k/cdkd/issues/3099) | hooks: strip_noncommand_spans reads a heredoc delimiter as the quoted span alone, and knows no # comment (third reader, not on heredoc_word) |
| [#3132](https://github.com/go-to-k/cdkd/issues/3132) | hooks: run()'s continuation arm joins a backslash that ends a comment, or precedes a CR, and refuses an even run inside backticks |
| [#3204](https://github.com/go-to-k/cdkd/issues/3204) | hooks: a leading redirection defeats every blocking gate (gate_strip_prefix strips no redirection) |
| [#3205](https://github.com/go-to-k/cdkd/issues/3205) | hooks: a newline inside a bash -c string is joined away, so the second line's verb is never matched |
| [#3213](https://github.com/go-to-k/cdkd/issues/3213) | test(integ): nothing lints that a verify.sh wc result is trimmed, so a fixture written on GNU coreutils fails unconditionally on macOS — SHIPPED by [#3304](https://github.com/go-to-k/cdkd/pull/3304) |
| [#3217](https://github.com/go-to-k/cdkd/issues/3217) | chore(hooks): post-merge-sync-reminder reports "PR merge succeeded" over a merge that failed, when the caller masks the exit status |
| [#3219](https://github.com/go-to-k/cdkd/issues/3219) | hooks: the $( ) heredoc latch drops a body bash's syntax-error recovery actually runs (malformed opener) |
| [#3228](https://github.com/go-to-k/cdkd/issues/3228) | hooks: a # comment inside a multi-line $( ) swallows the next command line (the join replaces its newline) |
| [#3254](https://github.com/go-to-k/cdkd/issues/3254) | test(ci): trim the archaeological half of workflow-expression-syntax.test.ts, which is where its false statements live |
| [#3256](https://github.com/go-to-k/cdkd/issues/3256) | chore(hooks): decide verify-pr-gate's repo-override question on the SELECTOR POSITION, not on every token's text |
| [#3258](https://github.com/go-to-k/cdkd/issues/3258) | hooks: a )# inside a DOUBLE-QUOTED multi-line substitution comments out the closer, and the verb after it is never matched |
| [#3259](https://github.com/go-to-k/cdkd/issues/3259) | hooks: run()'s $( ) join is O(n^2), so ~800 body lines cross the 10s PreToolUse timeout and disarm every gate |
| [#3260](https://github.com/go-to-k/cdkd/issues/3260) | hooks: a case arm written (y) instead of y) is not a command position, so the verb after it is never matched |
| [#3262](https://github.com/go-to-k/cdkd/issues/3262) | hooks: a bare (( )) arithmetic command is not skipped, so 1<<X reads as a heredoc opener and swallows the next line |
| [#3263](https://github.com/go-to-k/cdkd/issues/3263) | hooks: /bin/sh -c, bash -c --, a function body and eval all put a guarded verb past every gate |
| [#3267](https://github.com/go-to-k/cdkd/issues/3267) | hooks: the differential fence has no detector for a DEAD allow-row, so a stale row pre-authorises a lost match |
| [#3282](https://github.com/go-to-k/cdkd/issues/3282) | ci: profile and shorten hook-suites, so its timeout can come back down from 60 |
| [#3283](https://github.com/go-to-k/cdkd/issues/3283) | test(ci): the workflow-timeout fence catches an absent bound but not one that is too tight |
| [#3299](https://github.com/go-to-k/cdkd/issues/3299) | hooks: a " inside a single-quoted span inside "$( )" carries the quote across the line end, and the verb after it is never matched |
| [#3300](https://github.com/go-to-k/cdkd/issues/3300) | hooks: close_paren and flush_line still model bash alone for the PID-then-quote shape, and miss an unbalanced quote in a backtick frame |
| [#3301](https://github.com/go-to-k/cdkd/issues/3301) | chore(hooks): a combined short-flag cluster carrying R is not read as a repo slug, so the merge gates still judge the cwd repo for it |
| [#3303](https://github.com/go-to-k/cdkd/issues/3303) | fix(hooks): an escaped character before a `#` inside $( ) reads two ways, and each reading leaves fail-opens the other closes |
| [#3334](https://github.com/go-to-k/cdkd/issues/3334) | chore(tests): every tests/integration shell fence follows a symlinked verify.sh, so a fork PR can have a file outside the repo parsed and one line echoed into the job log |
| [#3336](https://github.com/go-to-k/cdkd/issues/3336) | test(rules): split layout-scripts.md into routing + satellites — the payload fence's own remedy is blocked wherever an index sits at its cap |
| [#3342](https://github.com/go-to-k/cdkd/issues/3342) | test(rules): assert each payload budget's satellite relations instead of re-deriving them by hand per row |
| [#3365](https://github.com/go-to-k/cdkd/issues/3365) | chore(hooks): three integ-* gates hand-roll the PR-number walk, so a URL selector makes them judge the wrong pull request |
| [#3384](https://github.com/go-to-k/cdkd/issues/3384) | test(scripts): six subprocess-spawning suites declare no per-test timeout, so a loaded run flakes and inflates any mutation-table row measured at that moment |
| [#3385](https://github.com/go-to-k/cdkd/issues/3385) | chore(hooks): gate_slug_from_url keeps the host, so a remote naming this repo through one of gh's github.com aliases reads as another repo and drops the verify-pr binding — SHIPPED by [#3386](https://github.com/go-to-k/cdkd/pull/3386) |
| [#3387](https://github.com/go-to-k/cdkd/issues/3387) | fix(hooks): gate_repo_slug trims `.git` before it case-folds, so a case-variant remote reads as a FOREIGN repo |
| [#3428](https://github.com/go-to-k/cdkd/issues/3428) | test(scripts): the wc-trim classifier declares two bounds that can ship an untrimmed `wc` with nothing else noticing, and neither has a case pinning it, so closing one or opening a third leaves the header and the docs asserting a stale set |
| — | test(unit): `gen-handled-property-wiring.test.ts`'s `every malformed FIELD gets a STRUCTURED refusal, not a caught crash` runs 4.8 s isolated against vitest's 5 s default, and timed out on a run overlapping a build. Widens [#3384](https://github.com/go-to-k/cdkd/issues/3384): that population is six spawning suites, and this file is not in it |
| — | docs(rules): `lock-contention-message.md` states LAST-and-UNWRAPPED as a property of a command inside a wrapper. B1 of go-to-k/cdkd#3363's review measured it wider: a `shellQuote`d VALUE in English prose is pasteable with NO wrapper, because an apostrophe in the sentence (`this stack's name`) opens a quote that closes at the value's own, and a `cdk.json`-planted bucket then ran as shell. The generalization exists only as a source comment in `malformed-resources-bag.ts`, so the next refusal an agent writes inherits the narrow rule — SHIPPED by [#3440](https://github.com/go-to-k/cdkd/pull/3440) |
| — | docs(rules): `layout-state-types.md` enumerates `lock-contention-message.ts`'s exports as `buildForceUnlockCommand` / `shellQuote` / `formatLockExpiry` / `UNREPRODUCIBLE_LOCK_CLAUSE`, and go-to-k/cdkd#3363 added three more (`commandHole`, `recoveryCommandFlags`, `sanitizeRecoveryValue`). A hand-maintained export list is the shape this corpus fences elsewhere by deriving it. Replacing it with a LONGER hand list only moves the staleness, so the entry now names the `grep` and refuses to carry a population — SHIPPED by [#3440](https://github.com/go-to-k/cdkd/pull/3440) |
| — | test(rules): the display fence's MIXED-RENDER arm is value-class-independent but scoped to the `cdkd local` surface, so the deploy path's raw renders fall outside it. Extending it means a per-statement judgement across ~7 files in `scrub.ts` / `state.ts` / `gc.ts` that the fence explicitly refuses to make mechanically. Filed as go-to-k/cdkd#3405 and closed under the tooling-findings rule |
| — | test(rules): `sanitizedLocals` in `tests/unit/cli/local-profile-display-population.test.ts` is a line walk on its fifth spelling; moving it to the compiler API means re-deriving every floor it feeds. Filed as go-to-k/cdkd#3411 and closed under the tooling-findings rule. Its sibling instrument — the AST mask-coverage checker — was DELETED by go-to-k/cdkd#3435 for the same maintenance reason, so weigh a rewrite against deleting this one too |
| — | test(deployment): the AST mask-coverage checker was the only instrument that could answer whether the resolver's raw-render population is CLOSED. With it deleted (go-to-k/cdkd#3435) the remaining fence asserts containment — `maskSecretsRaw` and the strip-and-mask composition have one caller each — and the per-site renders are held by byte-level cases. A NEW raw render at a NEW site is no longer reported; go-to-k/cdkd#3441 is the known remainder, derived by hand |
| — | chore(rules): `.claude/rules/layout-deployment-secrets.md` is 13,077 B against the 12 KB per-file cap in AGENTS.md's Tooling Policy item 4, and it is not one of the five index files that may reach 20 KB. Nothing measures the cap any more — the payload fence was retired — so the budget is now prose a lane has to remember |
| — | chore(skills): `.claude/skills/**` totals 214,717 B against the 200 KB budget in the same item — measure it with `find .claude/skills -type f -exec wc -c {} +`, since a `du -sk` reads disk blocks and overstates it. `.claude/rules/**` is 299,621 B, just inside its 300 KB budget, so the two are not equally slack; the skills one is what a lane will cross without noticing |
| — | test(integ): `cc-api-fallback-transitions` is RED on `main` (its `integ-last-run.tsv` row) — its override arm asserts that `--allow-unsupported-properties AWS::Lambda::Function:RuntimeManagementConfig` silent-drops a property go-to-k/cdkd#1621 made HANDLED. Same rotted premise that go-to-k/cdkd#3454 and go-to-k/cdkd#3457 repaired in `recreate-via-sdk-provider`, `recreate-mixed-direction` and `sdk-ccapi-crossref`; the rule is now in `docs/integ-fixture-conventions.md` ("Never seed a Cloud Control route from an unhandled property"). Repairing it means moving the trigger to `AWS::ApiGatewayV2::Api.Body` as `cc-api-fallback` did. A unit test reading each fixture's named `Type:Property` trigger against `property-coverage.generated.ts` would catch the next one offline, but needs fixtures to DECLARE their trigger first |
| — | chore(run-integ): nothing in `/run-integ` or `/work-issues` says how to tell an intermittent AWS-side failure from a regression. What separated them on `rollback-deletion-policy-snapshot` (go-to-k/cdkd#3455): re-run on `main`'s engine, then read CloudTrail's `userAgent` / `sourceIPAddress` for the offending call — `cloudformation.amazonaws.com` means Cloud Control's handler made it, not cdkd's SDK client. First occurrence |

## Deferred test-coverage gaps

These are `severity:low` coverage gaps whose fix is a NEW integ fixture and
for which there is no evidence of a defect — nothing here describes cdkd
behaviour a user was observed to hit. They are picked up when the subsystem is
next touched, as part of that work; the rows below are the record, and the
issues they name are to be closed on the tracker.

| Issue | Title |
| --- | --- |
| [#1749](https://github.com/go-to-k/cdkd/issues/1749) | test(dynamodb): the GlobalTable omit's local-vs-cross-region replica discrimination is unfenced (regional clients are unmockable in the unit suite) |
| [#1856](https://github.com/go-to-k/cdkd/issues/1856) | test(integ): the AWS::Glue::Database drift inversion has no live arm - no fixture runs cdkd drift over a declared and an undeclared CreateTableDefaultPermissions |
| [#1867](https://github.com/go-to-k/cdkd/issues/1867) | test(deploy): the CLI summary row and RunCounts.skipped for a skipped DELETE are still unasserted ((#1862) residual) |
| [#1878](https://github.com/go-to-k/cdkd/issues/1878) | test(provisioning): decouple four issue-1824 tests from the resolver's error wording, and make the added sts mocks non-inert |
| [#1939](https://github.com/go-to-k/cdkd/issues/1939) | test(dynamodb): the #1742 per-index WarmThroughput strip has no stale-baseline live arm, so its convergence claim is unproven end-to-end |
| [#1974](https://github.com/go-to-k/cdkd/issues/1974) | test(provisioning): fence the deploy summary counts, the provisionedBy snapshot, and two acm-certificate fixture-hygiene gaps |
| [#2061](https://github.com/go-to-k/cdkd/issues/2061) | test(integ): the custom resource's pre-delivery authz retry has no live arm — a clean run never reaches it |
| [#2120](https://github.com/go-to-k/cdkd/issues/2120) | test(rollback): the #2057 named-region arm has no real-AWS coverage, and two fixture assertions can flake on SSM read lag |
| [#2136](https://github.com/go-to-k/cdkd/issues/2136) | test(integ): no live arm proves a wrong-region needle fails to match a producer-region plaintext in state (#2109 residual) |
| [#2232](https://github.com/go-to-k/cdkd/issues/2232) | test(state)/fix(deployment): PR #2194 residuals — rebuild tie-break edge tests + set-change summary warn under resolutionFailed |
| [#2234](https://github.com/go-to-k/cdkd/issues/2234) | test(integ): the gc response-placeholder sweep has no live arm, and listRawObjects' wire shape is unexercised |
| [#2239](https://github.com/go-to-k/cdkd/issues/2239) | test(dynamodb): the --remove-protection compensation has no live arm - no fixture reaches a terminal delete failure |
| [#2425](https://github.com/go-to-k/cdkd/issues/2425) | test(integ): the issue 2036 CLOSURE has no end-to-end arm — only the RESIDUAL direction is covered |
| [#2647](https://github.com/go-to-k/cdkd/issues/2647) | test(local): no integ fixture carries an ALB Lambda target group, so start-alb --from-state partiality is unexercised |
| [#2756](https://github.com/go-to-k/cdkd/issues/2756) | test(masking): four deferred nits from the PR 2742 round-3 review — SSM fake refusal ordering, a structural cause assertion, an over-broad verify.sh inventory, and an overstated maskSecretsInError comment |
| [#3193](https://github.com/go-to-k/cdkd/issues/3193) | test(integ): cdkd diff has no real-AWS arm for a malformed outputs bag |
| [#3406](https://github.com/go-to-k/cdkd/issues/3406) | test(integ): dynamodb-ondemand does not exercise the per-GSI OnDemandThroughput pre-flight refusal |
