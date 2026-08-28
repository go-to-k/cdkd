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
#
# DERIVED FROM REGISTRATION, not from the directory listing (go-to-k/cdkd#2156).
# "Every file under .claude/hooks" iterates the real population only by
# COINCIDENCE: it is right today because every hook happens to live there and
# nothing else does, and the first hook registered from anywhere else -- a
# plugin, a `lib/` helper promoted to a hook, a vendored copy -- drops out of
# the population silently, which is this file's own failure mode turned on
# itself. `.claude/settings.json` is the only authoritative statement of what IS
# a hook, which is the same reasoning markgate-gate-name-class.test.sh already
# applies to its candidate list.
#
# Both directions are checked, because either one alone is a hole: a registered
# hook whose FILE is missing would silently shrink the population, and a hook
# file nobody registered is dead code that must not be mistaken for coverage.
HOOKS=()
REGISTERED=$(python3 - "$HOOKS_DIR/../settings.json" <<'PY' 2>/dev/null
import json,sys,re
d=json.load(open(sys.argv[1]))
seen=[]
for entries in d.get('hooks',{}).values():
    for e in entries:
        for h in e.get('hooks',[]):
            c=(h.get('command') or '').strip()
            # A registration may be spelled bare -- `.claude/hooks/x.sh` --
            # or rooted at the project dir, which go-to-k/cdkd#2380 switched
            # every entry to on 2026-08-28:
            #   ${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/x.sh
            # Anchored at the string start alone this matched NOTHING from
            # that day on, the population went empty, and the `-z $REGISTERED`
            # guard below has failed this suite on main ever since -- unseen,
            # because hooks.yml is path-filtered to `.claude/hooks/**` and the
            # PR that broke it touched only `.claude/settings.json` (that
            # filter is widened in the same change as this line).
            # The optional prefix must be LAZY and end in `/`: a greedy one
            # eats through `.claude/hooks/` itself and the group never binds.
            m=re.match(r'^(?:[^\s]*?/)?(\.claude/hooks/[A-Za-z0-9._-]+\.sh)\b',c)
            if m and m.group(1) not in seen: seen.append(m.group(1))
print("\n".join(seen))
PY
)
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  HOOKS+=("$HOOKS_DIR/../../${rel}")
done <<REG_EOF
$REGISTERED
REG_EOF

# Bail BEFORE touching `${#HOOKS[@]}`. Under `set -u` bash 3.2 -- which
# run-tests.sh runs every suite under -- expanding an EMPTY array is an
# "unbound variable" abort, so an unreadable settings.json (or a missing
# python3) would end the suite with an error about array syntax instead of the
# ng below, and `run-tests.sh` only greps for a `fail: N` tally.
if [ -z "$REGISTERED" ]; then
  ng "population: no hooks could be read from .claude/settings.json -- every case below would be vacuous"
  printf '%b' "$fail_log"
  exit 1
fi

if [ "${#HOOKS[@]}" -ge 30 ]; then
  ok "population: ${#HOOKS[@]} hooks enumerated from .claude/settings.json (floor 30)"
else
  ng "population: only ${#HOOKS[@]} hooks enumerated from .claude/settings.json, expected >= 30 -- the enumeration is broken, every case below is vacuous"
fi

missing_file=""
for h in "${HOOKS[@]}"; do
  [ -f "$h" ] || missing_file="$missing_file $(basename "$h")"
done
if [ -z "$missing_file" ]; then
  ok "population: every registered hook file exists"
else
  ng "population: registered hook(s) with no file -- the population silently shrank:$missing_file"
fi

unregistered=""
for f in "$HOOKS_DIR"/*.sh; do
  case "$f" in
    *.test.sh|*/run-tests.sh) continue ;;
  esac
  case "
$REGISTERED
" in
    *"
.claude/hooks/$(basename "$f")
"*) ;;
    *) unregistered="$unregistered $(basename "$f")" ;;
  esac
done
if [ -z "$unregistered" ]; then
  ok "population: every hook file under .claude/hooks is registered"
