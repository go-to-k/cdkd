#!/usr/bin/env bash
# markgate-gate-name-class.test.sh
#
# A CLASS-LEVEL fence for go-to-k/cdkd#2198.
#
# Every per-hook suite for a markgate-backed gate asserted an EXIT CODE, and a
# few asserted the cwd markgate ran in. None asserted the QUESTION the gate
# asked. Measured 2026-08-25 by rewriting each hook's `markgate verify <gate>`
# to `verify BOGUS-GATE` and running that hook's own suite: every one stayed
# GREEN, `integ-destroy-gate` at 20/20 among them.
#
# The class is not theoretical. A gate swapped onto another repo-wide marker
# passes whenever THAT marker is fresh -- it merges a PR whose own verification
# never ran -- and its own suite stays green. A gate pointed at the wrong marker
# is indistinguishable, from the outside, from a gate working correctly: same
# exit codes, same messages, same cwd. Only the argv separates them.
#
# `integ-destroy` and `integ-schema-migration` are the markgate gates left, so
# the table holds two rows. Its whole value is catching the NEXT one, written by
# someone who never read this file.
#
# WHY THE POPULATION IS DERIVED FROM BEHAVIOUR
#
# Not from the hook text, in any spelling. All three textual predicates were
# tried and all three are wrong:
#
#   - `grep -l 'markgate verify'` misses gates that invoke the binary as
#     `"${markgate[@]}" verify <gate>`, where no literal `markgate verify`
#     appears on any line.
#   - `grep -l markgate` finds ~20, because almost every gate reads
#     `.markgate.yml` for the repo opt-in check. Those verify nothing.
#   - Stripping comments first does not help either: a hook whose JOB is to
#     spot markgate commands carries `markgate[[:space:]]+(set|verify)` inside
#     a REGEX STRING, which is live code. That is what `NON_VERIFIERS` below
#     exists for; it is empty today.
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
#   fence 1  every hook in the table asks about the gate the table names, and
#            about NOTHING ELSE. Catches a gate repointed at another marker,
#            and a gate that ACQUIRES a second one.
#   fence 2  the table and the observed population agree in BOTH directions.
#            Catches a new markgate-backed hook added with no table entry, and
#            a table entry for a hook that no longer verifies anything.
#   fence 3  the probes actually REACH the markgate call. A gate scope-checks
#            the PR diff first and returns before verifying anything; a fence
#            that never reaches the call would report green over nothing.
#   fence 4  the markgate rc-2 branch sits at an EARLIER line than the alias
#            refusal. Static by necessity -- see .claude/rules/hooks.md.
#
# The matcher accepts `status` as well as `verify`. That call IS live in
# production (a stale marker reaches it) and a future probe may drive a stale
# verdict, so it is kept as coverage rather than as an explanation of anything.
#
# THE VACUITY FLOORS ARE SHALLOW, and that is worth stating rather than
# discovering. They are calibrated to the table: two gates, so "the table was
# read", "a hook was observed verifying" and "gates compared for rc-2 ordering"
# are floored at 2. They catch a total breakage and one gate dropping out, and
# nothing subtler. Fence 2's CANDIDATE floor counts hooks parsed out of
# settings.json rather than markgate callers -- keep it calibrated to the
# registered roster. Raise all of them when a gate is added.

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
# EMPTY on purpose, and integ-schema-migration-gate depends on it: an empty
# config is UNPARSABLE, `gate_resolve_marker_gate` fails closed to `canonical`,
# and the gate therefore consults markgate. A config DECLARING other gates --
# or an absent one -- resolves to `none`, and since go-to-k/cdkd#3351 a foreign
# target at `none` RELAXES, which would take that gate below this fence's
# reachability floor: it would go quiet in the suite built to notice a gate
# going quiet.
touch "$REPO/.markgate.yml"

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
integ-destroy-gate|integ-destroy|prmerge-destroy
integ-schema-migration-gate|integ-schema-migration|prmerge-schema
"

# Hooks that reference markgate but verify nothing, with the reason. Fence 2
# consults this so a deliberate non-verifier does not have to be a table entry.
# It is EMPTY today. The hook it named -- a PostToolUse detector carrying
# `markgate[[:space:]]+(set|verify)` inside a REGEX, because detecting markgate
# commands was its job -- was retired with the main-tree hook family.
NON_VERIFIERS=""

payload_for() {
  local key="$1" cmd
  case "$key" in
    commit)         cmd='git commit -m x' ;;
    prcreate)       cmd='gh pr create --title t --body b' ;;
    prmerge-*)      cmd='gh pr merge 1 --squash' ;;
    *)              cmd='git commit -m x' ;;
  esac
  printf '{"cwd":"%s","tool_input":{"command":"%s"}}' "$REPO" "$cmd"
}

# Per-gate PR diff, so the scope check ahead of the markgate call passes.
scope_env_for() {
  case "$1" in
    prmerge-destroy) printf 'src/provisioning/providers/s3-bucket-provider.ts' ;;
    prmerge-schema)  printf 'src/types/state.ts' ;;
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
    *)              printf '{"headRefOid":"deadbeef","headRefName":"feat/lane","state":"OPEN","mergeStateStatus":"CLEAN","additions":10,"deletions":1,"changedFiles":1,"files":[%s{"path":"src/a.ts"}]}' "$files_json" ;;
  esac
}

