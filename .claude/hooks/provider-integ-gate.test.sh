#!/usr/bin/env bash
# Smoke test for provider-integ-gate.sh.
#
# Builds fixture git repos with a structure that mimics cdkd's
# (src/provisioning/register-providers.ts + tests/integration/<name>/
# {lib,bin}/*.ts), stages combinations of register lines + integ
# fixtures, and asserts the hook's exit code. Run from the repo root:
#   bash .claude/hooks/provider-integ-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/provider-integ-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# init_repo <dir> — seed with one register line + one tracked fixture
# so subsequent staged diffs have a baseline.
init_repo() {
  local dir="$1"
  git init -q -b main "$dir"
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  mkdir -p "$dir/src/provisioning" "$dir/tests/integration/baseline/lib"
  cat > "$dir/src/provisioning/register-providers.ts" <<'EOF'
import { ProviderRegistry } from './provider-registry.js';

export function registerAllProviders(registry: ProviderRegistry): void {
  registry.register('AWS::IAM::Role', new IAMRoleProvider());
}
EOF
  # Baseline fixture covers AWS::IAM::Role via an L2 construct AND
  # documents the literal type in a comment so the hook accepts it.
  cat > "$dir/tests/integration/baseline/lib/baseline-stack.ts" <<'EOF'
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

// covers: AWS::IAM::Role
export class BaselineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    new iam.Role(this, 'R', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  }
}
EOF
  # Empty allow-list sidecar; tests opt-in by writing entries below.
  mkdir -p "$dir/.claude"
  printf '{}\n' > "$dir/.claude/integ-coverage-allowlist.json"
  git -C "$dir" add -A
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q -m baseline
}

# allowlist_set <dir> <type> <rationale>
allowlist_set() {
  local dir="$1" type="$2" rationale="$3"
  if command -v jq >/dev/null 2>&1; then
    tmp=$(mktemp)
    jq --arg t "$type" --arg r "$rationale" '. + {($t): $r}' \
      "$dir/.claude/integ-coverage-allowlist.json" > "$tmp"
    mv "$tmp" "$dir/.claude/integ-coverage-allowlist.json"
  else
    # Hand-roll JSON when jq is missing — the test then exercises the
    # hook's fallback grep path too.
    printf '{\n  "%s": "%s"\n}\n' "$type" "$rationale" \
      > "$dir/.claude/integ-coverage-allowlist.json"
  fi
}

# add_register <dir> <type> [<extra-suffix-for-line>]
add_register() {
  local dir="$1" type="$2" suffix="${3:-}"
  printf "  registry.register('%s', new FakeProvider());%s\n" "$type" "$suffix" \
    >> "$dir/src/provisioning/register-providers.ts"
}

# add_integ_fixture <dir> <fixture-name> <body>
#
# `body` is appended verbatim into `lib/<name>-stack.ts` between the
# constructor's `super(...)` call and the closing brace. The helper
# does NOT auto-indent the body — the caller is responsible for the
# leading whitespace on each line. Multi-line bodies must include the
# indent on every line (a literal `\n    ` between statements). This
# is fine for the hook's correctness because the hook does a literal
# string grep — indent doesn't matter for type detection. Callers
# that pass a single line don't need to worry.
add_integ_fixture() {
  local dir="$1" name="$2" body="$3"
  mkdir -p "$dir/tests/integration/$name/lib"
  cat > "$dir/tests/integration/$name/lib/${name}-stack.ts" <<EOF
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class ${name^}Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
${body}
  }
}
EOF
}

stage_all() { git -C "$1" add -A; }

run_hook() {
  local dir="$1"
  local payload
  payload=$(printf '{"tool_input":{"command":"git -C %s commit -m test"},"cwd":"%s"}' "$dir" "$dir")
  printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1
}

PASS=0
FAIL=0
case_label() { printf '  case: %s\n' "$1"; }
ok() { PASS=$((PASS + 1)); printf '    PASS\n'; }
ng() { FAIL=$((FAIL + 1)); printf '    FAIL: expected exit %s, got %s\n' "$1" "$2"; }

