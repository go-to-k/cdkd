---
title: Deploy: safety & compatibility flags
description: "Safety and compatibility flags for cdkd deploy — unsupported types and properties, recreate/replace escape hatches, strict GetAtt, unaddressed resources, and the CloudFormation-fallback opt-out."
---

## `--allow-unsupported-types` (deploy + destroy)

cdkd rejects genuinely-unsupported resource types at **pre-flight** —
before any resource is touched — instead of letting them fail mid-deploy
with an opaque Cloud Control error. A type is "unsupported" when AWS
reports it as `ProvisioningType: NON_PROVISIONABLE` (the provider-coverage
**Tier 3** set: Cloud Control API cannot create/update/delete it) AND cdkd
has no SDK provider for it. The Tier 3 set is generated from the audit
cache into the runtime at `src/provisioning/unsupported-types.generated.ts`
(`vp run gen:unsupported-types`; CI fails if it drifts).

When pre-flight hits one, the error names each type, the reason, a 1-click
pre-filled GitHub issue link to request support, and the exact re-run
command:

```text
The following resource types are not supported by cdkd:
  - AWS::AppMesh::Mesh
      AWS reports this type as NON_PROVISIONABLE (Cloud Control API cannot
      manage it) and cdkd has no SDK provider for it.
      Request support: https://github.com/go-to-k/cdkd/issues/new?title=...

To attempt deployment anyway (Cloud Control will likely fail for
NON_PROVISIONABLE types), re-run with: --allow-unsupported-types AWS::AppMesh::Mesh
```

`--allow-unsupported-types <types>` is the **escape hatch**: a
comma-separated (and repeatable) list of types to attempt via Cloud
Control anyway. It is per-type rather than a blanket override so you
explicitly acknowledge each type. Useful mainly for a type the cached
audit marks Tier 3 that AWS has since made provisionable (regenerate the
audit with `vp run audit:coverage:regenerate` for the permanent fix). It
is available on both `cdkd deploy` and `cdkd destroy` (and `cdkd state
destroy`) so a stack deployed with the flag can also be torn down.

```bash
cdkd deploy MyStack --allow-unsupported-types AWS::AppMesh::Mesh,AWS::Budgets::Budget
cdkd destroy MyStack --allow-unsupported-types AWS::AppMesh::Mesh,AWS::Budgets::Budget
```

## `--allow-unsupported-properties` (deploy)

When a CDK template uses a **top-level CFn property** that cdkd's SDK
provider would silently drop on write (e.g. AWS adds `CapacityProviderConfig`
to `AWS::Lambda::Function`, CDK adds support, you write it in your CDK code,
but `LambdaFunctionProvider.create()` does not read it yet), cdkd **auto-routes
the resource through Cloud Control API** by default. Cloud
Control forwards the full property map to AWS verbatim, so the silent
drop is closed without any user intervention — the field reaches AWS.

The routing decision is recorded on the resource's state record as
`provisionedBy: 'cc-api'` and stays sticky for the resource's lifetime
(`cdkd drift`, `cdkd destroy`, etc. route through the same layer that
created it — even if cdkd later adds first-class SDK provider support
for the property). `cdkd state show <stack>` displays the
`ProvisionedBy:` field so you can audit which layer owns each resource.

The set of handled vs silently-dropped properties is generated from the
CFn schema fixtures + each SDK provider's `handledProperties` /
`unhandledByDesign` declarations into the runtime at
`src/provisioning/property-coverage.generated.ts` (`vp run gen:property-coverage`;
CI fails if it drifts). Coverage is per Tier 1 (SDK provider) type only —
Tier 2 (Cloud Control fallback) types already forward the full property
map to AWS, so the auto-route is a no-op for them.

When the auto-route fires, cdkd logs an info line per affected resource:

```text
[info] MyLambda (AWS::Lambda::Function): routing via Cloud Control API
       (cdkd's SDK Provider does not yet wire CapacityProviderConfig — CC API
        will forward the full property map. Override via
        --allow-unsupported-properties AWS::Lambda::Function:CapacityProviderConfig.)
```

### `--allow-unsupported-properties <entries>` (override)