else
  ng "population: hook file(s) present but NOT registered in .claude/settings.json -- they run never, so their coverage here would be fiction:$unregistered"
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
  : > "$d/README.md"
  touch "$d/.markgate.yml"
  "$REAL_GIT" -C "$d" add -A >/dev/null 2>&1
  "$REAL_GIT" -C "$d" -c user.email=t@t -c user.name=t commit -q -m base
}

# An `origin/main` ref, so a gate that asks what a BRANCH ships
# (`git diff origin/main...HEAD`) gets an answer instead of bailing. Applied
# ONLY to the no-src fixture, and that restriction is a MEASUREMENT, not
# tidiness: adding the ref to the primary fixture made `integ-destroy-gate` stop
# blocking every one of its literal controls (measured, rc=2 -> rc=0), because
# with HEAD == origin/main the branch ships nothing and the gate is correctly
# out of scope. A fixture change that silently empties the population is exactly
# what fence 3 exists to catch, and here it caught one in its own fixture.
# The ref alone is not enough: pr-title-prefix-scope-gate asks what the BRANCH
# ships (`git diff origin/main...HEAD`) and passes when that is EMPTY, so with
# `origin/main == HEAD` the control was vacuous (measured rc=0). One commit
# ahead of the ref, touching no `src/**` file, is what makes a `feat:` title
# actually refusable.
add_origin_ref() {
  "$REAL_GIT" -C "$1" update-ref refs/remotes/origin/main HEAD
  echo note > "$1/notes.md"
  "$REAL_GIT" -C "$1" add -A >/dev/null 2>&1
  "$REAL_GIT" -C "$1" -c user.email=t@t -c user.name=t commit -q -m "chore: ahead of main"
}
stage_violations() { # <dir>
  local d="$1"
  echo two > "$d/f.txt"
  echo "registry.register('AWS::Foo::Bar', new FooProvider());" >> "$d/src/provisioning/register-providers.ts"
  echo "  'AWS::Foo::Bar'," >> "$d/src/deployment/intrinsic-function-resolver.ts"
  # `readCurrentState` is load-bearing, not decoration: roundtrip-test-gate skips
  # any provider that does not capture an AWS-current snapshot, so without this
  # token the file staged a provider the gate had no opinion about and the gate
  # blocked nothing -- which is why it had no literal control (go-to-k/cdkd#2156).
  printf 'export class FooProvider { async readCurrentState() { return {}; } }\n' \
    > "$d/src/provisioning/providers/foo-provider.ts"
  echo "export function register(cmd) { cmd.parse(process.argv); }" > "$d/src/cli/commands/foo.ts"
  printf '#!/usr/bin/env bash\ncdkd state destroy --force\n' > "$d/tests/integration/foo/run.sh"
  # Three more staged violations, each unlocking a gate that had NO literal
  # control before and therefore sat outside fence 3 entirely
  # (go-to-k/cdkd#2156). They ride the same commit as the ones above because
  # each gate reads only its own file shape.
  #   cmd-parse-stub-gate     -- cmd.parse(...) in a test with no .action stub
  #   internal-pr-labels-gate -- a `(PR 8b)` label in user-facing prose
  #   bughunt-clean-gate      -- the LEGACY FLAT sentinel, which blocks a commit
  #                              for every caller regardless of owner, and lives
  #                              in the TARGET repo so a gate can only see it by
  #                              looking where the command actually points
  printf "cmd.parse(['node', 'x']);\n" > "$d/tests/unit/provisioning/foo.test.ts"
  printf 'See the note (PR 8b) for details.\n' > "$d/README.md"
  : > "$d/.markgate-bughunt-pending"
  echo "FooStack" > "$d/.markgate-bughunt-pending"
  "$REAL_GIT" -C "$d" add -A >/dev/null 2>&1
}

# A SECOND violating fixture that stages NO `src/**` file. Needed because
# commit-prefix-scope-gate blocks a `feat:` / `fix:` message exactly when no
# src file is staged, which is the direct COMPLEMENT of what the fixture above
# stages -- one tree cannot satisfy both, which is why that gate had no literal
# control and sat outside fence 3 (go-to-k/cdkd#2156).
stage_nosrc_violation() { # <dir>
  local d="$1"
  echo two > "$d/f.txt"
  "$REAL_GIT" -C "$d" add -A >/dev/null 2>&1
}

