#!/usr/bin/env bash
# Smoke test for pr-review-gate.sh.
#
# Exercises the size+bias heuristic and the marker-freshness check
# against PATH-shimmed `gh` and `markgate` binaries. Each case stubs
# `gh pr view` to return a synthetic PR JSON shape and stubs
# `markgate` to return either "fresh" or "stale", then asserts the
# hook's exit code matches the expected gate decision.
#
# Every case additionally asserts that the REAL checkout's
# `.markgate-pr-review-sha` is byte-identical to what it was when the suite
# started (issue #2336) — the suite operates on a fixture repo under
# `$TMP_ROOT`, and that assertion is what keeps it that way.
#
# Run from the repo root: `bash .claude/hooks/pr-review-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pr-review-gate.sh"
SCRIPT_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ONE temp root, ONE cleanup function, ONE `trap ... EXIT` (issue #2336).
# Bash REPLACES an EXIT handler rather than chaining it, so a second
# `trap ... EXIT` further down silently disarms this one — which is what this
# suite used to do, at line 448, re-implementing most of `cleanup` instead of
# calling it. Fenced by tests/unit/scripts/integ-single-exit-trap.test.ts,
# whose population covers `.claude/hooks/**` for exactly this reason.
TMP_ROOT="$(mktemp -d)"
SHIM_DIR="$TMP_ROOT/shims"
CWD_TMP="$TMP_ROOT/cwd"
mkdir -p "$SHIM_DIR" "$CWD_TMP"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

# Post-#559 the hook is cwd-aware: the sentinel lives in the worktree the
# resolved command would run in. So every payload below points `cwd` at a
# FIXTURE repo, never this checkout (issue #2336).
#
# Why that matters: `.markgate-pr-review-sha` is the LIVE file
# `pr-review-gate.sh` reads to decide whether a `gh pr merge` is allowed, and
# the suite rewrites it once per case. Pointed at the real root, a concurrent
# `gh pr merge` or `/review-pr` in this worktree read a fixture sha, and a
# SIGKILLed run (no EXIT trap runs at all) left one behind — which is how a
# `run-tests.sh` pass reported 16 failures the same suite standalone did not.
# Measured on the pre-fix suite: the live sentinel took SEVEN distinct fixture
# values during one run and was deleted between them.
REPO_ROOT="$TMP_ROOT/main-worktree"
git init -q -b main "$REPO_ROOT"
git -C "$REPO_ROOT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
SENTINEL="$REPO_ROOT/.markgate-pr-review-sha"

# The REAL checkout's sentinel. Nothing here may touch it, and every case
# asserts so — a static "we point at a fixture now" claim would go stale the
# first time someone adds a case that reaches for `$SCRIPT_REPO`.
# It watches THREE things, and the second and third were bought the hard way.
# While developing this very fix, a mutation probe reverted `REPO_ROOT` to
# `$SCRIPT_REPO` for one run — which pointed the fixture setup below at the live
# checkout and ran `git init` + `git commit --allow-empty` against it, landing
# two empty `t <t@t>` commits on the branch. `git status` stayed CLEAN
# throughout, and a sentinel-only assertion saw nothing. Committing to the live
# repo is the same hazard as writing its sentinel, so the probe has to cover the
# tree's COMMIT state too, not just one file.
LIVE_SENTINEL="$SCRIPT_REPO/.markgate-pr-review-sha"
live_tree_state() {
  if [ -f "$LIVE_SENTINEL" ]; then
    printf 'sentinel=present:%s' "$(cat "$LIVE_SENTINEL" 2>/dev/null)"
  else
    printf 'sentinel=absent'
  fi
  printf ' head=%s' "$(git -C "$SCRIPT_REPO" rev-parse HEAD 2>/dev/null)"
  # SCOPED to `.markgate*`, not the whole tree. A repo-wide dirty count makes
  # this suite non-hermetic: this repo runs parallel agents by design, so a
  # PEER's edit lands in the baseline comparison and fails every later case
  # with "LIVE TREE MUTATED" — a false red blaming the suite for someone else's
  # write, which is the exact class issue #2336 is about.
  #
  # What this arm can actually SEE is narrow, and saying so matters: the
  # sentinel itself is gitignored, so `git status --porcelain` never reports it
  # whatever the pathspec. `.markgate.yml` is the tracked file in range. The
  # real #2336 hazard is covered twice over without this arm — `sentinel=`
  # stats and READS the file directly, and `head=` catches the commit that a
  # dirty count cannot see. This is the cheap third signal, not the load-bearing
  # one.
  printf ' stray=%s' "$(git -C "$SCRIPT_REPO" status --porcelain -- '.markgate*' 2>/dev/null | wc -l | tr -d '[:space:]')"
}
LIVE_BASELINE="$(live_tree_state)"

pass=0
fail=0
fail_log=""

# Receipt file: the gh shim appends one line per `gh api graphql` call, so a
# case can assert the hook made the timeline query — or, just as load-bearing,
# that it SKIPPED it when the answer could not change the tier.
GRAPHQL_TRACE_FILE="$SHIM_DIR/graphql-trace"
# EXPORTED: the shim is a separate process reached through PATH, and it reads
# this from the environment rather than from an interpolated literal.
export GRAPHQL_TRACE_FILE

# Write the gh shim. It dispatches by the args fixture name in
# $GH_FIXTURE — each test case sets that env var before invoking the
# hook to control what `gh pr view` returns.
# The shim needs ONE value from this shell: where to write its receipt. Passing
# it through the ENVIRONMENT rather than interpolating it into the script body
# keeps a `"` or a `$(` in `$TMPDIR` from becoming shim source code.
cat > "$SHIM_DIR/gh" <<'EOF_GH'
#!/usr/bin/env bash
set -u

# Dispatch on ARGS, not on $GH_FIXTURE alone: the hook makes TWO different gh
# calls (`pr view` and, for the rewrite-proof fix-back count, `api graphql`),
# and a shim that answers both with the same body cannot tell a wrong target
# from a right one. Every graphql call RECORDS ITS ARGV, so a case can assert
# both that the hook SKIPPED the query when it could not change the outcome AND
# that a query it did make named the right repository and PR.
if [ "${1:-}" = "api" ] && [ "${2:-}" = "graphql" ]; then
  # ONE LINE PER CALL: the `-f query=` argv element is multi-line, so printing
  # `$*` raw made a single call look like a dozen. The count is a call count.
  printf '%s\n' "$*" | tr '\n' ' ' >> "$GRAPHQL_TRACE_FILE"
  printf '\n' >> "$GRAPHQL_TRACE_FILE"
  case "${GH_FIXTURE:-}" in
    flattened-fixback)
      # PR #2634's real shape: the branch was flattened to ONE `fix(deploy):`
      # commit, but the timeline still names the rounds the flatten collapsed.
      # Three DISTINCT `fix` subjects -> up-bias.
      cat <<'EOF'
{"data":{"repository":{"pullRequest":{"timelineItems":{"nodes":[
{"beforeCommit":{"messageHeadline":"fix(rollback): delete an assertion-free test"},"afterCommit":{"messageHeadline":"fix(deploy): name the deleted old resource"}},
{"beforeCommit":{"messageHeadline":"test(integ): record the replacement-retain runs in the ledger"},"afterCommit":{"messageHeadline":"fix(deploy): honour UpdateReplacePolicy across replacement rollback"}}
]}}}}}
EOF
      ;;
    amended-fixback)
      # ONE fix-back round, amended and force-pushed. The subject is unchanged,
      # so the count must stay 1: counting SHAS (or occurrences) would say 2 and
      # up-bias a PR that had a single round.
      cat <<'EOF'
{"data":{"repository":{"pullRequest":{"timelineItems":{"nodes":[
{"beforeCommit":{"messageHeadline":"fix(state): sanitize the display sinks this branch added"},"afterCommit":{"messageHeadline":"fix(state): sanitize the display sinks this branch added"}}
]}}}}}
EOF
      ;;
    nofix-forcepush)
      # A force-push with no `fix` subject anywhere. A rewrite is not by itself
      # evidence of fix-back churn — this is the over-fire control.
      cat <<'EOF'
{"data":{"repository":{"pullRequest":{"timelineItems":{"nodes":[
{"beforeCommit":{"messageHeadline":"chore(deps): bump the lockfile"},"afterCommit":{"messageHeadline":"chore(deps): bump the lockfile and regenerate"}}
]}}}}}
EOF
      ;;
    two-fix-commits)
      # No rewrite at all: the branch still carries both rounds. The timeline
      # is empty and the count must come from the PR's own commit list.
      cat <<'EOF'
{"data":{"repository":{"pullRequest":{"timelineItems":{"nodes":[]}}}}}
EOF
      ;;
    graphql-fails)
      exit 1
      ;;
    slow-graphql-forks)
      # A `gh` stand-in that SPAWNS A CHILD, which `gh pr view` really does (it
      # shells out to `git`). A bound that signals only its direct child leaves
      # the grandchild holding the caller's command-substitution pipe: measured
      # 25s elapsed under a 6s bound, i.e. past the harness kill, which is the
      # fail-open the bound exists to prevent. Without this arm the hole is
      # unobservable, because every other slow fixture is a single process.
      perl -e '$SIG{ALRM} = "IGNORE"; sleep 30;' &
      exec perl -e '$SIG{ALRM} = "IGNORE"; sleep 30;'
      ;;
    slow-graphql)
      # A faithful `gh` stand-in: ONE process (no forked child whose orphan
      # would hold the command-substitution pipe open past the kill) that
      # IGNORES SIGALRM (as the Go runtime does with no os/signal listener) and
      # honours SIGTERM. A bash `sleep` shim would have honoured SIGALRM and
      # passed under a bound that does nothing to `gh` — the false green that
      # shipped in this PR's first cut.
      exec perl -e '$SIG{ALRM} = "IGNORE"; sleep 30;'
      ;;
    graphql-malformed)
      # HTTP 200 carrying a GraphQL error payload rather than a transport
      # failure — `gh` exits 0, so the `|| tl_json=""` arm never runs and the
      # jq filter is what has to cope.
      #
      # A PARTIAL response: `data` AND `errors` together, which GraphQL returns
      # with HTTP 200 — so `gh` exits 0 and the `|| tl_json=""` arm never runs.
      #
      # The `commits` block is a DECOY, and it is what makes this case
      # discriminate rather than merely assert "did not crash". The hook's query
      # does not request `commits`, and its jq reads an EXACT path, so it must
      # never see `fix(zzz)`. A recursive-descent read
      # (`.. | .messageHeadline? // empty` — what a hand-written one-liner
      # reaches for, and what `/review-pr`'s own snippet uses) harvests it and
      # up-biases a PR with a single fix-back round. First attempt at this decoy
      # used the key `message` and killed nothing: the mutation looks for
      # `messageHeadline`, so the decoy has to be spelled the way the WRONG
      # implementation reads, not the way an error payload happens to look.
      cat <<'EOF'
{"data":{"repository":{"pullRequest":{"commits":{"nodes":[{"commit":{"messageHeadline":"fix(zzz): reachable ONLY by recursive descent"}}]},"timelineItems":{"nodes":[]}}}},"errors":[{"message":"Something partial failed"}]}
EOF
      ;;
    *)
      cat <<'EOF'
{"data":{"repository":{"pullRequest":{"timelineItems":{"nodes":[]}}}}}
EOF
      ;;
  esac
  exit 0