The flag is the **opt-out** from the default CC auto-route. Each entry
is a `<ResourceType>:<PropertyName>` token (comma-separated and
repeatable); the flag pins the resource to the SDK provider path and
**accepts the silent drop** for the named property. A warn line is
logged so the silent drop is auditable.

```bash
cdkd deploy MyStack --allow-unsupported-properties AWS::Lambda::Function:CapacityProviderConfig,AWS::Lambda::Function:FunctionScalingConfig
```

Per type+property pair (not blanket) so you explicitly acknowledge each
silent drop. The flag is `deploy`-only — destroy uses the per-resource
physical ID and the state-recorded `provisionedBy` layer, not the
template properties.

Properties that do not appear in the CFn schema pass through silently —
these are usually `addPropertyOverride` escape hatches or typos, both of
which CFn itself tolerates. Read-only properties (AWS-managed Arns, Ids,
etc.) also pass through silently; you cannot set them from the template
side and they are no-ops if they appear there.

### When to use the override flag (auto-route opt-out guidance)

The auto-route is the default because silent drop is a real bug class
(the deployed resource is missing fields the user wrote). Cloud Control
closes the bug by forwarding the full property map. The flag is the
**opt-out** for situations where you specifically want the SDK provider
path even at the cost of the silent drop.

#### Use the flag when

- **You need the SDK provider's fast synchronous-AWS-call path** and the
  dropped property is non-essential for your use case (e.g. a structural
  CDK construct emits a property you do not care about).
- **A Cloud Control side-effect bothers you** — e.g. CC names a resource
  differently than cdkd's SDK provider would have, and you want the SDK
  naming convention to win.
- **You have an existing SDK-managed resource** (`provisionedBy: 'sdk'`)
  that you want to keep on the SDK path even after a new property
  appears in the template. Without the flag, the next deploy would
  auto-route it through CC (the routing decision re-evaluates per
  deploy — only a resource whose state already says `'cc-api'` is
  sticky to CC; a still-SDK resource with new silent-drop properties
  re-routes).

#### Do NOT use the flag when

- **The dropped property is security-meaningful** — e.g. `KmsKeyArn`,
  `MonitoringRoleArn`, `MasterUserSecret`, IAM policy attachments,
  resource-policy fields, encryption settings, TLS configuration.
  Silent drop here is a real-world incident. Without the flag, the
  auto-route closes the silent drop by sending the property to AWS via
  CC; with the flag, you opt back into the silent drop.
- **You are prototyping** and don't care about routing — the default
  auto-route already gets the property to AWS.

#### Decision summary

| Situation | Recommended action |
| --- | --- |
| Fresh deploy, template uses a silent-drop property | Default auto-route via Cloud Control (no flag needed) |
| Existing CC-managed resource, want to stay on CC | Default routing (sticky) — no flag needed |
| Existing SDK-managed resource, new silent-drop property appears | Default re-routes through CC. To stay on SDK, use `--allow-unsupported-properties` |
| You explicitly want SDK semantics + accept the silent drop | This flag |
| Property is security-meaningful | Do not use the flag — let the CC auto-route close the silent drop |

#### What the flag is NOT

- **NOT** a request to cdkd to start handling the property. The provider
  is unchanged; with the flag, the property is silently dropped at write
  time. (Without the flag, the resource takes the CC route and the
  property reaches AWS verbatim.)
- **NOT** persisted in cdkd state. Every deploy must pass the flag if
  the override is still desired; the resource's `provisionedBy` state
  field reflects the routing actually used at last deploy.

cdkd is currently a dev/test tool (see "Important Notes" in CLAUDE.md);
the CC auto-route closes a long-standing silent-drop bug class by
default. For production workloads, use the AWS CDK CLI until cdkd's
property coverage matches your needs.

## `--recreate-via-cc-api <LogicalId>` + `--force-stateful-recreation` (deploy)

`--recreate-via-cc-api <LogicalId>` (repeatable, one flag per resource)
destroys + recreates the named resource via Cloud Control API in this
deploy, so a previously-silent-dropped top-level CFn property reaches
AWS on the recreated copy. This is the mid-life counterpart to the
default-on auto-route for fresh deploys.

When to use it:

