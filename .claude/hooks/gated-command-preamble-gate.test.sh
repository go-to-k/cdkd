#!/usr/bin/env bash
# Smoke test for gated-command-preamble-gate.sh.
#
# Run from BESIDE the hook (`bash .claude/hooks/gated-command-preamble-gate.test.sh`):
# the path below is `${BASH_SOURCE[0]}`-relative, so a copy run from a scratch
# directory resolves a hook that is not there and every case exits 127.
#
# Both polarities are exercised deliberately. A gate that only ever proves it
# REFUSES the bad shape cannot notice itself starting to refuse the good one,
# and this gate sits on `git commit` -- the single most common agent call in
# the repo -- so an over-tightening would be felt immediately and everywhere.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gated-command-preamble-gate.sh"

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <command-string>
run_case() {
  local name="$1"; local want="$2"; local cmd="$3"
  local payload got out
  payload=$(jq -nc --arg c "$cmd" '{tool_input:{command:$c}}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1)
  got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1)); printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n  cmd: $cmd\n  out: $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- BLOCK: the two shapes measured on 2026-08-25 ---

run_case "markgate set before git commit" 2 \
  'mise exec -- markgate set docs && git add -A && git commit -F /tmp/m.txt'
run_case "bare markgate set before git commit" 2 \
  'markgate set check && git commit -m x'
run_case "heredoc file write before git commit" 2 \
  "cat > /tmp/commit-msg.txt <<'MSG'
subject
MSG
git commit -F /tmp/commit-msg.txt"
run_case "file write before gh pr create" 2 \
  'printf body > /tmp/pr.md && gh pr create --body-file /tmp/pr.md'
run_case "cp restore before git commit" 2 \
  'cp /tmp/snap.ts src/x.ts && git commit -m restore'
run_case "mv before gh pr merge" 2 \
  'mv a b && gh pr merge 1 --squash'
run_case "append redirect before git commit" 2 \
  'echo row >> docs/_generated/ledger.tsv && git commit -m ledger'
run_case "markgate set with cd prefix still blocked" 2 \
  'cd /repo && mise exec -- markgate set check && git commit -m x'

# --- ALLOW: the good shapes. Each one is a form the repo actively uses, so a
# regression here would be felt on the next commit anywhere. ---

run_case "cd prefix alone is allowed" 0 \
  'cd /repo/.claude/worktrees/x && git commit -F /tmp/m.txt'
run_case "git add before commit is allowed (loss is LOUD)" 0 \
  'git add -A && git commit -F /tmp/m.txt'
run_case "reads before commit are allowed" 0 \
  'git status --porcelain && git commit -m x'
run_case "fd duplication is not a write redirect" 0 \
  'git commit -F /tmp/m.txt 2>&1 | tail -3'
run_case "write AFTER the gated command is allowed" 0 \
  'gh pr merge 1 --squash > /tmp/out 2>&1'
run_case "markgate VERIFY (a read) before commit is allowed" 0 \
  'markgate verify check && git commit -m x'
run_case "no gated command at all" 0 \
  'markgate set check && echo done'
run_case "gated command alone" 0 \
  'git commit -F /tmp/m.txt'
run_case "markgate set after the gated command is allowed" 0 \
  'git commit -m x && markgate set check'

# --- ALLOW: `>` inside QUOTED DATA is not a redirect. Every one of these was
# refused by the first revision, and each is routine in a TypeScript repo. ---

run_case "arrow in a grep pattern" 0 \
  "grep -n '=>' src/x.ts && git commit -m x"
run_case "arrow in an rg pattern" 0 \
  'rg "\(\) => \{" src && git commit -m x'
run_case "comparison in an awk program" 0 \
  "awk '\$3 > 5' f && git commit -m x"
run_case "comparison in a jq filter" 0 \
  "jq '.a > 1' f.json && git commit -m x"
run_case "arrow in echoed prose" 0 \
  'echo "renamed foo -> bar" && git commit -m x'
run_case "arrow in a gh --body argument" 0 \
  'gh issue comment 1 --body "old > new" && git commit -m x'

# --- ALLOW: /dev/null writes nothing that can be lost ---

run_case "stderr discarded to /dev/null" 0 \
  'grep -q foo f 2>/dev/null && git commit -m x'
run_case "markgate verify with output suppressed" 0 \
  'markgate verify check >/dev/null 2>&1 && git commit -m x'

# --- BLOCK: a preamble BETWEEN two gated commands is not fail-open ---

run_case "preamble between two gated commands" 2 \
  'gh pr create --fill && cp a b && git commit -m x'

# --- BLOCK: the in-place / silent-write family ---

run_case "sed -i before commit" 2 \
  'sed -i "" s/a/b/ f && git commit -m x'
run_case "tee before commit" 2 \
  'echo x | tee f && git commit -m x'

# --- The remediation must list EVERY preamble, not only the last. That was the
# 2026-08-25 incident's own shape, so a message naming one of two would send the
# reader straight back into it. ---