fi

case "${GH_FIXTURE:-}" in
  small)
    # 200 LOC, 3 files: src + tests. Base tier = inline (fc<5).
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"abc1234567890","headRefName":"feat/small","files":[{"path":"src/foo.ts"},{"path":"tests/foo.test.ts"},{"path":"README.md"}]}
EOF
    ;;
  medium)
    # 500 LOC, 7 files. Base = 1-reviewer.
    cat <<'EOF'
{"additions":300,"deletions":200,"changedFiles":7,"headRefOid":"med1234567890","headRefName":"feat/medium","files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"},{"path":"src/d.ts"},{"path":"src/e.ts"},{"path":"src/f.ts"},{"path":"src/g.ts"}]}
EOF
    ;;
  large)
    # 1500 LOC, 15 files. Base = 3-axis.
    cat <<'EOF'
{"additions":1000,"deletions":500,"changedFiles":15,"headRefOid":"big1234567890","headRefName":"feat/large","files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"},{"path":"src/d.ts"},{"path":"src/e.ts"},{"path":"src/f.ts"},{"path":"src/g.ts"},{"path":"src/h.ts"},{"path":"src/i.ts"},{"path":"src/j.ts"},{"path":"src/k.ts"},{"path":"src/l.ts"},{"path":"src/m.ts"},{"path":"src/n.ts"},{"path":"src/o.ts"}]}
EOF
    ;;
  docs-with-security)
    # 200 LOC, 3 files: includes cognito-jwt.ts → up-bias to 1-reviewer.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"sec1234567890","headRefName":"feat/docs-sec","files":[{"path":"docs/foo.md"},{"path":"src/local/cognito-jwt.ts"},{"path":"README.md"}]}
EOF
    ;;
  authorizer-surface)
    # 200 LOC, 3 files: includes authorizer-resolver.ts. Base tier inline
    # -> up-bias -> 1-reviewer. Guards issue #1972: this path replaced the
    # dead `src/local/lambda-authorizer.ts`, and before that fix a PR
    # touching cdkd's authorizer surface got no up-bias at all.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"aut1234567890","headRefName":"feat/authorizer","files":[{"path":"docs/foo.md"},{"path":"src/local/authorizer-resolver.ts"},{"path":"README.md"}]}
EOF
    ;;
  authorizer-cache-surface)
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"aut1234567890","headRefName":"feat/authorizer","files":[{"path":"docs/foo.md"},{"path":"src/local/authorizer-cache.ts"},{"path":"README.md"}]}
EOF
    ;;
  sigv4-surface)
    # The AWS_IAM verifier + credential loader. Its resolver was listed
    # while it was not (issue #1972 review).
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"aut1234567890","headRefName":"feat/sigv4","files":[{"path":"docs/foo.md"},{"path":"src/local/sigv4-verify.ts"},{"path":"README.md"}]}
EOF
    ;;
  docker-cmd-surface)
    # `getDockerCmd()` resolves CDK_DOCKER into the spawned binary -- the
    # process-launch primitive behind every listed docker file.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"aut1234567890","headRefName":"feat/docker-cmd","files":[{"path":"docs/foo.md"},{"path":"src/utils/docker-cmd.ts"},{"path":"README.md"}]}