- An existing resource is `provisionedBy: 'sdk'` in cdkd state, and you
  want to start using a top-level CFn property cdkd's SDK provider does
  not yet wire (e.g. adding `CapacityProviderConfig` to an already-deployed
  Lambda). Adding the property on the next deploy alone won't reach AWS
  — the SDK update path drops it silently. The flag forces a destroy +
  recreate cycle so the new physical resource lands on CC and the
  property reaches AWS.

When NOT to use it:

- The resource is already `provisionedBy: 'cc-api'` (sticky). The
  update path already routes via CC; the recreate is a no-op.
  cdkd refuses pre-flight with `blockedAlreadyCcApi` — the
  destroy + recreate cycle would produce identical end state at the
  cost of unnecessary downtime. Mirror of the `blockedAlreadySdk`
  refusal on the reverse direction. Fix: drop the flag for that
  resource.
- Fresh deploy (the resource is not yet in cdkd state). The default
  auto-route handles fresh silent-drop deploys automatically — no flag
  needed.

```bash
# Recreate a single Lambda (stateless, no extra flag needed)
cdkd deploy MyStack --recreate-via-cc-api MyLambda --yes

# Recreate two Lambdas in one deploy (repeat the flag — comma-split is intentionally unsupported)
cdkd deploy MyStack \
  --recreate-via-cc-api MyLambda \
  --recreate-via-cc-api OtherFn \
  --yes

# Recreate a stateful resource — TWO flags required + data loss is acknowledged
cdkd deploy MyStack \
  --recreate-via-cc-api MyTable \
  --force-stateful-recreation \
  --yes
```

### Stateful-resource guard

The flag refuses to operate on resource types that carry user data
without `--force-stateful-recreation`. Two-flag protection mirrors the
`--remove-protection` pattern.

Guard list (always stateful — destroy loses ALL data, no automatic
migration):

| Category | Types |
| --- | --- |
| Database / storage | `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`, `AWS::DocDB::DBInstance`, `AWS::DocDB::DBCluster`, `AWS::Neptune::DBInstance`, `AWS::Neptune::DBCluster`, `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable` |
| Filesystem / blob | `AWS::EFS::FileSystem`, `AWS::FSx::FileSystem`, `AWS::ECR::Repository`, `AWS::EC2::Volume` |
| Streaming | `AWS::Kinesis::Stream` |
| Search | `AWS::Elasticsearch::Domain`, `AWS::OpenSearchService::Domain` |
| Identity / config | `AWS::Cognito::UserPool`, `AWS::SecretsManager::Secret`, `AWS::SSM::Parameter` |
| Metadata catalog | `AWS::Glue::Database`, `AWS::Glue::Table` |
| Edge | `AWS::CloudFront::Distribution` (URL changes break consumers; ~20-minute propagation) |

Conditionally stateful (guard fires only when the resource actually
contains data):

- `AWS::S3::Bucket` — guard fires when the bucket has at least one
  current version, prior version, or delete-marker. cdkd issues a
  single-page `s3:ListObjectVersions(MaxKeys=1)` against each S3 bucket
  target at plan time; empty buckets pass through,
  non-empty buckets (including versioned buckets whose current keys are
  soft-deleted but whose history is still retained) are refused unless
  `--force-stateful-recreation` is supplied. cdkd uses
  `ListObjectVersions` rather than `ListObjectsV2` so the probe's
  view of "empty" matches what the destroy + recreate cycle would
  actually wipe. If the probe itself fails (permission denied,
  transient network error), cdkd logs a warn and falls through to the
  conservative "not stateful" sync result — pass
  `--force-stateful-recreation` to proceed when the bucket might hold
  data and the probe could not be verified.
- `AWS::Logs::LogGroup` — guard fires when `RetentionInDays > 0` on the
  recorded state. Log groups without retention configured are treated
  as ephemeral.

There is no per-resource granularity on `--force-stateful-recreation`
— when set, EVERY named recreate target bypasses the stateful guard.
The user is opting into a footgun; per-resource force would imply a
false sense of granularity.

### Interactive confirmation

