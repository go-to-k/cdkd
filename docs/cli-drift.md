---
title: cdkd drift
description: "Detect and resolve drift between cdkd state and live AWS resources with cdkd drift."
---

## `cdkd drift`

`cdkd drift [<stack>...]` detects drift between cdkd's S3 state
and the live AWS-side configuration of each managed resource. cdkd does
not go through CloudFormation, so CFn-style drift detection does not
apply — instead, the command asks each resource's provider for its
`readCurrentState` snapshot and compares it against the **deploy-time
AWS snapshot** stored in `ResourceState.observedProperties` (state
schema `version: 3`+). Resources written by an older binary or by a
provider without `readCurrentState` lack `observedProperties` — for
those, the comparator falls back to the user-templated `properties`
field (the pre-v3 behavior). The observed-baseline path is what makes
console-side changes to keys the user did not template surface as
drift; the fallback only catches changes to keys the user did template.
One carve-out on the observed-baseline path: a top-level key the
template never declared whose captured value was EMPTY (`[]` / `{}` /
`null`) is skipped entirely. Such keys are typically materialized AFTER
the capture by a sibling resource in the same stack
(`AWS::ECS::ClusterCapacityProviderAssociations` populating the
cluster's `CapacityProviders`, a standalone
`AWS::AutoScaling::LifecycleHook` populating the ASG's hook list,
standalone security-group ingress/egress rules) or by AWS itself, so
comparing them reported permanent phantom drift on a freshly deployed
stack — and `--revert` then stripped that sibling-managed configuration
from AWS. CloudFormation's drift detection only compares
template-declared properties, so this matches its behavior for that
class; an undeclared key captured with a real value (an AWS-side
default) is still compared.
See [State Management](state-management.md) for the schema
details.

Detection is the default behavior — pass `--accept` or `--revert` to
also resolve any drift the comparator finds (see "Resolving drift" below).

```bash
# Single stack — auto-selects when state has exactly one stack
cdkd drift

# Single stack by name
cdkd drift MyStack

# Every stack in the bucket
cdkd drift --all

# Disambiguate when the same stack name has state in multiple regions
cdkd drift MyStack --stack-region us-east-1

# Machine-readable output for CI gating
cdkd drift --all --json

# Resolve drift: state ← AWS (catch up cdkd state with manual console changes)
cdkd drift MyStack --accept --yes

# Resolve drift: AWS ← state (push cdkd state values back into AWS)
cdkd drift MyStack --revert --yes

# Preview either resolution without acquiring a lock or hitting AWS
cdkd drift MyStack --accept --dry-run
cdkd drift MyStack --revert --dry-run
```

Flags:

- `<stacks...>` — zero or more positional stack names (physical
  CloudFormation names). When omitted and `--all` is not set, the
  command auto-selects the single stack in state (mirrors `cdkd deploy`
  / `cdkd destroy`); fails with a listing if state has more than one
  stack.
- `--all` — drift-check every stack in the state bucket.
- `--stack-region <region>` — region to inspect when a stackName has
  state in multiple regions (mirrors `cdkd state show`).
- `--json` — emit a structured per-stack report (see below) on **stdout, and
  nothing else**. The resolution paths still print their plain-text plan,
  prompt and summary, but under `--json` those go to **stderr** — see "Streams under
  `--json`" below.