EOF
    ;;
  dead-authorizer-path)
    # The path retired by issue #1972. It cannot exist, so it must NOT
    # up-bias: a dead alternative in UP_PATH_REGEX is the bug, not a
    # safety net.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"ded1234567890","headRefName":"feat/dead","files":[{"path":"docs/foo.md"},{"path":"src/local/lambda-authorizer.ts"},{"path":"README.md"}]}
EOF
    ;;
  tests-only-large)
    # 1500 LOC, 15 files, ALL under tests/ → down-bias to 1-reviewer.
    cat <<'EOF'
{"additions":1000,"deletions":500,"changedFiles":15,"headRefOid":"tst1234567890","headRefName":"feat/tests","files":[{"path":"tests/a.test.ts"},{"path":"tests/b.test.ts"},{"path":"tests/c.test.ts"},{"path":"tests/d.test.ts"},{"path":"tests/e.test.ts"},{"path":"tests/f.test.ts"},{"path":"tests/g.test.ts"},{"path":"tests/h.test.ts"},{"path":"tests/i.test.ts"},{"path":"tests/j.test.ts"},{"path":"tests/k.test.ts"},{"path":"tests/l.test.ts"},{"path":"tests/m.test.ts"},{"path":"tests/n.test.ts"},{"path":"tests/o.test.ts"}]}
EOF
    ;;
  rules-only-large)
    # 781 LOC, 11 files, ALL under .claude/rules/ + CLAUDE.md → down-bias
    # to 1-reviewer. Mirrors the PR #532 shape that originally surfaced
    # the missing `.claude/rules/.*` clause in DOWN_DOCS_REGEX.
    cat <<'EOF'
{"additions":460,"deletions":321,"changedFiles":11,"headRefOid":"rul1234567890","headRefName":"docs/claude-md-trim","files":[{"path":"CLAUDE.md"},{"path":".claude/rules/architecture.md"},{"path":".claude/rules/code-layout.md"},{"path":".claude/rules/state-schema.md"},{"path":".claude/rules/providers.md"},{"path":".claude/rules/synthesis.md"},{"path":".claude/rules/assets.md"},{"path":".claude/rules/analyzer.md"},{"path":".claude/rules/cli-internals.md"},{"path":".claude/rules/testing.md"},{"path":".claude/rules/hooks.md"}]}
EOF
    ;;
  lockfile-inflated)
    # PR #1082 shape: 2784 raw LOC but 2747 of it is root-level
    # pnpm-lock.yaml churn. Adjusted loc = 37 (< 300) with fc = 9
    # (< 10) → inline tier → pass-through. Pre-fix the hook computed
    # raw LOC → 3-axis → spurious block.
    cat <<'EOF'
{"additions":1651,"deletions":1133,"changedFiles":9,"headRefOid":"lck1234567890","headRefName":"chore/lockfile-heavy","files":[{"path":"pnpm-lock.yaml","additions":1614,"deletions":1133},{"path":"package.json","additions":8,"deletions":0},{"path":"vite.config.ts","additions":4,"deletions":0},{"path":"CLAUDE.md","additions":4,"deletions":0},{"path":"CONTRIBUTING.md","additions":2,"deletions":0},{"path":".mise.toml","additions":2,"deletions":0},{"path":"scripts/a.ts","additions":6,"deletions":0},{"path":"scripts/b.ts","additions":6,"deletions":0},{"path":".claude/skills/verify-pr/SKILL.md","additions":5,"deletions":0}]}
EOF
    ;;
  autogen-inflated-manyfiles)
    # 3000 raw LOC, 2900 under docs/_generated/** — adjusted loc = 100,
    # but fc = 12 (>= 10) still forces 3-axis: fc is intentionally NOT
    # adjusted for auto-generated files (a many-file diff stays
    # cross-cutting). Gate must still block on a stale marker.
    cat <<'EOF'
{"additions":2500,"deletions":500,"changedFiles":12,"headRefOid":"agn1234567890","headRefName":"feat/autogen-heavy","files":[{"path":"docs/_generated/integ-coverage.json","additions":2400,"deletions":500},{"path":"src/a.ts","additions":10,"deletions":0},{"path":"src/b.ts","additions":10,"deletions":0},{"path":"src/c.ts","additions":10,"deletions":0},{"path":"src/d.ts","additions":10,"deletions":0},{"path":"src/e.ts","additions":10,"deletions":0},{"path":"src/f.ts","additions":10,"deletions":0},{"path":"src/g.ts","additions":10,"deletions":0},{"path":"src/h.ts","additions":10,"deletions":0},{"path":"src/i.ts","additions":10,"deletions":0},{"path":"src/j.ts","additions":10,"deletions":0},{"path":"src/k.ts","additions":10,"deletions":0}]}
EOF
    ;;
  flattened-fixback)
    # 200 LOC, 3 files -> base tier INLINE. Its branch was flattened to a
    # single `fix(deploy):` commit, so the pre-#2638 arm counted at most 1 and
    # the up-bias could never fire. With the timeline unioned in, three
    # distinct fix-back rounds -> 1-reviewer -> a stale marker BLOCKS.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"flt1234567890","headRefName":"fix/flattened","url":"https://github.com/go-to-k/cdkd/pull/2634","commits":[{"messageHeadline":"fix(deploy): honour UpdateReplacePolicy across replacement rollback"}],"files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"}]}
EOF
    ;;
  amended-fixback)
    # Same size, one fix-back round that was amended + force-pushed. Distinct
    # subjects = 1 -> NO bias -> inline -> pass even on a stale marker.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"amd1234567890","headRefName":"fix/amended","url":"https://github.com/go-to-k/cdkd/pull/2557","commits":[{"messageHeadline":"fix(state): sanitize the display sinks this branch added"}],"files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"}]}
EOF
    ;;
  nofix-forcepush)
    # Force-pushed, but nothing on it is a fix-back round -> no bias.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"nfx1234567890","headRefName":"chore/deps","url":"https://github.com/go-to-k/cdkd/pull/2632","commits":[{"messageHeadline":"chore(deps): bump the lockfile and regenerate"}],"files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"}]}
EOF
    ;;
  two-fix-commits)
    # Never rewritten: two distinct fix rounds still on the branch, and NO
    # `origin/<branch>` ref in the fixture repo. Pins that the count no longer
    # depends on a local fetch — the pre-#2638 arm skipped entirely here.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"twf1234567890","headRefName":"fix/two-rounds","url":"https://github.com/go-to-k/cdkd/pull/2627","commits":[{"messageHeadline":"feat(deploy): add the thing"},{"messageHeadline":"fix(deploy): address the first review round"},{"messageHeadline":"fix(deploy): address the second review round"}],"files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"}]}
