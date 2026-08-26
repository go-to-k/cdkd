#!/usr/bin/env bash
# markgate-gate-name-class.test.sh
#
# A CLASS-LEVEL fence for go-to-k/cdkd#2198.
#
# Every per-hook suite for a markgate-backed gate asserted an EXIT CODE, and a
# few asserted the cwd markgate ran in. None asserted the QUESTION the gate
# asked. Measured 2026-08-25 by rewriting each hook's `markgate verify <gate>`
# to `verify BOGUS-GATE` and running that hook's own suite:
#
#     verify-pr-gate      Pass: 22  Fail: 0
#     check-gate          Pass: 33  Fail: 0
#     integ-destroy-gate  Pass: 20  Fail: 0
#     integ-broad-gate    24 pass, 0 fail
#
# The verify-pr case is not theoretical. Swapping `verify verify-pr` for
# `verify check` makes that gate pass whenever `/check` alone is fresh -- it
# merges a PR whose `/verify-pr` checklist never ran -- and its suite stayed
# green. A gate pointed at the wrong marker is indistinguishable, from the
# outside, from a gate working correctly: same exit codes, same messages, same
# cwd. Only the argv separates them.
#
# WHY THE POPULATION IS DERIVED FROM BEHAVIOUR
#
# Not from the hook text, in any spelling. All three textual predicates were
# tried on origin/main and all three are wrong:
#
#   - `grep -l 'markgate verify'` matches 4 of the 8, and EVERY hit is a comment
#     or a message string rather than a live call site. Gates invoke the binary as
#     `"${markgate[@]}" verify <gate>`, and `stop-warn.sh` builds that array as
#     `markgate=(markgate)` or `markgate=(mise exec -- markgate)`, so no literal
#     `markgate verify` appears on any line of it.
#   - `grep -l markgate` finds 20, because almost every gate reads
#     `.markgate.yml` for the repo opt-in check. Those verify nothing.
#   - Stripping comments first does NOT exclude `main-tree-git-cwd-detector.sh`:
#     it carries `markgate[[:space:]]+(set|verify)` inside a REGEX STRING, since
#     detecting markgate commands is its job. That is live code.
#
# So the CANDIDATE list comes from `.claude/settings.json` -- what the repo
# DECLARES as a hook, which is the only authoritative statement of it -- and
# each candidate is then RUN under a markgate shim that records its argv. The
# ones that actually invoke `verify` are the population.
#
# The directory listing is NOT the candidate list, and that is not a style
# choice: `.claude/hooks/run-tests.sh` is the aggregate suite RUNNER, so driving
# it re-runs every suite in the repo, once per probe payload. A first version of
# this file did exactly that and had to be killed after twenty minutes.
# settings.json excludes it for free, because it is not a hook.
#
# A grep can drift away from the code; an execution cannot. This also means a
# hook that STOPS calling markgate does not silently drop out of the population
# -- it fails the table cross-check below, which is the failure mode four
# earlier fences in this repo died of.
#
# WHAT EACH FENCE CATCHES -- read this before trusting a green run:
#
#   fence 1  every hook in the table asks about the gate the table names.
#            Catches a gate repointed at another marker.
#   fence 2  the table and the observed population agree in BOTH directions.
#            Catches a new markgate-backed hook added with no table entry, and
#            a table entry for a hook that no longer verifies anything.
# The matcher accepts `status` as well as `verify`, but NOT for the reason an
# earlier version of this comment gave. It claimed `check-gate` asks its
# question with `markgate status <gate>` and that a `verify`-only fence reports
# it as reaching nothing. That is false: `check-gate.sh` asks with
# `verify check` / `verify docs`, and its `status` call (`gate_reason`) runs
# only AFTER a verify returns non-zero, to pull the parenthesised staleness
# reason into the refusal. The shim's default `MG_VERDICT=fresh` never produces
# that, so the `status` arm has never executed here -- re-keying both matchers
# to `^verify` alone leaves the file 3/3 green.
#
# What actually made `check-gate` unreachable was the `--version` probe below,
# and the two were conflated. The `status` alternative stays because that call
# IS live in production (a stale marker reaches it) and a future probe may drive
# a stale verdict; it is kept as coverage, not as an explanation.
#
#   fence 3  the probes actually REACH the markgate call. Four gates scope-check
#            the PR diff first and return before verifying anything; a fence
#            that never reaches the call would report green over nothing.

