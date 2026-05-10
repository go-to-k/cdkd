#!/usr/bin/env bash
# Smoke test for internal-pr-labels-gate.sh.
#
# Builds fixture git repos with a structure that mimics cdkd's
# (README.md + docs/ + CLAUDE.md + tests/integration/...) and stages
# diffs with / without internal-PR labels. Run from the repo root:
#   bash .claude/hooks/internal-pr-labels-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/internal-pr-labels-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# init_repo <dir>
init_repo() {
  local dir="$1"
  git init -q -b main "$dir"
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  mkdir -p "$dir/docs" "$dir/tests/integration/foo" "$dir/.claude" "$dir/src"
  # Baseline content for the user-facing docs so subsequent diffs have
  # a previous version to diff against.
  cat > "$dir/README.md" <<'EOF'
# cdkd

cdkd is a CDK direct deployer.
EOF
  cat > "$dir/docs/cli-reference.md" <<'EOF'
# CLI Reference

cdkd deploy ...
EOF
  cat > "$dir/CLAUDE.md" <<'EOF'
# CLAUDE.md

Internal developer notes.
EOF
  cat > "$dir/tests/integration/foo/README.md" <<'EOF'
# foo integration test

Run `bash verify.sh`.
EOF
  cat > "$dir/.claude/settings.json" <<'EOF'
{ "hooks": {} }
EOF
  cat > "$dir/src/foo.ts" <<'EOF'
export const foo = 1;
EOF
  git -C "$dir" add -A
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q -m baseline
}

# append_line <file> <text>
append_line() {
  local file="$1" text="$2"
  printf '%s\n' "$text" >> "$file"
}

# stage_all <dir>
stage_all() {
  git -C "$1" add -A
}

# run_hook <dir> [<extra-cmd>] -> exit code captured in $?
run_hook() {
  local dir="$1"
  local payload
  payload=$(printf '{"tool_input":{"command":"git -C %s commit -m test"},"cwd":"%s"}' "$dir" "$dir")
  printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1
}

PASS=0
FAIL=0
case_label() {
  printf '  case: %s\n' "$1"
}
ok() {
  PASS=$((PASS + 1))
  printf '    PASS\n'
}
ng() {
  FAIL=$((FAIL + 1))
  printf '    FAIL: expected exit %s, got %s\n' "$1" "$2"
}

# --- Case 1: README.md with (PR 8b) → block ---
case_label "README.md with (PR 8b) → block"
D="$TMPDIR/case1"; init_repo "$D"
append_line "$D/README.md" ""
append_line "$D/README.md" "### local start-api authorizers (PR 8b)"
append_line "$D/README.md" ""
append_line "$D/README.md" "Authorizer support is here."
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 2: docs/cli-reference.md with (PR 6 of #224, issue #232) → block ---
case_label "docs/cli-reference.md with (PR 6 of #224, issue #232) → block"
D="$TMPDIR/case2"; init_repo "$D"
append_line "$D/docs/cli-reference.md" ""
append_line "$D/docs/cli-reference.md" "### Lambda Layers (PR 6 of #224, issue #232)"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 3: docs/other.md with (PR 5 of #224) → block ---
case_label "docs/other.md with (PR 5 of #224) → block"
D="$TMPDIR/case3"; init_repo "$D"
cat > "$D/docs/other.md" <<'EOF'
# Other doc

## Container Lambdas (PR 5 of #224)

Content here.
EOF
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 4: CLAUDE.md with (PR 8b) → pass (excluded) ---
case_label "CLAUDE.md with (PR 8b) → pass (excluded)"
D="$TMPDIR/case4"; init_repo "$D"
append_line "$D/CLAUDE.md" ""
append_line "$D/CLAUDE.md" "Note: this feature shipped in (PR 8b)."
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 5: README.md with inline code span `(PR 8b)` → pass ---
case_label "README.md with inline code span containing (PR 8b) → pass"
D="$TMPDIR/case5"; init_repo "$D"
append_line "$D/README.md" ""
append_line "$D/README.md" "Use the literal token \`(PR 8b)\` in your config."
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 6: README.md with (PR 8b) inside a fenced code block → pass ---
case_label "README.md with (PR 8b) inside fenced code block → pass"
D="$TMPDIR/case6"; init_repo "$D"
append_line "$D/README.md" ""
append_line "$D/README.md" '```'
append_line "$D/README.md" "## Container Lambdas (PR 5 of #224)"
append_line "$D/README.md" '```'
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 7: README.md with `closes #234` → pass ---
case_label "README.md with 'closes #234' → pass"
D="$TMPDIR/case7"; init_repo "$D"
append_line "$D/README.md" ""
append_line "$D/README.md" "This change closes #234 and fixes a bug."
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 8: README.md with parenthetical (#231) → pass ---
case_label "README.md with (#231) parenthetical → pass"
D="$TMPDIR/case8"; init_repo "$D"
append_line "$D/README.md" ""
append_line "$D/README.md" "Squashed from feat(...): subject (#231)"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 9: no staged docs → pass ---
case_label "no staged user-facing docs → pass"
D="$TMPDIR/case9"; init_repo "$D"
append_line "$D/src/foo.ts" "// dummy"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 10: unrelated bash command (not git commit) → pass ---
case_label "non-git-commit command → pass"
D="$TMPDIR/case10"; init_repo "$D"
append_line "$D/README.md" "## Container Lambdas (PR 5 of #224)"
stage_all "$D"
payload=$(printf '{"tool_input":{"command":"git -C %s push"},"cwd":"%s"}' "$D" "$D")
printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 11: staged JS/TS file with (PR 8b) in code comment → pass (not in scope) ---
case_label "src/foo.ts with (PR 8b) comment → pass (not in scope)"
D="$TMPDIR/case11"; init_repo "$D"
append_line "$D/src/foo.ts" "// internal note (PR 8b)"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 12: multi-file mixed; one clean docs/, one with label → block ---
case_label "multi-file mixed staged: one clean + one labeled → block"
D="$TMPDIR/case12"; init_repo "$D"
append_line "$D/README.md" "Plain prose addition."
append_line "$D/docs/cli-reference.md" "### local start-api authorizers (PR 8b)"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 13: tests/integration/foo/README.md with (PR 8b) → pass (excluded) ---
case_label "tests/integration/foo/README.md with (PR 8b) → pass (excluded)"
D="$TMPDIR/case13"; init_repo "$D"
append_line "$D/tests/integration/foo/README.md" ""
append_line "$D/tests/integration/foo/README.md" "This fixture exercises (PR 8b)."
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 14: bare 'PR 8b of #224' outside parens → block ---
case_label "README.md with bare 'PR 8b of #224' → block"
D="$TMPDIR/case14"; init_repo "$D"
append_line "$D/README.md" ""
append_line "$D/README.md" "This feature ships in PR 8b of #224 as planned."
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 15: docs/cli-reference.md with (PR 8b) alongside allowed (#231) → block ---
case_label "docs with both (PR 8b) and (#231) → block (only label matters)"
D="$TMPDIR/case15"; init_repo "$D"
append_line "$D/docs/cli-reference.md" ""
append_line "$D/docs/cli-reference.md" "Closing (#231) and adding authorizers (PR 8b)."
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

echo
echo "  total: $((PASS + FAIL))  pass: $PASS  fail: $FAIL"
if [[ $FAIL -eq 0 ]]; then exit 0; else exit 1; fi