viol="$TMPDIR/viol"; clean="$TMPDIR/clean"; viol_spaced="$TMPDIR/viol dir"
nosrc="$TMPDIR/nosrc"; nosrc_spaced="$TMPDIR/nosrc dir"
mk_repo "$viol"; mk_repo "$clean"; mk_repo "$viol_spaced"
mk_repo "$nosrc"; mk_repo "$nosrc_spaced"
stage_violations "$viol"; stage_violations "$viol_spaced"
add_origin_ref "$nosrc"; add_origin_ref "$nosrc_spaced"
stage_nosrc_violation "$nosrc"; stage_nosrc_violation "$nosrc_spaced"
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
# A GLOB, a brace expansion and a `~user` prefix belong here for the same reason
# as a variable: the shell expands them and the command lands in a real repo,
# while this parser cannot say which one. They were missing until round 5, and
# the reverted "not a git repository" branch meant they exited 0
# (go-to-k/cdkd#2027 review round 5, minor 3). `~/` and a bare `~` are NOT
# poison -- HOME is expanded here correctly, and refusing them would be a false
# refusal, which is why the resolvable controls below still cover them.
POISON=(
  '"$W"'
  '$W'
  '"${WORKTREE}"'
  '"$(git rev-parse --show-toplevel)"'
  '$(git rev-parse --show-toplevel)'
  '`pwd`'
  '/tmp/wt/*/'
  '/tmp/{a,b}/wt'
  '~nobody/wt'
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
  # go-to-k/cdkd#2156: two more literal controls, each the only shape that makes
  # its gate block at all.
  'gh -C @T@ issue create --title x --label nope-not-a-real-label'
)

# Templates that only DISCRIMINATE against the no-src fixture: a `feat:` /
# `fix:` message with no `src/**` staged is exactly what commit-prefix-scope-gate
# refuses, and it is the complement of what the primary fixture stages.
# The message / title is QUOTED here, and that is a measurement rather than
# style: with a bare `-m feat: x` the value is the single token `feat:` and both
# prefix-scope gates read no subject at all, so they exited 0 and the control
# was vacuous. Measured: quoted blocks (rc=2), unquoted passes (rc=0).
NOSRC_TEMPLATES=(
  'git -C @T@ commit -m "feat: add x"'
  'git -C @T@ commit -m "fix: add x"'
  'gh -C @T@ pr create --title "feat: add x"'
)

run_hook() { # <hook> <cwd> <cmd> -> exit code
  json_payload "$2" "$3" | PATH="$SHIM:$PATH" $TIMEOUT bash "$1" >/dev/null 2>&1
  return $?
}

exercised_list=""
leaks=""
space_leaks=""
# <target> <spaced twin> <template...>. Two fixtures, because one tree cannot
# satisfy every gate at once: the second stages NO src file, which is the exact
# complement the prefix-scope gate needs (go-to-k/cdkd#2156).
sweep_pairs() {
  local tgt="$1" tgt_spaced="$2"; shift 2
  local h hb tpl lit poison atk spaced
  for h in "${HOOKS[@]}"; do
    hb="$(basename "$h" .sh)"
    for tpl in "$@"; do
      lit="${tpl//@T@/$tgt}"
      run_hook "$h" "$clean" "$lit"; [ $? -eq 2 ] || continue
      case " $exercised_list " in *" $hb "*) ;; *) exercised_list="$exercised_list $hb" ;; esac
      for poison in "${POISON[@]}"; do
        atk="${tpl//@T@/$poison}"
        run_hook "$h" "$clean" "$atk"
        [ $? -eq 0 ] && leaks="$leaks\n  $hb: blocks the literal target but PASSES  ${tpl//@T@/$poison}"
      done
      # A quoted path containing a space is LITERAL and DETERMINATE. It must
      # still block -- this is the review's blocker 1, where a hand-copied verb
      # regex with no quoted alternative made every gate miss it.
      spaced="${tpl//@T@/\"$tgt_spaced\"}"
      run_hook "$h" "$clean" "$spaced"
      [ $? -eq 2 ] || space_leaks="$space_leaks\n  $hb: blocks '$lit' but NOT the same target quoted with a space"
    done
  done
}
sweep_pairs "$viol" "$viol_spaced" "${CMD_TEMPLATES[@]}"
sweep_pairs "$nosrc" "$nosrc_spaced" "${NOSRC_TEMPLATES[@]}"

