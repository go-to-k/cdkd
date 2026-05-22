# `cdkd migrate --from-cfn-stack`: adopt plain (non-CDK) CFn stacks

**Issue**: [#465](https://github.com/go-to-k/cdkd/issues/465)
**Status**: Design (no implementation)
**Wave**: 4

## 1. Goal & non-goals

### Goal

One-command path from a plain (non-CDK) CloudFormation stack — hand-authored
YAML / JSON, Terraform-to-CFn output, AWS Console-created stack updated via the
API, etc. — to a cdkd-managed CDK app. End state:

- A NEW TypeScript CDK app generated at the user-supplied output directory,
  with L1 (`Cfn*`) constructs mirroring every importable AWS resource.
- AWS resources unchanged in shape / count / ARN.
- cdkd state populated; subsequent `cdkd diff` / `cdkd deploy` / `cdkd destroy`
  work against the generated app.
- Optionally: the source CFn stack retired (every resource gets
  `DeletionPolicy: Retain` then `DeleteStack`), so management responsibility
  fully transfers to cdkd.

### Non-goals

- **L1-codegen surface**: cdkd does NOT own the per-CFn-type code-template
  table. That's a CDK CLI concern and the long tail of new resource types is
  large and changes with each AWS release. cdkd shells out to upstream
  `cdk migrate`.
- **L2 / L3 abstraction in generated code**: matches `cdk migrate`'s own
  output — every resource is L1. Refactoring to L2 / L3 is a downstream user
  task.
- **Non-TypeScript output in v1**: `cdk migrate` supports ts / go / java /
  python / csharp; cdkd v1 targets TypeScript only (the language cdkd-shipped
  examples and most users use). Adding go / py / csharp is a follow-up PR
  whose only delta is a `--language <choice>` pass-through.
- **In-place adoption without generating a CDK app**: would be a third
  migration mode and bypasses the user need this issue addresses (managing
  the stack as code going forward).
- **Plain-CFn stacks with `Transform: AWS::Serverless` (SAM)**: `cdk migrate`
  itself supports these inconsistently; surfaced as a known limitation.
- **Nested CloudFormation stacks** (`AWS::CloudFormation::Stack`): cdkd has
  no provider for that type; surface as out-of-scope at pre-flight.

## 2. Three-phase flow

```
┌────────────────────────────────────────────────────────────────────┐
│ User: cdkd migrate --from-cfn-stack <CfnStackName>                 │
│                    [--output-dir <dir>]                            │
│                    [--language typescript]                         │
│                    [--retire-cfn-stack]                            │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │
                                   ▼
            ┌──────────────────────────────────────────┐
            │ Phase 1: L1 codegen                      │
            │  Spawn `cdk migrate --from-stack         │
            │    --stack-name <N> --output-path <D>    │
            │    --language typescript                 │
            │    --region <R> [--account <A>]`         │
            │                                          │
            │  Pre-flight: verify `cdk` CLI installed  │
            │  + version >= 2.124.0                    │
            └──────────────────────┬───────────────────┘
                                   │ Output: <dir>/<StackName>/
                                   │   ├── bin/<stack-name>.ts
                                   │   ├── lib/<stack-name>-stack.ts
                                   │   ├── cdk.json
                                   │   ├── package.json
                                   │   └── ...
                                   ▼
            ┌──────────────────────────────────────────┐
            │ Phase 2: Synthesis                       │
            │  cd <generated-dir>                      │
            │  npm install (or skip if --skip-install) │
            │  cdk synth → cdk.out/                    │
            │                                          │
            │  cdkd then reads <generated-dir>/cdk.out │
            │  to drive the import phase.              │
            └──────────────────────┬───────────────────┘
                                   │ cdk.out/<StackName>.template.json
                                   ▼
            ┌──────────────────────────────────────────┐
            │ Phase 3: Adoption (existing flow)        │
            │  cdkd import <StackName>                 │
            │    --app <generated-dir>/cdk.out         │
            │    --migrate-from-cloudformation         │
            │    <CfnStackName>                        │
            │    [--retire-cfn-stack]                  │
            │                                          │
            │  Uses the existing DescribeStackResources│
            │  → overrides → import → optional retire  │
            │  pipeline. No new state-writing code     │
            │  needed; this is a thin orchestrator.    │
            └──────────────────────┬───────────────────┘
                                   │
                                   ▼
                  cdkd-managed CDK app + cdkd state
                       AWS resources unchanged
```

**Important**: cdkd does NOT own phase 1 (L1 codegen). It spawns the existing
upstream `cdk migrate` CLI as a subprocess. The user must have aws-cdk
installed (`npm i -g aws-cdk` or equivalent).

**Important**: phase 3 is the **existing** `cdkd import
--migrate-from-cloudformation` machinery
([src/cli/commands/import.ts](../../src/cli/commands/import.ts) +
[retire-cfn-stack.ts](../../src/cli/commands/retire-cfn-stack.ts)). The new
`cdkd migrate` command does NOT introduce a new state-writing or retirement
code path — it only orchestrates phase 1 + phase 2 + invokes the existing
phase 3.

## 3. CLI shape

### Command

```
cdkd migrate --from-cfn-stack <CfnStackName> [options]
```

### Required arg

- `--from-cfn-stack <CfnStackName>` — name of the CFn stack to adopt.

### Common options

| Flag | Default | Notes |
|------|---------|-------|
| `--output-dir <dir>` | `./<CfnStackName>` (cwd + stack name) | Where the generated CDK app is written. Symmetric with `cdk migrate --output-path`. |
| `--language <choice>` | `typescript` | v1: TypeScript only. Future: pass-through to `cdk migrate --language`. |
| `--region <region>` | `AWS_REGION` env / profile region | Threaded into `cdk migrate --region` AND `cdkd import`'s region resolution. |
| `--account <id>` | inferred via STS | Passed to `cdk migrate --account` when set. Optional; the upstream CLI auto-detects too. |
| `--retire-cfn-stack` | off | When set, runs the existing retirement flow after the import (inject `Retain` policies → `UpdateStack` → `DeleteStack`). Symmetric with `cdkd import --migrate-from-cloudformation`'s implicit retirement. |
| `--filter <key=value>` | none (full stack) | Pass-through to `cdk migrate --filter` for resource subsetting. Repeatable. **Use with care**: a partial migration must NOT leave dangling references; pre-flight rejects when `--retire-cfn-stack` is also set unless the filter covers every resource. |
| `--skip-install` | off | Skip `npm install` after codegen. Useful in CI with a pre-populated cache. |
| `--skip-synth` | off | Skip the `cdk synth` step. Surfaces only the generated source code; cdkd state is NOT written. For users who want to review the code before adopting. Mutually exclusive with `--retire-cfn-stack`. |
| `--dry-run` | off | Runs phase 1 (codegen) + phase 2 (synth) but skips phase 3. Symmetric with the existing `--dry-run` semantics. NOT compatible with `--retire-cfn-stack` (same constraint as `cdkd import --migrate-from-cloudformation`). |
| `-y` / `--yes` | off | Auto-confirm the import + retirement prompts. CDK CLI parity. |
| `--cdk-bin <path>` | `cdk` (PATH lookup) | Override the `cdk` binary path. Useful when multiple CDK CLI versions coexist on a developer's machine. |
| `--state-bucket <name>` | auto-resolved | Standard cdkd state-bucket flag, threaded into phase 3. |
| `--profile <name>` | AWS profile chain | Threaded into BOTH `cdk migrate` (via env) AND every cdkd SDK client. |
| `--role-arn <arn>` | none | Same semantic as every other cdkd command — assumes the role once at start, threads creds via `AWS_*` env vars to both the `cdk migrate` subprocess and cdkd's own SDK clients. |

### Example invocations

```bash
# Bare minimum: adopt a hand-authored CFn stack named "legacy-billing" into a
# CDK app at ./legacy-billing, leave the source CFn stack alive.
cdkd migrate --from-cfn-stack legacy-billing

# Full migration: adopt + retire the source CFn stack.
cdkd migrate --from-cfn-stack legacy-billing --retire-cfn-stack --yes

# Custom output directory + region.
cdkd migrate --from-cfn-stack prod-network \
  --output-dir apps/prod-network-cdk \
  --region us-west-2 \
  --retire-cfn-stack

# Dry run (preview generated code + import plan, no state writes).
cdkd migrate --from-cfn-stack legacy-billing --dry-run
```

## 4. Dependency on upstream `cdk` CLI

### Version requirement

- **Minimum**: aws-cdk `>= 2.124.0` (the release where `cdk migrate
  --from-stack` stabilized).
- **Recommended**: latest 2.x. cdkd verifies via `cdk --version` and warns on
  versions below the recommended minimum (does NOT hard-error below the
  minimum; the user may have a working older version and we should not
  gratuitously block migration). **Hard-error only when `cdk` is missing
  entirely.**

### Pre-flight checks (before phase 1)

1. `command -v cdk` (or `which cdk`): if missing → throw `MissingCdkCliError`
   with the install hint: `npm install -g aws-cdk@latest`. Surface exits with
   code 1, never starts the migration.
2. `cdk --version` parse: warn if `< 2.124.0`, log at debug if `>= 2.124.0`.
3. STS `GetCallerIdentity` (existing cdkd pre-flight): verify AWS credentials
   are usable for both `cdk migrate` (which needs `cloudformation:GetTemplate`
   + `cloudformation:DescribeStacks`) and the subsequent import (which needs
   admin-equivalent per the role-arn rules).

### Spawn contract

`cdk migrate` is spawned as a SUBPROCESS, NOT embedded as a Node module
import. Rationale:

- `cdk migrate`'s codegen depends on a pinned `aws-cdk-lib` runtime version
  that cdkd has no clean way to inject. Subprocess isolation means cdkd's own
  `aws-cdk-lib` peerDep doesn't have to match.
- The aws-cdk CLI is published as a CommonJS bundle with internal modules
  not exposed at any stable public API. There is no "library mode".
- Subprocess gives cdkd a clear failure boundary: capture `stderr`, surface
  to the user as `LocalMigrateError` with the upstream output preserved
  inline.

Command shape:

```bash
cdk migrate \
  --from-stack \
  --stack-name <CfnStackName> \
  --output-path <output-dir> \
  --language typescript \
  --region <region> \
  [--account <id>] \
  [--filter <k=v>...] \
  [--profile <name>]
```

The `--profile` and `AWS_*` env vars are inherited from cdkd's own resolved
identity (after `--role-arn` STS assume, if used). `stdout` and `stderr` are
streamed to cdkd's logger at info / warn so the user sees `cdk migrate`'s
own diagnostic output inline.

## 5. What if `cdk migrate` codegen produces something cdkd can't deploy?

`cdk migrate` is an upstream tool with known gaps. cdkd's responsibility is
to detect and surface these clearly, NOT to silently work around them.

### Known L1-resource gaps

The `cdk migrate` output reflects the per-CFn-type table maintained in
aws-cdk-cli. Resource types added to AWS very recently MAY not have a
generated L1 construct, in which case the synth in phase 2 fails. cdkd
surfaces the synth error verbatim and recommends:

1. Upgrade aws-cdk CLI to the latest version (gets the newest L1 generator).
2. If still missing: file an issue against aws-cdk; meanwhile, hand-edit the
   generated `lib/<stack>-stack.ts` to add the missing `CfnResource(...)`
   call, then re-run from phase 2 with `cdkd migrate --from-cfn-stack
   <name> --skip-codegen` (NEW flag — see "Resume semantics" below).

### CFn features `cdk migrate` does NOT support

- **Custom Resources** (`Custom::*`, `AWS::CloudFormation::CustomResource`):
  `cdk migrate` emits these as raw `CfnResource` calls. cdkd's `import`
  phase rejects Custom Resources by design (the backing Lambda's CFn
  response-URL protocol is incompatible with cdkd's import flow — see
  `cdkd export --include-non-importable` for the inverse direction).
  Surfaced as a hard pre-flight error after phase 1 + phase 2 with a clear
  message: the user must either (a) hand-author CDK constructs that replace
  the Custom Resource semantics, or (b) delete the Custom Resource from the
  CFn stack before migrating.
- **`Transform: AWS::Serverless` (SAM)**: `cdk migrate` itself produces
  malformed output for some SAM resources (the transformed template differs
  from the original; round-trip is unreliable). Surfaced as a WARN at
  pre-flight; the user is told the migration may not produce a clean
  template.
- **`Transform: AWS::Include`**: same caveat as SAM. WARN.
- **Nested stacks** (`AWS::CloudFormation::Stack`): aws-cdk-cli has its own
  policy here, but cdkd has NO provider for this type, so even if `cdk
  migrate` produced clean code, phase 3 (`cdkd import`) would reject. Hard
  pre-flight error after `cdk migrate` completes.
- **Resources with `DeletionPolicy: Retain` already set**: passes through
  fine; the retirement step's `injectRetainPolicies` is idempotent.

### Resume semantics (advanced)

`cdkd migrate` is a 3-phase pipeline. Failures in any one phase should leave
the user in a recoverable state:

- **Phase 1 fails** (codegen): the output directory may be partially
  populated. cdkd does NOT delete it (the user might want to inspect for
  debugging). A re-run of `cdkd migrate` against an existing non-empty
  output dir hard-errors with a clear message: either delete the dir, pass
  `--output-dir <new>`, or skip codegen with `--skip-codegen` (deferred
  flag).
- **Phase 2 fails** (synth): the user can hand-edit the generated code and
  re-run with `--skip-codegen` to retry from phase 2.
- **Phase 3 fails** (import or retire): the import phase is idempotent
  (state is written ONCE per resource); the retire phase is a separate
  AWS-side operation. The user can re-run with `--skip-codegen --skip-synth`
  to retry from phase 3.

**Note on `--skip-codegen` and `--skip-synth`**: these are mentioned in v1's
help text but deferred to a follow-up PR. The MVP runs all three phases
end-to-end; the user re-runs from scratch (after fixing the underlying issue)
when something fails. Resume support is a UX improvement, not a correctness
requirement.

## 6. Resource-mapping handling — the critical constraint

### The problem

`cdk migrate` generates CDK code where each AWS resource gets a CDK logical
ID **derived from the resource type and properties** — NOT from the
original CFn stack's logical IDs. For example, an AWS::S3::Bucket originally
named `MyOldBucketLogicalId` in the source CFn template might become
`Bucket` (or `MyBucket1234ABCD` after CDK's hash suffix) in the generated
CDK code. The CDK code's emitted CFn template after `cdk synth` will then
have a DIFFERENT logical ID than what AWS-deployed CFn stack records.

cdkd's import phase needs a `(generatedLogicalId, physicalId)` mapping to
write state. The existing `cdkd import --migrate-from-cloudformation` uses
`DescribeStackResources` against the SOURCE CFn stack, which returns
`(oldLogicalId, physicalId)` — and the mapping key doesn't match the
generated CDK code.

### What `cdk migrate` provides

After verifying against `aws-cdk-cli/packages/aws-cdk/lib/commands/migrate.ts`:

`cdk migrate` does NOT emit a sidecar JSON mapping file. The mapping
between original CFn logical IDs and generated CDK logical IDs is implicit
in the generated source code, and recoverable only by:

1. **Synthesizing** the generated CDK app and getting `cdk.out/<Stack>.template.json`.
2. Walking `Resources` in the synth template AND in the source CFn template,
   matching by `Type` + (heuristically) by `Properties` content.

This is a load-bearing constraint that the design must address.

### cdkd's approach

After phase 2 (synth) but before invoking phase 3 (`cdkd import`), cdkd
runs a **resource-mapping reconciliation step**:

1. Fetch the source CFn template via `cloudformation:GetTemplate(Original)`.
2. Read the synthesized CDK template from `<output-dir>/cdk.out/<Stack>.template.json`.
3. For each resource in the source template, find the matching resource in
   the synth template by `(Type, sorted-Properties-shape)` — `cdk migrate`'s
   codegen is deterministic enough that this matching is reliable for the
   90% case.
4. Build a `Map<generatedLogicalId, physicalId>` by reading
   `DescribeStackResources(<CfnStackName>)` for `(oldLogicalId, physicalId)`
   and joining on `oldLogicalId → generatedLogicalId` from step 3.
5. Pass the resulting map to `cdkd import` as `--resource-mapping-inline
   '<json>'` overrides (uses the existing flag — `cdkd import` already
   accepts inline mapping).

**When the auto-matching fails** (= source resource has no matching synth
resource, or two source resources map to the same synth resource):

- Surface a per-resource error with both logical IDs and the failure
  reason.
- Write a partial `<output-dir>/cdkd-resource-mapping.json` file with the
  matches that DID succeed.
- Hard-error and instruct the user to: (a) hand-edit the JSON file to add
  the missing entries, (b) re-run with `cdkd migrate --from-cfn-stack
  <name> --skip-codegen --skip-synth --resource-mapping
  <output-dir>/cdkd-resource-mapping.json` (deferred-to-follow-up resume
  flow as described above).

### Why this isn't fixed upstream

There's an open `aws-cdk-cli` discussion about emitting a sidecar
resource-mapping file from `cdk migrate`, but the AWS CDK team has not
prioritized it. cdkd's matching step is cdkd-specific glue that bridges
this gap. A future upstream feature would simplify the design (cdkd would
read the sidecar file directly), but is NOT a blocker for the v1
implementation.

## 7. State semantics post-migration

After a successful end-to-end migration:

| What | State |
|------|-------|
| AWS resources | **Unchanged**. Same ARNs, same physical IDs, same configuration. |
| Source CFn stack | If `--retire-cfn-stack`: **deleted** (every resource was first marked `Retain`, so AWS keeps the resources but drops the CFn stack record). Otherwise: **untouched**; the user may run `cdkd state destroy <CfnStackName>` later as a separate step. |
| cdkd state | New entry in `s3://<state-bucket>/cdkd/<StackName>/<region>/state.json` with one `ResourceState` per imported resource. Schema v3+ with `observedProperties` populated from the post-import AWS-current snapshot. |
| Generated CDK app | At the user-chosen `--output-dir`. The user OWNS this code going forward: commits to their repo, edits as needed, etc. cdkd never re-runs codegen against the same stack. |
| Source CFn stack management | Transferred to cdkd. `cdk deploy` against the generated app uses cdkd's deployment engine (since `cdk.json`'s `"app"` line points at the CDK app, but the user invokes `cdkd deploy` not `cdk deploy`). |

The key invariant: **AWS resources are never deleted, never modified, never
re-created**. The migration is purely a metadata transfer from CFn-managed
to cdkd-managed.

### What if the user wants to roll back?

After migration but BEFORE running any `cdkd deploy` against the new app:

- If `--retire-cfn-stack` was NOT used: the source CFn stack is still alive;
  just run `cdkd state orphan <StackName>` to drop cdkd's state record and
  the resources are back to being CFn-managed. No AWS-side impact.
- If `--retire-cfn-stack` WAS used: the source CFn stack is gone. To roll
  back, the user would need to either (a) run `cdkd export <StackName>` to
  hand the resources back to a fresh CFn stack, or (b) keep them
  cdkd-managed. This is a deliberate trade-off: the user opted into the
  full migration with `--retire-cfn-stack`; partial rollback after that
  point requires the explicit `cdkd export` step.

## 8. Implementation strategy

### New files

- `src/cli/commands/migrate.ts` — new top-level `cdkd migrate` command.
  Top-level command (not a flag on `cdkd import`) because the output is a
  NEW CDK app, semantically a different operation, and preserves `cdkd
  import`'s invariant ("input: existing CDK app + existing AWS resources").
- `src/cli/cdk-migrate-spawn.ts` — thin wrapper around `child_process.spawn`
  for the `cdk migrate` subprocess. Captures stdout / stderr, streams to
  logger, throws `LocalMigrateError` on non-zero exit.
- `src/cli/cdk-migrate-resource-mapper.ts` — the source-CFn-template ↔
  synth-template matching logic (Section 6).
- `src/utils/error-handler.ts` — extend with `MissingCdkCliError` (exit
  code 1, install-hint message) and `LocalMigrateError` (wraps upstream
  `cdk migrate` failures with stdout / stderr inline).

### Reused files

- `src/cli/commands/import.ts` — invoked as a library function (not a
  subprocess). The import command's body is already factored into a
  `runImport(...)` helper invoked from the CLI handler; `cdkd migrate`
  calls the same helper directly.
- `src/cli/commands/retire-cfn-stack.ts` — `retireCloudFormationStack(...)`
  invoked when `--retire-cfn-stack` is set. Same helper that
  `cdkd import --migrate-from-cloudformation` already uses.
- `src/cli/options.ts` — extend with the new flags.

### What this PR does NOT need to add

- No new state-writing code. Phase 3 reuses the existing import flow
  unchanged.
- No new retirement code. Phase 3 reuses `retireCloudFormationStack`.
- No new provider code. Every resource that `cdk migrate` produces is one
  of the existing AWS resource types covered by cdkd's import providers.

### Test strategy

- **Unit tests**:
  - Mock `child_process.spawn` for the `cdk migrate` subprocess; assert the
    spawn args (`--from-stack`, `--stack-name`, `--output-path`,
    `--language`, region / account / filter / profile passthroughs).
  - Mock `cdk --version` check (no `cdk` → throws; old version → warns;
    new version → passes).
  - Unit-test the source-CFn-template ↔ synth-template matching helper
    against representative fixtures (S3 bucket, Lambda function, IAM role,
    DynamoDB table — covering the simple-property and nested-property
    matching).
  - Mock the import phase invocation; assert that the resolved
    `(generatedLogicalId, physicalId)` mapping is threaded through as
    `--resource-mapping-inline`.
- **Real-AWS integration test** at `tests/integration/migrate-from-bare-cfn/`:
  1. Pre-create a 3-resource CFn stack via raw `aws cloudformation
     create-stack` (no CDK): an S3 bucket + an SSM parameter + an SNS topic.
  2. Run `cdkd migrate --from-cfn-stack <name> --output-dir /tmp/migrate-out
     --retire-cfn-stack --yes`.
  3. Assert: generated CDK app exists at `/tmp/migrate-out`; cdkd state
     populated; source CFn stack reaches `DELETE_COMPLETE`; AWS resources
     still exist (verify via `aws s3api head-bucket`, `aws ssm
     get-parameter`, `aws sns get-topic-attributes`).
  4. Cleanup: `cdkd destroy <StackName>` against the cdkd-managed stack
     (uses the new CDK app), verify all 3 AWS resources are gone, verify
     cdkd state record is gone.
- The integ test exercises the `integ-broad` scope (touches a top-level CLI
  command + the synthesis + import + retire pipeline) so its run refreshes
  both `integ-destroy` and `integ-broad` markgate markers.

### Documentation updates

- `docs/cli-reference.md` — new "`cdkd migrate`" subsection.
- `docs/import.md` — add a "Plain CFn stack adoption" subsection pointing at
  the new command. Remove the "Plain (non-CDK) CloudFormation stacks are out
  of scope: chain `cdk migrate` ..." caveat at the bottom (this is the
  deferral that #465 closes).
- `CLAUDE.md` — under "src/cli/", replace the same "out of scope" sentence
  with a one-line pointer to `cdkd migrate`.
- `README.md` — under "Importing existing resources", add the bare-CFn entry.

## 9. Open questions

1. **Should `cdkd migrate` write a `cdkd-resource-mapping.json` to the output
   directory unconditionally, or only on partial-match failure?**
   Recommendation: write it unconditionally as `cdkd-resource-mapping.json`
   in the output dir, so the user has an auditable record of what mapped to
   what and can replay it in the future `--skip-codegen --skip-synth` resume
   flow.

2. **`cdk migrate`'s `--language` non-TypeScript output (go / python / java /
   csharp): when do we open them up?**
   Recommendation: defer to a follow-up issue. cdkd's own examples and
   integration tests are TypeScript; the migration produces code the user
   then maintains, so opening up other languages would force cdkd to verify
   they synthesize cleanly against the user's downstream toolchain. Punt to
   v2 once we have a real user request for a non-TS language.