EOF
    ;;
  graphql-fails)
    # `gh pr view` succeeds, `gh api graphql` does not. The count falls back to
    # what the branch itself shows (one round) -> no bias -> pass. Fail-open is
    # never WEAKER than the pre-#2638 behaviour, and never stronger.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"gqf1234567890","headRefName":"fix/flattened","url":"https://github.com/go-to-k/cdkd/pull/2634","commits":[{"messageHeadline":"fix(deploy): honour UpdateReplacePolicy across replacement rollback"}],"files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"}]}
EOF
    ;;
  skip-3axis)
    # 1500 LOC, 15 files, no down-bias -> already 3-axis, which up-bias clamps
    # to. The timeline query cannot change the outcome, so it must not be made.
    cat <<'EOF'
{"additions":1000,"deletions":500,"changedFiles":15,"headRefOid":"sk31234567890","headRefName":"fix/big","url":"https://github.com/go-to-k/cdkd/pull/2601","commits":[{"messageHeadline":"fix(a): one"},{"messageHeadline":"fix(b): two"}],"files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"},{"path":"src/d.ts"},{"path":"src/e.ts"},{"path":"src/f.ts"},{"path":"src/g.ts"},{"path":"src/h.ts"},{"path":"src/i.ts"},{"path":"src/j.ts"},{"path":"src/k.ts"},{"path":"src/l.ts"},{"path":"src/m.ts"},{"path":"src/n.ts"},{"path":"src/o.ts"}]}
EOF
    ;;
  skip-uppath)
    # A security-surface path already set up_bias, so the query is redundant.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"skp1234567890","headRefName":"fix/sec","url":"https://github.com/go-to-k/cdkd/pull/2593","commits":[{"messageHeadline":"fix(local): one"}],"files":[{"path":"docs/foo.md"},{"path":"src/local/cognito-jwt.ts"},{"path":"README.md"}]}
EOF
    ;;
  graphql-malformed)
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"mal1234567890","headRefName":"fix/malformed","url":"https://github.com/go-to-k/cdkd/pull/2634","commits":[{"messageHeadline":"fix(deploy): honour UpdateReplacePolicy across replacement rollback"}],"files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"}]}
EOF
    ;;
  slow-graphql)
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"slw1234567890","headRefName":"fix/slow","url":"https://github.com/go-to-k/cdkd/pull/2634","commits":[{"messageHeadline":"fix(deploy): honour UpdateReplacePolicy across replacement rollback"}],"files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"}]}
EOF
    ;;
  slow-graphql-forks)
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"frk1234567890","headRefName":"fix/forks","url":"https://github.com/go-to-k/cdkd/pull/2634","commits":[{"messageHeadline":"fix(deploy): honour UpdateReplacePolicy across replacement rollback"}],"files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"}]}
EOF
    ;;
  killed-midway)
    # `gh` writes part of a large-PR JSON and then dies on SIGKILL — an OOM
    # kill, an operator, or this hook's own bound escalating. The bytes on
    # stdout are a PREFIX of valid JSON, so every `jq` falls through to its
    # `|| echo 0` default and the tier resolves to `inline`: a PASS. The only
    # thing standing between that and a silent unreviewed merge is the wrapper
    # reporting the signal death as a failure, so the documented infra
    # fail-open runs and SAYS so.
    printf '%s' '{"additions":1000,"deletions":1000,"changedFiles":15,"head'
    kill -9 $$
    ;;
  slow-prview)
    # `gh pr view` itself hangs. Same single-process, SIGALRM-deaf model.
    exec perl -e '$SIG{ALRM} = "IGNORE"; sleep 30;'
    ;;
  hostile-url)
    # `gh api -F key=@path` means "read the value from a file", so an owner of
    # `@evil` would be a file-read primitive rather than a string. The charset
    # guard must refuse it and fall back to the commits-only count.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"hst1234567890","headRefName":"fix/hostile","url":"https://github.com/@evil/cdkd/pull/2634","commits":[{"messageHeadline":"fix(deploy): honour UpdateReplacePolicy across replacement rollback"}],"files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"}]}
EOF
    ;;
  fixback-vs-downbias)
    # 1500 LOC, 15 files, ALL under tests/ -> base 3-axis, down-bias -> the
    # skip guard lets the query through because up-bias would CANCEL the
    # down-bias. Two distinct fix rounds -> back to 3-axis. Both tiers block, so
    # only the TIER assertion can see this.
    cat <<'EOF'
{"additions":1000,"deletions":500,"changedFiles":15,"headRefOid":"fvd1234567890","headRefName":"fix/tests-rounds","url":"https://github.com/go-to-k/cdkd/pull/2570","commits":[{"messageHeadline":"fix(tests): address the first review round"},{"messageHeadline":"fix(tests): address the second review round"}],"files":[{"path":"tests/a.test.ts"},{"path":"tests/b.test.ts"},{"path":"tests/c.test.ts"},{"path":"tests/d.test.ts"},{"path":"tests/e.test.ts"},{"path":"tests/f.test.ts"},{"path":"tests/g.test.ts"},{"path":"tests/h.test.ts"},{"path":"tests/i.test.ts"},{"path":"tests/j.test.ts"},{"path":"tests/k.test.ts"},{"path":"tests/l.test.ts"},{"path":"tests/m.test.ts"},{"path":"tests/n.test.ts"},{"path":"tests/o.test.ts"}]}
EOF
    ;;
  history-floor)
    # ONE fix subject in the PR's commits and an empty timeline, but the BRANCH
    # itself carries two `fix:` commits that share that subject. Distinct
    # subjects = 1, branch history = 2. Only the floor keeps the bias alive.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"flr1234567890","headRefName":"fix/floor","url":"https://github.com/go-to-k/cdkd/pull/2601","commits":[{"messageHeadline":"fix(x): one and the same subject"}],"files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"}]}
EOF
    ;;
  fail)
    # Simulate gh failure.
    exit 1
    ;;
  *)
    # Default: medium tier so the test author notices an unset fixture.
    cat <<'EOF'
{"additions":300,"deletions":200,"changedFiles":7,"headRefOid":"def1234567890","headRefName":"feat/default","files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"},{"path":"src/d.ts"},{"path":"src/e.ts"},{"path":"src/f.ts"},{"path":"src/g.ts"}]}
EOF
    ;;
esac
EOF_GH
chmod +x "$SHIM_DIR/gh"

# Trace file: the mocked markgate writes $PWD to this file on every
# call. The cwd-aware test cases below (run_case_cwd) can assert the
# hook `cd`'d to the resolved target dir before invoking markgate.
# Mirrors check-gate.test.sh (post-#562) — closes the coverage gap
# the #562 reviewer flagged.
CWD_TRACE_FILE="$SHIM_DIR/cwd-trace"
# EXPORTED for the same reason as GRAPHQL_TRACE_FILE: the shims below are
# separate processes and read these from the environment, so no path from this
# shell is interpolated into shim SOURCE. `$TMPDIR` is not ours to trust — a
# `"` or a `$(` in it would otherwise become shim code.
export CWD_TRACE_FILE SHIM_DIR

