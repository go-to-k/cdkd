---
title: cdkd drift
description: "Detect and resolve drift between cdkd state and live AWS resources with cdkd drift."
---

# cdkd drift

`cdkd drift` compares each resource cdkd manages against its live AWS-side
configuration and reports what diverged. Detection is the default; `--accept`
and `--revert` also resolve what the comparator finds, in either direction.
cdkd does not go through CloudFormation, so CloudFormation's own drift
detection does not apply — the comparison is state against a fresh read from
each resource's provider.

```bash
cdkd drift                              # the single stack in state
cdkd drift MyStack                      # one stack by name
cdkd drift --all                        # every stack in the state bucket
cdkd drift MyStack --stack-region us-east-1   # disambiguate a multi-region name
cdkd drift --all --json                 # machine-readable, for CI gating
cdkd drift MyStack --accept --yes       # state <- AWS (catch up to a console edit)
cdkd drift MyStack --revert --yes       # AWS <- state (undo a console edit)
cdkd drift MyStack --revert --dry-run   # preview either resolution
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack name(s) to check, as physical CloudFormation names. With none given and `--all` unset, the single stack in state is auto-selected. |
| `--all` | off | Check every stack in the state bucket. |
| `--json` | off | Emit the structured per-stack report on stdout, and nothing else. |
| `--accept` | off | Write the AWS-current values into cdkd state (state ← AWS). Mutually exclusive with `--revert`. |
| `--revert` | off | Push cdkd state values back into AWS (AWS ← state). Mutually exclusive with `--accept`. |
| `--dry-run` | off | Print the planned mutations and exit, without taking a lock or calling AWS / S3. |
| `--concurrency <n>` | `4` | Maximum concurrent `provider.update` calls during `--revert`. No effect on `--accept`, whose writes are serialized per stack. |
| `--stack-region <region>` | — | Region of the stack record to inspect. Required when one stack name has state in more than one region. |
| `-y`, `--yes` | off | Skip the confirmation prompt before `--accept` writes state or `--revert` writes to AWS. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | off | Verbose logging. |

`--region` is deprecated — prefer `AWS_REGION` or your AWS profile — but it is
still honored if passed, and it is not a no-op.

`cdkd drift` reads state only. It never synthesizes, so it takes no `--app`.

## What drift compares

The AWS side is whatever the resource's provider reads back now. The cdkd side
is the **deploy-time AWS snapshot** in `ResourceState.observedProperties`
(state schema `version: 3`+). A resource written before observed capture
existed, or by a provider with no read-back, has no `observedProperties`; for
those the comparator falls back to `properties`, the user-templated intent.

The difference matters: the observed baseline is what makes a console-side
change to a key you never templated surface as drift, while the fallback only
catches changes to keys you did template. Run
[`cdkd state refresh-observed <stack>`](cli-state.md#cdkd-state-refresh-observed) or redeploy to
populate an observed baseline in place.

The comparator only looks at keys present in cdkd state. AWS-managed fields
cdkd never set — timestamps, generated identifiers, account-wide defaults —
are ignored, so they never surface as false-positive drift.

### Empty undeclared keys are skipped

On the observed-baseline path, a top-level key the template never declared
whose captured value was EMPTY (`[]`, `{}`, `null`) is skipped entirely. Such
keys are typically filled in AFTER the capture by a sibling resource in the
same stack — `AWS::ECS::ClusterCapacityProviderAssociations` populating the
cluster's `CapacityProviders`, a standalone `AWS::AutoScaling::LifecycleHook`
populating the ASG's hook list, standalone security-group ingress and egress
rules — or by AWS itself. Comparing them reported permanent phantom drift on a
freshly deployed stack, and `--revert` then stripped that sibling-managed
configuration out of AWS.

CloudFormation's drift detection likewise compares only template-declared
properties, so this matches its behaviour for that class. An undeclared key
captured with a REAL value — an AWS-side default — is still compared.

### Tags

Tag drift is compared for every SDK provider with a read-back and on the Cloud
Control fallback. cdkd filters `aws:`-prefixed entries (notably `aws:cdk:path`
and `aws:cdk:metadata`) out of the AWS-current snapshot before comparing:
those are injected by CDK as construct metadata rather than as user-managed
`Tags`, so leaving them in would fire drift on every CDK-deployed resource.
The remaining user tags are normalized to CloudFormation's `[{Key, Value}]`
shape and sorted by `Key` for a stable comparison, and the key is omitted
entirely when AWS reports no user tags.

IAM Role, User and Group inline-policy bodies are compared too, via paginated
policy listing plus per-policy reads, reconciled against the order state
records.

## Per-resource outcomes

Every resource ends in exactly one of four states.

| Outcome | Meaning | In the report |
| --- | --- | --- |
| **drifted** | At least one property differs between state and AWS. | `~ <logicalId> (<type>)`, with one `+/-` line per diverging property path. |
| **clean** | Every state-recorded property was compared against AWS and matched. | Counted in the per-stack summary, not listed individually. |
| **not compared** | Nothing differed, but cdkd did not compare every property. | Listed in the partially-compared block, with its own reason. |
| **drift unknown** | Nothing could be read back for the resource. | `? <logicalId> (<type>)`, in a separate block at the bottom of the stack's report. |

A **clean** verdict never means anything except compared-and-matched.

### Why a resource was not compared

`--json` reports the reason per resource as `notCompared[].cause`:

| `cause` | What happened | Clearable? |
| --- | --- | --- |
| `refused` | cdkd declined to resolve a dynamic reference the resource's state records, because it could not attribute the reference to a region. Its secret-bearing properties were never looked at. | Yes — spell the reference as a full ARN, which names its region. |
| `unresolvedToken` | State records a `{{resolve:...}}` spelling cdkd resolves for nobody. cdkd resolves all three CloudFormation services (`secretsmanager`, `ssm`, `ssm-secure`), so this is reserved for text that is not a dynamic reference at all, or a service AWS adds later. | No — a re-run cannot clear it, which is why it alone does not affect the exit code. |
| `readFailed` | The read or the comparison threw, so NONE of that resource's properties were compared. Every other resource in the stack is still compared and reported. | Yes — usually a missing permission or a throttle; grant it or re-run. |

A **drifted** resource can be partially compared too: the changes it reports
are real, but they are not the whole comparison, so it carries
`referencesUnresolved: true` alongside them and is rolled up under
`notCompared` as well.

Everything not fully compared is listed under the human report's
`N resource(s) only PARTIALLY compared` block — headed
`N resource(s) NOT fully compared — K not compared AT ALL (the read or
comparison failed)` when a `readFailed` resource is present, since calling
such a resource "partially compared" understates it. Each entry names its own
reason, and the per-resource detail also goes to the log, which a caller
piping stdout does not see.

The usual causes are a least-privilege role without
`secretsmanager:GetSecretValue` / `ssm:GetParameter`, a deleted or
rotated-away secret, and a cross-region reference cdkd refuses to resolve in
the consumer's region because that would compare against — and under
`--revert`, write — a different region's same-named secret.

### What "drift unknown" excludes from the count

A resource nothing was read for is **excluded from the summary's "checked"
count** and reported separately as `N unsupported`. A stack whose only
resource is unsupported prints:

```text
⚠ ... no drift detected, but NOTHING was compared — 0 of 1 resource checked (1 unsupported)
```

The glyph follows the question "was everything actually compared", so a stack
in which nothing was compared does not get a reassuring `✓`. The **exit code
is still `0`** — only the claim about coverage changes. The same applies to a
stack whose resources are all Custom Resources, which are reported as
`skipped`.

Both the `N checked` and the `N of M fully checked` spellings count only
resources a comparison was attempted for. In the `N of M` spelling the
unsupported total sits OUTSIDE the parenthetical — `1 of 3 resources fully
checked (2 only partially compared), 1 unsupported` — so the bracketed figure
accounts for exactly the gap between the two numbers rather than reading as a
third share of `M`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` (detection) | Nothing drifted, nothing was refused, and no read or comparison failed. A resource under `notCompared` for an `unresolvedToken` still allows this. |
| `0` (`--accept` / `--revert`) | The remediation run completed. This does NOT assert every comparison completed. |
| `1` | Drift was detected on at least one resource, OR the command failed (no state found, an AWS error, bad arguments). |
| `2` (detection) | Nothing drifted, but at least one comparison did not happen for a reason you can act on. |
| `2` (`--revert`) | The revert finished with one or more resources not reverted. |