`cdkd deploy --recreate-via-cc-api <id>` prints a per-target plan
(logical id + resource type + `stateful` reason where applicable) and
then asks `Continue? (y/N)` before any AWS call. Default is `N`
(destructive — the destroy + recreate cycle is irreversible per
resource). Combine with `--yes` / `-y` for non-interactive CI runs;
the plan is then warn-logged once and the deploy proceeds without
prompting. Non-TTY runs without `--yes` are rejected with an
actionable error rather than hanging on a closed stdin.

For stateful targets (those reaching pre-flight only because the user
opted in with `--force-stateful-recreation`), the prompt prefixes each
row with `**DATA LOSS**` and emits an explicit `DATA: all data in
<logical id> will be lost` caveat — the third "stop and think" moment
on top of the two-flag opt-in.

### Cross-stack reference propagation

The recreated resource gets a fresh physical id. Downstream stacks that
read this resource's outputs via `Fn::GetStackOutput` /
`Fn::ImportValue` must be re-deployed before they see the new id. A
warn line lists this caveat at recreate time; cdkd does NOT walk the
state bucket to enumerate downstream consumers in v1 (deferred to a
follow-up issue). Plan multi-stack recreates from leaf to root.

### Interaction with `--allow-unsupported-properties`

`--recreate-via-cc-api MyLambda` combined with
`--allow-unsupported-properties AWS::Lambda::Function:CapacityProviderConfig`
on a resource whose template carries `CapacityProviderConfig` is **ambiguous
intent**:

- Does the user want SDK + silent drop (override path)?
- Does the user want CC migration (recreate path)?

cdkd refuses with a pre-flight error naming the overlap. Pick one
strategy per resource.

### Reversibility (one-way at v1)

Once a resource is `provisionedBy: 'cc-api'`, going back to the SDK
Provider requires another flag (the inverse `--recreate-via-sdk`). NOT
in scope for v1 — file an issue if you need this direction.

When a later cdkd release wires the property the user originally
needed, the migrated resource stays on CC unless the user explicitly
switches it back. Sticky-state semantics avoid SDK↔CC ping-pong on
every backfill release.

### What `--recreate-via-cc-api` is NOT

- **NOT** a per-stack shortcut. There is no
  `--recreate-via-cc-api-all-with-silent-drops` form — the user names
  each target explicitly to acknowledge the cost.
- **NOT** persisted in cdkd state. The next deploy WITHOUT the flag
  routes the recreated resource via CC (sticky); the flag is only
  needed to trigger the initial destroy + recreate.
- **NOT** compatible with cross-account / cross-region migration —
  the flag operates within the current deploy's environment only.
- **NOT** compatible with Tier 3 (`NON_PROVISIONABLE`) types — CC API
  can't handle them either; the existing Tier 3 reject fires first.
- **NOT** compatible with multi-region resources like
  `AWS::DynamoDB::GlobalTable` in v1 — the destroy + recreate cycle
  across replica regions is more involved; cdkd refuses with a clear
  error.

## `--replace` (deploy)

Replace (DELETE + CREATE) a resource whose **in-place update is rejected
because an immutable property changed and AWS exposes no update API for
it**. Some resource types are immutable on AWS — there is no
`Update<Thing>` call, so any property change must publish / register a
new physical resource. Examples: `AWS::Lambda::LayerVersion` content,
`AWS::EFS::AccessPoint`, `AWS::ECS::TaskDefinition`,
`AWS::Glue::SecurityConfiguration`, and several `AWS::ApiGatewayV2::*`
identity fields.

For a few of these cdkd already has a built-in replacement rule (e.g.
`AWS::Lambda::LayerVersion` auto-replaces with no flag). For the rest,
cdkd's diff classifies the change as an in-place UPDATE, the provider's
`update()` hard-rejects with `ResourceUpdateNotSupportedError`, and —
without this flag — the deploy fails. `--replace` opts into catching that
rejection and falling back to a DELETE + CREATE of the resource (the same
replacement path the Cloud Control `UnsupportedActionException`
auto-fallback already uses), matching what CloudFormation would do.

Unlike `--recreate-via-cc-api` / `--recreate-via-sdk-provider` (which
name a specific logical id and force a routing migration), `--replace` is
a stack-wide opt-in that fires only for resources whose update genuinely
hard-rejects — a resource whose update succeeds in place is unaffected.