# --- Case 1: net-new register WITHOUT integ -> exit 2 ---
case_label "net-new register without integ -> block"
D="$TMPDIR/case1"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 2: net-new register + integ with literal type string -> exit 0 ---
case_label "net-new register + integ literal -> pass"
D="$TMPDIR/case2"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
add_integ_fixture "$D" "foo" "    // covers: AWS::Foo::Bar
    new cdk.CfnResource(this, 'X', { type: 'AWS::Foo::Bar', properties: {} });"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 3: net-new register + integ with L1 CfnXxx class -> exit 0 ---
case_label "net-new register + integ L1 CfnXxx -> pass"
D="$TMPDIR/case3"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
add_integ_fixture "$D" "foo" "    // L1 form
    new foo.CfnBar(this, 'X', { /* ... */ });"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 4: net-new register + allow-list sidecar entry -> exit 0 ---
case_label "net-new register + sidecar allow-no-integ rationale -> pass"
D="$TMPDIR/case4"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
allowlist_set "$D" "AWS::Foo::Bar" "covered transitively via parent CR"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 5: allow-list entry with empty rationale -> exit 2 ---
# An empty/whitespace-only rationale shouldn't bypass the gate.
case_label "sidecar allow-no-integ with empty rationale -> block"
D="$TMPDIR/case5"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
printf '{ "AWS::Foo::Bar": "" }\n' > "$D/.claude/integ-coverage-allowlist.json"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 6: refactor (remove + re-add same type) -> exit 0 ---
# Genuinely exercise the `comm -23 added removed` subtraction at the
# heart of the refactor pass-through. The diff MUST produce a `-` line
# AND a `+` line on the same `AWS::IAM::Role` literal so `extract_types`
# returns the type on both sides; then `comm -23` cancels them out and
# the gate exits 0 without running the per-type integ search.
case_label "refactor: remove + re-add same type -> pass"
D="$TMPDIR/case6"; init_repo "$D"
# Move the register line to a different position in the file. `sed`
# couldn't help here (a class-name-only rename leaves the register line
# text-identical and produces no `-`/`+` for the type literal). Instead,
# rewrite the file from scratch with the same type on a different line.
cat > "$D/src/provisioning/register-providers.ts" <<'EOF'
import { ProviderRegistry } from './provider-registry.js';

export function registerAllProviders(registry: ProviderRegistry): void {
  // Re-added on a different line (refactor: extracted a constant first)
  const role = new IAMRoleProvider();
  registry.register('AWS::IAM::Role', role);
}
EOF
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 7: register-providers.ts unchanged -> exit 0 ---
case_label "register-providers.ts unchanged -> pass"
D="$TMPDIR/case7"; init_repo "$D"
echo "// unrelated" >> "$D/tests/integration/baseline/lib/baseline-stack.ts"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 8: non-commit command -> exit 0 ---
case_label "non-commit git command -> pass"
D="$TMPDIR/case8"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
stage_all "$D"
payload=$(printf '{"tool_input":{"command":"git -C %s push"},"cwd":"%s"}' "$D" "$D")
printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 9: pre-existing tracked integ covers the new type -> exit 0 ---
# The new register lands in this commit but a fixture from a prior
# commit already references the literal type. Should pass.
case_label "pre-existing tracked integ covers new type -> pass"
D="$TMPDIR/case9"; init_repo "$D"
# Pre-commit a fixture referencing the type we'll register next.
mkdir -p "$D/tests/integration/foo/lib"
cat > "$D/tests/integration/foo/lib/foo-stack.ts" <<'EOF'
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
// covers: AWS::Foo::Bar
export class FooStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
EOF
git -C "$D" add -A
git -C "$D" -c user.email=t@t -c user.name=t commit -q -m "pre-existing fixture"
add_register "$D" "AWS::Foo::Bar"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 10: multiple new registers, only one missing integ -> exit 2 ---
case_label "multiple new registers, partial integ coverage -> block"
D="$TMPDIR/case10"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
add_register "$D" "AWS::Foo::Baz"
add_integ_fixture "$D" "foo" "    // covers: AWS::Foo::Bar
    new cdk.CfnResource(this, 'X', { type: 'AWS::Foo::Bar', properties: {} });"