# markgate shim: $MARKGATE_FIXTURE controls verify's exit code. Also
# writes $PWD to $CWD_TRACE_FILE so the cwd-aware test cases can
# assert the hook `cd`'d to the resolved target dir.
cat > "$SHIM_DIR/markgate" <<'EOF_MG'
#!/usr/bin/env bash
set -u
echo "$PWD" >> "$CWD_TRACE_FILE"
case "${1:-}" in
  verify)
    case "${MARKGATE_FIXTURE:-stale}" in
      fresh) exit 0 ;;
      stale) exit 1 ;;
      *) exit 1 ;;
    esac
    ;;
  status)
    echo "state: stale (digest differs)"
    exit 0
    ;;
  set)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
EOF_MG
chmod +x "$SHIM_DIR/markgate"

# Wrap mise so the hook's `mise exec -- markgate ...` path also routes
# through the shim. The real `mise exec` would re-resolve the
# repo-pinned markgate version, defeating our shim.
cat > "$SHIM_DIR/mise" <<'EOF_MISE'
#!/usr/bin/env bash
# Skip leading "exec --" so we can call the shim directly.
set -u
if [ "${1:-}" = "exec" ]; then
  shift
  if [ "${1:-}" = "--" ]; then shift; fi
  exec "$SHIM_DIR/$@"
fi
exec "$@"
EOF_MISE
chmod +x "$SHIM_DIR/mise"