# Which copy of the hook to run. Every gate in the table reads the payload's
# cwd, so the checkout under test is always the fixture repo.
hook_path_for() {
  printf '%s' "$HOOKS_DIR/$1.sh"
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
  # The two declarations a real bump edits, spelled as `src/types/state.ts`
  # actually spells them (go-to-k/cdkd#3351). This fixture previously used
  # `version: 1 | 2 | ... | 8;` and `STATE_SCHEMA_VERSION = 8`, neither of which
  # has ever appeared in that file -- so this fence drove the schema gate with a
  # shape only the gate's equally-fictional regexes could match, and would have
  # gone on reporting the gate reachable after the regexes were corrected.
  [ "$key" = prmerge-schema ] && diff_body="diff --git a/src/types/state.ts b/src/types/state.ts
--- a/src/types/state.ts
+++ b/src/types/state.ts
@@ -1,4 +1,4 @@
-export type StateSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
+export type StateSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
-export const STATE_SCHEMA_VERSION_CURRENT: StateSchemaVersion = 8;
+export const STATE_SCHEMA_VERSION_CURRENT: StateSchemaVersion = 9;"
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

if [ "$declared" -lt 2 ]; then
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
if [ "$(printf '%s' "$CANDIDATES" | wc -w | tr -d ' ')" -lt 10 ]; then
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
  # is prose. Without the strip the net catches every gate doing the opt-in
  # check; with it, exactly the table's entries plus the declared
  # non-verifiers, which is the net having no holes AND no slack.
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
if [ "$observed_count" -lt 2 ]; then
  ng "fence 2: only $observed_count hooks were observed verifying a marker; the drive harness is not reaching them, so this comparison is vacuous"
elif [ -z "$missing_from_table$stale_in_table$mentions_markgate" ]; then
  ok "fence 2: the table and the $observed_count observed markgate callers agree in both directions"
else
  ng "fence 2: the table and the observed markgate callers disagree:$(printf '%b' "$missing_from_table$stale_in_table$mentions_markgate")"
fi

# --- fence 4: rc-2 must be handled BEFORE the alias refusal, in EVERY gate ---
#
# go-to-k/cdkd#2236. markgate exit 2 means "could not EVALUATE this gate", not
# "the marker is stale", and the two need OPPOSITE remedies: an integ run cannot
# clear an unevaluable gate, because `markgate set` fails on the same condition.
# A gate that reaches its ALIAS refusal first reports an rc-2 as staleness and
# sends the reader to burn a Docker / real-AWS run for nothing.
#
# WHY THIS IS STATIC AND CLASS-LEVEL RATHER THAN A PER-GATE CASE. No gate has
# an alias row today (`GATE_MARKER_ALIASES` is empty), so no suite can reach the
# alias branch at all: measured 2026-08-26 while `integ-local` still existed and
# still had the only row, moving the rc-2 block below the alias block in
# `integ-destroy-gate.sh` left destroy 24/24 GREEN while the identical mutation
# in the alias-carrying gate went red. `integ-destroy-gate` therefore carries a
# live ordering trap that no behavioural test can see -- and it springs
# precisely when someone adds the first alias row for it, which is the moment
# nobody re-reads the ordering.
#
# So this asserts on SOURCE ORDER, which is exactly what the trap is about, and
# it fences the case that does not exist yet. That is the only kind of fence
# that can catch this one.
order_bad=""
order_checked=0
for gate_file in integ-destroy-gate integ-schema-migration-gate; do
  src="$HOOKS_DIR/$gate_file.sh"
  [ -f "$src" ] || { order_bad="$order_bad\n    - $gate_file.sh not found"; continue; }
  rc2_line=$(grep -n '^if \[ "\$status" -eq 2 \]; then' "$src" | head -1 | cut -d: -f1)
  alias_line=$(grep -n '^if \[ "\$__mode" = "alias" \]; then' "$src" | head -1 | cut -d: -f1)
  if [ -z "$rc2_line" ]; then
    order_bad="$order_bad\n    - $gate_file.sh has NO \`status -eq 2\` branch, so an unevaluable gate is reported as a stale marker"
    continue
  fi
  if [ -z "$alias_line" ]; then
    order_bad="$order_bad\n    - $gate_file.sh has no alias branch, so the cross-repo resolution is missing entirely"
    continue
  fi
  order_checked=$((order_checked + 1))
  if [ "$rc2_line" -ge "$alias_line" ]; then
    order_bad="$order_bad\n    - $gate_file.sh handles rc-2 at line $rc2_line, AFTER the alias refusal at line $alias_line; an unevaluable gate would be reported as staleness"
  fi
done

if [ "$order_checked" -lt 2 ]; then
  ng "fence 4: only $order_checked of the markgate-backed gates were actually compared, so this assertion is vacuous:$(printf '%b' "$order_bad")"
elif [ -n "$order_bad" ]; then
  ng "fence 4: a gate handles markgate rc-2 after its alias refusal:$(printf '%b' "$order_bad")"
else
  ok "fence 4: all $order_checked markgate-backed gate(s) handle rc-2 BEFORE the alias refusal"
fi

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b\n' "$fail_log"
  exit 1
fi