# AWS::Foo::Baz NOT covered.
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 11: bin/ directory file satisfies the gate -> exit 0 ---
# Ensure the hook scans bin/*.ts in addition to lib/*.ts.
case_label "bin/*.ts file with literal type -> pass"
D="$TMPDIR/case11"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
mkdir -p "$D/tests/integration/foo/bin"
cat > "$D/tests/integration/foo/bin/app.ts" <<'EOF'
// covers: AWS::Foo::Bar
import * as cdk from 'aws-cdk-lib';
const app = new cdk.App();
EOF
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 12: cd <path> && git commit chain -> hook resolves correctly ---
case_label "cd <dir> && git commit chain -> resolves correctly"
D="$TMPDIR/case12"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
stage_all "$D"
payload=$(printf '{"tool_input":{"command":"cd %s && git commit -m test"},"cwd":"/tmp"}' "$D")
printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 13: sidecar allowlist file missing entirely -> exit 2 ---
# The hook must still gate (no sidecar = no allow-list, every net-new
# register without integ blocks). Covers the empty-`git show` branch
# in `read sidecar` when the file is not tracked.
case_label "no sidecar file at all -> block (net-new register, no coverage, no allow-list)"
D="$TMPDIR/case13"; init_repo "$D"
rm -f "$D/.claude/integ-coverage-allowlist.json"
git -C "$D" -c user.email=t@t -c user.name=t add -A
git -C "$D" -c user.email=t@t -c user.name=t commit -q -m "remove sidecar"
add_register "$D" "AWS::Foo::Bar"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 14: `$`-prefixed keys in sidecar are documentation -> exit 2 ---
# `$schema-doc` / `$why-sidecar` keys in the real sidecar must NEVER
# exempt the type. A regex regression that drops the `$` filter would
# silently allow every entry — this case catches that.
case_label "sidecar with only `$`-prefixed keys (no real entry) -> block"
D="$TMPDIR/case14"; init_repo "$D"
cat > "$D/.claude/integ-coverage-allowlist.json" <<'EOF'
{
  "$schema-doc": "documentation, not an entry",
  "$why-sidecar": "documentation, not an entry"
}
EOF
add_register "$D" "AWS::Foo::Bar"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 15: JSON value is whitespace-only -> exit 2 ---
# Both the jq path (gsub-then-length-check) and the grep fallback path
# must agree: a value like "   " is NOT a valid rationale. A naive
# `"[^"]+"` regex would accept it; the fallback uses
# `"[^"]*[^[:space:]"][^"]*"` to require at least one non-whitespace
# non-quote character.
case_label "sidecar value is whitespace-only -> block"
D="$TMPDIR/case15"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
printf '{ "AWS::Foo::Bar": "   " }\n' > "$D/.claude/integ-coverage-allowlist.json"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 16: multi-line body in `add_integ_fixture` is preserved ---
# Documents that callers must include their own indent on each line;
# the hook's literal-string match still detects the type regardless of
# indent. Regression guard against future refactors that auto-indent
# the body — those would change the file content but not the hook's
# behaviour, so this test asserts the detection path stays robust to
# the surrounding whitespace.
case_label "multi-line fixture body -> hook still detects literal type"
D="$TMPDIR/case16"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
add_integ_fixture "$D" "foo" "// covers: AWS::Foo::Bar
new cdk.CfnResource(this, 'X', {
  type: 'AWS::Foo::Bar',
  properties: {},
});"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 17: sidecar with object value is rejected (not a string rationale) ---
# Mirrors the unit-test coverage of `parseAllowNoIntegRationalesContent`
# but at the hook level. The jq filter requires `.value | type ==
# "string"`, so an object value like `{"reason": "wrapped"}` must NOT
# count as a valid rationale. Without the type guard, a careless edit
# could accidentally exempt a type with no actual rationale string.
case_label "sidecar with object value -> block (not a valid string rationale)"
D="$TMPDIR/case17"; init_repo "$D"
add_register "$D" "AWS::Foo::Bar"
cat > "$D/.claude/integ-coverage-allowlist.json" <<'EOF'
{
  "AWS::Foo::Bar": {
    "reason": "wrapped object instead of plain string"
  }
}
EOF
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

echo
echo "  total: $((PASS + FAIL))  pass: $PASS  fail: $FAIL"
if [[ $FAIL -eq 0 ]]; then exit 0; else exit 1; fi
