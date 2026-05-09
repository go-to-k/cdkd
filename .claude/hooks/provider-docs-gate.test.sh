#!/usr/bin/env bash
# Smoke test for provider-docs-gate.sh.
#
# Builds fixture git repos with a structure that mimics cdkd's
# (src/provisioning/register-providers.ts + docs/supported-resources.md
# + docs/import.md), stages combinations of register lines + docs
# updates, and asserts the hook's exit code. Run from the repo root:
#   bash .claude/hooks/provider-docs-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/provider-docs-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# init_repo <dir>
init_repo() {
  local dir="$1"
  git init -q -b main "$dir"
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  mkdir -p "$dir/src/provisioning" "$dir/docs"
  # Seed the three target files with a minimal baseline so subsequent
  # diffs have something to diff against.
  cat > "$dir/src/provisioning/register-providers.ts" <<'EOF'
import { ProviderRegistry } from './provider-registry.js';

export function registerAllProviders(registry: ProviderRegistry): void {
  registry.register('AWS::IAM::Role', new IAMRoleProvider());
}
EOF
  printf '# Supported Resources\n\n| Category | Type | Provider |\n|---|---|---|\n| IAM | AWS::IAM::Role | SDK Provider |\n' \
    > "$dir/docs/supported-resources.md"
  printf '# Import Coverage\n\n## Auto-lookup\n\n- AWS::IAM::Role\n' \
    > "$dir/docs/import.md"
  git -C "$dir" add -A
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q -m baseline
}

# add_register <dir> <type> — append a registry.register line.
add_register() {
  local dir="$1" type="$2"
  printf "  registry.register('%s', new FakeProvider());\n" "$type" \
    >> "$dir/src/provisioning/register-providers.ts"
}

# add_supported <dir> <type>
add_supported() {
  local dir="$1" type="$2"
  printf "| Misc | %s | SDK Provider |\n" "$type" \
    >> "$dir/docs/supported-resources.md"
}

# add_import <dir> <type>
add_import() {
  local dir="$1" type="$2"
  printf -- "- %s\n" "$type" >> "$dir/docs/import.md"
}

# stage_all <dir>
stage_all() {
  git -C "$1" add -A
}

# run_hook <dir> -> exit code captured in $?
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

# --- Case 1: net-new register WITH both docs entries → exit 0 ---
case_label "net-new register + both docs entries → pass"
D="$TMPDIR/case1"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
add_supported "$D" "AWS::Foo::Bar"
add_import "$D" "AWS::Foo::Bar"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 2: net-new register MISSING both docs entries → exit 2 ---
case_label "net-new register without docs entries → block"
D="$TMPDIR/case2"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 3: net-new register with ONLY supported-resources entry → exit 2 ---
case_label "net-new register with only supported-resources entry → block"
D="$TMPDIR/case3"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
add_supported "$D" "AWS::Foo::Bar"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 4: net-new register with ONLY import.md entry → exit 2 ---
case_label "net-new register with only import.md entry → block"
D="$TMPDIR/case4"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
add_import "$D" "AWS::Foo::Bar"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 5: refactor (remove + add same type, same diff) → exit 0 ---
# Simulates renaming the provider class — the registration line shape
# changes but the resource type stays the same.
case_label "refactor: remove + add same type → pass"
D="$TMPDIR/case5"; init_repo "$D"
add_register "$D" "AWS::IAM::Role"  # same type as baseline already registered
# Remove the baseline IAM::Role line and add a re-stylized one.
sed -i.bak "s|registry.register('AWS::IAM::Role', new IAMRoleProvider());|registry.register('AWS::IAM::Role', new RenamedIAMRoleProvider());|" \
  "$D/src/provisioning/register-providers.ts"
rm -f "$D/src/provisioning/register-providers.ts.bak"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 6: register-providers.ts unchanged → pass through ---
case_label "register-providers.ts not staged → pass"
D="$TMPDIR/case6"; init_repo "$D"
echo "// unrelated change" >> "$D/docs/import.md"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 7: non-commit command → pass through ---
case_label "non-commit git command → pass"
D="$TMPDIR/case7"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
stage_all "$D"
payload=$(printf '{"tool_input":{"command":"git -C %s push"},"cwd":"%s"}' "$D" "$D")
printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 8: multiple new registers, only one missing docs → exit 2 ---
case_label "multiple new registers, partial docs coverage → block"
D="$TMPDIR/case8"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
add_register "$D" "AWS::Foo::Baz"
add_supported "$D" "AWS::Foo::Bar"
add_supported "$D" "AWS::Foo::Baz"
add_import "$D" "AWS::Foo::Bar"
# AWS::Foo::Baz NOT added to import.md
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

echo
echo "  total: $((PASS + FAIL))  pass: $PASS  fail: $FAIL"
if [[ $FAIL -eq 0 ]]; then exit 0; else exit 1; fi
