#!/usr/bin/env bash
# unresolved-target-class.test.sh
#
# A CLASS-LEVEL fence for go-to-k/cdkd#2027, not a per-hook one.
#
# The defect was never one hook. Twenty-four gates each carried a hand-rolled
# copy of the same `-C <path>` scan, and every copy captured the raw token with
# no guard for an unexpanded `$VAR`. So the spelling this repo's own
# instructions hand people for worktree commits --
#
#     git -C "$W" add -A && git -C "$W" commit -F <file>
#
# -- resolved to the literal `<cwd>/$W`, failed the gate's own `git -C ...
# rev-parse` probe, and exited 0. The gate was weakest on exactly the path the
# documentation steers everyone onto. A second family did not bail but silently
# judged the PAYLOAD CWD instead, which passes a violation living in the target
# tree. A third shape, found by review rather than by this fence, was WIDER
# still: a hand-copied VERB regex with no quoted alternative for a flag value,
# so `git -C "/a b" commit` and `git -C "$(...)" commit` matched no verb at all
# and every blocking gate exited 0 on a fully determinate command.
#
# Per-hook cases are necessary and live in each gate's own suite. They are not
# sufficient: a hook WRITTEN NEXT MONTH reintroduces this the moment someone
# copies a scan from a neighbour. So the fences below take their population from
# what the hooks DECLARE -- the directory listing -- never from a hand-written
# list, and never from the defect itself (a hook that stops resolving `-C`
# altogether stays in the population and simply passes, rather than dropping out
# silently, which is how four earlier fences in this repo went inert).
#
# WHICH FENCE CATCHES WHICH CLASS -- read this before trusting a green run:
#
#   * fence 1 (static)  catches a hand-rolled `-C` scan being reintroduced.
#   * fence 2 (dynamic) catches a poisoned target actually being RESOLVED. It
#     CANNOT catch the matcher class: a gate that never fires calls no
#     `git -C` at all, so it satisfies "no poisoned resolution" VACUOUSLY.
#     Fence 2 going green says nothing about whether a gate still fires.
#   * fence 3 (paired)  is the only one that discriminates a gate that stopped
#     firing, because its control asserts the gate DOES block the literal
#     spelling before it asserts anything about the variable one.
#
# Run from the repo root: `bash .claude/hooks/unresolved-target-class.test.sh`.

set -u

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_GIT="$(command -v git)"

# `timeout` keeps one wedged hook from hanging the suite. It is not used
# elsewhere under .claude/hooks, so degrade to running without it rather than
# failing for a reason that has nothing to do with the property under test.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT="timeout 30"
else
  TIMEOUT=""
  echo "note: 'timeout' not found (brew install coreutils); running hooks unbounded"
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

pass=0
fail=0
fail_log=""
ok() { pass=$((pass + 1)); printf 'OK   %s\n' "$1"; }
ng() { fail=$((fail + 1)); fail_log+="FAIL $1\n"; printf 'FAIL %s\n' "$1"; }

# --- the population -----------------------------------------------------------
HOOKS=()
for f in "$HOOKS_DIR"/*.sh; do
  case "$f" in
    *.test.sh|*/run-tests.sh) continue ;;
  esac
  HOOKS+=("$f")
done

if [ "${#HOOKS[@]}" -ge 25 ]; then
  ok "population: ${#HOOKS[@]} hooks enumerated (floor 25)"
else
  ng "population: only ${#HOOKS[@]} hooks enumerated, expected >= 25 -- the enumeration is broken, every case below is vacuous"
fi