exercised_count=$(printf '%s' "$exercised_list" | wc -w | tr -d ' ')

# PER-HOOK baseline, recorded from measurement rather than predicted. An
# aggregate floor cannot say WHICH gate went quiet, and a floor set below the
# current value tolerates exactly the drop it exists to reveal: the previous
# `>= 6` against an actual 9 stayed green with check-gate AND branch-gate
# reduced to `exit 0`.
EXPECTED_EXERCISED="branch-gate bughunt-clean-gate check-gate ci-green-gate cmd-parse-stub-gate commit-prefix-scope-gate dirty-path-restore-gate gh-label-validity-gate gh-pr-edit-deprecation-gate integ-broad-gate integ-destroy-gate integ-local-gate integ-schema-migration-gate internal-pr-labels-gate issue-dup-check-gate main-tree-branch-gate post-merge-orphan-push-gate pr-review-gate pr-title-prefix-scope-gate provider-docs-gate provider-integ-gate ref-segment-audit-gate roundtrip-test-gate state-destroy-force-gate verify-pr-gate"
missing=""
for want in $EXPECTED_EXERCISED; do
  case " $exercised_list " in *" $want "*) ;; *) missing="$missing $want" ;; esac
done
if [ -z "$missing" ]; then
  ok "fence 3: all baseline hooks still block their literal control ($exercised_count exercised:$exercised_list)"
else
  ng "fence 3: these gates no longer block ANY literal control -- they have gone quiet:$missing"
fi

# --- the OTHER direction: every registered hook is exercised OR declared -----
#
# go-to-k/cdkd#2156. The baseline above only says "these 25 must not go quiet".
# On its own that lets a hook sit outside the fence forever, which is exactly
# where ten of them sat: the go-to-k/cdkd#2027 lane raised this population from
# 7 to 16, NAMED the remaining ten, and left them uncovered because no literal
# control could be constructed. Seven of those ten now have one -- the fixture
# above gained the staged shapes and the second no-src tree they each needed --
# and the three that remain are declared here WITH THE REASON, so the exclusion
# is a statement someone can disagree with rather than an absence nobody sees.
#
# The check is a partition: registered == exercised + declared. A new hook
# lands in NEITHER list and fails, which is the case a floor cannot catch.
DECLARED_UNEXERCISED="
closes-paren-form-gate            verdict is the PR BODY, not the target tree
commit-msg-heredoc-gate           verdict is the command SHAPE, target-independent
gated-command-preamble-gate       verdict is the command SHAPE, target-independent
gh-body-english-gate              verdict is the published BODY, not the target tree
integ-coverage-matrix-gate        needs the real repo toolchain (node + the regen script) in the target
issue-classification-label-gate   verdict is the published BODY, not the target tree
main-tree-dirty-detector          PostToolUse, non-blocking by design
main-tree-edit-gate               fires on a WRITE-shaped command, not a git/gh verb
main-tree-git-cwd-detector        PostToolUse, non-blocking by design
non-english-text-gate             verdict is the PR DIFF text, not the target tree
post-merge-sync-reminder          PostToolUse, non-blocking by design
pr-body-item-number-gate          verdict is the published BODY, not the target tree
restore-backup                    non-blocking by design (it snapshots, never refuses)
stop-unmerged-lane-warn           Stop hook, no command to gate
stop-warn                         Stop hook, no command to gate
vp-run-test-path-gate             gates a `vp` verb, not a git/gh one
worktree-owner-gate               Edit|Write|NotebookEdit matcher, no Bash command
"
unpartitioned=""
for h in "${HOOKS[@]}"; do
  hb="$(basename "$h" .sh)"
  case " $exercised_list " in *" $hb "*) continue ;; esac
  case "