```bash
# A Glue SecurityConfiguration's EncryptionConfiguration changed (immutable) —
# fails without the flag, replaces cleanly with it
cdkd deploy MyStack --replace --yes
```

### Stateful-resource guard (shared with `--recreate-via-cc-api`)

`--replace` shares the same stateful-resource guard as
`--recreate-via-cc-api`: when the replacement target is a stateful type
(see the guard list above — RDS / DynamoDB / EFS / S3-with-data /
Logs-with-retention / etc.), the DELETE + CREATE loses all data, so
cdkd refuses unless `--force-stateful-recreation` is ALSO passed. The
guard is evaluated at the moment the immutable-update rejection is
caught (mid-deploy), and the error names the resource + the data-loss
reason. Non-stateful immutable types (LayerVersion, Glue
SecurityConfiguration, ECS TaskDefinition, ApiGatewayV2 sub-resources,
etc.) replace with `--replace` alone.

The same stateful guard ALSO covers **property-driven replacement** — a
replacement cdkd detects directly from the diff (an immutable / createOnly
property changed in the template, e.g. `AWS::EFS::FileSystem.PerformanceMode`,
an `AWS::EC2::Volume` `AvailabilityZone` move, or an S3 `BucketName` rename)
rather than from a provider's mid-deploy update rejection. A plain `cdkd deploy` (no `--replace` flag) that would DELETE+CREATE
a **stateful** resource because of such a change now requires
`--force-stateful-recreation` and throws `STATEFUL_REPLACE_BLOCKED` without it,
closing the prior footgun where a template immutable-property change silently
destroyed a stateful resource's data. Non-stateful types still replace freely
on `cdkd deploy` with no flag.

## `--recreate-via-sdk-provider <LogicalId>` (deploy)

`--recreate-via-sdk-provider <LogicalId>` (repeatable, one flag per
resource) is the reverse direction of `--recreate-via-cc-api`.
It destroys + recreates the named resource via cdkd's
SDK Provider so a resource currently sticky on `provisionedBy: 'cc-api'`
flips back to `provisionedBy: 'sdk'`.

When to use it:

- A `provisionedBy: 'cc-api'`-sticky resource (landed on CC because
  the user originally needed a top-level CFn property cdkd's SDK
  Provider did not wire, e.g. Lambda `LoggingConfig`) is now eligible
  for SDK Provider routing because a later cdkd release has added
  SDK coverage for that property. The flag forces a destroy + recreate
  cycle so the new physical resource lands on SDK and benefits from
  SDK Provider performance / diagnostic clarity / narrower IAM scope.
- A `provisionedBy: 'cc-api'` resource where the user no longer needs
  the CC route (e.g. removed the silent-drop property from the
  template) and wants to consolidate routing back to SDK for the
  reasons above.

When NOT to use it:

- The resource is already `provisionedBy: 'sdk'` (or pre-v7 legacy
  state, treated as SDK by the v7 binary) — the reverse migration is
  a no-op. cdkd refuses with a clear error.
- The resource type has no SDK provider registered (Tier 2 CC-only) —
  the destroy + recreate would route via CC again. cdkd refuses.
- The template still uses a silent-drop property NOT in
  `--allow-unsupported-properties` — the default-on CC auto-route
  would re-route the SDK-recreated resource back to CC on the very
  next routing decision. cdkd refuses (inverse ambiguous intent); fix
  by either removing the property from the template or accepting the
  silent drop via `--allow-unsupported-properties <Type>:<Prop>`.

Stateful-resource guard, multi-region refusal, and the interactive
`Continue? (y/N)` prompt are symmetric to `--recreate-via-cc-api`:
named stateful targets (RDS / DynamoDB / S3-with-data / etc.) refuse
unless `--force-stateful-recreation` is also passed, multi-region
resources (`AWS::DynamoDB::GlobalTable`) refuse outright in v1, and
the prompt fires per-stack with the same `**DATA LOSS**` prefix on
stateful entries. The two flags are mutually exclusive on a per-resource
basis — naming the same logical id in both is refused as ambiguous.