# =============================================================================
# FENCE 1 (static): no hook may hand-roll a `(git|gh) -C <path>` scan.
# =============================================================================
# Resolution belongs to lib/command-match.sh, the one place the `$`/backtick
# guard lives. The pattern below deliberately matches a FAMILY of spellings, not
# one byte-exact fragment: an earlier version keyed on a single capture form and
# 4 of 6 realistic variants walked straight past it.
handrolled_hit() { # <file> -> 0 when the file appears to parse `-C` itself
  # COMMENTS ARE STRIPPED FIRST. Every one of these hooks documents the `git -C
  # <path>` shape in prose, so a pattern loose enough to catch a real parse also
  # catches every explanation of one: the first draft of this fence flagged 30
  # of 38 hooks, including two that touch no command text at all.
  local body
  body=$(sed 's/^[[:space:]]*#.*$//' "$1")
  # `-C` followed by a POSIX character class, ANYWHERE in code. Requiring a `=~`
  # on the same line missed the grep form that integ-local-gate still carried
  # (`grep -qE '"'"'gh([[:space:]]+-C[[:space:]]+...'"'"'`), which is how fence 1
  # printed an OK line while two live hand-rolled copies sat in the tree
  # (go-to-k/cdkd#2027 review round 4). Nothing legitimate spells this: the one
  # place allowed to know the shape is lib/command-match.sh, which is not in the
  # population.
  printf '%s\n' "$body" | grep -qE -- '-C\[\[:(space|blank):\]\]' && return 0
  # The same test written with a literal space instead of a class.
  printf '%s\n' "$body" | grep -qE '=~.*[^[:alnum:]]-C[[:space:]]' && return 0
  # An extraction pipeline rather than a regex test.
  printf '%s\n' "$body" | grep -qE "(grep|sed|awk)[^|]*['\"][^'\"]*-C[[:space:]]" && return 0
  return 1
}

offenders=""
for h in "${HOOKS[@]}"; do
  if handrolled_hit "$h"; then
    offenders="$offenders $(basename "$h")"
  fi
done
if [ -z "$offenders" ]; then
  ok "fence 1: no hook matches any known hand-rolled '-C' spelling (NOT a proof it cannot be written another way -- see fence 3)"
else
  ng "fence 1: hand-rolled -C scan in:$offenders -- use gate_target_dir_strict (blocking) or gate_target_dir (detectors) instead"
fi