$DECLARED_UNEXERCISED" in
    *"
$hb "*) continue ;;
  esac
  unpartitioned="$unpartitioned $hb"
done
if [ -z "$unpartitioned" ]; then
  ok "fence 3: every registered hook is either exercised by a literal control or declared unexercisable with a reason"
else
  ng "fence 3: registered hook(s) in NEITHER list -- they are outside the fence and nothing says why:$unpartitioned"
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

# ONE definition, used by both the guard-the-guard probes and the real scan,
# and it MUST stay above both. It was written out twice, so the probes validated
# a COPY of the predicate rather than the code that runs -- a guard-the-guard
# that guards a duplicate proves only that the duplicate works.
#
# De-duplicating it left the definition BELOW the real scan, and the result is
# worth stating plainly because it is this fence's own subject turned on itself:
# all 35 calls returned 127 (`command not found`), `&&` short-circuited, the
# `coupled` list stayed empty, and fence 4 printed OK. A fence written to catch
# inert gates was itself inert and reported green. `run-tests.sh` captures
# stderr but only greps for a `fail: N` tally, so the suite was rc=0 and the
# 35 `command not found` lines were invisible. The liveness check below is what
# makes that state loud instead.
#
# Indirections the collector must survive, all confirmed live against the
# earlier version: `printf -v re ...`; a variable copied through another
# (`a="$GATE_..."; b="$a"`); a command substitution (`re=$(pick)`); an indirect
# expansion (`name=GATE_RE_...; [[ $c =~ ${!name} ]]`); and an assignment
# sharing a line with a function opener (`setup() { re="$GATE_..."; }`), which
# a `^[[:space:]]*NAME=` anchor misses. The scan is deliberately generous here:
# a false positive is one comment away from being cleared, a false negative is
# a silently re-opened gate.
fence4_hazard() {
  local f="$1" gv m=0
  grep -qE '=~[^#]*\$\{?GATE_' "$f" && m=1
  if [ "$m" -eq 0 ]; then
    # Names assigned a GATE_ pattern, anywhere on a line, plus `printf -v`.
    for gv in $(
      { grep -oE '[A-Za-z_][A-Za-z0-9_]*=[^=]*\$\{?GATE_' "$f" | grep -oE '^[A-Za-z_][A-Za-z0-9_]*'
        grep -oE 'printf[[:space:]]+-v[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' "$f" | grep -oE '[A-Za-z_][A-Za-z0-9_]*$'
      } | sort -u
    ); do
      grep -qE "=~[[:space:]]*\"?\\\$\{?!?${gv}\}?\"?" "$f" && { m=1; break; }
      # A name copied into another name, one hop -- enough for the shapes seen.
      for gv2 in $(grep -oE "[A-Za-z_][A-Za-z0-9_]*=\"?\\\$\{?${gv}\}?\"?" "$f" | grep -oE '^[A-Za-z_][A-Za-z0-9_]*'); do
        grep -qE "=~[[:space:]]*\"?\\\$\{?!?${gv2}\}?\"?" "$f" && { m=1; break 2; }
      done
    done
  fi
  # An indirect expansion names its target as a plain STRING, so the collector
  # above cannot see it; catch the shape directly.
  if [ "$m" -eq 0 ] && grep -qE '=[[:space:]]*"?GATE_RE_[A-Z_]+' "$f" && grep -qE '=~[^#]*\$\{![A-Za-z_]' "$f"; then
    m=1
  fi
  [ "$m" -eq 1 ] || return 1
  grep -qE '\$\{BASH_REMATCH\[' "$f"
}

