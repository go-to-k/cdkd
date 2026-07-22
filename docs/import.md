# Importing existing resources

`cdkd import` adopts AWS resources that are already deployed (e.g. via
`cdk deploy`, manual creation, or another tool) into cdkd state, so the
next `cdkd deploy` updates them in-place instead of trying to CREATE
duplicates.

It reads the CDK app to find logical IDs, resource types, and
dependencies, then matches each logical ID to a real AWS resource in
one of three modes.

All examples below assume cdkd reads the CDK app command from `cdk.json`
(the typical case). Pass `--app "<command>"` only if you're running cdkd
outside the CDK project directory or want to override `cdk.json`.

## Mode 1: auto (default — no flags)

```bash
cdkd import MyStack
```

Attempts to import **every** resource in the synthesized template, without
naming physical ids by hand. Per resource, cdkd tries two lookups in order:

1. **By physical name** — the template's own name property
   (`ManagedPolicyName`, `TopicName`, `TableName`, ...).
2. **From CloudFormation** — if a CloudFormation stack of the same name exists,
   its `DescribeStackResources` mapping. This is what makes adopting a
   `cdk deploy`-managed stack work without naming ids by hand.

> [!NOTE]
> There is deliberately no `aws:cdk:path` **tag** lookup. `aws:cdk:path` is not
> a tag that exists on AWS resources: AWS rejects any `aws:`-prefixed tag write
> (`Tag keys beginning with aws: are reserved for system use`), and
> CloudFormation keeps the value in the template's resource `Metadata` without
> promoting it to a tag. cdkd once carried such a walk as a stage-3 fallback;
> because it could never match, issue
> [#1134](https://github.com/go-to-k/cdkd/issues/1134) removed it from every
> provider. Stage 2 (added in
> [#1128](https://github.com/go-to-k/cdkd/issues/1128)) is what resolves a
> CFn-generated physical name — the usual CDK shape, which stage 1 alone cannot
> find.

Stage 2 is best-effort and never fatal: with no CloudFormation stack of that
name it is skipped silently, and if the call fails (missing
`cloudformation:DescribeStackResources` permission, throttling) cdkd warns and
falls back to stage 1. A resource that neither names itself nor lives in a
same-named CloudFormation stack comes back `not found`; adopt it with an
explicit `--resource <logicalId>=<physicalId>`.

To adopt a `cdk deploy`-managed stack **and retire the CloudFormation stack**
in one step, use
[`--migrate-from-cloudformation`](#migrating-from-cdk-deploy-cloudformation-to-cdkd).
Plain auto mode adopts without touching the source stack. For a handful of
resources, name them explicitly with `--resource` (Mode 2).

## Mode 2: selective (CDK CLI parity — when explicit overrides are given)

```bash
# Import ONLY MyBucket; the other resources in the template are left alone.
cdkd import MyStack --resource MyBucket=my-bucket-name

# Several resources at once (--resource is repeatable).
cdkd import MyStack \
  --resource MyBucket=my-bucket-name \
  --resource MyFn=my-function-name

# CDK CLI compat: read overrides from a JSON file.
cdkd import MyStack --resource-mapping mapping.json
# mapping.json: { "MyBucket": "my-bucket-name", "MyFn": "my-function-name" }

# CDK CLI compat: inline JSON (handy for non-TTY CI scripts).
cdkd import MyStack --resource-mapping-inline '{"MyBucket":"my-bucket-name"}'

# Capture cdkd's resolved logicalId→physicalId mapping for re-use.
# Combine with --auto (or no flags) to record the auto-mode resolutions.
cdkd import MyStack --record-resource-mapping ./mapping.json
# mapping.json after the run: { "MyBucket": "my-bucket-name", ... }
# Replay non-interactively in CI:
cdkd import MyStack --resource-mapping ./mapping.json --yes
```

When at least one `--resource` flag (or a `--resource-mapping` /
`--resource-mapping-inline` payload) is supplied, **only the listed
resources are imported**. Every other resource in the template is
reported as `out of scope` and left out of state — the next `cdkd
deploy` will treat them as new and CREATE them. This matches the
semantics of `cdk import --resource-mapping` /
`--resource-mapping-inline`. cdkd validates that every override key is
a real logical ID in the template; a typo aborts the run rather than
silently importing nothing. `--resource-mapping` and
`--resource-mapping-inline` are mutually exclusive — pick one source.

Use selective mode when you want to **adopt a few specific resources**
out of a larger stack — for example, you have one S3 bucket that was
created manually that you want cdkd to manage, while the rest of the
stack will be deployed fresh.

**Selective mode is non-destructive.** When state already exists for
the stack, listed resources are **merged** into it: unlisted entries
already in state are preserved (no `--force` needed). `--force` is
only required when a listed override would overwrite a resource
already in state — that's the one case where the merge is destructive.
This is the right command for "I have a deployed stack and want to
adopt one more resource into it":

```bash
# Existing state has Queue + Topic; add Bucket without affecting them.
cdkd import MyStack --resource MyBucket=my-bucket-name
# Resulting state: Queue + Topic (preserved) + Bucket (newly imported).
```

## Mode 3: hybrid (`--auto` with overrides)

```bash
cdkd import MyStack \
  --resource MyBucket=my-bucket-name \
  --auto
```

Listed resources use the explicit physical ID you supplied; **every
other resource still goes through auto-resolution** (Mode 1's physical-name
and CloudFormation `DescribeStackResources` lookups). Useful when one
resource cannot be auto-resolved (no explicit name, no CloudFormation
counterpart) but you want cdkd to find the rest automatically.

## Common flags

| Flag | Purpose |
| --- | --- |
| `--dry-run` | Preview what would be imported. State is NOT written. |
| `--yes` | Skip the confirmation prompt before writing state (and the CloudFormation retirement prompt under `--migrate-from-cloudformation`). |
| `--force` | Confirm a destructive write to existing state — see below. |
| `--migrate-from-cloudformation [name]` | After cdkd state is written, retire the source CloudFormation stack: inject `DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain` on every resource via `UpdateStack`, then `DeleteStack`. AWS resources are NOT deleted. See [Migrating from `cdk deploy` (CloudFormation) to cdkd](#migrating-from-cdk-deploy-cloudformation-to-cdkd) below. |
| `--use-cdk-bootstrap-assets` | Keep the CDK bootstrap asset destinations verbatim (skip the cdkd asset-storage rewrite) even when the region is opted in via `cdkd bootstrap`. Without it, import rewrites asset references (Lambda `Code`, image URIs, …) to the cdkd-owned storage before writing state, so the imported state matches what the next `cdkd deploy` would write. See the asset-destinations section in [docs/cli-reference.md](cli-reference.md). |

`--force` is only needed when the import would lose data:

- **Auto / whole-stack mode + existing state**: required. The resource
  map is rebuilt from the template, so any state entry not re-imported
  is dropped.
- **Selective mode + listed override already in state**: required.
  The listed entry is overwritten with the new physical id.
- **Selective mode without a conflict (pure merge)**: not required.
  Unlisted state entries are preserved automatically.
- **No existing state (first-time import)**: not required.

## Migrating from `cdk deploy` (CloudFormation) to cdkd

If a stack was previously deployed via `cdk deploy` (and is therefore
managed by CloudFormation), `cdkd import --migrate-from-cloudformation` adopts
the resources into cdkd state AND retires the source CloudFormation
stack in one go:

```bash
cdkd import MyStack --migrate-from-cloudformation --yes
```

No `--resource <id>=<physical>` flags are needed — cdkd recovers each
resource's physical id directly from CloudFormation via
`DescribeStackResources`, so it works for both `cdk deploy`-managed and
`cdkd deploy`-managed stacks. (This same `DescribeStackResources` recovery
is what plain `auto` mode uses too, since #1128 — see Mode 1. `aws:cdk:path`
could never have helped here: upstream `cdk deploy` keeps the path in the
template's `Metadata`, and AWS reserves the `aws:` tag prefix so it is never
a real AWS tag on the resource.)

The flow:

1. `DescribeStackResources` — ask CloudFormation for every
   `(LogicalResourceId, PhysicalResourceId)` pair in the source stack.
   These are merged into the import overrides; user-supplied
   `--resource <id>=<physical>` flags take precedence over CFn's view.
2. `cdkd import` runs and adopts every resource into cdkd state via
   each provider's `import()` method, using the CFn-resolved physical
   ids as direct lookups.
3. `cdkd` writes state.
4. `DescribeStacks` + `GetTemplate` + `UpdateStack` to inject
   `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain` on every
   resource — a metadata-only update.
5. `DeleteStack` — every resource is now `Retain`, so CloudFormation
   walks the stack and skips every resource. The stack record disappears;
   the underlying AWS resources are left intact and are now solely
   managed by cdkd.

Steps 1–5 all run inside the same lock so a concurrent `cdkd deploy`
cannot race the in-flight migration.

By default the CloudFormation stack name is taken from the cdkd stack
name (the typical case — CDK uses the synthesized stack name as the CFn
stack name). Pass an explicit value when the names differ:

```bash
cdkd import MyStack --migrate-from-cloudformation LegacyCfnStackName --yes
```

### Nested stacks (recursive walk)

Source CloudFormation stacks that contain `AWS::CloudFormation::Stack`
children are walked **recursively** (issue [#464](https://github.com/go-to-k/cdkd/issues/464)):

- Step 1 (`DescribeStackResources`) becomes a recursive tree walk:
  for every nested-stack row, cdkd calls `DescribeStackResources(<child
  ARN>)` to enumerate the child's resources, and so on to arbitrary
  depth. Children at every level are fetched in parallel.
- After the root state is written, cdkd writes **one v6-keyed state
  file per nested child** at `cdkd/<parent>~<childLogicalId>/<region>/state.json`,
  with `parentStack` / `parentLogicalId` / `parentRegion` populated per
  the v6 schema. Grandchildren get `cdkd/<parent>~<child>~<grand>/<region>/state.json`,
  recursively. Per-child locks are acquired before the write and
  released in reverse on success or failure.
- The root parent's state entry for each nested-stack row carries the
  synthesized cdkd-local ARN (`arn:cdkd-local:<region>:<account>:nested-stack/<parent>/<logicalId>`)
  — NOT the real AWS child stack ARN. This matches what
  `NestedStackProvider.create` would write at deploy time, so an
  import-then-deploy cycle does not surface phantom property changes.
- Step 4 (`UpdateStack` with Retain injection) is also recursive: for
  every nested-stack row in the parent template, cdkd fetches the
  child's template via `GetTemplate`, recursively injects Retain on
  every non-nested-stack resource at every depth, uploads the modified
  child template to the cdkd state bucket, and rewrites the parent's
  `Properties.TemplateURL` to point at it. AWS CFn's parent-side
  `DeleteStack` cascades into each child — every leaf resource is
  `Retain`'d (so the AWS resource survives), and the child stack
  record gets deleted as a side effect.

Synth template ↔ AWS shape is validated up front: a nested-stack row
in the synth template that has no matching AWS child (or vice versa)
hard-errors before any state write, naming the offending logical id —
matching upstream `cdk import`'s mismatch UX.

Limitations:

- **JSON and YAML supported.** The Retain-policy injection in step 4
  parses the source CloudFormation template via cdkd's CFn-aware codec
  (`src/cli/yaml-cfn.ts`), which preserves every shorthand intrinsic
  (`!Ref`, `!Sub`, `!GetAtt`, `!Join`, ...) across the parse →
  inject-Retain → re-serialize round-trip. The phase-1 UPDATE submits
  the template in the **same format** as the source — a YAML-authored
  CFn stack stays YAML on the wire (with `.yaml` key suffix and
  `application/x-yaml` content type when uploaded to the cdkd state
  bucket).
- **1 MB template limit.** Templates up to the inline 51,200-byte
  `TemplateBody` ceiling are submitted directly. Larger templates are
  uploaded to the cdkd state bucket under
  `cdkd-migrate-tmp/<stack>/<timestamp>.json` and submitted via
  `TemplateURL`; the transient object is deleted in a `finally`
  immediately after `UpdateStack`. Templates over the 1 MB
  CloudFormation `TemplateURL` ceiling are structurally
  unsubmittable — cdkd fails with a clear error. cdkd state has
  already been written at that point, so re-runs and manual cleanup
  are both supported. The same ceiling applies independently to every
  uploaded nested-child template.
- **Not compatible with `--dry-run`.** The post-state-write
  `UpdateStack` + `DeleteStack` are real side-effects and cannot be
  faithfully simulated. Use plain `cdkd import --dry-run` to preview
  per-resource import outcomes.
- **Partial imports leave unmanaged resources.** If a resource cannot
  be imported (no provider, AWS not-found, etc.), `DeleteStack` skips
  it (Retain) and cdkd never wrote it into state — so the resource
  exists in AWS but unmanaged by both CloudFormation and cdkd. cdkd
  warns loudly when this happens; either re-import the missing
  resources first or accept the orphaning intentionally.
- **Bare `cdkd import` (no migration flag) does NOT recurse.** Without
  `--migrate-from-cloudformation`, each `AWS::CloudFormation::Stack`
  row is treated as `unsupported` (the underlying `NestedStackProvider`
  has no `import()` method). Future work would add per-resource tag-
  based nested-stack adoption; for now, the migration flag is the only
  path.

## After import

Run `cdkd diff` to see how the imported state lines up with the
template. If the resource's actual properties differ from the template,
the next `cdkd deploy` will UPDATE them to match. If you imported only
some resources (selective mode), the remaining template resources
appear as `to create` in the diff.

## Provider coverage

This section lists every resource type whose cdkd provider implements
`import()`, grouped by how the import is resolved. Use it to decide
whether your stack can be adopted with a bare `cdkd import MyStack`
(all resources auto-resolve) or whether you need
`--resource <id>=<physical>` overrides for some of them.

For resource types without auto-lookup support (ApiGateway
sub-resources, niche services, anything in Cloud Control API), use the
explicit `--resource <id>=<physicalId>` override mode — selective mode
handles exactly this case. Resource types whose provider does not
implement import are reported as `unsupported` and skipped.

### Auto-resolved (no `--resource` flag needed)

These types implement `import()` and can resolve a physical id under `auto`
(default) and `hybrid` modes **without** an explicit `--resource` override,
when one of these applies:

1. the template sets an explicit physical-name property (`BucketName`,
   `RoleName`, `TopicName`, ...) — cdkd verifies / lists by that name; or
2. a CloudFormation stack of the same name exists — cdkd recovers every
   physical id from its `DescribeStackResources` (issue
   [#1128](https://github.com/go-to-k/cdkd/issues/1128) /
   [#1130](https://github.com/go-to-k/cdkd/issues/1130)), which is how a
   `cdk deploy`-managed stack is adopted.

> [!NOTE]
> There is **no** `aws:cdk:path` tag lookup. AWS reserves the `aws:` tag
> prefix, so that tag never exists on a real resource and a walk keyed on it
> could not match — CloudFormation keeps the construct path in the template's
> `Metadata`, never as a tag. Issue
> [#1134](https://github.com/go-to-k/cdkd/issues/1134) removed the former tag
> walk from every provider. A CDK app that sets no explicit physical names and
> has no same-named CloudFormation stack must adopt those resources with
> `--resource <logicalId>=<physicalId>`.

Types with an `import()` that auto-resolves via the above:

- AWS::S3::Bucket
- AWS::Lambda::Function
- AWS::IAM::Role
- AWS::IAM::ManagedPolicy
- AWS::IAM::InstanceProfile
- AWS::IAM::User
- AWS::CertificateManager::Certificate
- AWS::IAM::Group
- AWS::SNS::Topic
- AWS::SQS::Queue
- AWS::DynamoDB::Table
- AWS::DynamoDB::GlobalTable
- AWS::Logs::LogGroup
- AWS::Events::EventBus
- AWS::Events::Rule
- AWS::KMS::Key
- AWS::KMS::Alias
- AWS::SecretsManager::Secret
- AWS::SSM::Parameter
- AWS::EC2::VPC
- AWS::EC2::Subnet
- AWS::EC2::SecurityGroup
- AWS::EC2::NatGateway
- AWS::RDS::DBInstance
- AWS::RDS::DBCluster
- AWS::RDS::DBProxy
- AWS::RDS::DBProxyEndpoint
- AWS::RDS::DBSubnetGroup
- AWS::DocDB::DBInstance
- AWS::DocDB::DBCluster
- AWS::DocDB::DBSubnetGroup
- AWS::Neptune::DBInstance
- AWS::Neptune::DBCluster
- AWS::Neptune::DBSubnetGroup
- AWS::ECS::Cluster
- AWS::ECS::Service
- AWS::ECS::TaskDefinition
- AWS::CloudFront::Distribution
- AWS::Cognito::UserPool
- AWS::ApiGatewayV2::Api
- AWS::AppSync::GraphQLApi
- AWS::CloudTrail::Trail
- AWS::CloudWatch::Alarm
- AWS::CodeBuild::Project
- AWS::CodeCommit::Repository
- AWS::ECR::Repository
- AWS::ElasticLoadBalancingV2::LoadBalancer
- AWS::ElasticLoadBalancingV2::TargetGroup
- AWS::Route53::HostedZone
- AWS::StepFunctions::StateMachine
- AWS::Glue::Database
- AWS::Glue::Table
- AWS::Glue::Job
- AWS::Glue::Crawler
- AWS::Glue::Connection
- AWS::Glue::Trigger
- AWS::Glue::Workflow
- AWS::Glue::SecurityConfiguration
- AWS::Kinesis::Stream
- AWS::Kinesis::StreamConsumer
- AWS::KinesisFirehose::DeliveryStream
- AWS::WAFv2::WebACL
- AWS::EFS::FileSystem
- AWS::EFS::AccessPoint
- AWS::ElastiCache::CacheCluster
- AWS::ElastiCache::SubnetGroup
- AWS::Lambda::LayerVersion
- AWS::ServiceDiscovery::Service
- AWS::ServiceDiscovery::PrivateDnsNamespace
- AWS::ServiceDiscovery::HttpNamespace
- AWS::ServiceDiscovery::PublicDnsNamespace
- AWS::S3Express::DirectoryBucket
- AWS::S3Tables::TableBucket
- AWS::S3Tables::Namespace
- AWS::S3Tables::Table
- AWS::S3Vectors::VectorBucket
- AWS::DLM::LifecyclePolicy
- AWS::FSx::FileSystem
- AWS::Budgets::Budget (the template `Budget.BudgetName` resolves it without a flag)
- AWS::EMR::Cluster (override with the cluster id `j-XXXX`)

### Override-only — no standalone identity / list API

These resource types have no AWS-side identity that cdkd can list and
match on. Use `--resource <logicalId>=<physicalId>` (or
`--resource-mapping <file>` / `--resource-mapping-inline '<json>'`) to
provide the physical id explicitly.

- AWS::IAM::Policy (inline)
- AWS::IAM::UserToGroupAddition
- AWS::Scheduler::Schedule (schedules are not taggable; the template `Name` + `GroupName` also resolve without a flag)
- AWS::CloudFormation::WaitConditionHandle (no AWS-queryable resource exists behind a handle; an explicit `--resource` id — or CloudFormation's pre-signed-URL physical id during `--migrate-from-cloudformation` — is recorded verbatim, and a synthesized placeholder is used otherwise)

### Override-only — sub-resources without a standalone identity

Sub-resources of a parent (an API Gateway Method belongs to a Resource
which belongs to a RestApi; a Route53 RecordSet belongs to a HostedZone)
have no standalone name or list API cdkd can resolve them by. Provide the
physical id via `--resource`.

- AWS::ApiGateway::Authorizer
- AWS::ApiGateway::Resource
- AWS::ApiGateway::Deployment
- AWS::ApiGateway::Stage
- AWS::ApiGateway::Method
- AWS::ApiGatewayV2::Stage
- AWS::ApiGatewayV2::Integration
- AWS::ApiGatewayV2::Route
- AWS::ApiGatewayV2::Authorizer
- AWS::AppSync::GraphQLSchema
- AWS::AppSync::DataSource
- AWS::AppSync::Resolver
- AWS::AppSync::ApiKey
- AWS::Route53::RecordSet
- AWS::ElasticLoadBalancingV2::Listener
- AWS::EFS::MountTarget
- AWS::RDS::DBProxyTargetGroup

### Override-only — sub-resources / attachments

Attachment-style resources (a SNS Subscription pinning a Topic to an
endpoint, a Lambda Permission granting a principal access to a function)
have no taggable identity either. Provide the physical id via
`--resource`.

- AWS::SNS::Subscription
- AWS::SNS::TopicPolicy
- AWS::SQS::QueuePolicy
- AWS::S3::BucketPolicy
- AWS::Lambda::Permission
- AWS::Lambda::EventSourceMapping
- AWS::Lambda::Url
- AWS::Lambda::EventInvokeConfig
- AWS::CloudFormation::CustomResource
- AWS::CloudFront::CloudFrontOriginAccessIdentity
- AWS::BedrockAgentCore::Runtime (adopt by ARN via `--resource`)
- AWS::BedrockAgentCore::Evaluator (accepts the evaluator ARN or bare id; an id is resolved to the canonical ARN via `GetEvaluator`)
- AWS::Lambda::MicrovmImage (adopt by image ARN via `--resource`; a bare name is rejected — `GetMicrovmImage` requires the ARN)

Note: `AWS::BedrockAgentCore::Browser` / `AWS::BedrockAgentCore::CodeInterpreter`
are adopt-only singletons pointing at the AWS-managed defaults; their import is
a live auto-lookup (`GetBrowser` / `GetCodeInterpreter`) that needs no
`--resource` override at all.

### Cloud Control API fallback

Any other CC-API-supported resource type can be imported via the same
`--resource <logicalId>=<physicalId>` override. cdkd does not run
auto-lookup over Cloud Control API by default — it would issue an
`aws-cloudcontrol:ListResources` call per type, which is too expensive
for whole-stack adoption.

### Unsupported

Resource types whose cdkd provider does not implement `import()` (or
which have no provider at all) are reported as `unsupported` in the
import summary and skipped. CDK Stages — separate top-level stacks
under one app — are fine; pass the stack's display path or physical
name as the positional argument.

**Nested CloudFormation stacks (`AWS::CloudFormation::Stack`)**: bare
`cdkd import` (auto / selective / hybrid mode) still treats each nested-
stack row as `unsupported` — there is no per-resource `import()` on the
`NestedStackProvider`. To adopt a parent stack with nested children,
use `cdkd import --migrate-from-cloudformation` instead, which recursively
walks the tree, writes one v6-keyed state file per child
(`cdkd/<parent>~<childLogicalId>/<region>/state.json`), and retires the
whole tree via a single parent-side `DeleteStack` cascade. See the
`--migrate-from-cloudformation` section below for details.

`AWS::AutoScaling::AutoScalingGroup` is also currently unsupported —
the SDK provider exists for create / update / delete / readCurrentState
but has not yet been wired for `import()`. Track-able via a follow-up
that adds an override-only `import()` keyed on the group name.

`AWS::EMR::InstanceGroupConfig` / `AWS::EMR::InstanceFleetConfig` are
likewise currently unsupported for import — the SDK providers exist for
create / update / delete but not `import()`. They are cluster
sub-resources with no standalone name (they are listed
via `ListInstanceGroups` / `ListInstanceFleets` under a parent
`ClusterId`), so a future override-only `import()` keyed on the group /
fleet id (`ig-XXXX` / `if-XXXX`) is the natural follow-up.

### Adding a new entry

When adding `import()` support to a provider, add the resource type to
the appropriate section above. Keep entries one-per-line so parallel
PRs don't conflict on rebase.

## `cdkd import` vs upstream `cdk import`

cdkd's `import` command mirrors the surface of upstream
[`cdk import`](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-import.html)
where it can, but the underlying mechanism is fundamentally different
and a handful of upstream-only flags are not implemented. Use this
table to predict behavior when migrating from `cdk import`.

| Topic | `cdk import` (upstream) | `cdkd import` |
| --- | --- | --- |
| Mechanism | CloudFormation `CreateChangeSet` with `ResourcesToImport` — atomic, all-or-nothing. | Per-resource SDK calls (e.g. `s3:HeadBucket`, `lambda:GetFunction`, IAM `ListRoleTags`). **Not atomic.** |
| Failure mode | Failed import rolls the changeset back; the stack is left unchanged. | Per-resource: `imported` / `skipped-not-found` / `skipped-no-impl` / `skipped-out-of-scope` / `failed` rows are summarized. State is written for whatever succeeded — but only after a confirmation prompt (or `--yes`), so a partial run is opt-in. To roll a partial import back, use `cdkd state orphan <stack>` (drops the state record only). |
| Selective mode (`--resource-mapping <file>`) | Supported. Listed resources are imported; unlisted resources cause the changeset to fail. | Supported. Listed resources are imported; unlisted resources are reported as `out of scope` and left out of state (next `cdkd deploy` will CREATE them). |
| Selective mode (`--resource <id>=<physical>` repeatable) | Not supported (upstream uses interactive prompts or a mapping file). | Supported as cdkd's CLI-friendly equivalent. |
| `--resource-mapping-inline '<json>'` | Supported (use in non-TTY environments). | Supported. Same shape as `--resource-mapping <file>` but supplied as a string — useful for non-TTY CI scripts that do not want a separate file. Mutually exclusive with `--resource-mapping`. |
| `--record-resource-mapping <file>` | Supported (writes the mapping the user typed at the prompt to a file for re-use). | Supported. Writes the resolved `{logicalId: physicalId}` map (covers explicit overrides AND auto-mode name / CloudFormation resolution) to the file before the confirmation prompt. The file is produced even if the user says "no" or under `--dry-run`, so the resolved data is never thrown away. |
| Interactive prompt for missing IDs | Default in TTY — prompts for every resource not covered by a mapping file. | **Not supported.** cdkd is non-interactive: missing logical IDs are resolved from the template's physical-name property, then from a same-named CloudFormation stack's `DescribeStackResources` (#1128), in `auto` / `hybrid` modes, or skipped as `out of scope` in selective mode. The only prompt is the final "write state?" confirmation, which `--yes` skips. |
| Typo'd logical ID | Aborts with a clear error before any AWS calls. | Aborts with a clear error before any AWS calls — checked against the synthesized template. |
| Whole-stack import with no per-resource ids | **Not supported.** | **cdkd-specific.** With no flags cdkd resolves each resource from the template's physical-name property, then from a same-named CloudFormation stack's `DescribeStackResources` (#1128). Use `--migrate-from-cloudformation` when you also want the source CloudFormation stack retired. |
| Hybrid mode (overrides + auto-resolution) | **Not supported.** | **cdkd-specific.** `--auto` together with `--resource` lets listed resources use the explicit physical id while everything else still goes through auto-resolution (name property + CloudFormation lookup). |
| Nested stacks (`AWS::CloudFormation::Stack`) | Explicitly unsupported. | Supported via `cdkd import --migrate-from-cloudformation` (issue [#464](https://github.com/go-to-k/cdkd/issues/464)): recursively walks the tree via `DescribeStackResources`, writes one v6-keyed state file per child (`cdkd/<parent>~<childLogicalId>/<region>/state.json`), recursively injects `DeletionPolicy: Retain` into every leaf resource template, then retires the whole tree via a single parent-side `DeleteStack` cascade. Bare `cdkd import` (auto / selective / hybrid mode) still reports each nested-stack row as `unsupported`. CDK Stages (separate top-level stacks) are also fine: pass the stack's display path or physical name as the positional argument. |
| Bootstrap requirement | Bootstrap v12+ (deploy role needs to read the encrypted staging bucket). | cdkd's own state bucket; no CDK bootstrap version requirement. |
| Resource-type coverage | Whatever [CloudFormation supports for import](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-supported-resources.html). | The set of cdkd providers that implement `import()` — see [Provider coverage](#provider-coverage) above. For any other CC-API-supported type, use `--resource <id>=<physical>` to drive the Cloud Control API fallback. The two lists overlap heavily but are not identical. |
| Confirmation prompt before writing state | n/a (CloudFormation operates atomically). | Yes — cdkd asks before writing the state file. Skip with `--yes`. |
| `--force` | "Continue even if the diff includes updates or deletions" — about diff strictness. | "Confirm a destructive write to existing state" — required for auto/whole-stack rebuild and for overwriting a listed entry already in state; not required for a pure selective merge. **Same flag name, different meaning.** |
| `--dry-run` | Implied by `--no-execute` (creates the changeset without executing). | Native: shows the import plan and exits without writing state. |

### Practical implications when migrating from `cdk import`

- If you script around `--resource-mapping <file>`: behavior matches.
  The file format (`{"LogicalId": "physical-id"}`) is the same.
- If you script around `--resource-mapping-inline`: behavior matches.
  The JSON shape is the same as `--resource-mapping <file>`.
- If you script around `--record-resource-mapping <file>`: behavior
  matches. cdkd writes the resolved `{logicalId: physicalId}` map to
  the file before the confirmation prompt — and even if the user says
  "no" or under `--dry-run` — so you can capture cdkd's auto-mode
  resolution result and replay it via `--resource-mapping` in CI.
- If your workflow relies on the interactive prompt: rewrite as
  `--resource-mapping <file>`. cdkd will not prompt.
- If you rely on atomic rollback: cdkd cannot offer that — its
  per-resource model writes state only after the full pass completes
  (and after confirmation), so a partial run is bounded, but if a
  later resource fails after several earlier ones already returned
  successfully and you confirm the write, those earlier ones are
  in cdkd state. Use `cdkd state orphan <stack>` to back out.
- If you import nested stacks: neither tool supports this. Convert
  to top-level CDK stacks first.