# run_case <name> <expect_exit> <gh_fixture> <mg_fixture> <sentinel_content> <command>
#          [<expect_graphql: yes | no | <substring of the query's argv>>]
#          [<expect_tier: inline | 1-reviewer | 3-axis>]
#          [<max_secs: wall-clock ceiling for the hook invocation>]
#          [<expect_msg: substring the hook's own output must contain>]
#
# The 7th arg asserts whether the hook issued the fix-back timeline query
# (`gh api graphql`), and — when it is neither `yes` nor `no` — that the query's
# ARGV contained the given substring. The shim records argv precisely so a case
# can tell a right target from a wrong one; without that a query naming the
# wrong repo or PR answers identically to a correct one.
#
# The 8th arg asserts the RESOLVED TIER from the block message. The exit code
# cannot carry it: `1-reviewer` and `3-axis` both block, so every bias that
# moves between those two is invisible to an exit-code-only assertion — which is
# exactly the fix-back-versus-down-bias interaction.
run_case() {
  local name="$1"
  local want="$2"
  local gh_fix="$3"
  local mg_fix="$4"
  local sentinel="$5"
  local command="$6"
  local expect_graphql="${7:-}"
  local expect_tier="${8:-}"
  # A BOUND CANNOT BE ASSERTED BY ITS OUTCOME. Both the bounded and the
  # unbounded hook end up with the same fallback count, so only elapsed time
  # separates them.
  local max_secs="${9:-}"
  # Some verdicts are identical in EXIT CODE and differ only in whether the
  # hook SAID why. A silent fail-open and a loud one both exit 0; only the text
  # separates "the gate decided" from "the gate fell over quietly".
  local expect_msg="${10:-}"

  : > "$GRAPHQL_TRACE_FILE"

  # Reset sentinel.
  if [ -n "$sentinel" ]; then
    printf '%s' "$sentinel" > "$SENTINEL"
  else
    rm -f "$SENTINEL"
  fi

  local payload
  payload=$(printf '{"cwd":"%s","tool_input":{"command":"%s"}}' "$REPO_ROOT" "$command")

  local got out t0 t1 elapsed
  t0=$(date +%s)
  out=$(GH_FIXTURE="$gh_fix" MARKGATE_FIXTURE="$mg_fix" \
        PATH="$SHIM_DIR:$PATH" \
        printf '%s' "$payload" | \
        GH_FIXTURE="$gh_fix" MARKGATE_FIXTURE="$mg_fix" PATH="$SHIM_DIR:$PATH" "$HOOK" 2>&1)
  got=$?
  t1=$(date +%s)
  elapsed=$((t1 - t0))

  local time_ok=1
  if [ -n "$max_secs" ] && [ "$elapsed" -gt "$max_secs" ]; then time_ok=0; fi

  local live_now
  live_now="$(live_tree_state)"

  local gq_count gq_ok
  gq_count=$(grep -c . "$GRAPHQL_TRACE_FILE" 2>/dev/null | tr -d '[:space:]')
  case "$gq_count" in ''|*[!0-9]*) gq_count=0 ;; esac
  gq_ok=1
  case "$expect_graphql" in
    '')  ;;
    yes) [ "$gq_count" -ge 1 ] || gq_ok=0 ;;
    no)  [ "$gq_count" -eq 0 ] || gq_ok=0 ;;
    *)   if [ "$gq_count" -lt 1 ] || ! grep -qF -- "$expect_graphql" "$GRAPHQL_TRACE_FILE" 2>/dev/null; then
           gq_ok=0
         fi ;;
  esac

  local msg_ok=1
  if [ -n "$expect_msg" ]; then
    printf '%s' "$out" | grep -qF -- "$expect_msg" || msg_ok=0
  fi

  local tier_ok=1
  if [ -n "$expect_tier" ]; then
    printf '%s' "$out" | grep -qF -- "requires \`$expect_tier\` review" || tier_ok=0
  fi

  if [ "$got" = "$want" ] && [ "$live_now" = "$LIVE_BASELINE" ] && [ "$gq_ok" -eq 1 ] && [ "$tier_ok" -eq 1 ] && [ "$time_ok" -eq 1 ] && [ "$msg_ok" -eq 1 ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    if [ "$gq_ok" -eq 0 ]; then
      fail_log+="  graphql call: want '$expect_graphql', saw $gq_count call(s): $(tr '\n' '|' < "$GRAPHQL_TRACE_FILE" 2>/dev/null)\n"
    fi
    if [ "$msg_ok" -eq 0 ]; then
      fail_log+="  SILENT: output does not contain '$expect_msg'\n"
    fi
    if [ "$time_ok" -eq 0 ]; then
      fail_log+="  NOT BOUNDED: took ${elapsed}s, ceiling was ${max_secs}s\n"
    fi
    if [ "$tier_ok" -eq 0 ]; then
      fail_log+="  resolved tier: want '$expect_tier', message said: $(printf '%s' "$out" | head -1)\n"
    fi
    if [ "$live_now" != "$LIVE_BASELINE" ]; then
      fail_log+="  LIVE TREE MUTATED (issue #2336): $SCRIPT_REPO was '$LIVE_BASELINE', is now '$live_now'\n"
    fi
    fail_log+="  fixture: gh=$gh_fix mg=$mg_fix sentinel=$sentinel\n"
    fail_log+="  command: $command\n"
    fail_log+="  output : $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- Pass-through cases ------------------------------------------------

# 1. Non-merge command always passes through (no gh call needed).
run_case "git status passes" 0 \
  unused stale "" \
  "git status"

# 2. gh pr create is NOT gated.
run_case "gh pr create passes" 0 \
  unused stale "" \
  "gh pr create --title foo"

# 3. gh pr view is not gated.
run_case "gh pr view passes" 0 \
  unused stale "" \
  "gh pr view 42"

# --- Small / inline tier: always pass regardless of marker --------------

# 4. Small PR (200 LOC, 3 files) → inline tier → pass-through.
run_case "small PR (inline) passes regardless of marker" 0 \
  small stale "" \
  "gh pr merge 100"

# 4b. Lockfile-inflated PR (PR #1082 shape): 2784 raw LOC but only 37
# after subtracting root-level pnpm-lock.yaml churn → inline tier →
# pass-through even on a stale marker. Pins the auto-gen LOC exclusion
# (and its `(^|/)` anchoring for ROOT-level lockfiles).
run_case "lockfile-inflated PR (inline after exclusion) passes on stale marker" 0 \
  lockfile-inflated stale "" \
  "gh pr merge 1082"

# 4c. Auto-gen-inflated PR that still has fc >= 10: loc adjusts to 100
# but the file count alone keeps it 3-axis (fc is NOT adjusted) →
# block on stale marker.
run_case "autogen-inflated PR with fc>=10 still 3-axis → block on stale" 2 \
  autogen-inflated-manyfiles stale "" \
  "gh pr merge 404"

# --- Medium / 1-reviewer tier -----------------------------------------

# 5. Medium PR with fresh marker matching sha → pass.
run_case "medium PR + fresh marker + sha match → pass" 0 \
  medium fresh "med1234567890" \
  "gh pr merge 200"

# 6. Medium PR with stale marker → block.
run_case "medium PR + stale marker → block" 2 \
  medium stale "" \
  "gh pr merge 200"

# 7. Medium PR with fresh marker but WRONG sha → block.
run_case "medium PR + fresh marker + sha mismatch → block" 2 \
  medium fresh "stale1234567890" \
  "gh pr merge 200"

# --- Large / 3-axis tier ----------------------------------------------

# 8. Large PR with fresh marker matching sha → pass.
run_case "large PR + fresh marker + sha match → pass" 0 \
  large fresh "big1234567890" \
  "gh pr merge 300"

# 9. Large PR with stale marker → block.
run_case "large PR + stale marker → block" 2 \
  large stale "" \
  "gh pr merge 300"

# 10. Large PR with fresh marker but different sha (new push since
#     last review) → block.
run_case "large PR + fresh marker + sha mismatch → block" 2 \
  large fresh "old1234567890" \
  "gh pr merge 300"

# --- Bias factors -----------------------------------------------------

# 11. Docs+security: 200 LOC, 3 files, includes cognito-jwt.ts.
#     Base tier inline → up-bias → 1-reviewer → marker required.
#     With stale marker, expect block.
run_case "docs+security PR up-bias → block on stale" 2 \
  docs-with-security stale "" \
  "gh pr merge 400"

# 12. Same as above but with fresh+matching marker → pass.
run_case "docs+security PR up-bias + fresh marker → pass" 0 \
  docs-with-security fresh "sec1234567890" \
  "gh pr merge 400"

# 12-a. Security-surface up-bias for the paths issue #1972 added. Each is
#       inline by size and must be pushed to 1-reviewer by the path alone,
#       so a stale marker blocks. Before #1972 these three fired nothing:
#       the authorizer entry named a file deleted in PR #691, and the
#       sigv4 / docker-cmd primitives were never listed.
run_case "authorizer-resolver up-bias -> block on stale" 2 \
  authorizer-surface stale "" \
  "gh pr merge 401"

run_case "authorizer-cache up-bias -> block on stale" 2 \
  authorizer-cache-surface stale "" \
  "gh pr merge 402"

run_case "sigv4-verify up-bias -> block on stale" 2 \
  sigv4-surface stale "" \
  "gh pr merge 403"

run_case "docker-cmd up-bias -> block on stale" 2 \
  docker-cmd-surface stale "" \
  "gh pr merge 404"

# 12-b. The retired dead path must NOT up-bias. This is the negative arm
#       that keeps the fix honest: without it, re-adding a nonexistent
#       path to UP_PATH_REGEX would still pass every other case here.
run_case "retired lambda-authorizer path does NOT up-bias" 0 \
  dead-authorizer-path stale "" \
  "gh pr merge 405"

# 13. Tests-only large PR: 1500 LOC, 15 files, all under tests/.
#     Base = 3-axis → down-bias → 1-reviewer → still gated.
#     With stale marker, expect block (down-bias does NOT unblock).
run_case "tests-only large PR down-bias → still gated on stale" 2 \
  tests-only-large stale "" \
  "gh pr merge 500"

# 14. Tests-only large PR with fresh marker → pass.
run_case "tests-only large PR + fresh marker → pass" 0 \
  tests-only-large fresh "tst1234567890" \
  "gh pr merge 500"

# 14b. .claude/rules/-only large PR (PR #532 shape):
#      781 LOC, 11 files, all under .claude/rules/ + CLAUDE.md → base
#      3-axis → down-bias → 1-reviewer → still gated. Verifies the
#      `.claude/rules/.*` clause in DOWN_DOCS_REGEX (added in #533).
run_case ".claude/rules/-only large PR down-bias → still gated on stale" 2 \
  rules-only-large stale "" \
  "gh pr merge 532"

# 14c. Same PR with fresh+matching marker → pass.
run_case ".claude/rules/-only large PR + fresh marker → pass" 0 \
  rules-only-large fresh "rul1234567890" \
  "gh pr merge 532"

# --- Fix-back up-bias, rewrite-proof (issue #2638) ---------------------
#
# The fix-back arm had NO coverage before this block: every fixture above
# resolves to a branch that does not exist in the fixture repo, so the old
# `git rev-parse --verify origin/<branch>` guard skipped the whole check and
# the arm was inert in all 33 cases. All six below are inline by SIZE, so the
# exit code reports the bias and nothing else.

# 14d. The defect itself. The branch was flattened to one `fix(deploy):`
#      commit — the pre-#2638 arm sees at most 1 and never biases — while the
#      PR's timeline still names three distinct fix-back rounds. Inline by
#      size, so a block here IS the up-bias, and the graphql receipt proves
#      the count came from the timeline rather than from luck.
run_case "flattened branch: timeline restores the fix-back up-bias -> block" 2 \
  flattened-fixback stale "" \
  "gh pr merge 2634" yes

# 14e. Never rewritten, two distinct rounds still on the branch, and NO
#      `origin/<branch>` ref locally. Pins that the count no longer depends on
#      a local fetch: the pre-#2638 arm skipped this shape entirely.
run_case "two fix rounds from the PR's own commits (no local ref) -> block" 2 \
  two-fix-commits stale "" \
  "gh pr merge 2627" yes

# 14f. NEGATIVE ARM, and the one that keeps the fix honest. One round, amended
#      and force-pushed: two shas, ONE subject. Counting shas (or occurrences)
#      would up-bias a PR with a single fix-back round, which is over-firing on
#      the most routine operation in this repo.
run_case "amended fix-back (2 shas, 1 subject) does NOT up-bias" 0 \
  amended-fixback stale "" \
  "gh pr merge 2557" yes

# 14g. NEGATIVE ARM. A force-push with no `fix` subject anywhere. A history
#      rewrite is not by itself evidence of fix-back churn — without this the
#      cheap "was it force-pushed? then bias" reading would pass every case.
run_case "force-push with no fix-back subject does NOT up-bias" 0 \
  nofix-forcepush stale "" \
  "gh pr merge 2632" yes

# 14h. `gh api graphql` fails. The count falls back to the branch's own single
#      round -> no bias -> pass. Fail-open is never WEAKER than the pre-#2638
#      behaviour, and this case pins that it is not stronger either.
run_case "graphql failure falls back to the branch count (fail-open)" 0 \
  graphql-fails stale "" \
  "gh pr merge 2634" yes

# 14i / 14j. The query is SKIPPED when it cannot change the tier: already
#      3-axis with no down-bias to cancel, and a path trigger that already set
#      up_bias. Both still block on a stale marker — the receipt is what
#      separates "skipped" from "ran and did not matter".
run_case "3-axis PR skips the timeline query (cannot change the tier)" 2 \
  skip-3axis stale "" \
  "gh pr merge 2601" no

run_case "path up-bias already fired: timeline query skipped" 2 \
  skip-uppath stale "" \
  "gh pr merge 2593" no

# 14k. NEGATIVE ARM for the `-F key=@file` surface. A `url` whose owner starts
#      with `@` must not reach `gh api -F owner=...`; the charset guard refuses
#      it, the query is skipped, and the count falls back to the PR's commits
#      (one round) -> no bias -> pass.
run_case "hostile owner in the PR url: query refused, not issued" 0 \
  hostile-url stale "" \
  "gh pr merge 2634" no

# 14l. A GraphQL ERROR payload arrives with HTTP 200, so `gh` exits 0 and the
#      `|| tl_json=""` arm never runs — the jq filter is what has to cope.
run_case "malformed graphql body does not crash or over-count" 0 \
  graphql-malformed stale "" \
  "gh pr merge 2634" yes

# 14n. The fix-back bias CANCELS a down-bias. Base 3-axis, all-tests down-bias
#      would give 1-reviewer; two fix rounds put it back to 3-axis. BOTH tiers
#      exit 2, so the exit code cannot see this — the tier assertion can.
run_case "fix-back bias cancels the tests-only down-bias" 2 \
  fixback-vs-downbias stale "" \
  "gh pr merge 2570" yes 3-axis

# 14o. The query must name the right repository and PR. The shim answers any
#      argv, so without this the gate could query an unrelated PR and no case
#      would notice.
run_case "the timeline query names this PR's owner/repo/number" 2 \
  flattened-fixback stale "" \
  "gh pr merge 2634" "-F owner=go-to-k -F repo=cdkd -F number=2634" 1-reviewer

# 14p. A hanging TIMELINE query degrades to the commits-only count. Unbounded,
#      it would run into the harness's own 15s kill, which emits NO exit 2 —
#      the gate fails OPEN. The wall-clock ceiling is the assertion that matters:
#      both the bounded and the unbounded hook reach the same fallback COUNT, so
#      only elapsed time tells them apart.
run_case "a hanging timeline query is bounded, not left to the harness kill" 0 \
  slow-graphql stale "" \
  "gh pr merge 2634" yes "" 8

# 14p-bis. The hang SPAWNS A CHILD. `gh pr view` shells out to `git`, and a
#      bound that signals only the direct child leaves the grandchild holding
#      the caller's pipe — rc 124 at the bound while the caller waits the full
#      sleep, which is the harness kill and the fail-open all over again. Only a
#      process-GROUP kill closes it, and only a forking fixture can see that.
run_case "a hanging query that spawned a child is still bounded" 0 \
  slow-graphql-forks stale "" \
  "gh pr merge 2634" yes "" 8

# 14p-ter. A SIGNAL-killed `gh` must not look like success. `$? >> 8` is 0 for
#      a signal death, and the truncated JSON then parses to loc=0 / fc=0 ->
#      `inline` -> exit 0 with NOTHING on stderr. The exit code is 0 either way,
#      so only the message can tell a decision from a silent stumble.
run_case "a SIGKILLed gh pr view fails open LOUDLY, not silently" 0 \
  killed-midway stale "" \
  "gh pr merge 2634" no "" "" "allowing merge (infra fail-open)"

# 14q. A hanging PR LOOKUP fails CLOSED. This is the direction a naive bound
#      gets backwards: the tier cannot be computed without the stats, and the
#      generic infra fail-open would ALLOW the merge — so a bound would have
#      turned a correct block into a pass for any latency between the bound and
#      the harness kill.
run_case "a hanging gh pr view refuses the merge rather than allowing it" 2 \
  slow-prview stale "" \
  "gh pr merge 2634" no "" 8

# --- gh failure fail-open --------------------------------------------

# 15. gh failure → pass-through with debug warning.
run_case "gh pr view failure → pass-through (fail-open)" 0 \
  fail stale "" \
  "gh pr merge 999"

# --- gh pr merge --auto variant --------------------------------------

# 16. `gh pr merge --auto <N>` form matches.
run_case "gh pr merge --auto <N> + stale marker → block" 2 \
  medium stale "" \
  "gh pr merge --auto 600"

# 17. `gh pr merge <N> --auto` (number first) matches.
run_case "gh pr merge <N> --auto + stale marker → block" 2 \
  medium stale "" \
  "gh pr merge 700 --auto"

# 18. Command containing the bare word "merge" BEFORE the actual
#     `gh pr merge` in a single-line `;`-chain (typical: an inline
#     `# Wait + merge` comment in a multi-line Bash script, OR a
#     `git merge` / `npm run merge:foo` earlier in a `;`-chained
#     command).
#
#     Pre-issue #563 the matcher was `\bgh ... pr merge\b` (word-
#     boundary), so the line as a whole matched and the
#     `${cmd##*gh pr merge}` greedy-strip parser then landed on the
#     correct PR number. Post-#563 the matcher is line-start anchored
#     (per memory rule feedback_hook_command_match_line_start.md) to
#     eliminate quoted-body false-positives (the `gh issue create
#     --body "...gh pr merge..."` shape, see the Part C cases below).
#     Formerly an ACCEPTED FALSE-NEGATIVE: a chained `... ; gh pr merge`
#     fell through the matcher because the line started with `echo`, so
#     an un-reviewed PR could be merged by chaining the command.
#
#     Issue #1455 closed that. The verb is now matched in COMMAND
#     POSITION (line start OR after `&&` / `||` / `;` / `|`), so this
#     merge is blocked. The quoted-body false-positives the anchoring
#     originally guarded against are handled by stripping quoted spans
#     before matching — the Part C cases below still pass.
run_case "single-line chained gh pr merge after echo is now CAUGHT (#1455)" 2 \
  medium stale "" \
  "echo merge first; for i in 1 2 3; do echo loop; done; gh pr merge 800 --squash"

# --- CWD-AWARE cases (cdkd #559) ---------------------------------------
#
# Verify that the hook resolves the target git working tree from the
# payload's `cwd` field / `cd <path>` / `gh -C <path>` flag, and that
# the sentinel + markgate state are read from THAT worktree rather
# than always the main tree. Pre-#559 the hook landed in the main
# tree via `git rev-parse --git-common-dir`'s parent.
#
# Side worktree fixture: a fresh empty git repo with its own sentinel
# binding to the medium-fixture's `headRefOid` ("med1234567890").
# When the hook resolves to this side dir, the marker is fresh AND
# the sentinel matches → pass.
# (`CWD_TMP` and the single EXIT trap are set up at the top of the file —
# issue #2336. Do NOT install a second `trap ... EXIT` here: bash replaces
# rather than chains, so it would disarm `cleanup`.)
# A fixture repo carrying REAL `origin/` refs, for the history-floor case.
# Every other fixture resolves to a branch this repo does not have, which left
# the floor at `pr-review-gate.sh`'s `[ "$rewrite_fix_count" -gt "$fix_count" ]`
# with zero coverage: deleting it kept the whole suite green while a branch with
# two same-subject `fix:` commits went from blocked to allowed. The floor IS the
# "never weaker than the pre-#2638 hook" contract, so it gets its own arm.
#
# Two commits sharing ONE subject is the discriminating shape: distinct subjects
# = 1 (no bias on its own), branch history = 2 (bias). Only the floor keeps it.
FLOOR_REPO="$CWD_TMP/floor-worktree"
git init -q -b main "$FLOOR_REPO"
git -C "$FLOOR_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "feat(x): base"
git -C "$FLOOR_REPO" update-ref refs/remotes/origin/main HEAD
git -C "$FLOOR_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "fix(x): one and the same subject"
git -C "$FLOOR_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "fix(x): one and the same subject"
git -C "$FLOOR_REPO" update-ref refs/remotes/origin/fix/floor HEAD

CWD_SIDE_REPO="$CWD_TMP/side-worktree"
git init -q -b feature/x "$CWD_SIDE_REPO"
git -C "$CWD_SIDE_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
printf 'med1234567890' > "$CWD_SIDE_REPO/.markgate-pr-review-sha"

# Override run_case to take an explicit cwd. We define a parallel
# helper below to avoid touching every existing case's signature.
#
# Accepts an optional 7th arg, `expect_cwd`, that asserts the hook
# `cd`'d into the expected dir before invoking markgate (issue #563
# — closes the coverage gap the PR #562 reviewer flagged). Empty
# (or omitted) skips the cwd assertion — used for the markgate-fresh
# pass-through cases where the trace still gets written but the
# explicit assertion is unnecessary if the caller doesn't pass it.
run_case_cwd() {
  local name="$1"; local want="$2"; local gh_fix="$3"; local mg_fix="$4"; local cwd="$5"; local command="$6"; local expect_cwd="${7:-}"

  : > "$CWD_TRACE_FILE"
  local payload
  payload=$(printf '{"cwd":"%s","tool_input":{"command":"%s"}}' "$cwd" "$command")

  local got out
  out=$(GH_FIXTURE="$gh_fix" MARKGATE_FIXTURE="$mg_fix" \
        PATH="$SHIM_DIR:$PATH" \
        printf '%s' "$payload" | \
        GH_FIXTURE="$gh_fix" MARKGATE_FIXTURE="$mg_fix" PATH="$SHIM_DIR:$PATH" "$HOOK" 2>&1)
  got=$?

  local cwd_ok=1
  if [ -n "$expect_cwd" ]; then
    if ! grep -qFx "$expect_cwd" "$CWD_TRACE_FILE" 2>/dev/null; then
      cwd_ok=0
    fi
  fi

  local live_now
  live_now="$(live_tree_state)"

  if [ "$got" = "$want" ] && [ "$cwd_ok" -eq 1 ] && [ "$live_now" = "$LIVE_BASELINE" ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got"
    if [ "$live_now" != "$LIVE_BASELINE" ]; then
      fail_log+="; LIVE SENTINEL MUTATED (issue #2336): was '$LIVE_BASELINE', now '$live_now'"
    fi
    if [ "$cwd_ok" -eq 0 ]; then
      fail_log+="; cwd mismatch (want '$expect_cwd', trace: $(cat "$CWD_TRACE_FILE" 2>/dev/null | tr '\n' '|'))"
    fi
    fail_log+="\n  cwd: $cwd; command: $command\n"
    fail_log+="  output : $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# 19. cwd in side worktree + fresh marker (mocked) + sentinel binding
#     to PR head sha → pass. Proves the hook reads the SIDE worktree's
#     sentinel rather than always the main tree's. The 7th arg asserts
#     markgate was invoked from the SIDE worktree (issue #563).
run_case_cwd "side worktree cwd + fresh marker + sentinel match → pass" 0 \
  medium fresh "$CWD_SIDE_REPO" "gh pr merge 1000" "$CWD_SIDE_REPO"

# 19b. HISTORY FLOOR. The branch's own two `fix:` commits share a subject, so
#      the rewrite-proof count is 1 and only the floor reaches 2. Dropping the
#      floor flips this to exit 0 — measured; before this case it flipped
#      nothing and the suite stayed 45/45.
run_case_cwd "branch history floor keeps the bias when subjects collide" 2 \
  history-floor stale "$FLOOR_REPO" "gh pr merge 2601"

# 20. cwd in main tree + stale marker → block (sanity that the cwd
#     resolution doesn't break the existing path).
run_case_cwd "main tree cwd + stale marker → block" 2 \
  medium stale "$REPO_ROOT" "gh pr merge 1100" "$REPO_ROOT"

# 21. `cd <side> && gh pr merge` from main cwd routes to side → pass.
run_case_cwd "cd <side> && gh pr merge from main cwd → side wins" 0 \
  medium fresh "$REPO_ROOT" "cd $CWD_SIDE_REPO && gh pr merge 1200" "$CWD_SIDE_REPO"

# 22. `gh -C <side> pr merge` from main cwd routes to side → pass.
run_case_cwd "gh -C <side> pr merge from main cwd → side wins" 0 \
  medium fresh "$REPO_ROOT" "gh -C $CWD_SIDE_REPO pr merge 1300" "$CWD_SIDE_REPO"

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substring `gh pr merge`
# appears inside a quoted argument body of an unrelated command. Per
# memory rule feedback_hook_command_match_line_start.md, applied to
# pr-review-gate.sh in issue #563 (mirroring the PR #562 fix to
# check-gate.sh). Even with a large/3-axis-tier PR fixture, the
# quoted-body form must pass through because the matcher fires
# BEFORE the tier computation.

# 23. `gh issue create --body "...gh pr merge..."`: body mentions
#     `gh pr merge` but the line starts with `gh issue create`.
#     MUST pass through.
run_case "gh issue body quoting 'gh pr merge' passes (FP)" 0 \
  large stale "" \
  "gh issue create --body \"next step: gh pr merge --squash\""

# 24. `echo "...gh pr merge..."`: body mentions `gh pr merge` but
#     the command starts with `echo`. MUST pass through.
run_case "echo body quoting 'gh pr merge' passes (FP)" 0 \
  large stale "" \
  "echo \"after CI: gh pr merge 999 --auto\""

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