# GUARD THE GUARD, with VARIANTS. A grep that matches nothing looks exactly like
# a grep that found nothing wrong, and planting a copy of the very spelling the
# pattern was written against proves only that a string equals itself.
plant_dir="$TMPDIR/plants"; mkdir -p "$plant_dir"
cat > "$plant_dir/v1.sh" <<'PLANT'
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then target="${BASH_REMATCH[1]}"; fi
PLANT
cat > "$plant_dir/v2.sh" <<'PLANT'
if [[ "$cmd" =~ gh[[:blank:]]+-C[[:blank:]]+(\"?[^[:space:]]+) ]]; then target="${BASH_REMATCH[1]}"; fi
PLANT
cat > "$plant_dir/v3.sh" <<'PLANT'
target=$(printf '%s' "$cmd" | grep -oE 'git -C [^ ]+' | awk '{print $3}')
PLANT
cat > "$plant_dir/v4.sh" <<'PLANT'
if printf '%s' "$cmd" | grep -qE 'gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge'; then :; fi
PLANT
missed=""
for v in "$plant_dir"/v*.sh; do
  handrolled_hit "$v" || missed="$missed $(basename "$v")"
done
if [ -z "$missed" ]; then
  ok "fence 1 guard: all 4 planted VARIANTS are caught (not just the spelling the pattern was written from)"
else
  ng "fence 1 guard: planted variants missed:$missed -- fence 1 is narrower than it looks"
fi

# =============================================================================
# Shared fixtures for fences 2 and 3
# =============================================================================
# A VIOLATING target and a CLEAN cwd. This split is what makes the family of
# gates that judge CONTENT (rather than a marker) testable at all: with the
# violation staged in the `-C` target and nothing staged in the cwd, a gate can
# only block by looking where the command actually points. An earlier fixture
# staged nothing, so 11 of those gates never blocked the control, their pairs
# were skipped, and reverting a gate to the pre-fix defect left the fence green.
mk_repo() { # <dir>
  local d="$1"
  mkdir -p "$d/src/provisioning/providers" "$d/src/cli/commands" "$d/src/deployment" \
           "$d/src/types" "$d/docs/_generated" "$d/tests/integration/foo" \
           "$d/tests/unit/provisioning" "$d/.claude"
  "$REAL_GIT" init -q -b main "$d"
  : > "$d/docs/supported-resources.md"; : > "$d/docs/import.md"
  : > "$d/docs/integ-coverage.md"; : > "$d/docs/_generated/integ-coverage.json"
  echo "// base" > "$d/src/provisioning/register-providers.ts"
  echo "// base" > "$d/src/deployment/intrinsic-function-resolver.ts"
  echo "// base" > "$d/src/types/state.ts"
  echo one > "$d/f.txt"
  touch "$d/.markgate.yml"
  "$REAL_GIT" -C "$d" add -A >/dev/null 2>&1
  "$REAL_GIT" -C "$d" -c user.email=t@t -c user.name=t commit -q -m base
}
stage_violations() { # <dir>
  local d="$1"
  echo two > "$d/f.txt"
  echo "registry.register('AWS::Foo::Bar', new FooProvider());" >> "$d/src/provisioning/register-providers.ts"
  echo "  'AWS::Foo::Bar'," >> "$d/src/deployment/intrinsic-function-resolver.ts"
  echo "export class FooProvider {}" > "$d/src/provisioning/providers/foo-provider.ts"
  echo "export function register(cmd) { cmd.parse(process.argv); }" > "$d/src/cli/commands/foo.ts"
  printf '#!/usr/bin/env bash\ncdkd state destroy --force\n' > "$d/tests/integration/foo/run.sh"
  "$REAL_GIT" -C "$d" add -A >/dev/null 2>&1
}

viol="$TMPDIR/viol"; clean="$TMPDIR/clean"; viol_spaced="$TMPDIR/viol dir"
mk_repo "$viol"; mk_repo "$clean"; mk_repo "$viol_spaced"
stage_violations "$viol"; stage_violations "$viol_spaced"
"$REAL_GIT" -C "$clean" checkout -q -b feature/clean

SHIM="$TMPDIR/bin"; mkdir -p "$SHIM"
export GH_VIEW="$TMPDIR/v.json" GH_DIFF="$TMPDIR/d.txt" GH_CHECKS="$TMPDIR/c.tsv" GH_LIST="$TMPDIR/l.json"
printf '{"files":[{"path":"src/deployment/deploy-engine.ts"},{"path":"src/local/x.ts"},{"path":"src/types/state.ts"}],"additions":2000,"deletions":100,"changedFiles":30,"headRefOid":"abc123","headRefName":"feat/x"}' > "$GH_VIEW"
printf 'diff --git a/src/types/state.ts b/src/types/state.ts\n-  version: 1 | 2 | 3 | 4 | 5;\n+  version: 1 | 2 | 3 | 4 | 5 | 6;\n' > "$GH_DIFF"
printf 'check-build-test\tfail\t2m\thttps://x\n' > "$GH_CHECKS"
printf '[{"number":263,"mergedAt":"2026-05-11T03:00:00Z","headRefName":"main","title":"t"}]' > "$GH_LIST"
cat > "$SHIM/mise" <<'M'
#!/usr/bin/env bash
if [ "$1" = "exec" ] && [ "$2" = "--" ]; then shift 2; exec "$@"; fi
exit 1
M
cat > "$SHIM/markgate" <<'M'
#!/usr/bin/env bash
case "$1" in
  --version) echo 0.4.1; exit 0 ;;
  verify) exit 1 ;;
  status) printf 'key:        %s\nstate:      stale (digest differs)\n' "$2"; exit 0 ;;