# Counting `run:` LINES, not grepping for the preamble text. The text form was
# vacuous: the hook's own remediation boilerplate contains the literal
# `markgate set check && markgate set docs && git commit`, so both greps matched
# the boilerplate whether or not either preamble had been listed -- mutating the
# hook to keep only the LAST preamble left the suite fully green (measured
# 2026-08-26). The preambles below are also chosen to be ABSENT from that
# boilerplate, so the count and the content are independent of it.
two_pre=$(printf '%s' '{"tool_input":{"command":"cp a.txt b.txt && tee out.log && git commit -m x"}}' | "$HOOK" 2>&1)
two_pre_n=$(printf '%s\n' "$two_pre" | grep -cE '^  run: ')
if [ "$two_pre_n" -eq 2 ] &&
  printf '%s' "$two_pre" | grep -q 'cp a.txt b.txt' &&
  printf '%s' "$two_pre" | grep -q 'tee out.log'; then
  pass=$((pass + 1)); printf 'OK   remediation lists BOTH preambles\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL remediation lists BOTH preambles: run-lines=$two_pre_n want 2\n  out: $two_pre\n"
  printf 'FAIL remediation lists BOTH preambles (run-lines=%s want 2)\n' "$two_pre_n"
fi

# --- ALLOW: MORE THAN ONE discarding redirect. The shape-matched exemption
# admitted exactly one, so `>/dev/null 2>/dev/null` -- an ordinary way to
# silence a probe -- was REFUSED (measured 2026-08-26). Both polarities here:
# the last case proves stripping the discards did not start exempting a real
# write that happens to sit beside one. ---

run_case "two /dev/null redirects, no-space spelling" 0 \
  'markgate verify check >/dev/null 2>/dev/null && git commit -m x'
run_case "two /dev/null redirects, spaced spelling" 0 \
  'foo > /dev/null 2> /dev/null && git commit -m x'
run_case "/dev/null redirects in either order" 0 \
  'foo 2>/dev/null >/dev/null && git commit -m x'
run_case "fd close 2>&- is not a write" 0 \
  'foo 2>&- && git commit -m x'
run_case "a REAL write beside a discarded one is still a write" 2 \
  'foo 2>/dev/null > /tmp/keep.log && git commit -m x'

# --- BLOCK: the sed -i spellings the first cut missed ---

run_case "sed -i.bak (portable GNU+BSD spelling)" 2 \
  'sed -i.bak s/a/b/ f && git commit -m x'
run_case "sed with an option cluster before -i" 2 \
  "sed -E -i '' s/a/b/ f && git commit -m x"

# --- ALLOW: sed WITHOUT in-place edits nothing ---

run_case "sed -n is not an in-place edit" 0 \
  'sed -n 1p f && git commit -m x'

# --- The remediation must be COPY-PASTEABLE. An earlier cut carried the
# `<- marker write` annotation into the `run:` lines, so following it verbatim
# ran `markgate set check marker write <- ...` -- the same "agent copies it and
# it breaks" failure the multi-preamble fix was written for, one layer down. ---

rem=$(printf '%s' '{"tool_input":{"command":"markgate set check && git commit -m x"}}' | "$HOOK" 2>&1)
if printf '%s' "$rem" | grep -qE '^  run: markgate set check[[:space:]]*$'; then
  pass=$((pass + 1)); printf 'OK   remediation run: line is copy-pasteable\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL remediation run: line is copy-pasteable\n  out: $rem\n"
  printf 'FAIL remediation run: line is copy-pasteable\n'
fi

# --- The `run:` line must survive a preamble whose own text contains the
# annotation separator. An earlier revision re-parsed the annotated list with
# `sed 's/    <- .*$//'`, which truncates at the LEFTMOST match and emitted
# `run: echo "a` -- an unterminated quote. ---

ann=$(printf '%s' '{"tool_input":{"command":"echo \"a    <- b\" > f && git commit -m x"}}' | "$HOOK" 2>&1)
if printf '%s' "$ann" | grep -qF 'run: echo "a    <- b" > f'; then
  pass=$((pass + 1)); printf 'OK   run: line survives an annotation-lookalike preamble\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL run: line survives an annotation-lookalike preamble\n  out: $ann\n"
  printf 'FAIL run: line survives an annotation-lookalike preamble\n'
fi

# --- The library liveness guard must FAIL CLOSED. The hook depends on both
# `gate_segments` and `strip_noncommand_spans`; a truncated library defining one
# and not the other would strip every segment to empty and exit 0 in silence.
# Sibling suites (issue-dup-check-gate, gh-body-english-gate) fence this; the
# commit that hardened the guard described it without asserting it. ---