# --- fence 4: nobody indexes into a SHARED flag pattern by position ----------
#
# go-to-k/cdkd#2200. `GATE_FLAGS` had to be widened so a flag value containing a
# space (`git -c user.name="Jane Doe" commit`) stopped ending the flag loop
# mid-value -- an ungated commit straight to `main`, in every gate keyed on it.
# But widening a regex ADDS CAPTURE GROUPS, and two gates read the argument tail
# as a positional `BASH_REMATCH[N]` into that shared pattern. The first attempt
# shipped the widening alone: `dirty-path-restore-gate` silently stopped
# blocking `git checkout -- <dirty path>` in 7 of its 18 cases, and fence 3
# above reported it "gone quiet". Trading a `git -c` bypass for a
# `git checkout --` bypass is not a fix, so it was reverted.
#
# Both callers now strip the matched prefix by LENGTH (`gate_verb_rest` /
# `gate_pr_selector`), so the group count is internal to command-match.sh. This
# fence keeps it that way. It is deliberately a SOURCE scan rather than a
# behavioural one: the behavioural symptom is a gate going quiet, which fence 3
# already reports -- but only for the shapes it happens to exercise, and only
# AFTER someone has written the coupling. This catches the coupling itself, in a
# hook written next month by someone copying a neighbour.
#
# The population is the directory listing, never a hand-written list, for the
# reason stated at the top of this file.
if ! command -v fence4_hazard >/dev/null 2>&1; then
  ng "fence 4: fence4_hazard is not defined at the point the scan runs, so every call returns 127, \`&&\` short-circuits, and the fence reports OK over nothing. This exact state shipped once."