The full cross-command table is in the
[CLI Reference](cli-reference.md#exit-codes).

**Drift outranks a partial comparison.** A run that both detects drift and
leaves something uncompared exits `1`, not `2`. Both the drift case and the
crash case go through the same error handler; drift detection emits the full
human report before throwing, so that report is the only output for it.

**Exit `2` on detection is narrower than `notCompared`, deliberately.** Two
causes produce it: a resource cdkd `refused` to compare, and one whose read or
comparison `readFailed`. A resource whose only uncompared properties hold an
`unresolvedToken` is listed under `notCompared` and in the report's
not-fully-compared block, but does not produce this exit code — cdkd resolves
that spelling for nobody, the condition is permanent, and exiting non-zero for
it would fail such a stack's CI forever over something unrelated. A type
Cloud Control has no READ handler for is excluded on the same grounds and
reports `drift unknown` instead, whether the fallback signals that by
returning nothing or by throwing `UnsupportedActionException`.

**A remediation run keeps exit `0` even when the comparison was incomplete.**
`--accept` and `--revert` keep their own exit codes, so a run whose reads were
refused or failed still exits `0`. It says so in words instead: such a run
prints `Comparison INCOMPLETE — nothing to accept/revert, and that is NOT a
clean bill of health`, names how many of the stack's resources were not
compared and why, splits them into the ones cdkd is genuinely uncertain about
(a failed read, a refused or unresolvable dynamic reference) and the ones it
never drift-checks by design (`Custom::*`, and types no provider reads back
yet, reported without any uncertainty claim), and points at the detection-only
run, which DOES report exit `2`. Nothing is written on the strength of a
comparison that did not happen: `--accept` and `--revert` act on drifted
resources only. `--accept` likewise exits `0` when it deliberately refused a
secret-bearing property whose AWS-current value it could not identify — the
refusal is warned about by name, and the drift is still reported next run.

**To gate CI on "everything was actually compared"**, run `cdkd drift`
WITHOUT `--accept` / `--revert` and read its exit code, or read `--json`'s
`notCompared[].cause`.

**Exit `2` on `--revert`** (`PartialFailureError`) covers three shapes: a
`provider.update` call that failed, one that threw
`ResourceUpdateNotSupportedError`, and — counted and reported separately,
since it never reached `provider.update` at all — a resource whose recorded
dynamic reference(s) cdkd could not re-resolve. Grant the caller
`secretsmanager:GetSecretValue` / `ssm:GetParameter`, or fix the reference.
That last counter also covers a resource `--revert` refused because its
recorded baseline holds only the redaction mask and AWS reports nothing to
preserve there. Successful resources are in sync; re-run `cdkd drift <stack>`
to see what is left, then either `cdkd drift <stack> --revert` for the
recoverable failures or `cdkd deploy <stack> --replace` for the
update-not-supported ones.

## Secret and redacted values

**Secret dynamic references** — `{{resolve:secretsmanager:...}}`,
`{{resolve:ssm-secure:...}}`, and `{{resolve:ssm:...}}` naming a
`SecureString` parameter — are compared like-for-like. cdkd state stores the
unresolved expression, never the plaintext, so `cdkd drift` re-resolves the
baseline in memory before comparing it against the AWS-current snapshot. That
is a comparison and nothing else: the resolved value is never written to
state.

This means `cdkd drift` needs **read access to the referenced secrets**:
`secretsmanager:GetSecretValue` for a `secretsmanager` reference, and
`ssm:GetParameter` (with `kms:Decrypt` on the parameter's key) for an `ssm`
one. If the caller lacks the permission, or the secret has been deleted, cdkd
**warns and continues** — that one resource's secret-bearing properties are
reported as neither clean nor drifted, and every other resource and stack in
the run is unaffected.

What the report may show at a secret-bearing property is deliberately narrow:

- When AWS holds the value the reference resolves to, both sides render as the
  `{{resolve:...}}` expression, so the property is clean and nothing is
  printed.
- When AWS holds anything else, the property is reported as drifted with the
  AWS side shown as `***`. The commonest cause is a **Secrets Manager
  rotation**, where the deployed resource still carries the previous version,
  but an out-of-band console edit looks identical from here — cdkd cannot tell
  a stale secret from a non-secret edit, so it prints neither.
- When AWS returns **nothing** for that exact property, it is reported as
  neither clean nor drifted. A write-only credential (`MasterUserPassword` and
  friends) is not returned by any read-back, so an absence there means "cannot
  be checked", not "was removed"; reporting it would make `cdkd drift` exit `1`
  forever on every stack with a templated credential. This applies to the
  property itself only. A whole block disappearing — the console's "remove all
  environment variables" — IS reported, and `--accept` refuses it, because
  accepting an absence deletes the key and would take the `{{resolve:...}}`
  reference with it. Use `--revert` for that shape.
- `--accept` **refuses** such a property and says so: it will not write `***`
  into state, and it will not write a value it could not identify. The drift
  keeps being reported. Properties that are not secret-bearing are accepted
  normally in the same run, and `--accept --dry-run` prints the same refusal
  the real run will make.
- `--revert` re-resolves before calling the provider, so the live resource
  receives the concrete secret rather than the literal `{{resolve:...}}` token.

### Redacted (`NoEcho`) baselines

Where a `NoEcho` custom-resource `Data` value was resolved into a property,
cdkd state holds the literal mask `***` rather than an expression — the value
was generated by the handler, so there is nothing to re-resolve. The three
arms above therefore answer differently, and none of them needs a
`{{resolve:...}}` reference to fire:

- the report shows the position but MASKS the AWS-current side, so the live
  value is not printed;
- `--accept` refuses the property, because accepting would write the live
  plaintext over a deliberate redaction;
- `--revert` leaves that position exactly as AWS has it rather than pushing
  the mask. When AWS reports nothing there, it refuses the whole resource
  (counted with the other unresolvable ones, exit `2`), because sending `***`
  would corrupt the live value and dropping the key would delete a property
  the resource may require.

**Such a position drifts on every run, and that is expected.** cdkd's side is
the mask and AWS's side is the real value, so the two never converge: the
resource is reported as drifted, the report renders `***` on both sides, and
detection-only mode exits `1` indefinitely. cdkd does NOT drop the comparison
the way it drops an absent write-only credential — there the read is
impossible and the comparison meaningless, whereas here the live value is
genuinely readable and cdkd simply cannot say what belongs there. Silently
hiding it would claim a clean bill of health it has no basis for.

To clear it, force the custom resource to update — change one of its
properties, a nonce being the usual way — and re-deploy, so its handler runs
again and supplies the value. An ordinary re-deploy leaves the resource
unchanged, so the handler does not run and the mask stays. If a stack in this
state must gate CI on drift, either stop marking that response `NoEcho`, so
the value round-trips normally, or gate on `--json` and filter the known
position out.

A property whose real value happens to BE the string `***` is treated the same
way, since nothing in state distinguishes the two — see
[State Management](state-management.md#noecho-custom-resource-responses).

### Tokens that are not references

Every CloudFormation spelling — `secretsmanager`, `ssm` and `ssm-secure` — is
resolved and therefore maskable, so a `{{resolve:...}}` token that survives
the pass is text that merely looks like a reference, or a service AWS adds
later. The value AWS holds at such a position is reported as ordinary data:
masking it would leave a path refused by `--accept` and pinned by `--revert`
with no remedy you could apply.

A reference cdkd does not resolve at all is **not** an error and is **not**
compared. The property is reported as neither clean nor drifted, and a warning
names the token once per resource.

What a `--revert` triggered by another drifted property on the same resource
does to those positions depends on where the token sits:

- If the property's **whole value** is the token, the live value is left
  **unchanged** — cdkd cannot tell what it should be, so it does not touch it.
- If the token is **embedded in a longer string**, that string is written
  **with the token literal**, exactly as `cdkd deploy` does, so a value AWS
  holds there **is overwritten**.

Both the drift warning and the revert warning state which of the two applies,
and the drift one is printed before the confirmation prompt.

A stack whose AWS side and state side BOTH hold a literal
`{{resolve:ssm-secure:...}}` token — written by a cdkd release that predates
`ssm-secure` resolution — reads as `NO_CHANGE` on the deploy diff, so
upgrading does not repair the live value on its own. For a property the
provider reads back, `cdkd drift` reports it (the resolved value no longer
matches the literal) and `--revert` writes the resolved value. A write-only
destination (`MasterUserPassword`, `LoginProfile.Password`) needs that
property to be updated once.

## Resource type coverage

Drift detection works for every resource type routed through the Cloud Control
API, which is the majority of cdkd's surface. SDK providers add their own
first-class read-back per type, which avoids the Cloud Control round-trip and
lets the provider map AWS's response shape back to the CloudFormation shape
cdkd state stores.

These SDK-provider types ship with a first-class read-back:

| Service | Types |
| --- | --- |
| `AWS::ApiGateway` | `Account`, `Authorizer`, `Deployment`, `Method`, `Resource`, `Stage` |
| `AWS::ApiGatewayV2` | `Api`, `Authorizer`, `Integration`, `Route`, `Stage` |
| `AWS::AppSync` | `ApiKey`, `DataSource`, `GraphQLApi`, `GraphQLSchema`, `Resolver` |
| `AWS::AutoScaling` | `AutoScalingGroup` |
| `AWS::BedrockAgentCore` | `Browser`, `CodeInterpreter`, `Evaluator`, `Runtime` |
| `AWS::CertificateManager` | `Certificate` |
| `AWS::CloudFormation` | `WaitConditionHandle` |
| `AWS::CloudFront` | `CloudFrontOriginAccessIdentity`, `Distribution`, `OriginAccessControl` |
| `AWS::CloudTrail` | `Trail` |
| `AWS::CloudWatch` | `Alarm` |
| `AWS::CodeBuild` | `Project` |
| `AWS::CodeCommit` | `Repository` |
| `AWS::Cognito` | `UserPool` |
| `AWS::DLM` | `LifecyclePolicy` |
| `AWS::DocDB` | `DBCluster`, `DBInstance`, `DBSubnetGroup` |
| `AWS::DynamoDB` | `GlobalTable`, `Table` |
| `AWS::EC2` | `EIP`, `Instance`, `InternetGateway`, `NatGateway`, `NetworkAcl`, `NetworkAclEntry`, `Route`, `RouteTable`, `SecurityGroup`, `SecurityGroupIngress`, `Subnet`, `SubnetNetworkAclAssociation`, `SubnetRouteTableAssociation`, `VPC`, `VPCGatewayAttachment` |
| `AWS::ECR` | `Repository` |
| `AWS::ECS` | `Cluster`, `Service`, `TaskDefinition` |
| `AWS::EFS` | `AccessPoint`, `FileSystem`, `MountTarget` |
| `AWS::ElastiCache` | `CacheCluster`, `SubnetGroup` |
| `AWS::ElasticLoadBalancingV2` | `Listener`, `LoadBalancer`, `TargetGroup` |
| `AWS::EMR` | `Cluster` |
| `AWS::Events` | `EventBus`, `Rule` |
| `AWS::FSx` | `FileSystem` |
| `AWS::Glue` | `Connection`, `Crawler`, `Database`, `Job`, `SecurityConfiguration`, `Table`, `Trigger`, `Workflow` |
| `AWS::IAM` | `AccessKey`, `Group`, `InstanceProfile`, `ManagedPolicy`, `Policy`, `Role`, `User`, `UserToGroupAddition` |
| `AWS::Kinesis` | `Stream`, `StreamConsumer` |
| `AWS::KinesisFirehose` | `DeliveryStream` |
| `AWS::KMS` | `Alias`, `Key` |
| `AWS::Lambda` | `EventInvokeConfig`, `EventSourceMapping`, `Function`, `LayerVersion`, `MicrovmImage`, `Permission`, `Url` |
| `AWS::Logs` | `LogGroup` |
| `AWS::Neptune` | `DBCluster`, `DBInstance`, `DBSubnetGroup` |
| `AWS::RDS` | `DBCluster`, `DBInstance`, `DBProxy`, `DBProxyEndpoint`, `DBProxyTargetGroup`, `DBSubnetGroup` |
| `AWS::Route53` | `HostedZone`, `RecordSet` |
| `AWS::S3` | `Bucket`, `BucketPolicy` |
| `AWS::S3Express` | `DirectoryBucket` |
| `AWS::S3Tables` | `Namespace`, `Table`, `TableBucket` |
| `AWS::S3Vectors` | `VectorBucket` |
| `AWS::Scheduler` | `Schedule` |
| `AWS::SecretsManager` | `Secret` |
| `AWS::ServiceDiscovery` | `HttpNamespace`, `PrivateDnsNamespace`, `PublicDnsNamespace`, `Service` |
| `AWS::SNS` | `Subscription`, `Topic`, `TopicPolicy` |
| `AWS::SQS` | `Queue`, `QueuePolicy` |
| `AWS::SSM` | `Parameter` |
| `AWS::StepFunctions` | `StateMachine` |
| `AWS::WAFv2` | `WebACL` |

Five SDK-provider types have no first-class read-back yet and take the Cloud
Control fallback described below, exactly as a type with no SDK provider does:
`AWS::Budgets::Budget`, `AWS::CloudFormation::Stack`,
`AWS::CloudWatch::AnomalyDetector`, `AWS::EMR::InstanceFleetConfig` and
`AWS::EMR::InstanceGroupConfig`. `AWS::CloudFormation::Stack` is deny-listed
on that fallback, so it reports `drift unknown`.

> [!NOTE]
> **physicalId formats.** Several types above
> (`AWS::ApiGateway::Method`, `AWS::Route53::RecordSet`,
> `AWS::AppSync::DataSource` / `Resolver` / `ApiKey`, `AWS::Glue::Table`,
> `AWS::S3Tables::Namespace` / `Table`, and the EC2 sub-resources) are
> identified by a **composite, `|`-delimited physical id** rather than a
> single scalar. That composite is what `cdkd state show` /
> `cdkd state resources` print and what
> `cdkd import --resource <logicalId>=<physicalId>` expects — quote it on a
> shell command line. The per-type format table is in
> [State Management](state-management.md#composite-pipe-delimited-physicalids).

### False-drift prevention on the Cloud Control fallback

When an SDK provider has no read-back of its own, drift falls back to Cloud
Control's generic `GetResource`. cdkd state's `properties` field is in
CloudFormation-template shape — what the provider's create call was passed —
and Cloud Control's response is usually the same shape, but for some resource
types it diverges enough to fire false drift on every run. Two guards protect
the fallback:

1. **Deny-list.** Types with verified structural divergence short-circuit to
   `drift unknown` before the Cloud Control call fires. Current entries are
   `AWS::ApiGateway::RestApi` (its `Body` / `BodyS3Location` are write-only
   inputs the response omits, while cdkd state preserves them),
   `AWS::CloudFormation::Stack` (the response is runtime stack state — outputs
   and status — not the template parameters cdkd stores), and
   `AWS::EC2::LaunchTemplate` (the response carries version-bumped
   `LaunchTemplateData` plus a synthetic `LatestVersionNumber`).
2. **Strip pass.** Known AWS-managed timestamp, owner and generated-id fields
   (`CreationDate`, `LastModifiedTime`, `OwnerId`, `RevisionId`, and
   similar) are removed from Cloud Control responses before the comparator
   sees them. The list is conservative: name-collision-prone fields that some
   CloudFormation types use as legitimate inputs (`Status`, `State`,
   `VersionId`, `Arn`) are NOT stripped, so a real `Status` change on
   `AWS::ECS::CapacityProvider.ManagedScaling` still surfaces as drift.

A deny-listed type is fixed by giving it a first-class SDK read-back, which
makes the deny-list entry unreachable.

## Resolving drift: `--accept` and `--revert`

Once `cdkd drift` has detected drift, the same command can resolve it. The two
flags are mutually exclusive — pick the direction that matches the intent.

Both acquire the per-stack lock (the same one `cdkd deploy` uses) before
mutating anything, and both prompt for confirmation unless `-y` / `--yes` is
set. `--dry-run` prints the planned mutations and exits `0` without acquiring
a lock or touching AWS / S3.

Both are no-ops on a clean stack. Resources reported as `drift unknown` are
skipped by both, because the comparator never produced a property difference
for them.

### `--accept` (state ← AWS)

Writes the AWS-current values into cdkd's S3 state file. Use it when the
AWS-side change is the intentional source of truth — typically a manual
console edit you want cdkd to catch up to without redeploying. **AWS resources
are not modified.**

By default the write lands in `observedProperties`, the deploy-time snapshot
used as the drift baseline, so the next drift run reports clean while
`properties` — the last-deployed template intent — is left untouched. For a
resource with no `observedProperties`, the write falls back to `properties`.

The state ETag captured during the read is forwarded as an `IfMatch`
precondition on the save, so a concurrent `cdkd deploy` cannot race the write.

### `--revert` (AWS ← state)

Calls each drifted resource's `provider.update` to push state values back into
AWS. The desired properties are built as the AWS-current snapshot — captured
during the drift read, with no second AWS call — with the **drifted top-level
subtrees overlaid from `observedProperties ?? properties`**, the same
precedence the comparator uses. `previousProperties` is the AWS-current
snapshot itself.

Net effect: every drifted property is pushed back to its state-recorded value,
while non-drifted properties carry their AWS-current values on both sides, so
a diff-based `update()` (SNS, IAM Role) sees `newVal === oldVal` for them and
does not touch AWS for those keys. `--revert` undoes exactly the delta
`cdkd drift` reported and leaves non-drifted attributes alone.

Per-resource failures are collected and surface as `PartialFailureError` at
the end of the run; one resource's failure does not abort the rest. cdkd state
is normally NOT modified — once `provider.update` succeeds, AWS matches state
by definition, so a subsequent `cdkd drift` reports clean. The one exception
is a provider-reported narrowing, below.

#### Tags a revert preserves

A drifted **top-level tag list** keeps any AWS-SERVICE-authored entry instead
of stripping it. Every ordinary tag still reverts exactly as before: one the
baseline lost is re-added, a changed value is reset, and a user- or
console-added tag AWS alone carries is still REMOVED. But a service-managed
key — `AmazonECSManaged`, or any `aws:`-reserved prefix — survives. ECS
attaches `AmazonECSManaged` to an ASG when a capacity provider binds it, and
managed scaling breaks without it, so a strip-everything revert would break
the live resource.

The `--revert` plan names each preserved key before the confirmation prompt.

The carve-out applies to a top-level property NAMED `Tags`, or one whose name
ends in `Tags` — the `[{Key, Value}]` shape alone is not tag-exclusive, as
`LoadBalancerAttributes` shows — and it applies even when the recorded
baseline list is EMPTY, since a declared-but-empty `Tags` still has an AWS
side worth diffing. A tag list NESTED inside another property, such as an EC2
launch template's `TagSpecifications`, still reverts wholesale.

#### AWS-authored values a revert leaves alone

A revert overwrites each drifted top-level subtree from
`observedProperties ?? properties`. When a resource has NO `observedProperties`
— older state, or a deploy-time capture that failed — the desired side is the
raw template, and anything AWS wrote into that subtree that the template never
declared is indistinguishable from an out-of-band change.

cdkd preserves those paths and lists them before the confirmation prompt, in
two forms:

- nested object keys report dotted: `Parameters.table_type`;
- a KEYED `[{Key, Value}]` list reports its missing entries in bracket form:
  `LoadBalancerAttributes[deletion_protection.enabled]`. The bracket
  distinguishes a list entry from a nested path, since attribute keys contain
  dots of their own.

A service-authored tag is not listed — the tag carve-out above preserves it
either way. A POSITIONAL array is compared wholesale, because its elements
have positions rather than identities, so it is neither reported nor narrowed.

#### Resources with no observed-capture baseline

On that same baseline the revert **leaves every untemplated value alone**:
cdkd merges those paths into the bag it actually SENDS, instead of overlaying
the drifted subtree wholesale. Merging on the desired side — rather than
trimming `previousProperties` — is what makes this hold for both provider
shapes: one that key-diffs a collection would otherwise put those paths on its
removal path, and one that replaces a bag wholesale (`PutBucketTagging` is
documented full-replace) never consults the previous side at all.

The plan prints, per affected resource, a
`! this resource has no observed-capture baseline ... LEAVES N AWS-authored
values untouched` line naming each path, before the confirmation prompt and
under `--dry-run`. A Glue Iceberg table's `table_type` / `metadata_location`,
and the roughly eighteen untemplated attributes an ELBv2 load balancer
reports, survive the revert instead of being reset.

Run **`cdkd state refresh-observed <stack>`**, or redeploy, if you want them
reverted too. Either populates `observedProperties`, after which the baseline
IS a deploy-time AWS snapshot, an out-of-band addition is genuinely
identifiable and IS stripped, and the notice stops firing.

Only DRIFTED top-level keys are ever narrowed; non-drifted keys keep their
AWS-current values on both sides.

#### Narrowed values written back to state

Some providers answer `update()` with the bag they ACTUALLY sent, because AWS
only accepts a narrower form than the template declares — `AWS::EC2::Route`'s
single destination, an `AWS::EC2::SecurityGroupIngress` `IpProtocol` coerced
to a string. `--revert` records that narrowing, writing ONLY the keys the
provider changed into the same field the comparator uses as its baseline
(`observedProperties` when the resource has one, else `properties`). Without
it the next `cdkd drift` would report the identical difference and `--revert`
would re-issue the identical call, forever.

Only the provider-changed keys move. The AWS-current values that rode along in
the bag sent to `provider.update` are NOT imported into state, so `--revert`
never behaves like `--accept`. Two further limits keep that guarantee airtight:

- only a key the baseline ALREADY declares can move, so a provider echoing
  back an out-of-band, AWS-only key cannot insert it;
- on a resource with no `observedProperties`, only a key REMOVAL is recorded,
  never a value. That baseline is the raw template, the values sent to the
  provider deliberately carry the untemplated AWS paths described above, and
  writing one into `properties` would make the template intent describe
  AWS-side data.

The write is BEST-EFFORT: AWS has already been reverted by the time it runs,
so a failed state write warns and the command carries on — under `--all`,
aborting would skip every later stack's revert. The only cost of the warn path
is that the narrowing re-surfaces on the next `cdkd drift`.

#### Update-not-supported resources

Some resource types are immutable in AWS (`AWS::Lambda::LayerVersion`,
sub-resource attachments such as `AWS::Lambda::Permission` and
`AWS::ApiGateway::Deployment`) or do not yet have an in-place `update()` in
cdkd (`AWS::AppSync::*`, `AWS::EFS::*`,
`AWS::KinesisFirehose::DeliveryStream`, `AWS::ApiGatewayV2::*`,
`AWS::ApiGateway::Authorizer` / `Deployment` / `Method`,
`AWS::Glue::Database`, `AWS::ServiceDiscovery::*`,
`AWS::ElasticLoadBalancingV2::LoadBalancer`).

For those, `--revert` surfaces a distinct
`⊘ <stack>/<id> (<type>): could not revert — ...` line carrying a
`ResourceUpdateNotSupportedError` and an explicit suggestion. The summary then
names them separately (`N reverted, M update-not-supported`) and the run exits
`2`. The fix is to redeploy the stack with `cdkd deploy --replace`, or destroy
and redeploy — the same recovery path you would use for a CloudFormation
immutable-property error.

AWS update failures — a `provider.update()` call that returns a runtime error
— are reported separately with a `✗` glyph and counted as `failed`. The fix
there is to inspect the AWS error and retry once the underlying cause is
resolved.

## JSON output

`--json` emits an array of per-stack reports:

```json
[
  {
    "stack": "MyStack",
    "region": "us-east-1",
    "drifted": [
      {
        "logicalId": "Bucket1",
        "type": "AWS::S3::Bucket",
        "changes": [
          {
            "path": "VersioningConfiguration.Status",
            "stateValue": "Enabled",
            "awsValue": "Suspended"
          }
        ],
        "referencesUnresolved": false
      }
    ],
    "clean": [
      { "logicalId": "Queue1", "type": "AWS::SQS::Queue", "referencesUnresolved": false }
    ],
    "notSupported": [
      { "logicalId": "Function1", "type": "AWS::Lambda::Function" }
    ],
    "notCompared": []
  }
]
```

A populated `notCompared`, showing the two per-entry keys:

```json
"notCompared": [
  {
    "logicalId": "Function1",
    "type": "AWS::Lambda::Function",
    "referencesUnresolved": true,
    "cause": "refused"
  },
  {
    "logicalId": "Detector1",
    "type": "AWS::CloudWatch::AnomalyDetector",
    "referencesUnresolved": false,
    "cause": "readFailed"
  }
]
```

The `notCompared` roll-up answers one question `clean` alone cannot: **was the
comparison complete?** When cdkd cannot resolve — or deliberately refuses to
resolve — a dynamic reference a resource's state records, that resource's
secret-bearing properties are not compared at all. The comparator skips those
leaves, so nothing is reported as drifted, which on its own is
indistinguishable from compared-and-matched. The array also carries any
resource whose read or comparison threw, for which nothing at all was
compared.

Such a resource appears under `notCompared` and **not** under `clean`, so
every `clean` entry always carries `referencesUnresolved: false`. A `drifted`
entry can carry `referencesUnresolved: true` and is rolled up under
`notCompared` as well.

Each `notCompared` entry carries two keys of its own:

- **`cause`** — `refused`, `unresolvedToken` or `readFailed`. This is the key
  to gate on when you need to tell a clearable cause from a permanent one; the
  exit code says the run had at least one clearable cause but cannot say which
  resource.
- **`referencesUnresolved`** — `true` for the two reference-related causes and
  `false` for `readFailed`, whose references are beside the point. A consumer
  written as `notCompared.filter(n => n.referencesUnresolved)` therefore drops
  `readFailed` entries. Gate on `notCompared.length` — the documented
  predicate — or on `cause`.

So a CI job that gates on drift should read `notCompared`, not just `drifted`:

```bash
# "everything was actually checked, and nothing drifted"
cdkd drift --all --json | jq -e 'all(.[]; .drifted == [] and .notCompared == [])'
```

### Streams under `--json`

With `--json`, **stdout carries the payload and nothing else**, so
`cdkd drift ... --json | jq ...` is safe in every mode, `--accept` and
`--revert` included. Every human-facing line the command would otherwise print
on stdout goes to **stderr** instead: the `--accept` / `--revert` plan, the
confirmation prompt, the `--dry-run` notice,
`No drift detected — nothing to accept.`, the `Comparison INCOMPLETE` block,
the `✓ State updated` and `Revert summary` lines, and `--verbose` debug
output. Warnings and errors were already on stderr and are unaffected.

The lines are **moved, not suppressed**: run the command in a terminal, or
with `2>&1` into a pager, and you see exactly what you would see without
`--json`. Redirect the two streams separately to keep both:

```bash
cdkd drift MyStack --json --accept --yes > report.json 2> progress.log
```

Without `--json`, nothing moves on `cdkd drift` — its human modes print to
stdout as before.

The same contract holds for **every `--json` surface**: `cdkd events --json`
(and its `--format json` alias) and
`cdkd state {resources,show,info} --json` route their
`--verbose` debug output and the `Assumed role ...` notice from `--role-arn` /
`CDKD_ROLE_ARN` runs to stderr while `--json` is in effect.
`cdkd diff --json`
instead demotes the logger to `warn`, which suppresses rather than moves its
info-level lines.

Neither `cdkd list` nor [`cdkd state list`](cli-state.md#cdkd-state-list) is in
that set, because their reservation is not conditional: they reserve stdout in
EVERY mode, `--json` or not, along with `cdkd synth`,
`cdkd local invoke` and `cdkd local invoke-agentcore` — see
[Output streams: when stdout is a payload](cli-reference.md#output-streams-when-stdout-is-a-payload).

## Related

- [Drift Detection](drift.md) — the same subject, summarised for a first read
- [State Management](state-management.md) — the state schema, `observedProperties`, and `cdkd state refresh-observed`
- [`cdkd scrub`](cli-scrub.md) — keeping secret plaintext out of the state records drift compares against
- [`cdkd diff`](cli-diff.md) — the template-vs-state comparison, as opposed to state-vs-AWS
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
- [Troubleshooting](troubleshooting.md) — what to do when a drift run fails