set -u

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HOOKS_DIR/../.." && pwd)"

TMPDIR_T="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_T"' EXIT

pass=0
fail=0
fail_log=""
ok() { pass=$((pass + 1)); printf 'OK   %s\n' "$1"; }
ng() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; fail_log="$fail_log\nFAIL $1"; }

# --- fixture repo -----------------------------------------------------------
REPO="$TMPDIR_T/repo"
git init -q -b feat/lane "$REPO"
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
# Repo opt-in: every one of these gates is scoped to repos carrying a
# `.markgate.yml`, so without this the whole suite passes through untested.
touch "$REPO/.markgate.yml"

# `stop-warn` resolves its repo from `${BASH_SOURCE[0]}` -- its OWN checkout --
# not from the payload, and exits 0 when that repo has no uncommitted changes.
# So its reachability depended on whether the developer's tree happened to be
# dirty: locally it reached markgate, on a clean CI checkout it did not, and the
# suite reported the gate as verifying nothing. That is the fence asserting the
# ENVIRONMENT rather than the code, which is the failure this whole file exists
# to catch. A COPY of the hook in a fixture repo makes `$REPO` the fixture, and
# the fixture is dirty by construction.
STOP_REPO="$TMPDIR_T/stop-repo"
mkdir -p "$STOP_REPO/.claude/hooks"
git init -q -b feat/lane "$STOP_REPO"
git -C "$STOP_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
touch "$STOP_REPO/.markgate.yml"
cp "$HOOKS_DIR/stop-warn.sh" "$STOP_REPO/.claude/hooks/stop-warn.sh"
printf 'uncommitted\n' > "$STOP_REPO/dirty.txt"
git -C "$STOP_REPO" add dirty.txt
printf 'changed\n' >> "$STOP_REPO/dirty.txt"

# --- shims ------------------------------------------------------------------
SHIM="$TMPDIR_T/bin"
mkdir -p "$SHIM"
MG_ARGS="$TMPDIR_T/mg-args"

cat > "$SHIM/markgate" <<MG_EOF
#!/usr/bin/env bash
echo "\$*" >> "$MG_ARGS"
# 'fresh' by default so a gate that consults the marker CONTINUES rather than
# refusing on the first call; a gate that stops early tells us nothing about
# which later gate it would have asked about.
case "\$1" in
  --version|version) echo 'markgate 0.4.1'; exit 0 ;;
  verify) [ "\${MG_VERDICT:-fresh}" = fresh ] && exit 0; exit 1 ;;
  status)
    if [ "\${MG_VERDICT:-fresh}" = fresh ]; then
      printf 'key:        %s\nstate:      match\n' "\$2"
    else
      printf 'key:        %s\nstate:      stale (digest differs)\n' "\$2"
    fi
    exit 0 ;;
esac
exit 1
MG_EOF

cat > "$SHIM/mise" <<'MISE_EOF'
#!/usr/bin/env bash
if [ "$1" = "exec" ] && [ "$2" = "--" ]; then
  shift 2
  exec "$@"
fi
exit 1
MISE_EOF

# `gh` returns whatever the case under test put in GH_FILES / GH_JSON. Four of
# these gates read the PR diff and return BEFORE touching markgate when the diff
# is out of their scope, so a generic stub makes them look like they verify
# nothing at all -- which is exactly the mis-derived population fence 2 exists
# to refuse.
cat > "$SHIM/gh" <<'GH_EOF'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *"pr diff"*"--name-only"*) printf '%s\n' ${GH_FILES:-} ; exit 0 ;;
  *"pr diff"*)               printf '%s\n' "${GH_DIFF:-}" ; exit 0 ;;
  *"pr view"*"--json"*)      printf '%s\n' "${GH_JSON:-{\}}" ; exit 0 ;;
  *"pr checks"*)             printf 'check\tpass\t1s\thttps://x\n' ; exit 0 ;;
  *"auth status"*)           exit 0 ;;
  *"--json"*)                printf '%s\n' "${GH_JSON:-{\}}" ; exit 0 ;;
