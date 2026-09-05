#!/usr/bin/env bash
# Smoke test for hook-lib-parse-detector.sh.
#
# It ships one because `hooks.md` says every hook but `post-merge-sync-reminder`
# does, and because two reviewers independently noted this one did not: its
# arming predicate, its detection and its exit-0 contract were all unverified.
# A detector nobody has watched fire is indistinguishable from one that cannot.
#
# The subject is a DIRECTORY of shell files, so each case builds a throwaway
# tree with the detector copied into it — the detector resolves its scan root
# from its own location, which is exactly the behaviour worth exercising.
set -u

DET="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hook-lib-parse-detector.sh"
TMPDIR_T="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_T"' EXIT INT TERM

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
ng()  { fail=$((fail + 1)); printf 'not ok %s\n' "$1"; }

# build <name> <good|broken> -> echoes the tree's detector path
build() {
  # SPLIT DECLARATION: `local a="$1" b="$TMPDIR/$a"` reads `$a` before the
  # assignment has taken effect, which under `set -u` is an unbound-variable
  # abort rather than an empty path.
  local name="$1" state="$2" root
  root="$TMPDIR_T/$name"
  mkdir -p "$root/.claude/hooks/lib"
  cp "$DET" "$root/.claude/hooks/"
  printf '#!/usr/bin/env bash\ntrue\n' > "$root/.claude/hooks/lib/ok.sh"
  if [ "$state" = broken ]; then
    printf '#!/usr/bin/env bash\nf() {\n' > "$root/.claude/hooks/lib/broken.sh"
  fi
  printf '%s' "$root/.claude/hooks/hook-lib-parse-detector.sh"
}

# run <detector> <command text> -> its stderr; STDOUT is captured separately to
# $TMPDIR_T/out because that is the channel the model actually reads, and the
# exit code to $TMPDIR_T/rc, since a variable set inside the caller`s `$( )`
# does not survive it.
run() {
  local d="$1" c="$2"
  printf '%s' "$(jq -nc --arg c "$c" '{tool_name:"Bash",tool_input:{command:$c}}')" \
    | bash "$d" 2>&1 >"$TMPDIR_T/out"
  printf '%s' "$?" > "$TMPDIR_T/rc"
}

# 1. It DETECTS. Without this the rest is a test of silence.
out=$(run "$(build detect broken)" "sed -i x .claude/hooks/lib/broken.sh")
case "$out" in
  *"no longer parses"*) ok "(detect) a broken hook file is reported" ;;
  *) ng "(detect) expected a report, got: ${out:-<silence>}" ;;
esac

# 2. NON-BLOCKING by contract. PostToolUse cannot block, and a non-zero exit
#    from one is a harness error rather than a refusal.
rc=$(cat "$TMPDIR_T/rc")
[ "$rc" = 0 ] && ok "(contract) it exits 0 even when it reports" \
              || ng "(contract) exited $rc; PostToolUse must exit 0"

# THE CHANNEL, not just the text. At exit 0 neither stdout nor stderr reaches
# the model; only `hookSpecificOutput.additionalContext` does. A detector whose
# whole purpose is immediacy, writing where nobody reads, buys nothing -- and
# nothing but this case would notice, because the wording would look right in
# every transcript a human inspects.
stdout_json=$(cat "$TMPDIR_T/out")
case "$stdout_json" in
  *'"additionalContext"'*"no longer parses"*)
    ok "(channel) the report reaches the model as additionalContext" ;;
  *) ng "(channel) stdout carried no additionalContext: ${stdout_json:-<empty>}" ;;
esac
printf '%s' "$stdout_json" | jq -e . >/dev/null 2>&1 \
  && ok "(channel) that stdout is valid JSON" \
  || ng "(channel) stdout is not parseable JSON"

# 3. It is QUIET on a healthy tree — the direction that makes the noise
#    meaningful. A detector that always speaks is one people stop reading.
out=$(run "$(build clean good)" "sed -i x .claude/hooks/lib/ok.sh")
[ -z "$out" ] && ok "(quiet) a healthy tree produces no output" \
              || ng "(quiet) expected silence, got: $out"

# 4. The ARMING predicate. It only walks the directory when the command
#    mentions it, which is what keeps it off the cost of every Bash call.
out=$(run "$(build unarmed broken)" "ls /tmp")
[ -z "$out" ] && ok "(arming) a command not naming the hooks dir is ignored" \
              || ng "(arming) expected silence for an unrelated command"

# 5. The report NAMES the file. "Something is broken" sends the reader to the
#    whole directory; the point of catching it at the moment of the write is
#    that the next edit can be the fix.
out=$(run "$(build named broken)" "python3 - .claude/hooks/lib/broken.sh")
case "$out" in
  *"lib/broken.sh"*) ok "(report) it names the offending file" ;;
  *) ng "(report) expected the filename in: $out" ;;
esac

echo "----"
echo "  total: $((pass + fail))  fail: $fail"
[ "$fail" -eq 0 ]