3. **Should `--retire-cfn-stack` be the default behavior?**
   Recommendation: NO — keep it opt-in. The destructive side effect (source
   CFn stack `DeleteStack`) is exactly what users would NOT expect from
   `cdkd migrate` by default; mirroring `cdkd destroy`'s opt-in confirmation
   pattern. Document the recommended workflow as `cdkd migrate
   --from-cfn-stack <name>` (review the generated CDK app, run `cdkd diff`
   to confirm no surprise changes) THEN `cdkd migrate --from-cfn-stack <name>
   --retire-cfn-stack` (or the equivalent "complete the migration" command).

4. **Should the source-CFn-template ↔ synth-template matching live in cdkd or
   upstream?**
   Long-term: would be cleaner if `cdk migrate` emitted the mapping. We
   should file an upstream issue against aws-cdk after shipping the cdkd v1
   implementation, with our matching algorithm as a starting point — if /
   when upstream accepts it, cdkd's matching helper can become a thin
   sidecar-file reader.

5. **`cdk migrate` `--filter` pass-through: what's the right safety guard?**
   The user can use `--filter` to migrate a subset of the CFn stack's
   resources, but the leftover resources stay in the CFn stack (since
   `--retire-cfn-stack` would then DeleteStack and we'd lose them).
   Recommendation: when BOTH `--filter` AND `--retire-cfn-stack` are set,
   pre-flight rejects with a clear error explaining that partial migration
   + full retirement leaves the leftover resources stranded. The user must
   either drop one of the flags or accept the trade-off explicitly via a
   `--accept-partial-retirement` confirmation flag (deferred to a follow-up
   if anyone actually asks for it).

6. **What about CFn stacks in DRIFT_DETECTION_IN_PROGRESS or similar
   transient states?**
   The existing `retireCloudFormationStack` already validates against
   `STABLE_TERMINAL_STATUSES`; the same validation runs before phase 1
   (via a `DescribeStacks` pre-flight) so the user gets a clean error
   without wasting time on phase 1 + 2 codegen + synth.

7. **`cdk migrate`'s `--from-scan` mode (scan account for resources NOT in a
   stack) — should cdkd support that too?**
   No. `--from-scan` is a fundamentally different workflow ("adopt random
   account resources into a stack") and orthogonal to "adopt an existing
   CFn stack". File as a separate issue if anyone asks. The `--from-cfn-stack`
   name in cdkd's CLI explicitly scopes it to the CFn-stack-source case.