esac
exit 0
GH_EOF
chmod +x "$SHIM"/*
export PATH="$SHIM:$PATH"

# --- the hook -> gate table -------------------------------------------------
#
# Hand-declared on purpose: the whole point is to pin what each gate SHOULD ask
# about, so deriving it from what the gate currently asks would assert nothing.
# Fence 2 cross-checks it against the observed population in both directions.
#
# Columns: hook | expected gate name(s), space-separated | probe verb key
TABLE="
check-gate|check docs|commit
verify-pr-gate|verify-pr|prcreate
integ-destroy-gate|integ-destroy|prmerge-destroy
integ-broad-gate|integ-broad|prmerge-broad
integ-local-gate|integ-local|prmerge-local
integ-schema-migration-gate|integ-schema-migration|prmerge-schema
pr-review-gate|pr-review|prmerge-review
stop-warn|check|stop
"

# Hooks that reference markgate but verify nothing, with the reason. Fence 2
# consults this so a deliberate non-verifier does not have to be a table entry.
# `main-tree-git-cwd-detector` carries `markgate[[:space:]]+(set|verify)` inside
# a REGEX -- detecting markgate commands is its job -- so it must never be
# expected to verify one itself. `gated-command-preamble-gate` is the same
# class: it matches `markgate[[:space:]]+set` to recognise a preamble whose loss
# would be SILENT, and verifies no gate of its own.
NON_VERIFIERS="main-tree-git-cwd-detector gated-command-preamble-gate"

payload_for() {
  local key="$1" cmd
  case "$key" in
    commit)         cmd='git commit -m x' ;;
    prcreate)       cmd='gh pr create --title t --body b' ;;
    prmerge-*)      cmd='gh pr merge 1 --squash' ;;
    # `stop-warn` is a Stop hook: no tool_input at all, so every verb payload
    # above leaves it untouched and it would look like a non-verifier.
    stop)           printf '{"cwd":"%s","stop_hook_active":false}' "$REPO"; return 0 ;;
    *)              cmd='git commit -m x' ;;
  esac
  printf '{"cwd":"%s","tool_input":{"command":"%s"}}' "$REPO" "$cmd"
}

# Per-gate PR diff, so the scope check ahead of the markgate call passes.
scope_env_for() {
  case "$1" in
    prmerge-destroy) printf 'src/provisioning/providers/s3-bucket-provider.ts' ;;
    prmerge-broad)   printf 'src/deployment/deploy-engine.ts' ;;
    prmerge-local)   printf 'src/local/docker-runner.ts' ;;
    prmerge-schema)  printf 'src/types/state.ts' ;;
    prmerge-review)  printf 'src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts src/g.ts src/h.ts src/i.ts src/j.ts' ;;
    *)               printf '' ;;
  esac
}

# The gates read their scope from `gh pr view --json files`, NOT from
# `gh pr diff --name-only`, so the per-probe scope has to live HERE. A generic
# `files` array made four gates decide the PR was out of scope and return before
# touching markgate -- which fence 3 reported rather than passing over.
json_for() {
  local files_json="" f
  for f in $(scope_env_for "$1"); do
    files_json="$files_json{\"path\":\"$f\"},"
  done
  case "$1" in
    # >= 10 changed files forces pr-review-gate to the 3-axis tier, so it
    # consults its marker instead of passing the PR through as `inline`.
    prmerge-review) printf '{"additions":2000,"deletions":100,"changedFiles":12,"headRefOid":"deadbeef","headRefName":"feat/lane","files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"},{"path":"src/d.ts"},{"path":"src/e.ts"},{"path":"src/f.ts"},{"path":"src/g.ts"},{"path":"src/h.ts"},{"path":"src/i.ts"},{"path":"src/j.ts"},{"path":"src/k.ts"},{"path":"src/l.ts"}]}' ;;
    *)              printf '{"headRefOid":"deadbeef","headRefName":"feat/lane","state":"OPEN","mergeStateStatus":"CLEAN","additions":10,"deletions":1,"changedFiles":1,"files":[%s{"path":"src/a.ts"}]}' "$files_json" ;;
  esac
}

# Which copy of the hook to run. Only `stop-warn` differs, and only because it
# reads its OWN checkout rather than the payload -- see the fixture above.
hook_path_for() {
  case "$1" in
    stop-warn) printf '%s' "$STOP_REPO/.claude/hooks/stop-warn.sh" ;;
    *)         printf '%s' "$HOOKS_DIR/$1.sh" ;;
  esac
}

# drive <hook-basename> <probe-key> -> writes argv lines to $MG_ARGS
drive() {
  local hook="$1" key="$2"
  : > "$MG_ARGS"
  GH_FILES="$(scope_env_for "$key")" \
  GH_JSON="$(json_for "$key")" \
  GH_DIFF="+ // a diff line" \
    payload_for "$key" | true
  # The schema gate does not grep the diff as flat text -- it splits it into
  # per-FILE hunks and greps the payload of the `src/types/state.ts` one. A
  # bare `+ version: ...` line with no `diff --git` header therefore belongs to
  # no file and matches nothing, which reads as "this PR is not a schema bump".
  local diff_body="diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
+// x"
  [ "$key" = prmerge-schema ] && diff_body="diff --git a/src/types/state.ts b/src/types/state.ts
--- a/src/types/state.ts
+++ b/src/types/state.ts
@@ -1,4 +1,4 @@
-  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
+  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
-export const STATE_SCHEMA_VERSION = 8;
+export const STATE_SCHEMA_VERSION = 9;"
  GH_FILES="$(scope_env_for "$key")" GH_JSON="$(json_for "$key")" GH_DIFF="$diff_body" \
    bash -c 'payload="$1"; printf "%s" "$payload" | "$2"' _ "$(payload_for "$key")" "$(hook_path_for "$hook")" \
    >/dev/null 2>&1
}

# --- fence 3 (run first: it decides whether 1 and 2 mean anything) -----------
unreached=""
declared=0
while IFS='|' read -r hook gates key; do
  [ -n "$hook" ] || continue
  declared=$((declared + 1))
  drive "$hook" "$key"
  if ! grep -qE '^(verify|status)' "$MG_ARGS" 2>/dev/null; then
    unreached="$unreached\n    - $hook (probe: $key)"
  fi
done <<< "$(printf '%s' "$TABLE" | sed '/^$/d')"

if [ "$declared" -lt 8 ]; then
  ng "fence 3: the table declares only $declared hooks; it is not being read, so fences 1 and 2 mean nothing"
elif [ -n "$unreached" ]; then
  ng "fence 3: these hooks never reached their markgate call, so nothing below asserts anything about them:$(printf '%b' "$unreached")\n    Usually the gate scope-checks the PR diff first -- give its probe an in-scope file in scope_env_for()."
else
  ok "fence 3: all $declared declared hooks reach their markgate call under their probe"
fi

# --- fence 1: each hook asks about the gate the table names -----------------
wrong=""
while IFS='|' read -r hook gates key; do
  [ -n "$hook" ] || continue
  drive "$hook" "$key"
  # `sed -E`, not BRE: `\|` alternation is a GNU extension, so on macOS the
  # substitution silently matched nothing and EVERY hook reported "asked about
  # []" -- which is indistinguishable from a gate that asks about nothing at
  # all. The fence was reporting its own broken instrument as a total failure
  # of the subject.
  asked="$(sed -nE 's/^(verify|status) (--[^ ]* )*//p' "$MG_ARGS" 2>/dev/null | tr '\n' ' ')"
  for want in $gates; do
    case " $asked " in
      *" $want "*) ;;
      *) wrong="$wrong\n    - $hook asked about [${asked% }] but the table says it must verify '$want'" ;;
    esac
  done
  # And nothing BEYOND the table. Subset-only was the whole assertion until
  # review: adding `verify check` ALONGSIDE `verify verify-pr` in
  # verify-pr-gate.sh left the file 3/3 green, so a gate that ACQUIRES a second
  # marker -- `verify integ-destroy || verify check`, the shape that turns a
  # specific gate into a permissive one -- was unfenced. Only replacement was
  # caught.
  for got in $asked; do
    case " $gates " in
      *" $got "*) ;;
      *) wrong="$wrong\n    - $hook ALSO asked about '$got', which the table does not list. A gate that acquires a second marker passes whenever EITHER is fresh." ;;
    esac
  done