stub_dir=$(mktemp -d) || { printf "%s\n" "FAIL could not mktemp -d for the stub-library cases" >&2; exit 1; }
trap 'rm -rf "$stub_dir"' EXIT
mkdir -p "$stub_dir/lib"
cp "$HOOK" "$stub_dir/"
# `functions-no-constants` is the shape a TAIL TRUNCATION actually produces:
# the library declares `strip_noncommand_spans` and `gate_segments` hundreds of
# lines BEFORE the `GATE_RE_*` constants, so a file cut short keeps the
# functions and loses the constants. Without this variant the suite fenced only
# shapes a truncation CANNOT make, while the reachable one exited 1 on an
# unbound variable -- which `.claude/rules/hooks.md` says propagates as a
# non-blocking error, i.e. a PASS.
stub_fn_seg="gate_segments() { :; }"
stub_fn_strip="strip_noncommand_spans() { :; }"
# `constants-no-function` is what fences the `declare -F` half. Without it every
# stub below lacks the GATE_RE_* constants too, so the CONSTANTS clause alone
# catches all of them -- measured: deleting the whole `declare -F` half left the
# suite fully green, in a commit whose message claimed per-clause probing.
stub_consts="GATE_RE_GIT_COMMIT=x\nGATE_RE_GH_PR_CREATE=x\nGATE_RE_GH_PR_MERGE=x"
# `no-strip` fences the LAST unfenced clause. Deleting only
# `! declare -F strip_noncommand_spans` left the suite fully green while a
# library with everything BUT that helper took the gate from rc=2 to rc=0 --
# the same vacuity class this suite already fixed twice. Every clause of the
# guard now has a stub that reds when only that clause is removed.
for stub in "gate_segments" "strip_noncommand_spans" "neither" "functions-no-constants" "constants-no-function" "no-strip"; do
  : > "$stub_dir/lib/command-match.sh"
  case "$stub" in
    gate_segments)          printf "%s\n" "$stub_fn_seg" > "$stub_dir/lib/command-match.sh" ;;
    strip_noncommand_spans) printf "%s\n" "$stub_fn_strip" > "$stub_dir/lib/command-match.sh" ;;
    neither)                : ;;
    functions-no-constants) printf "%s\n%s\n" "$stub_fn_seg" "$stub_fn_strip" > "$stub_dir/lib/command-match.sh" ;;
    constants-no-function)  printf "%s\n%b\n" "$stub_fn_strip" "$stub_consts" > "$stub_dir/lib/command-match.sh" ;;
    no-strip)               printf "%s\n%b\n" "$stub_fn_seg" "$stub_consts" > "$stub_dir/lib/command-match.sh" ;;
  esac
  printf '%s' '{"tool_input":{"command":"git commit -m x"}}' \
    | "$stub_dir/$(basename "$HOOK")" >/dev/null 2>&1
  rc=$?
  if [ "$rc" = "2" ]; then
    pass=$((pass + 1)); printf 'OK   fails CLOSED when the library defines only: %s (exit 2)\n' "$stub"
  else
    fail=$((fail + 1))
    fail_log+="FAIL library-truncated ($stub): want exit 2, got $rc\n"
    printf 'FAIL library-truncated (%s): want 2, got %s\n' "$stub" "$rc"
  fi
done

# --- BLOCK: a path that merely BEGINS with /dev/null is a real file. Without a
# right boundary on the discard pattern these stripped to nothing and passed --
# stripping can DESTROY a write, not only reveal one. ---

run_case "/dev/nullx is a real file, not a discard" 2 \
  'foo > /dev/nullx && git commit -m x'
run_case "/dev/null.bak is a real file, not a discard" 2 \
  'foo >/dev/null.bak && git commit -m x'

# --- Interpreter one-liners are OPAQUE writes (issue #2369). The code argument
# is a quoted span the stripper removes, so the gate cannot see whether it
# writes; the measured incident was a `python3 -c` that rewrote the gated
# command's own body file and was discarded by a refusal, twice in one run. ---

run_case "python3 -c preamble before gh pr create blocks" 2 \
  "python3 -c 'open(x)' && gh pr create --title t --body-file /tmp/b.md"
run_case "node -e preamble before gh pr create blocks" 2 \
  "node -e 'fs.writeFileSync(x)' && gh pr create --title t --body-file /tmp/b.md"
run_case "perl -pi -e clustered preamble blocks" 2 \
  "perl -pi -e 's/a/b/' f.md && git commit -F /tmp/m.txt"
run_case "python3 stdin-script (heredoc) preamble blocks" 2 \
  'python3 - <<'"'"'PY'"'"'
code
PY
git commit -F /tmp/m.txt'

# Controls, both directions: the widening must not read mentions or
# argument-position interpreter names as invocations, and an interpreter
# AFTER the gated command is that command'"'"'s own follow-up.
run_case "quoted mention of python3 -c in a commit message passes" 0 \
  'git commit -m "use python3 -c to fix it"'
run_case "interpreter name in argument position passes" 0 \
  'grep python3 - </tmp/x && git commit -F /tmp/m.txt'
run_case "interpreter AFTER the gated command passes" 0 \
  "git commit -F /tmp/m.txt && python3 -c 'print(1)'"
run_case "interpreter alone (no gated verb) passes" 0 \
  "python3 -c 'print(1)'"

printf '\nPass: %d  Fail: %d\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then printf '%b' "$fail_log" >&2; exit 1; fi
exit 0