```bash
# Mid-life CC→SDK migration after a backfill release landed SDK coverage
# for Lambda's LoggingConfig:
cdkd deploy MyStack --recreate-via-sdk-provider MyLambda --yes

# Multiple targets:
cdkd deploy MyStack \
  --recreate-via-sdk-provider MyLambda \
  --recreate-via-sdk-provider OtherFn \
  --yes
```

### What `--recreate-via-sdk-provider` is NOT

- **NOT** a per-stack shortcut. Per-resource explicit naming only.
- **NOT** the only path to SDK routing — fresh CREATEs route via the
  routing-decision matrix in `ProviderRegistry.getProviderFor` and
  land on SDK whenever an SDK Provider is registered for the type AND
  the template has no silent-drop property. This flag is for the
  existing-state CC → SDK migration only.
- **NOT** compatible with `--recreate-via-cc-api` on the same logical
  id — pick ONE direction per resource.

## `--strict-getatt` (deploy)

Fail the deploy on ANY `Fn::GetAtt` that falls back to the resource's
physical ID because cdkd cannot construct the requested attribute, and on
any stack Output that cannot be resolved.

```bash
cdkd deploy MyStack --strict-getatt
```

### Default behavior (without the flag)

When a template requests an attribute that is neither captured in state
`attributes` nor constructible by the resolver's per-type mappings, cdkd
falls back to the resource's **physical ID**:

- **Knowably-wrong shapes hard-fail even without the flag**:
  an attribute name ending in `Arn` whose fallback value is not
  `arn:`-shaped, or ending in `Url` whose fallback is not an http(s) URL,
  cannot be what CloudFormation would return — the deploy fails with an
  actionable error naming the resource, attribute, and an issue link. This
  applies to the resolver's final unknown-type fallback AND to every
  per-type handler's unknown-attribute default branch.
- **Every other suffix warns and returns the physical ID** (`Unknown
  attribute X for resource type Y, returning physical ID`) — an alias or
  endpoint is shape-indistinguishable from a plain name, so a hard-fail
  there would risk failing correct deploys.
- **The same refusals apply inside `Fn::Sub`**. A
  `${LogicalId.Attribute}` placeholder resolves through the same code path,
  so a reference that hard-fails as a resource property hard-fails there
  too. Previously `Fn::Sub` downgraded EVERY resolution failure to a
  warning and kept the raw `${...}` text, so the identical reference shipped
  a literal `${MyResource.SomeArn}` to AWS on a green deploy. A variable
  that genuinely does not exist still warns and keeps its placeholder — the
  long-standing behavior — and the warning now names the actual reason
  instead of always saying `not found`.
- When at least one such fallback happened, the deploy summary prints a
  one-line count so the warns don't scroll away on green deploys:

  ```text
  2 attribute resolution(s) fell back to the physical ID (potentially wrong values); re-run with --strict-getatt to fail on these
  ```

  Each distinct fallback site is counted once per run (diff-phase
  resolutions are not double-counted against provisioning-phase ones). The
  count is per stack: a nested-stack child's fallbacks are counted by the
  child's own deploy engine and are not aggregated into the parent's
  summary line.

- An **Output** whose value cannot be resolved is warned about and skipped
  (no value is persisted or exported); the deploy still exits 0.

### With `--strict-getatt`

- EVERY unknown-attribute physical-ID fallback — any suffix, including an
  ARN-shaped fallback for an `*Arn` attribute — is a hard error.
- An Output resolution failure fails the deploy instead of silently
  publishing nothing (which would otherwise break downstream
  `Fn::ImportValue` consumers with "export not found" long after this
  deploy exited 0). The failure fires AFTER all resource operations
  succeeded, so cdkd persists the provisioning result to state BEFORE
  failing: the created/updated resources are recorded (previously
  persisted outputs are kept), no rollback runs, and a follow-up
  `cdkd deploy` or `cdkd destroy` sees them — even on a first deploy,
  nothing becomes an invisible orphan.

Use it in CI to guarantee no potentially-wrong `Fn::GetAtt` value ever
ships quietly; drop it (default) when a known-benign fallback (e.g. a
physical ID that genuinely is the attribute value for a type cdkd has not
enriched yet) is acceptable. Nested-stack child deploys inherit the flag
from the parent deploy.