fi
coupled=""
scanned=0
for hook in "$HOOKS_DIR"/*.sh; do
  case "$(basename "$hook")" in *.test.sh) continue ;; esac
  # POPULATION: every hook that loads the shared matcher. Not "every hook that
  # currently embeds a GATE_ constant in a `=~`" -- that set is the DEFECT, and
  # taking the population from the defect is how a fence goes inert the moment
  # it succeeds. Measured while writing this: after the fix that subset is 1,
  # so a floor on it would be unreachable and a clean run would prove nothing.
  # A hook in the population that has no coupling simply passes.
  grep -q 'command-match.sh' "$hook" || continue
  scanned=$((scanned + 1))
  # HAZARD: this file builds its OWN match out of a shared constant, and then
  # reads a numbered group out of it. Either half alone is fine -- the `gate_*`
  # helpers take the pattern as an argument and index their own local patterns,
  # which no widening here can shift.
  # The hazard is: this file MATCHES a shared GATE_ pattern with `=~` itself,
  # and reads BASH_REMATCH by subscript. Both halves need care.
  #
  # On the match side, three spellings evaded earlier versions of this scan and
  # all three are real rather than hypothetical: the pattern inline on the `=~`
  # line; the pattern assigned to a variable on one line and matched on another
  # (`restore-backup.sh` already writes that assignment); and the same with the
  # variable quoted on the `=~`. So variables assigned from a GATE_ constant are
  # collected first, then looked for on an `=~`.
  #
  # But "mentions a GATE_ constant" alone is far too broad, and the difference
  # is not cosmetic: four hooks -- commit-prefix-scope-gate, integ-local-gate,
  # post-merge-orphan-push-gate, pr-title-prefix-scope-gate -- assign a
  # `GATE_RE_*` and pass it as an ARGUMENT to `gate_target_dir_strict`, never
  # matching it themselves, while indexing BASH_REMATCH out of their own local
  # patterns. Those are correct code. Flagging them would make a clean state
  # unreachable without an exemption list, and an exemption list is the thing
  # that rots.
  #
  # On the index side the subscript is not required to be a literal: an earlier
  # version demanded `[0-9]+` and `idx=4; ${BASH_REMATCH[$idx]}` walked past it.
  fence4_hazard "$hook" && coupled="$coupled\n    - $(basename "$hook")"
done

# Guard the guard. `coupled` being empty is the PASS condition, so an
# always-empty scan -- a broken grep, a bad path, a quoting slip -- reads as a
# clean repo. Fence 1 plants variants to prove it detects; this does the same,
# against a throwaway file carrying each evasion spelling.

probe_dir="$TMPDIR/fence4-probe"
mkdir -p "$probe_dir"
cat > "$probe_dir/inline.sh" <<'P1'
if [[ "$c" =~ git${GATE_FLAGS}[[:space:]]+checkout ]]; then x="${BASH_REMATCH[4]}"; fi
P1
cat > "$probe_dir/split.sh" <<'P2'
re="^git${GATE_FLAGS}[[:space:]]+checkout"
[[ "$c" =~ $re ]] && x="${BASH_REMATCH[4]}"
P2
cat > "$probe_dir/indirect.sh" <<'P3'
if [[ "$c" =~ git${GATE_GH_C}[[:space:]]+pr ]]; then idx=4; x="${BASH_REMATCH[$idx]}"; fi
P3
cat > "$probe_dir/quoted.sh" <<'P4'
re="^git${GATE_FLAGS}[[:space:]]+push"
if [[ "$c" =~ "$re" ]]; then x="${BASH_REMATCH[2]}"; fi
P4
# The two shapes that must stay CLEAR. `passthrough` is the real one: four hooks
# in this repo look exactly like it, and an over-broad scan flags them.
cat > "$probe_dir/clean.sh" <<'P5'
rest="$(gate_verb_rest "$c" "$GATE_RE_GIT_CHECKOUT")"
P5
cat > "$probe_dir/printfv.sh" <<'P7'
printf -v re '%s' "$GATE_RE_GIT_PUSH"
[[ "$c" =~ $re ]] && x="${BASH_REMATCH[2]}"
P7
cat > "$probe_dir/copied.sh" <<'P8'
a="$GATE_RE_GIT_PUSH"
b="$a"
[[ "$c" =~ $b ]] && x="${BASH_REMATCH[2]}"
P8
cat > "$probe_dir/indirect_name.sh" <<'P9'
name=GATE_RE_GIT_PUSH
[[ "$c" =~ ${!name} ]] && x="${BASH_REMATCH[2]}"
P9
cat > "$probe_dir/inline_fn.sh" <<'P10'
setup() { re="$GATE_RE_GIT_PUSH"; }
[[ "$c" =~ $re ]] && x="${BASH_REMATCH[2]}"
P10
cat > "$probe_dir/passthrough.sh" <<'P6'
__verb_ere="$GATE_RE_GIT_PUSH"
target=$(gate_target_dir_strict "$c" "$PWD" "$__verb_ere")
if [[ "$c" =~ [[:space:]]push([[:space:]]+(.*))?$ ]]; then a="${BASH_REMATCH[2]}"; fi
P6


undetected=""
for probe in inline split indirect quoted printfv copied indirect_name inline_fn; do
  fence4_hazard "$probe_dir/$probe.sh" || undetected="$undetected $probe"
done
false_positive=""
for probe in clean passthrough; do
  fence4_hazard "$probe_dir/$probe.sh" && false_positive="$false_positive $probe"
done
if [ -n "$undetected" ]; then
  ng "fence 4 (guard the guard): the scan does not detect these coupling spellings, so its clean verdict on the real hooks means nothing:$undetected"
elif [ -n "$false_positive" ]; then
  ng "fence 4 (guard the guard): the scan flags$false_positive, which pass a GATE_ pattern to a helper instead of matching it. Four real hooks look like this; flagging them makes a clean state unreachable without an exemption list."
else
  ok "fence 4 (guard the guard): the scan detects all 8 coupling spellings and clears both non-coupling ones"
fi

if [ "$scanned" -lt 20 ]; then
  ng "fence 4: only $scanned hooks load command-match.sh -- the scan is not seeing the hook directory, so a green result here would mean nothing"
elif [ -z "$coupled" ]; then
  ok "fence 4: none of the $scanned matcher-using hooks index a shared pattern positionally"
else
  ng "fence 4: these hooks read a positional BASH_REMATCH out of a match they built from a SHARED GATE_ constant, so widening that constant shifts their index and silently re-opens them (go-to-k/cdkd#2200):$(printf '%b' "$coupled")\n    Use gate_verb_rest / gate_pr_selector, which strip the matched prefix by LENGTH."
fi

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