done <<< "$(printf '%s' "$TABLE" | sed '/^$/d')"

if [ -z "$wrong" ]; then
  ok "fence 1: every declared hook verifies the gate the table names"
else
  ng "fence 1: a gate is pointed at the wrong marker. Exit codes, messages and cwd are IDENTICAL when this happens, so only this assertion separates the two:$(printf '%b' "$wrong")"
fi

# --- fence 2: table and observed population agree, both directions ----------
observed=""
# The candidate list, computed ONCE: every hook `.claude/settings.json`
# declares. Both halves of fence 2 read it, so they cannot drift apart.
CANDIDATES=$(python3 -c '
import json, re, sys
d = json.load(open(sys.argv[1]))
names = sorted(set(re.findall(r"\.claude/hooks/([a-z0-9-]+)\.sh", json.dumps(d))))
print(" ".join(names))
' "$REPO_ROOT/.claude/settings.json")
if [ "$(printf '%s' "$CANDIDATES" | wc -w | tr -d ' ')" -lt 20 ]; then
  ng "fence 2: settings.json yielded only $(printf '%s' "$CANDIDATES" | wc -w | tr -d ' ') hook candidates; the parse is broken, so every comparison below is vacuous"
fi

for base in $CANDIDATES; do
  [ -f "$HOOKS_DIR/$base.sh" ] || continue
  # Drive with EVERY probe key, since a hook only reveals itself under a payload
  # whose verb it gates.
  for key in commit prcreate prmerge-destroy prmerge-broad prmerge-local prmerge-schema prmerge-review stop; do
    drive "$base" "$key"
    if grep -qE '^(verify|status)' "$MG_ARGS" 2>/dev/null; then
      case " $observed " in *" $base "*) ;; *) observed="$observed $base" ;; esac
      break
    fi
  done