## `--allow-unaddressed` (deploy)

A deploy that finishes without a single resource FAILING can still leave a
resource cdkd was responsible for alive in AWS. That outcome exits `2`,
matching what `cdkd destroy` does for the identical
case. Two cases produce it, and
they differ in whether they heal themselves:

| Summary row | Cause | Next `cdkd deploy` retries it? |
|---|---|---|
| `Skipped (not deleted): N` | a resource removed from the template whose provider could not issue the delete — typically a malformed `physicalId` in state | **Yes.** The state record is deliberately KEPT, so the resource is still diffed as a DELETE next run |
| `of which left an orphaned predecessor: N` | a replacement whose new resource was created and whose OLD one could not be deleted | **No.** State now points at the replacement, so the survivor is untracked — delete it by hand |

```bash
cdkd deploy MyStack                       # exit 2 if either row is non-zero
cdkd deploy MyStack --allow-unaddressed   # exit 0 for the same run
```

The flag changes the **exit code**, and with it the run-level error message.
What survives it: the summary rows, each resource's own warning (naming its
cause and remedy), the switched banner, the `skipped` figure in `cdkd events`,
and the `RUN_FINISHED` `result: 'FAILED'` record. So a run that used the flag
still says — in its log and in its durable post-mortem — that a resource
survived. The events store records what happened, not what the operator chose
to tolerate.

What it DOES take away, beyond the exit code: the `PartialFailureError` message
is not raised at all, and that message is the only place the run-level
remediation text appears ("a skipped DELETE keeps its state record… a
replacement's survivor is not tracked — delete it by hand") along with the count
of stacks that were cancelled and never deployed. The banner's closing sentence
also differs. If you set the flag in CI, the per-resource warnings remain your
route to the cause.

It exists because the orphaned-predecessor case has a legitimate
not-yet-fixable window. The commonest instance is an ACM certificate
replacement rejected because a consumer — often a CloudFront distribution in
another stack not yet updated — still references the old certificate; the
delete succeeds on its own once `DescribeCertificate.InUseBy` is empty. Until
then a pipeline would be red for a cause it cannot act on.

Prefer the flag over wrapping the command in a shell exit-code test. `cdkd
deploy` also exits `2` for `MacroExpansionError` (a synth-time macro failure)
and `ResourceUpdateNotSupportedError`, so `cdkd deploy || [ $? -eq 2 ]` would
silence those unrelated real failures; `--allow-unaddressed` is scoped to this
one cause.

## `--no-cfn-fallback` (deploy / diff)

By default, a cross-stack
reference that is not found in cdkd state falls back to CloudFormation,
so a cdkd-deployed consumer can reference a producer stack still managed
by CloudFormation (`cdk deploy` / raw CFn):

- `Fn::ImportValue` → CloudFormation `ListExports` in the consumer's
  region (CFn's own semantic for the intrinsic).
- `Fn::GetStackOutput` → CloudFormation `DescribeStacks` outputs in the
  target region. Same-account only — the `RoleArn` (cross-account) form
  never takes the fallback.

The fallback fires ONLY after a cdkd-state miss (cdkd-first precedence:
existing cdkd-to-cdkd references are untouched, and a name collision
resolves to the cdkd export). A CFn-sourced resolution is a **weak
reference** — not recorded into `state.imports` / `state.outputReads`,
so there is no destroy-time protection in either direction: deleting the
CFn producer breaks the consumer's next resolve, not the producer's
delete. A fallback lookup failure (e.g. missing
`cloudformation:ListExports` / `cloudformation:DescribeStacks`
permission) logs a warning and surfaces the original not-found error.

```bash
cdkd deploy MyStack --no-cfn-fallback   # cdkd-state-only resolution
cdkd diff MyStack --no-cfn-fallback     # preview with the same semantics
```

Pass the flag when you want cdkd-state-only semantics — IAM kept minimal,
or an export-name typo failing fast instead of accidentally matching an
unrelated CloudFormation export in the account. Nested-stack child
deploys inherit the flag from the parent deploy; `cdkd diff` honors it in
its best-effort resolvers so preview and apply resolve identically. See
[docs/cross-stack-references.md](cross-stack-references.md) for the full
design.