esac
exit 1
M
# A `gh` shim is REQUIRED, not a nicety: without one, feeding `gh`-verb payloads
# to every hook lets the gh-backed gates make live GitHub calls from the suite.
cat > "$SHIM/gh" <<'M'
#!/usr/bin/env bash
mode=""
for a in "$@"; do case "$a" in view) mode=view;; diff) mode=diff;; checks) mode=checks;; list) mode=list;; esac; done
case "$mode" in
  view) cat "$GH_VIEW"; exit 0 ;;
  diff) cat "$GH_DIFF"; exit 0 ;;
  checks) cat "$GH_CHECKS"; exit 1 ;;
  list) cat "$GH_LIST"; exit 0 ;;
esac
exit 1
M
chmod +x "$SHIM"/*
export GH_BIN="$SHIM/gh"

json_payload() { # <cwd> <command>
  printf '{"cwd":"%s","tool_name":"Bash","session_id":"fence","tool_input":{"command":"%s"}}' \
    "$1" "$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# Every spelling a shell allows for a `-C` value that this parser CANNOT read.
# A `$VAR`-only list is what let the review find a wider hole than the fence:
# `$( )` and backticks are not variables, and a quoted path with a space is not
# unreadable at all -- it is fully determinate, and belongs in the must-BLOCK
# column rather than here.
POISON=(
  '"$W"'
  '$W'
  '"${WORKTREE}"'
  '"$(git rev-parse --show-toplevel)"'
  '$(git rev-parse --show-toplevel)'
  '`pwd`'
)

# =============================================================================
# FENCE 2 (dynamic): no hook may ever hand git a target it could not read.
# =============================================================================
TRACE="$TMPDIR/git-c-trace"; : > "$TRACE"
cat > "$SHIM/git" <<SHIM_EOF
#!/usr/bin/env bash
if [ "\$1" = "-C" ]; then printf '%s\t%s\n' "\${FENCE_HOOK:-?}" "\$2" >> "$TRACE"; fi
exec "$REAL_GIT" "\$@"
SHIM_EOF
chmod +x "$SHIM/git"

ATTACK_TEMPLATES=(
  'git -C @P@ commit -m x'
  'git -C @P@ add -A && git -C @P@ commit -F /tmp/msg'
  'git -C @P@ push origin HEAD'
  'git -C @P@ switch -c feat/x'
  'git -C @P@ merge origin/main'
  'git -C @P@ checkout -- f.txt'
  'gh -C @P@ pr merge 42 --squash'
  'gh -C @P@ pr create --title x'
  'cd @P@ && git commit -m x'
  'cd @P@ && gh pr merge 42 --squash'
)

for h in "${HOOKS[@]}"; do
  for tpl in "${ATTACK_TEMPLATES[@]}"; do
    for poison in "${POISON[@]}"; do
      atk="${tpl//@P@/$poison}"
      json_payload "$viol" "$atk" \
        | FENCE_HOOK="$(basename "$h")" PATH="$SHIM:$PATH" $TIMEOUT bash "$h" >/dev/null 2>&1
    done
  done
done

traced=$(wc -l < "$TRACE" | tr -d ' ')
if [ "$traced" -ge 10 ]; then
  ok "fence 2: git -C observed $traced times across the population (floor 10)"
else
  ng "fence 2: only $traced git -C calls observed -- the shim was not exercised, so the assertion below is vacuous"
fi

poisoned=$(awk -F'\t' '$2 ~ /[$`]/ {print}' "$TRACE" | sort -u)
if [ -z "$poisoned" ]; then
  ok "fence 2: no hook resolved a target containing an unexpanded \$ or backtick"
else
  ng "fence 2: resolved target(s) still carry an unreadable token:
$(printf '%s\n' "$poisoned" | head -8 | sed 's/^/      /')"
fi

# =============================================================================
# FENCE 3 (paired, self-calibrating): the only fence that sees a gate stop firing
# =============================================================================
# For every hook and every command: IF the gate blocks the plain literal
# spelling, THEN it must also (a) refuse every unreadable spelling and (b) still
# block the DETERMINATE-but-awkward one (a quoted path containing a space). The
# antecedent is the control, so no per-hook knowledge is encoded -- but a gate
# that stops firing makes its pairs vanish, which is what the per-hook baseline
# below turns into a failure instead of a silent skip.
CMD_TEMPLATES=(
  'git -C @T@ commit -m x'
  'git -C @T@ commit -m chore: x'
  'git -C @T@ commit -m docs: x'
  'git -C @T@ push origin HEAD'
  'git -C @T@ push -u origin'
  'git -C @T@ switch -c feat/x'
  'git -C @T@ merge origin/main'
  'git -C @T@ checkout -- f.txt'
  'gh -C @T@ pr merge 42 --squash'
  'gh -C @T@ pr merge 42 --auto'
  'gh -C @T@ pr create --title chore: x'
  'gh -C @T@ pr edit 42 --body x'
)

run_hook() { # <hook> <cwd> <cmd> -> exit code
  json_payload "$2" "$3" | PATH="$SHIM:$PATH" $TIMEOUT bash "$1" >/dev/null 2>&1
  return $?
}

exercised_list=""
leaks=""
space_leaks=""
for h in "${HOOKS[@]}"; do
  hb="$(basename "$h" .sh)"
  for tpl in "${CMD_TEMPLATES[@]}"; do
    lit="${tpl//@T@/$viol}"
    run_hook "$h" "$clean" "$lit"; [ $? -eq 2 ] || continue
    case " $exercised_list " in *" $hb "*) ;; *) exercised_list="$exercised_list $hb" ;; esac
    for poison in "${POISON[@]}"; do
      atk="${tpl//@T@/$poison}"
      run_hook "$h" "$clean" "$atk"
      [ $? -eq 0 ] && leaks="$leaks\n  $hb: blocks the literal target but PASSES  ${tpl//@T@/$poison}"
    done
    # A quoted path containing a space is LITERAL and DETERMINATE. It must still
    # block -- this is the review's blocker 1, where a hand-copied verb regex
    # with no quoted alternative made every gate miss it.
    spaced="${tpl//@T@/\"$viol_spaced\"}"
    run_hook "$h" "$clean" "$spaced"
    [ $? -eq 2 ] || space_leaks="$space_leaks\n  $hb: blocks '$lit' but NOT the same target quoted with a space"
  done
done

exercised_count=$(printf '%s' "$exercised_list" | wc -w | tr -d ' ')

# PER-HOOK baseline, recorded from measurement rather than predicted. An
# aggregate floor cannot say WHICH gate went quiet, and a floor set below the
# current value tolerates exactly the drop it exists to reveal: the previous
# `>= 6` against an actual 9 stayed green with check-gate AND branch-gate
# reduced to `exit 0`.
EXPECTED_EXERCISED="branch-gate check-gate ci-green-gate dirty-path-restore-gate gh-pr-edit-deprecation-gate integ-broad-gate integ-destroy-gate integ-local-gate integ-schema-migration-gate main-tree-branch-gate post-merge-orphan-push-gate pr-review-gate provider-docs-gate provider-integ-gate ref-segment-audit-gate state-destroy-force-gate verify-pr-gate"
missing=""
for want in $EXPECTED_EXERCISED; do
  case " $exercised_list " in *" $want "*) ;; *) missing="$missing $want" ;; esac
done
if [ -z "$missing" ]; then
  ok "fence 3: all 17 baseline hooks still block their literal control ($exercised_count exercised)"
else
  ng "fence 3: these gates no longer block ANY literal control -- they have gone quiet:$missing"
fi

if [ -z "$leaks" ]; then
  ok "fence 3: every gate that blocks a literal target refuses all 6 unreadable spellings"
else
  ng "fence 3: gates still fail open on an unreadable target:$(printf '%b' "$leaks")"
fi

if [ -z "$space_leaks" ]; then
  ok "fence 3: every such gate also blocks a quoted target path containing a space"
else
  ng "fence 3: gates miss a determinate quoted target path:$(printf '%b' "$space_leaks")"
fi

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
