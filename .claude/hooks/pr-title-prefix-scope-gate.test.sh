#!/usr/bin/env bash
# Smoke test for pr-title-prefix-scope-gate.sh.
#
# Spins up a throwaway git repo per case with a synthetic origin/main
# branch + diffed feature branch, then runs the hook against a
# synthetic `gh pr create` / `gh api` invocation. Exit 0 = allow,
# exit 2 = block.
#
# Run from the repo root:
#   bash .claude/hooks/pr-title-prefix-scope-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pr-title-prefix-scope-gate.sh"

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <title> <diff-files-csv> <cmd-shape>
# diff-files-csv: comma-separated paths to commit on top of base.
#                 'NONE' = no diff (block-on-empty path; expect pass).
# cmd-shape: 'create' / 'create-eq' / 'create-singleq' /
#            'api-f' / 'api-F' / 'api-field' / 'api-rawfield' /
#            'api-no-title' / 'create-no-title' / 'unrelated'
run_case() {
  local name="$1"; local want="$2"; local title="$3"; local files_csv="$4"
  local shape="$5"

  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" RETURN

  (
    cd "$tmpdir" || exit 1
    git init -q -b main
    git config user.email t@t
    git config user.name t
    echo base > base.txt
    git add base.txt
    git commit -q -m "init"

    # Fake `origin/main` ref pointing at the init commit so the hook's
    # `git rev-parse origin/main` succeeds and the 3-dot diff has a base.
    git update-ref refs/remotes/origin/main HEAD

    git switch -q -c feature
    if [[ "$files_csv" != "NONE" ]]; then
      IFS=',' read -ra files <<< "$files_csv"
      for f in "${files[@]}"; do
        mkdir -p "$(dirname "$f")"
        echo content > "$f"
        git add "$f"
      done
      git commit -q -m "feature"
    fi
  ) >/dev/null 2>&1

  local cmdstr
  case "$shape" in
    create)
      cmdstr=$(printf 'gh -C %q pr create --title "%s" --body-file /tmp/b' "$tmpdir" "$title")
      ;;
    create-eq)
      cmdstr=$(printf 'gh -C %q pr create --title="%s" --body-file /tmp/b' "$tmpdir" "$title")
      ;;
    create-singleq)
      cmdstr=$(printf "gh -C %q pr create --title '%s' --body-file /tmp/b" "$tmpdir" "$title")
      ;;
    api-f)
      cmdstr=$(printf 'gh -C %q api -X PATCH repos/owner/repo/pulls/562 -f title="%s"' "$tmpdir" "$title")
      ;;
    api-F)
      cmdstr=$(printf 'gh -C %q api -X PATCH repos/owner/repo/pulls/562 -F title="%s"' "$tmpdir" "$title")
      ;;
    api-field)
      cmdstr=$(printf 'gh -C %q api -X PATCH repos/owner/repo/pulls/562 --field title="%s"' "$tmpdir" "$title")
      ;;
    api-rawfield)
      cmdstr=$(printf 'gh -C %q api -X PATCH repos/owner/repo/pulls/562 --raw-field title="%s"' "$tmpdir" "$title")
      ;;
    api-no-title)
      # api PATCH on pulls without title= field — body-only edit, pass through.
      cmdstr=$(printf 'gh -C %q api -X PATCH repos/owner/repo/pulls/562 -F body=@/tmp/b' "$tmpdir")
      ;;
    create-no-title)
      # gh pr create without --title (opens editor) — pass through.
      cmdstr=$(printf 'gh -C %q pr create --body-file /tmp/b' "$tmpdir")
      ;;
    unrelated)
      # Unrelated gh command — pass through.
      cmdstr=$(printf 'gh -C %q pr view 562' "$tmpdir")
      ;;
    *)
      echo "internal test error: unknown shape '$shape'" >&2
      return 1
      ;;
  esac

  local payload
  payload=$(jq -cn --arg c "$cmdstr" '{tool_input:{command:$c}}')

  local got
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?

  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  title: $title\n  files: $files_csv\n  shape: $shape\n  cmd: $cmdstr\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- BLOCK cases: feat:/fix: title with no src/** in diff ---

run_case "block fix(hooks) on .claude/** only" 2 \
  "fix(hooks): make markgate gate hooks cwd-aware (#559)" \
  ".claude/hooks/foo.sh,.claude/rules/hooks.md" create

run_case "block feat(skill) on .claude/skills/** only" 2 \
  "feat(review-pr): bump review tier threshold" \
  ".claude/skills/review-pr/SKILL.md" create

run_case "block fix with single-quote title" 2 \
  "fix: tweak local hook behavior" \
  ".claude/hooks/foo.sh" create-singleq

run_case "block fix via api -f title=" 2 \
  "fix(hooks): rename matcher" \
  ".claude/hooks/foo.sh" api-f

run_case "block fix via api -F title=" 2 \
  "fix(hooks): rename matcher" \
  ".claude/hooks/foo.sh" api-F

run_case "block fix via api --field title=" 2 \
  "fix(hooks): rename matcher" \
  ".claude/hooks/foo.sh" api-field

run_case "block fix via api --raw-field title=" 2 \
  "fix(hooks): rename matcher" \
  ".claude/hooks/foo.sh" api-rawfield

run_case "block breaking-change fix!:" 2 \
  "fix!: remove deprecated hook" \
  ".claude/hooks/foo.sh" create

run_case "block --title=\"...\" (eq form, quoted)" 2 \
  "fix(hooks): rename" \
  ".claude/hooks/foo.sh" create-eq

# --- PASS cases: feat:/fix: with src/** in diff ---

run_case "pass fix on mixed src/** + .claude/**" 0 \
  "fix(deploy): fix bug in deploy" \
  "src/cli/commands/deploy.ts,.claude/hooks/foo.sh" create

run_case "pass feat with only src/**" 0 \
  "feat(provider): add SES provider" \
  "src/provisioning/providers/ses.ts" create

# --- PASS cases: non-feat/fix prefix on any diff ---

run_case "pass chore on .claude/** only" 0 \
  "chore(hooks): refactor markgate hooks" \
  ".claude/hooks/foo.sh" create

run_case "pass docs on docs only" 0 \
  "docs: update README" \
  "docs/foo.md,README.md" create

run_case "pass test on tests only" 0 \
  "test: add coverage" \
  "tests/unit/foo.test.ts" create

run_case "pass refactor on .claude/**" 0 \
  "refactor(hooks): cleanup" \
  ".claude/hooks/foo.sh" create

run_case "pass revert on anything" 0 \
  "revert: previous change" \
  ".claude/hooks/foo.sh" create

# --- PASS cases: title shape edge cases ---

run_case "pass non-conventional-commit title" 0 \
  "Bump dependencies and clean up" \
  ".claude/hooks/foo.sh" create

run_case "pass gh pr create with no --title (editor)" 0 \
  "(no title — editor)" \
  ".claude/hooks/foo.sh" create-no-title

run_case "pass gh api PATCH with no title field" 0 \
  "(no title — body only)" \
  ".claude/hooks/foo.sh" api-no-title

run_case "pass unrelated gh command" 0 \
  "(n/a)" \
  ".claude/hooks/foo.sh" unrelated

# --- PASS cases: false-positive avoidance ---

# `git commit -m "review feedback: gh pr create with --title fix(...)"`
# — quoted body containing the trigger phrase. With line-start
# anchoring the hook MUST NOT fire.
fp_payload=$(jq -cn '{tool_input:{command:"git commit -m \"review feedback: gh pr create with --title fix(hooks): something\""}}')
got=$(printf '%s' "$fp_payload" | "$HOOK" >/dev/null 2>&1; echo $?)
if [[ "$got" == "0" ]]; then
  pass=$((pass + 1))
  printf 'OK   %s (exit %s)\n' "false-positive: git commit body mentioning 'gh pr create --title fix:'" "$got"
else
  fail=$((fail + 1))
  fail_log+="FAIL false-positive: want 0 got $got\n"
  printf 'FAIL %s (want 0, got %s)\n' "false-positive: git commit body mentioning 'gh pr create --title fix:'" "$got"
fi

# `echo "gh pr create --title fix: something"` — pure quoted echo,
# line starts with `echo`. MUST NOT fire.
fp2_payload=$(jq -cn '{tool_input:{command:"echo \"to do: gh pr create --title fix: something\""}}')
got=$(printf '%s' "$fp2_payload" | "$HOOK" >/dev/null 2>&1; echo $?)
if [[ "$got" == "0" ]]; then
  pass=$((pass + 1))
  printf 'OK   %s (exit %s)\n' "false-positive: echo body containing 'gh pr create --title'" "$got"
else
  fail=$((fail + 1))
  fail_log+="FAIL false-positive echo: want 0 got $got\n"
  printf 'FAIL %s (want 0, got %s)\n' "false-positive: echo body containing 'gh pr create --title'" "$got"
fi

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  printf '%b' "$fail_log" >&2
  exit 1
fi
exit 0