done

table_hooks="$(printf '%s' "$TABLE" | sed '/^$/d' | cut -d'|' -f1 | tr '\n' ' ')"
missing_from_table=""
for o in $observed; do
  case " $table_hooks " in *" $o "*) continue ;; esac
  case " $NON_VERIFIERS " in *" $o "*) continue ;; esac
  missing_from_table="$missing_from_table\n    - $o verifies a marker but has no table entry"
done
# Behaviour gives the PRECISE population, but only for verbs the probe set
# carries. A hook gated on any other verb is invisible to it: review planted a
# `zz-fake-gate` verifying `zz-marker` behind `git push`, registered it in
# settings.json, and the file stayed 3/3 -- the third time a population in this
# repo has been narrower than its own claim, all three in the green direction.
#
# So the completeness half takes a conservative OVER-APPROXIMATION from the
# text: any candidate whose source mentions `markgate` at all MIGHT verify one,
# and must therefore be accounted for -- in the table, in NON_VERIFIERS, or by
# having been observed. The grep is useless as a population (it finds 20 hooks,
# almost all of them only reading `.markgate.yml`) and exactly right as a
# net that must not have holes. Over-approximate the trigger, be strict on the
# resolution: the same rule `.claude/rules/hooks.md` states for the gates.
mentions_markgate=""
for base in $CANDIDATES; do
  [ -f "$HOOKS_DIR/$base.sh" ] || continue
  # Strip COMMENTS and the two SENTINEL filenames before looking. Neither is a
  # refinement: `.markgate.yml` is the repo opt-in check that almost every gate
  # does, `.markgate-*` are the broad-integ / pr-review sentinels, and a comment
  # is prose. Without the strip the net catches 20 hooks and then 17; with it,
  # exactly 10 -- the 8 in the table plus the two declared non-verifiers, which
  # is the net having no holes AND no slack. (This count is PROSE and goes stale
  # silently; the assertions below are floors, so update it when NON_VERIFIERS
  # or the table changes.)
  sed -e 's/#.*//' -e 's/\.markgate\.yml//g' -e 's/\.markgate-[A-Za-z0-9-]*//g' \
      "$HOOKS_DIR/$base.sh" | grep -q 'markgate' || continue
  case " $table_hooks " in *" $base "*) continue ;; esac
  case " $NON_VERIFIERS " in *" $base "*) continue ;; esac
  case " $observed " in *" $base "*) continue ;; esac
  mentions_markgate="$mentions_markgate\n    - $base mentions markgate, is not in the table, is not declared a non-verifier, and no probe reached it"
done

stale_in_table=""
for t in $table_hooks; do
  case " $observed " in *" $t "*) ;; *) stale_in_table="$stale_in_table\n    - $t is in the table but never verified anything" ;; esac
done

observed_count=0
for _o in $observed; do observed_count=$((observed_count + 1)); done
if [ "$observed_count" -lt 8 ]; then
  ng "fence 2: only $observed_count hooks were observed verifying a marker; the drive harness is not reaching them, so this comparison is vacuous"
elif [ -z "$missing_from_table$stale_in_table$mentions_markgate" ]; then
  ok "fence 2: the table and the $observed_count observed markgate callers agree in both directions"
else
  ng "fence 2: the table and the observed markgate callers disagree:$(printf '%b' "$missing_from_table$stale_in_table$mentions_markgate")"
fi

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b\n' "$fail_log"
  exit 1
fi
