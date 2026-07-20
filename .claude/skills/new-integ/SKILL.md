---
name: new-integ
description: Scaffold a new integration test for cdkd. Creates a minimal CDK app with the specified AWS resources for deploy/destroy E2E testing.
argument-hint: "<test-name>"
---

# New Integration Test Scaffold

You are scaffolding a new integration test for cdkd.

## Input

The user provides a kebab-case test name (e.g., `ses-email-identity`,
`s3-event-notification`).

## Steps

1. **Build cdkd first**: `vp run build` from the repo root — verify.sh and the
   synth check both run against `dist/cli.js`, so source changes without a build
   have no effect.

2. **Check the test does not already exist** in `tests/integration/<test-name>/`,
   AND that an existing fixture does not already cover the pattern. Grep for the
   construct/resource type across `tests/integration/*/lib` before building —
   a fixture that already deploys the thing (even without a verify.sh) means the
   higher-value move is often to ADD a functional verify.sh to it rather than a
   whole new fixture.

3. **Read a recent fixture as the reference shape.** Use
   `tests/integration/dynamodb-gsi-update/` (deploy + UPDATE + destroy with real
   assertions) or `tests/integration/s3-event-notification/` (functional check)
   — NOT the oldest ones, whose conventions have drifted.

4. **Create the test directory** at `tests/integration/<test-name>/` with these
   files. The project runs CDK apps via Node 24 type-stripping (`node bin/app.ts`),
   so the fixture is ESM (`"type": "module"`) and imports carry the `.ts`
   extension — there is NO `ts-node` / `tsx` dependency.

   **`cdk.json`**:
   ```json
   {
     "app": "node bin/app.ts"
   }
   ```

   **`package.json`** (note `"type": "module"`; no `ts-node`):
   ```json
   {
     "name": "cdkd-integ-<test-name>",
     "version": "1.0.0",
     "private": true,
     "description": "<one-line description>",
     "scripts": {
       "build": "tsc",
       "watch": "tsc -w"
     },
     "devDependencies": {
       "@types/node": "^20.0.0",
       "aws-cdk": "^2.1112.0",
       "typescript": "^5.0.0"
     },
     "dependencies": {
       "aws-cdk-lib": "^2.169.0",
       "constructs": "^10.0.0"
     },
     "type": "module"
   }
   ```

   **`tsconfig.json`** (ESNext / NodeNext, with `rewriteRelativeImportExtensions`
   so the `.ts`-suffixed relative imports type-check):
   ```json
   {
     "compilerOptions": {
       "target": "ESNext",
       "module": "NodeNext",
       "lib": ["ES2023"],
       "declaration": true,
       "strict": true,
       "noImplicitAny": true,
       "strictNullChecks": true,
       "noImplicitThis": true,
       "alwaysStrict": true,
       "noUnusedLocals": false,
       "noUnusedParameters": false,
       "noImplicitReturns": true,
       "noFallthroughCasesInSwitch": false,
       "inlineSourceMap": true,
       "inlineSources": true,
       "experimentalDecorators": true,
       "strictPropertyInitialization": false,
       "typeRoots": ["./node_modules/@types"],
       "moduleResolution": "NodeNext",
       "rewriteRelativeImportExtensions": true,
       "erasableSyntaxOnly": true,
       "verbatimModuleSyntax": true
     },
     "exclude": ["node_modules", "cdk.out"]
   }
   ```

   **`bin/app.ts`** — entry point. Import the stack WITH the `.ts` extension and
   wire the env from `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`:
   ```ts
   #!/usr/bin/env node
   import * as cdk from 'aws-cdk-lib';
   import { MyTestStack } from '../lib/<test-name>-stack.ts';

   const app = new cdk.App();
   new MyTestStack(app, 'Cdkd<PascalCaseName>Example', {
     description: '<one-line description>',
     env: {
       account: process.env.CDK_DEFAULT_ACCOUNT,
       region: process.env.CDK_DEFAULT_REGION,
     },
   });
   ```

   **`lib/<test-name>-stack.ts`** — the stack. Keep it minimal: only the resource
   under test + its required dependencies. In the class docstring, add a
   `covers: AWS::Service::Type` line for each resource type the test is meant to
   cover (the coverage matrix in step 7 parses these annotations).

5. **Ask the user** what specific AWS resources the test should create, if not
   obvious from the test name.