- `--accept` — write the AWS-current values back into cdkd state (state
  ← AWS) for every drifted property. By default this updates
  `observedProperties` (the deploy-time snapshot used as the drift
  baseline) so the next drift run reports clean, while leaving
  `properties` (the user's last-deployed template intent) untouched. For
  resources without `observedProperties` (older state, providers without
  `readCurrentState`) the mutation falls back to `properties`, matching
  the pre-v3 behavior. Requires a stack lock. Mutually exclusive with
  `--revert`. See "Resolving drift" below.
- `--revert` — call `provider.update` to push cdkd state values back
  into AWS (AWS ← state) for every drifted resource. The values passed
  to `provider.update` are constructed as the AWS-current snapshot with
  the drifted top-level subtrees overlaid from
  `observedProperties ?? properties` — same precedence as the
  comparator, so `--revert` undoes exactly the delta `cdkd drift`
  reported and leaves non-drifted attributes untouched. One exception:
  a drifted **top-level tag list** keeps any AWS-SERVICE-authored entry
  instead of stripping it. Every ordinary tag still
  reverts exactly as before — one the baseline lost is re-added, a
  changed value is reset, and a user- or console-added tag AWS alone
  carries is still REMOVED — but a service-managed key
  (`AmazonECSManaged`, or any `aws:`-reserved prefix) survives. ECS
  attaches `AmazonECSManaged` to an ASG when a capacity provider binds
  it and managed scaling breaks without it, so the previous
  strip-everything revert silently broke live resources. The `--revert`
  plan names each preserved key before the confirmation prompt. The
  carve-out applies to a top-level property NAMED `Tags` (or ending in
  `Tags`) — the `[{Key, Value}]` shape alone is not tag-exclusive, e.g.
  `LoadBalancerAttributes` — and it applies even when the recorded
  baseline list is EMPTY, since a declared-but-empty `Tags` still has an
  AWS side worth diffing. A tag list NESTED inside another property (an
  EC2 launch template's `TagSpecifications`) still reverts wholesale.

  The plan also **names the AWS-authored values the revert leaves
  alone**. A revert
  overwrites each drifted top-level subtree from
  `observedProperties ?? properties`, so when a resource has NO
  `observedProperties` (older state, or a deploy-time capture that failed)
  the desired side is the raw template — and anything AWS wrote into that
  subtree but the template never declared is indistinguishable from an
  out-of-band change. cdkd preserves those paths and lists them before the
  confirmation prompt. Both shapes are covered: nested object
  keys report dotted (`Parameters.table_type`), and a KEYED
  `[{Key, Value}]` list reports its missing entries in bracket form
  (`LoadBalancerAttributes[deletion_protection.enabled]`) — the bracket
  distinguishes a list entry from a nested path, since attribute keys contain
  dots of their own. That keyed-list half was a later addition: the walk previously
  skipped every array, which is exactly the shape with the most at stake, so
  a revert against an ELBv2 resource could touch ~18 untemplated attributes
  while the plan named none. A service-authored tag is NOT listed — the
  carve-out above preserves it either way. A POSITIONAL array is still
  compared wholesale, because its elements have positions rather than
  identities, so it is neither reported nor narrowed.

  `--revert` normally leaves cdkd state alone — once the update succeeds,
  AWS matches state by definition. The ONE exception is a provider that
  reports a **narrowing**: some providers answer `update()` with the bag
  they ACTUALLY sent, because AWS only accepts a narrower form than the
  template declares (`AWS::EC2::Route`'s single destination, an
  `AWS::EC2::SecurityGroupIngress` `IpProtocol` coerced to a string). The
  deploy path already records that narrowed value; `--revert` now does the
  same, writing ONLY the keys the provider changed into the same field the
  comparator uses as its baseline (`observedProperties` when the resource
  has one, else `properties`). Without it the next `cdkd drift` reported
  the identical difference and `--revert` re-issued the identical call,
  forever. Only the provider-changed keys move — the AWS-current values
  that rode along in the bag sent to `provider.update` are NOT imported
  into state, so `--revert` never behaves like `--accept`. Two further limits
  keep that guarantee airtight: only a key the baseline ALREADY declares can
  move (a provider echoing back an out-of-band, AWS-only key cannot insert it),
  and on a resource with no `observedProperties` only a key REMOVAL is recorded,
  never a value — that baseline is the raw template, the values sent to the
  provider deliberately carry the untemplated AWS paths described above, and
  writing one into `properties` would make the template intent describe AWS-side
  data. That write is BEST-EFFORT: AWS has already been reverted by the time it
  runs, so a failed state write warns and the command carries on (under `--all`,
  aborting would skip every later stack's revert). The only cost of the warn
  path is that the narrowing re-surfaces on the next `cdkd drift`.

  Requires a stack lock. Mutually exclusive with
  `--accept`. See "Resolving drift" below.
- `--dry-run` — for `--accept` / `--revert`: print the planned mutations
  and exit without acquiring a lock or hitting AWS / S3.
- `--concurrency <number>` — maximum concurrent `provider.update` calls
  during `--revert` (default `4`). No effect on `--accept` (writes are
  serialized per stack).
- `-y` / `--yes` — skip the confirmation prompt before writing state
  (`--accept`) or pushing changes back to AWS (`--revert`).
- `--state-bucket`, `--state-prefix`, `--profile`, `--verbose`,
  `--role-arn`, `--region` — same as on every other state-driven
  command. `--region` is deprecated (prefer `AWS_REGION` / your AWS
  profile) but still honored if passed.

Exit codes:

| Exit | Meaning |
| --- | --- |
| `0` (detection) | Every inspected stack has zero drift **and cdkd left no comparison incomplete** (nothing refused, and no read or comparison failed). Note a resource can be reported under `notCompared` and the run still exit `0` — that happens when the only reason it was not compared is a `{{resolve:...}}` spelling cdkd never resolves (see the `2 (detection)` row). |
| `0` (`--accept` / `--revert`) | The remediation run completed: it resolved every drift cleanly, or there was no drift to resolve. **Unlike the detection row, this does NOT mean every comparison completed** — the remediation modes keep their documented exit codes, so a run whose reads were refused or failed still exits `0` (the `2` exit is scoped to detection-only mode deliberately; changing it would alter what a remediation run means). It says so in WORDS instead: a remediation run that found no drift but could not compare everything prints `Comparison INCOMPLETE — nothing to accept/revert, and that is NOT a clean bill of health`, names how many of the stack's resources were not compared and why, splits them into the ones cdkd is genuinely uncertain about (a failed read, a refused or unresolvable dynamic reference) and the ones it never drift-checks by design (`Custom::*`, and types no provider reads back yet — reported without any uncertainty claim), and points at the detection-only run — which DOES report it as exit `2`. Such resources are never touched by `--accept` / `--revert` (both act on drifted resources only), so nothing is written on the strength of a comparison that did not happen. `--accept` likewise exits `0` when it deliberately REFUSED a secret-bearing property whose AWS-current value it could not identify (see "Secret dynamic references" above) — the refusal is warned about by name and the drift is still reported on the next run. **If you gate CI on "everything was actually compared", run `cdkd drift` without `--accept` / `--revert` and read its exit code, or read `--json`'s `notCompared[].cause`.** |
| `1` | Drift detected on at least one resource on at least one stack (detection-only mode), OR the command crashed (no state found, AWS error, bad arguments). Both go through the default error handler — drift detection emits the rich human report before throwing, so the report is the only output for the drift case. Drift OUTRANKS a partial comparison: a run that both detects drift and leaves something uncompared exits `1`, not `2`. |
| `2` (detection) | Nothing drifted, but at least one resource's comparison did not happen for a reason **you can act on**. Two causes produce it. (a) cdkd **deliberately REFUSED** to compare a resource: a dynamic reference its state records could not be attributed to a region, so its secret-bearing properties were not compared. (b) the **read or comparison FAILED** for a resource — an SDK or Cloud Control readback that rejected (a least-privilege role, a throttle), or a comparison that threw on a provider-authored bag. Previously that second cause did not produce an exit code at all: it aborted the whole run with exit `1`, leaving every other resource in the stack unchecked while reporting the same code that means "drift detected", so a CI gate could not tell the two apart. Reporting that run as `0` would be a clean bill of health for a comparison that did not happen — and the refused population likewise used to exit `1`, because cdkd resolved the reference in the wrong region and reported phantom drift, so a non-zero exit is what CI consumers already had. **This is narrower than `notCompared`, deliberately.** A resource whose only uncompared properties hold a surviving `{{resolve:...}}` look-alike token (a spelling that is not a CloudFormation dynamic reference at all — every supported spelling, `ssm-secure` included, is resolved) is listed under `notCompared` and in the report's not-fully-compared block, but does **not** produce this exit code: cdkd resolves that spelling for nobody, so the condition is permanent and unclearable by any action you can take, and exiting non-zero for it would fail such a stack's CI forever over something unrelated. **A type Cloud Control has no READ handler for is excluded on the same grounds** and reports `drift unknown` instead, whether the fallback signals it by returning nothing or by throwing `UnsupportedActionException`. Fix a refusal by spelling the reference as a full ARN, which names its region; fix a read failure by granting the missing permission or re-running. Use `--json` and read each `notCompared` entry's `cause` to tell them apart per resource. |
| `2` (`--revert`) | `--revert` finished but one or more resources did not revert (`PartialFailureError`): a `provider.update` call failed, threw `ResourceUpdateNotSupportedError`, or — counted and reported separately, since it never reached `provider.update` at all — cdkd could not re-resolve the dynamic reference(s) the resource's state records (grant the caller `secretsmanager:GetSecretValue` / `ssm:GetParameter`, or fix the reference). That same counter also covers a resource `--revert` REFUSED because its recorded baseline holds only the redaction mask and AWS reports nothing to preserve there (force that custom resource to update and re-deploy, so its handler supplies the value again; an ordinary re-deploy leaves it unchanged). Successful resources are now in sync; re-run `cdkd drift <stack>` to see what's left, then either `cdkd drift <stack> --revert` (for the recoverable failures) or `cdkd deploy <stack> --replace` (for the update-not-supported ones). |

The command produces four terminal states per resource:

- **drifted** — at least one property differs between state and AWS.
  Reported as `~ <logicalId> (<type>)` with one `+/-` line per
  property path that diverged.
- **clean** — every state-recorded property was compared against AWS and
  matched. Counted in the per-stack summary but not listed individually.
- **not compared** — nothing differed, but cdkd did not compare every
  property. Three causes, told apart per resource by `--json`'s
  `notCompared[].cause`:
  - `refused` — cdkd deliberately refused to resolve a dynamic reference the
    resource's state records, so its secret-bearing properties were never
    looked at. Clearable: spell the reference as a full ARN.
  - `unresolvedToken` — the state records a `{{resolve:...}}` spelling cdkd
    resolves for nobody. cdkd resolves all three CloudFormation services
    (`secretsmanager`, `ssm` and `ssm-secure`), so this is reserved for a
    spelling that is not a dynamic reference at all, or one AWS adds later.
    Permanent; a re-run cannot clear it, which is why it alone does not
    affect the exit code.
  - `readFailed` — the read or the comparison THREW, so **none** of that
    resource's properties were compared. Every OTHER resource
    in the stack is still compared and reported; previously one such throw
    aborted the entire run.
- **drift unknown** — the provider does not implement the optional
  `readCurrentState` method yet. Reported as `? <logicalId> (<type>)`
  in a separate block at the bottom of each stack's report, and — like
  everything else nothing was read for — **excluded from the summary's
  "checked" count**, which reports it separately as `N unsupported`. A stack whose
  only resource is unsupported prints
  `⚠ ... no drift detected, but NOTHING was compared — 0 of 1 resource checked
  (1 unsupported)` — the glyph follows "was everything actually compared", so a
  stack in which nothing was compared does not get the reassuring
  `✓`. The **exit code is
  unchanged at `0`**: only the claim printed about coverage changed. The same
  applies to a stack whose resources are all Custom Resources (`skipped`).

A **drifted** resource can be partially compared too — the changes it reports
are real, but they are not the whole comparison — so it carries
`referencesUnresolved: true` alongside them. Everything not fully compared, that
resource included, is rolled up under `notCompared` in `--json`, listed under the
human report's `PARTIALLY compared` block -- whose heading changes to
`NOT fully compared` when a `readFailed` resource is present, since none of that
resource's properties were compared and calling it "partially" understates it -- and excluded from that report's
"fully checked" count — as is anything **unsupported**, so both the `N checked`
and the `N of M fully checked` spellings count only resources a comparison was
attempted for. In the `N of M` spelling the unsupported total is reported
outside the parenthetical (`1 of 3 resources fully checked (2 only partially
compared), 1 unsupported`), so the bracketed figure accounts for exactly the
gap between the two numbers rather than reading as a third share of `M`. A **clean** verdict never means anything but "compared
and matched".

Two different things land in that bucket, and only one of them changes the exit
code:

- **Refused** — cdkd CAN read the reference but declines to, because it cannot
  tell which region should answer for it. This is actionable (spell the
  reference as a full ARN) and it drives exit `2`.
- **Unresolvable** — a `{{resolve:...}}` spelling cdkd resolves for nobody.
  No CloudFormation service is in that position (cdkd resolves
  `secretsmanager`, `ssm` and `ssm-secure`); the bucket is kept for text that
  merely looks like a reference. Nothing you can do makes cdkd compare it, so
  it is reported but left out of the exit code.

The `--json` payload does not distinguish them today; if you need to, key on
whether the run exited `2`. Giving the two
causes a single, explicit representation is planned.

**Secret dynamic references** (`{{resolve:secretsmanager:...}}`,
`{{resolve:ssm-secure:...}}`, and `{{resolve:ssm:...}}` naming a
`SecureString` parameter) are compared
like-for-like. cdkd state stores the unresolved expression, never the
plaintext, so `cdkd drift` re-resolves the baseline in memory before
comparing it against the AWS-current snapshot — a comparison, and nothing
else: the resolved value is never written to state.

This means `cdkd drift` needs **read access to the referenced secrets**:
`secretsmanager:GetSecretValue` for a `secretsmanager` reference, and
`ssm:GetParameter` (with `kms:Decrypt` on the parameter's key) for an `ssm`
one. Earlier versions made no such call. If the caller lacks the permission,
or the secret has been deleted, cdkd **warns and continues**: that one
resource's secret-bearing properties are reported as neither clean nor
drifted — they are simply not compared — and every other resource and stack
in the run is unaffected.

What the report is allowed to show at a secret-bearing property is
deliberately narrow:

- When AWS holds the value the reference resolves to, both sides render as
  the `{{resolve:...}}` expression, so the property is clean and nothing is
  printed at all.
- When AWS holds anything else — the commonest cause is a **Secrets Manager
  rotation**, where the deployed resource still carries the previous version,
  but an out-of-band console edit looks identical from here — the property is
  reported as drifted with the AWS side shown as `***`. cdkd cannot tell a
  stale secret from a non-secret edit, so it does not print either.
- When AWS returns **nothing** for that exact property, it is reported as
  neither clean nor drifted. A write-only credential (`MasterUserPassword` and
  friends) is not returned by any readback, so an absence there means "cannot
  be checked", not "was removed" — reporting it would make `cdkd drift` exit 1
  forever on every stack with a templated credential. This applies to the
  property itself only: a whole block disappearing (the console's "remove all
  environment variables") IS reported, and `--accept` refuses it, because
  accepting an absence deletes the key and would take the `{{resolve:...}}`
  reference with it. Use `--revert` for that shape.
- `--accept` **refuses** such a property and says so: it will not write `***`
  into state, and it will not write a value it could not identify. The drift
  keeps being reported. Use `--revert` to push the referenced value back to
  AWS, or re-deploy if the reference itself changed. Properties that are not
  secret-bearing are accepted normally in the same run, and `--accept
  --dry-run` prints the same refusal the real run will make.
- `--revert` re-resolves before calling the provider, so the live resource
  receives the concrete secret rather than the literal `{{resolve:...}}`
  token.

**A REDACTED baseline is a different shape**. Where a `NoEcho`
custom-resource `Data` value was resolved into a property, cdkd state holds the
literal mask `***` rather than an expression — the value was generated by the
handler, so there is nothing to re-resolve. The three arms above therefore
answer differently, and none of them needs a `{{resolve:...}}` reference to
fire:

- the report shows the position but MASKS the AWS-current side, so the live
  value is not printed;
- `--accept` refuses the property, because accepting would write the live
  plaintext over a deliberate redaction;
- `--revert` leaves that position exactly as AWS has it rather than pushing the
  mask. When AWS reports nothing there, it refuses the whole resource (counted
  with the other unresolvable ones — exit `2`), because sending `***` would
  corrupt the live value and dropping the key would delete a property the
  resource may require. To clear it, force the custom resource to update
  (change one of its properties — a nonce is the usual way) and re-deploy, so
  its handler runs again and supplies the value; an ordinary re-deploy leaves
  the resource unchanged, so the handler does not run and the mask stays.

**Such a position drifts on every run, and that is expected.** cdkd's side is
the mask and AWS's side is the real value, so the two never converge — the
resource is reported as drifted, the report renders `***` on both sides
(cdkd will not print the live one), and detection-only mode exits `1`
indefinitely. cdkd does NOT drop the comparison the way it drops an absent
write-only credential: there the read is impossible and the comparison is
meaningless, whereas here the live value is genuinely readable and cdkd simply
cannot say what belongs there — silently hiding it would claim a clean bill of
health it has no basis for. If a stack in this state must gate CI on drift,
either stop marking that response `NoEcho` (the value then round-trips
normally) or gate on `--json` and filter the known position out.

A property whose real value happens to BE the string `***` is treated the same
way, since nothing in state distinguishes the two — see
[State Management](state-management.md#noecho-custom-resource-responses).

**A surviving token is not treated as a secret.** Every CloudFormation
spelling — `secretsmanager`, `ssm` and `ssm-secure` — is resolved and
therefore maskable, so a `{{resolve:...}}` token that survives the pass is
text that merely looks like a reference (or a service AWS adds later). The
value AWS holds at such a position is reported as ordinary data: masking it
would leave a path refused by `--accept` and pinned by `--revert` with no
remedy you could apply.

A reference cdkd does not resolve at all is **not** an error, and is **not**
compared: the property is reported as neither clean nor drifted, and a
warning names the token once per resource.

What a `--revert` triggered by another drifted property on the same resource
does to those positions depends on where the token sits:

- If the property's **whole value** is the token, the live value is left
  **unchanged** — cdkd cannot tell what it should be, so it does not touch it.
- If the token is **embedded in a longer string**, that string is written
  **with the token literal**, exactly as `cdkd deploy` does — so a value AWS
  holds there **is overwritten**.

**A stack deployed by a cdkd release that did not yet resolve `ssm-secure`**
holds the literal token on AWS and the same token in state, so the deploy
diff reads `NO_CHANGE` and the live value is not repaired by the upgrade. For
a property the provider reads back, `cdkd drift` reports it (the resolved
value no longer matches the literal) and `--revert` writes the resolved value;
a write-only destination (`MasterUserPassword`, `LoginProfile.Password`) needs
that property to be updated once.

Both the drift warning and the revert warning state which of the two applies,
and the drift one is printed before the confirmation prompt.

Drift detection works automatically for every resource type that goes
through Cloud Control API (the majority of cdkd's surface). SDK
Providers add their own `readCurrentState` incrementally — providers
without an implementation surface as `drift unknown` rather than `clean`,
so you can see exactly which types are still uncovered.

The following SDK Providers ship with first-class `readCurrentState`
(no CC API round-trip):
- `AWS::Lambda::Function`, `AWS::S3::Bucket`, `AWS::DynamoDB::Table`,
  `AWS::IAM::Role`, `AWS::SQS::Queue`, `AWS::SNS::Topic`,
  `AWS::Logs::LogGroup`
- `AWS::CloudFront::CloudFrontOriginAccessIdentity`,
  `AWS::Events::EventBus`, `AWS::Events::Rule`,
  `AWS::SSM::Parameter`, `AWS::SecretsManager::Secret`,
  `AWS::ECR::Repository`, `AWS::StepFunctions::StateMachine`,
  `AWS::ECS::Cluster`, `AWS::ECS::Service`, `AWS::ECS::TaskDefinition`,
  `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`,
  `AWS::RDS::DBSubnetGroup`, `AWS::KMS::Key`, `AWS::KMS::Alias`,
  `AWS::ApiGateway::Account`, `AWS::ApiGateway::Method`,
  `AWS::ApiGatewayV2::Api`, `AWS::Cognito::UserPool`
- `AWS::AppSync::GraphQLApi`, `AWS::AppSync::DataSource`,
  `AWS::AppSync::Resolver`, `AWS::AppSync::ApiKey`,
  `AWS::EFS::FileSystem`, `AWS::EFS::AccessPoint`, `AWS::EFS::MountTarget`,
  `AWS::ElastiCache::CacheCluster`, `AWS::ElastiCache::SubnetGroup`,
  `AWS::ElasticLoadBalancingV2::LoadBalancer`,
  `AWS::ElasticLoadBalancingV2::TargetGroup`,
  `AWS::ElasticLoadBalancingV2::Listener`,
  `AWS::Route53::HostedZone`, `AWS::Route53::RecordSet`,
  `AWS::WAFv2::WebACL`,
  `AWS::KinesisFirehose::DeliveryStream`, `AWS::Kinesis::Stream`,
  `AWS::Glue::Database`, `AWS::Glue::Table`,
  `AWS::CloudTrail::Trail`, `AWS::CloudWatch::Alarm`,
  `AWS::CodeBuild::Project`,
  `AWS::ServiceDiscovery::PrivateDnsNamespace`,
  `AWS::ServiceDiscovery::Service`,
  `AWS::SNS::Subscription`
- `AWS::IAM::Policy`, `AWS::Lambda::Permission`,
  `AWS::ApiGateway::Authorizer`, `AWS::ApiGateway::Resource`,
  `AWS::ApiGateway::Deployment`, `AWS::ApiGateway::Stage`,
  `AWS::ApiGatewayV2::Stage`, `AWS::ApiGatewayV2::Integration`,
  `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Authorizer`
  (the sub-resource batch; receives `properties` so the parent
  `RestApiId` / `ApiId` / `FunctionName` / `Roles[]` is available to
  issue the matching `Get*` call)
- `AWS::ServiceDiscovery::HttpNamespace`,
  `AWS::ServiceDiscovery::PublicDnsNamespace`
- `AWS::CloudFront::OriginAccessControl` (SDK provider added to take the
  type off the Cloud Control polling path; the CFn and SDK
  `OriginAccessControlConfig` field names are identical, so the reverse
  mapping is a straight per-field copy)

> [!NOTE]
> **physicalId formats.** Several types in the lists above
> (`AWS::ApiGateway::Method`, `AWS::Route53::RecordSet`,
> `AWS::AppSync::DataSource` / `Resolver` / `ApiKey`, `AWS::Glue::Table`,
> `AWS::S3Tables::Namespace` / `Table`, and the EC2 sub-resources) are
> identified by a **composite, `|`-delimited physical id** rather than a
> single scalar. That composite is what `cdkd state show` /
> `cdkd state resources` print and what
> `cdkd import --resource <logicalId>=<physicalId>` expects — quote it on
> a shell command line. The per-type format table is in
> [State Management](state-management.md#composite-pipe-delimited-physicalids).

Tag drift is supported across the SDK Providers listed above (and the CC
API fallback). cdkd filters out CDK / AWS-internal `aws:`-prefixed entries
(notably `aws:cdk:path` and `aws:cdk:metadata`) from the AWS-current
snapshot before comparing — those are injected by CDK as construct
metadata, not as user-managed `Tags` properties, so leaving them in would
fire false-positive drift on every CDK-deployed resource. The remaining
user tags are normalized to CFn's `[{Key, Value}]` shape (sorted by `Key`
for stable comparison) and the result key is omitted entirely when AWS
reports no user tags. IAM Role / User / Group inline-policy bodies are
covered (paginated `List*Policies` + parallel `Get*Policy` round-trips
with state-driven order reconciliation);
see [src/types/resource.ts](https://github.com/go-to-k/cdkd/blob/main/src/types/resource.ts) for the per-provider
shape decisions.

Still reporting `drift unknown` (deferred):

- `AWS::CloudFront::Distribution` defers to the CC API fallback — its
  `DistributionConfig` schema uses the SDK's `Quantity + Items` shape vs
  CFn's flat array shape, and mirroring the conversion would balloon the
  diff for marginal gain over the CC API path.
- `AWS::AppSync::GraphQLSchema` body drift is deferred — AWS's
  `GetIntrospectionSchema` returns SDL bytes but normalizes the schema
  on the way out (canonical field ordering, comment / whitespace
  stripping), so a direct string comparison against the user-authored
  `Definition` in cdkd state would fire constantly on cosmetic diffs.
  A meaningful comparison needs an SDL parser to canonicalize both
  sides before diff, which is out of scope.
- `AWS::Kinesis::StreamConsumer` falls through to the CC API fallback;
  the SDK provider only handles `AWS::Kinesis::Stream`. A dedicated
  SDK impl would require building out create / update / delete first.

### Streams under `--json`

With `--json`, **stdout carries the payload and nothing else**, so
`cdkd drift ... --json | jq ...` is safe on every mode including `--accept` /
`--revert`. Every human-facing line the command would otherwise print on
stdout — the `--accept` / `--revert` plan, the confirmation prompt, the
`--dry-run` notice, `No drift detected — nothing to accept.`, the
`Comparison INCOMPLETE` block, the `✓ State updated` and `Revert summary`
lines, and `--verbose` debug output — goes to **stderr** instead. Warnings and
errors were already on stderr and are unaffected.

The lines are **moved, not suppressed**: run the command in a terminal (or with
`2>&1` into a pager) and you see exactly what you saw before. Redirect the two
streams separately to keep both:

```bash
cdkd drift MyStack --json --accept --yes > report.json 2> progress.log
```

Without `--json` nothing moves **on `cdkd drift`** — its human modes keep
printing to stdout as before. Previously these lines shared stdout
with the payload, so a `--json --accept` run produced a document a parser
rejected while looking correct on screen.

The same contract holds for **every `--json` surface**, not just `drift`:
`cdkd events --json` (and its `--format json` alias) and the four
`cdkd state {list,resources,show,info} --json` subcommands route their
`--verbose` debug output and the `Assumed role ...` notice from
`--role-arn` / `CDKD_ROLE_ARN` runs to **stderr** while `--json` is in effect.
`cdkd diff --json` predates the mechanism and instead demotes the logger to
`warn`, which suppresses rather than moves its info-level lines.

**`cdkd list` is no longer in that list, because its reservation is no longer
conditional**: it reserves stdout in
EVERY mode, `--json` or not, along with `cdkd synth`, `cdkd local invoke` and
`cdkd local invoke-agentcore` -- see
[Output streams: when stdout is a payload](cli-reference.md#output-streams-when-stdout-is-a-payload).

`--json` output shape:

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

A populated `notCompared` entry, showing the two per-entry keys:

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

The `notCompared` roll-up answers one question `clean` alone cannot:
**was the comparison complete?** When cdkd cannot resolve — or
deliberately REFUSES to resolve — a dynamic reference a resource's state
records, that resource's secret-bearing properties are not compared at
all. The comparator skips those leaves, so nothing is reported as
drifted, which on its own is indistinguishable from "compared and
matched". The array also carries a
resource whose read or comparison THREW, for which **nothing at all** was
compared.

Such a resource appears under `notCompared` and **not** under `clean`: `clean`
means compared-and-matched and nothing else, so its entries always carry
`referencesUnresolved: false`. A `drifted` entry can carry
`referencesUnresolved: true` — the changes it reports are real, but they
are not the whole comparison — and it is rolled up under `notCompared`
as well.

Each `notCompared` entry carries two keys of its own:

- `cause` — `refused`, `unresolvedToken` or `readFailed` (see the outcome list
  above). This is the key to gate on when you need to tell a **clearable**
  cause from a **permanent** one; the exit code says the run had at least one
  clearable cause but cannot say which resource.
- `referencesUnresolved` — `true` for the two reference-related causes and
  `false` for `readFailed`, whose references are beside the point. It was the
  constant `true` before `readFailed` entries widened the array's population, so **a consumer
  written as `notCompared.filter(n => n.referencesUnresolved)` silently drops
  `readFailed` entries** where it previously matched everything in the array.
  Gate on `notCompared.length` (unchanged, and the documented predicate) or on
  `cause`; the run still exits `2` either way.

So a CI job that gates on drift should read `notCompared`, not just
`drifted`:

```bash
# "everything was actually checked, and nothing drifted"
cdkd drift --all --json | jq -e 'all(.[]; .drifted == [] and .notCompared == [])'
```

The human-readable report says the same thing in a block headed
`N resource(s) only PARTIALLY compared` — or, when a `readFailed` resource is
present, `N resource(s) NOT fully compared — K not compared AT ALL (the read or
comparison failed)`, because calling such a resource "partially compared"
understates it. Each entry names its own reason. The per-resource detail also
goes to the log, which a caller piping stdout does not see. The usual
causes are a least-privilege role without `secretsmanager:GetSecretValue`
/ `ssm:GetParameter`, a deleted or rotated-away secret, and a
cross-region reference cdkd refuses to resolve in the consumer's region
because that would compare against (and with `--revert`, write) a
different region's same-named secret.

The comparator only looks at keys present in cdkd state — AWS-managed
fields (timestamps, generated identifiers, account-wide defaults) that
cdkd never set are ignored, so they never surface as false-positive
drift.

### False-drift prevention for the CC API fallback

When an SDK Provider doesn't yet implement `readCurrentState`, drift
falls back to Cloud Control API's generic `GetResource`. cdkd state's
`properties` field is in CFn-template shape (what `provider.create()`
was passed); CC API's response is usually the same shape, but for some
resource types it diverges enough to fire false-positive drift on
every run. Two guards protect the fallback:

1. **Deny-list** (`src/analyzer/drift-cc-api-deny-list.ts`) — types
   with verified structural divergence (e.g. `AWS::ApiGateway::RestApi`'s
   write-only `Body` field, or `AWS::EC2::LaunchTemplate`'s
   version-bumped `LaunchTemplateData`) short-circuit to `drift unknown`
   before the CC API call ever fires. The fix path for any deny-listed
   type is a first-class SDK-provider `readCurrentState`, not a
   per-entry tweak — once the provider implements it, the deny-list
   entry is unreachable.
2. **Strip pass** (`src/analyzer/cc-api-strip.ts`) — known AWS-managed
   timestamp / owner / generated-id fields (`CreationDate`,
   `LastModifiedTime`, `OwnerId`, `RevisionId`, ...) are removed from
   CC API responses before the comparator sees them. The strip list is
   conservative: name-collision-prone fields that some CFn types use
   as legitimate inputs (`Status`, `State`, `VersionId`, `Arn`, ...)
   are NOT stripped, so a real `Status` change on
   `AWS::ECS::CapacityProvider.ManagedScaling` still surfaces as
   drift.

A breadth-of-coverage shape fixture suite
(`tests/unit/analyzer/drift-cc-api-shape-fixtures.test.ts`) verifies
~10 representative CC-API-fallback types produce zero drift on a
clean stack. When a new shape regression is reported, add the type
either to the fixture suite (if the strip list catches it) or to the
deny-list (if the divergence is structural).

### Resolving drift (`--accept` / `--revert`)

Once `cdkd drift` has detected drift, the same command can also resolve
it. The two flags are mutually exclusive — pick the direction that
matches the intent:

- **`--accept`** (state ← AWS) — write the AWS-current values back
  into cdkd's S3 state file. Use this when the AWS-side change is the
  intentional source of truth (typically a manual console edit you want
  cdkd to "catch up" to without re-deploying). The cdkd state ETag
  captured during the read is forwarded to `S3StateBackend.saveState`
  as `IfMatch` for optimistic locking, so a concurrent `cdkd deploy`
  cannot race the write. AWS resources are NOT modified.

- **`--revert`** (AWS ← state) — call each drifted resource's
  `provider.update` to push state values back into AWS for the
  drifted properties. `properties` is built as the AWS-current
  snapshot (captured during the drift read, no second AWS call) with
  the **drifted top-level subtrees overlaid from cdkd's
  `observedProperties`**, and `previousProperties` is the AWS-current
  snapshot itself. Net effect: every drifted property is pushed back
  to its state-recorded value; non-drifted properties carry their
  AWS-current values, so a diff-based `update()` (e.g. SNS, IAM Role)
  sees `newVal === oldVal` for them and does not touch the AWS
  resource for those keys. Use this to undo a manual AWS console
  change. Per-resource failures are collected and surface as
  `PartialFailureError` (exit 2) at the end of the run; one resource's
  failure does not abort the rest. cdkd state is NOT modified by
  `--revert` — once `provider.update` succeeds, AWS values match state
  by definition, so a subsequent `cdkd drift` reports `clean`.

  **Resources with no observed-capture baseline.** The revert baseline is
  `observedProperties ?? properties`. A resource deployed BEFORE
  observed-capture shipped has no `observedProperties`, so the desired side
  is the raw **template** while the previous side would be the AWS-current
  snapshot — and on that baseline cdkd cannot tell an AWS-authored value
  from an out-of-band change, because neither appears in the template.

  So on that baseline the revert **leaves every untemplated value
  alone**: cdkd merges
  those paths into the bag it actually SENDS, instead of overlaying the
  drifted subtree wholesale. Merging on the desired side (rather than trimming
  `previousProperties`) is what makes this hold for both provider shapes — one
  that key-diffs a collection would otherwise put them on its removal path,
  and one that replaces a bag wholesale (`PutBucketTagging` is documented
  full-replace) never consults the previous side at all. The plan
  prints, per affected resource, a `! this resource has no observed-capture
  baseline ... LEAVES N AWS-authored values untouched` line naming each path,
  before the confirmation prompt and under `--dry-run`. A Glue Iceberg
  table's `table_type` / `metadata_location`, and the ~18 untemplated
  attributes an ELBv2 load balancer reports, survive the revert instead of
  being reset. Run **`cdkd state refresh-observed <stack>`** (or re-deploy)
  if you want them reverted too; either populates `observedProperties`, after
  which the baseline IS a deploy-time AWS snapshot — an out-of-band addition
  is then genuinely identifiable and IS stripped, and the notice stops
  firing. Only DRIFTED
  top-level keys are ever narrowed; non-drifted keys keep their AWS-current
  values on both sides.

  **Update-not-supported resources.** Some resource types are immutable
  in AWS (e.g. `AWS::Lambda::LayerVersion`, sub-resource attachments
  like `AWS::Lambda::Permission`, `AWS::ApiGateway::Deployment`) or do
  not yet have an in-place `update()` implementation in cdkd
  (`AWS::AppSync::*`, `AWS::EFS::*`, `AWS::KinesisFirehose::DeliveryStream`,
  `AWS::ApiGatewayV2::*`, `AWS::ApiGateway::Authorizer` /
  `Deployment` / `Method`, `AWS::Glue::Database`,
  `AWS::ServiceDiscovery::*`, `AWS::ElasticLoadBalancingV2::LoadBalancer`).
  For those, `--revert` surfaces a distinct `⊘ <stack>/<id> (<type>):
  could not revert — ...` line with a `ResourceUpdateNotSupportedError`
  and an explicit suggestion. The summary then names them separately
  ("`N reverted, M update-not-supported`") and the run exits `2`. The
  fix is to **re-deploy the stack with `cdkd deploy --replace`**, or
  destroy + redeploy — the same recovery path you would use for a
  CloudFormation immutable-property error. AWS update failures (a
  successful `provider.update()` call returning a runtime error) are
  reported separately with a `✗` glyph and counted as `failed`; the
  fix there is to inspect the AWS error and retry once the underlying
  cause is resolved.

Both flags acquire the per-stack lock (the same one `cdkd deploy` uses)
before mutating anything, and prompt for confirmation unless `-y` /
`--yes` is set. `--dry-run` prints the planned mutations and exits 0
without acquiring a lock or hitting AWS / S3.

`--accept` is a no-op on a clean stack (no drift, nothing to write).
`--revert` is likewise a no-op on a clean stack (no drift, nothing to
push). Resources surfaced as `unsupported` (provider has no
`readCurrentState` yet) are skipped by both flags — the comparator
never produced a `PropertyDrift` for them.