6. **Write a `verify.sh`** (the most important deliverable — a deploy-only smoke
   test is NOT enough). Model it on `tests/integration/dynamodb-gsi-update/verify.sh`.
   It must:
   - `set -euo pipefail`, `cd "$(dirname "$0")"`, and define `STACK`, `REGION`
     (`${AWS_REGION:-us-east-1}`), `STATE_KEY`, and
     `LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"`.
   - Require `STATE_BUCKET` (fail fast if unset) and the built `dist/cli.js`.
   - Define a `cleanup()` and arm it on EXIT **and both signals**; run it once
     up-front as a pre-run cleanup:

     ```bash
     trap cleanup EXIT
     trap '(exit 130); cleanup; exit 130' INT
     trap '(exit 143); cleanup; exit 143' TERM
     ```

     `trap cleanup EXIT INT TERM` is NOT equivalent and must never be used — a
     bash signal handler returns to the interrupted point, so the script resumes
     the interrupted phase and can `exit 0`, reporting PASS while resources leak.
     The `(exit N)` seed is also load-bearing: inside a handler `$?` is the
     interrupted command's status, so a `cleanup` opening with `rc=$?` would
     otherwise see 0 and skip teardown. Disarm with `trap - EXIT INT TERM`.
     Enforced by `tests/unit/scripts/integ-verify-signal-traps.test.ts` (#1097).

     cleanup must `node "${LOCAL_DIST}" state destroy`, delete
     the AWS resources by deterministic name, remove the `state.json` + `lock.json`,
     and **sweep `/aws/lambda/${STACK}*` log groups** (Lambda auto-creates them on
     invoke and neither CFn nor cdkd deletes them — leaving them counts as an
     orphan).
   - **Phase 1 — deploy**, then a **functional assertion that the feature
     actually works and reached AWS** (curl the endpoint / put an object and
     confirm the handler fired / read the property back via the AWS API). A clean
     deploy summary is not proof.
   - **Phase 2 — UPDATE** when the resource has a meaningful in-place change
     (gate the stack on `process.env.CDKD_TEST_UPDATE === 'true'`). Set the env
     PER-PHASE: Phase 1 baseline via `env -u CDKD_TEST_UPDATE node ... deploy`,
     Phase 2 via inline `CDKD_TEST_UPDATE=true node ... deploy`. Never gate the
     whole phase on a caller-set global env. Assert the change reached AWS AND
     that it was in-place, not a replacement (e.g. an identity field like
     DynamoDB `CreationDateTime` is unchanged).
   - **Final phase — destroy** (`--force`), then assert the resource is gone, the
     `state.json` is gone, and sweep the log groups again. Gone-assertions MUST
     go through the canonical `gone_probe` / `assert_gone` helper block (copy it
     verbatim from any swept fixture, e.g.
     `tests/integration/dynamodb-gsi-update/verify.sh`; source of truth in
     `scripts/check-integ-probe-not-found.ts`), inserted right after
     `set -euo pipefail`:

     ```bash
     assert_gone "resource <name> still exists after destroy" aws <service> <read-verb> [args...]
     assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
     ```

     Never write `if aws <read-probe> ... >/dev/null 2>&1; then FAIL` (or the
     inverse `if ! aws ...; then <gone>`): a throttled probe would silently
     pass the leak check (issue #1097 pattern 2). Use `s3api head-object` for
     state files, never `aws s3 ls` (exit 1 + empty output for "no keys" is
     indistinguishable from a silenced error). Enforced by
     `tests/unit/scripts/integ-verify-probe-not-found.test.ts`.
   - End with a single `echo "[verify] PASS — ..."` line (the run-integ harness
     greps for it).
   - `chmod +x verify.sh`.

7. **Regenerate the coverage matrices** (adding/removing a Construct changes
   them, and CI hard-fails on a stale matrix — `/check` does NOT catch this):
   ```bash
   vp run integ-coverage && vp run scenario-coverage && vp run format
   ```
   Commit the regenerated `docs/_generated/*.json` alongside the fixture.

8. **Install deps + verify synthesis**:
   ```bash
   cd tests/integration/<test-name> && npm install
   node ../../../dist/cli.js synth --region us-east-1
   ```

9. **Run the full test** with `/run-integ <test-name>` (deploy + functional +
   destroy + orphan-zero verification against real AWS). A fixture that has never
   passed `/run-integ` is worse than no fixture — never commit one unrun.

## Important

- Keep tests minimal — only the resources needed to verify the behavior.
- **English only** — this is an OSS repo; no Japanese characters in any committed
  file (code, comments, shell scripts, READMEs).
- Do NOT include `stateBucket` in `cdk.json` context (let the CLI resolve it).
- Use `RemovalPolicy.DESTROY` (and `autoDeleteObjects: true` on buckets) so
  teardown is clean.
- Prefer `lambda.Code.fromInline(...)` for handlers — no asset bundling needed,
  and `@aws-sdk/client-*` is already in the Node.js 20 runtime.
- Stack id convention: `Cdkd<PascalCaseName>Example` (matches the `STACK` var in
  verify.sh). Some older fixtures use `<PascalCaseName>Stack`; follow the
  `Cdkd...Example` form for new tests.
- Do NOT commit `node_modules/`, `package-lock.json`, `cdk.out/`, or build output
  (`*.js` / `*.d.ts`) — `tests/integration/.gitignore` covers them.
