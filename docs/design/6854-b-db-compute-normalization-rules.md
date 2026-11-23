---
title: "Design: the database and compute provider normalization rules (#6854, lane B)"
unlisted: true
---

# Design: the database and compute provider normalization rules (#6854, lane B)

## Scope

This page continues `6852-drift-normalization-rules.md` for the RDS,
DocumentDB, Neptune, FSx, Auto Scaling, EC2, ELBv2, CodeBuild and Lambda
providers (`src/provisioning/providers/{rds,docdb,neptune,fsx-filesystem,asg,ec2,elbv2,codebuild,lambda-*}`
and `db-associated-roles.ts`). It lists every rule that makes two values
compare equal in `cdkd drift` or in a provider's change detection: the
canonicalizers (`canonicalizeDriftProperties`, `canonicalizeDriftPair`,
`canonicalizeDesiredProperties`), the unordered-path declarations
(`getDriftUnorderedPaths`), and the readback steps that echo the recorded
spelling or fold a live value. For each rule it records why AWS treats the two
spellings as one, the boundary, the negative test, and the verdict.

A rule may equate two values only when AWS treats them as one. Where AWS
behavior is unknown, the values compare as different.

Tests: `tests/unit/provisioning/db-compute-normalization-boundaries-6854.test.ts`
holds a positive and a negative case per canonicalizer rule; the readback rules
are tested in their providers' readback suites (named per row).

Measurements (us-east-1, 2026-11-23, each throwaway resource deleted after the
probe):

- EC2 `CreateSubnet` with `Ipv6CidrBlock` `2600:1f18:7033:e001::5/64` stored
  `2600:1f18:7033:e001::/64`; an upper-case, fully expanded spelling stored
  the compressed lower-case one.
- EC2 `AuthorizeSecurityGroupIngress` with `10.0.0.5/24` stored `10.0.0.0/24`,
  with `2001:db8::5/64` stored `2001:db8::/64`, and refused `10.0.0.0/` as
  malformed.
- SSM `CreateAssociation` refused the ARN of a document this account owns
  ("Use '<name>' instead") and the ARN of an AWS document, so a `DocumentName`
  ARN always names another account's shared document.
- Auto Scaling `AttachTrafficSources` with an `elbv2` target group listed the
  group in `TargetGroupARNs` as well as in `TrafficSources`.

## Rules tightened by this audit

| Rule | Where | What it equated that AWS does not | Now |
| --- | --- | --- | --- |
| Event source mapping `FunctionName` echoed as the recorded bare name | `lambda-eventsource/read-state.ts` `readCurrentState` | The ARN's LAST segment was compared with the recorded name. On a mapping to an alias or version (`...:function:other-fn:prod`) that segment is the qualifier, so a mapping on `other-fn:prod` read as one on a function named `prod`. | The bare name is echoed only for that function's UNQUALIFIED ARN (`parseLambdaFunctionAddress`); a qualified ARN is emitted as AWS returns it. Tests: `lambda-eventsource-provider-readcurrentstate.test.ts`. |
| FSx Windows `Aliases` read regardless of lifecycle | `fsx-filesystem/read-state.ts` `readWindowsConfiguration` | An alias that failed to associate (`CREATE_FAILED`) or is being disassociated (`DELETING`) read as one of the file system's names, so a declared alias that never worked compared equal. | Those two lifecycles are left out (a declared one reads as drift, and `--revert` re-associates it through `applyAliasDelta`'s retry arm). `CREATING` and `DELETE_FAILED` (still associated) count as held. Test: `providers/fsx-filesystem-provider.test.ts`. |
| Security group rule CIDR key | `ec2/sg-rule-by-id.ts` `cidrKey` (now `sg-rule-identity.ts` `sgCidrKey`, shared by every SG rule identity; see the EC2 table) | A prefix of no digits (`10.0.0.0/`) read as `/0`, the same key as `0.0.0.0/0`. EC2 refuses that spelling. | The prefix must be 1-3 digits, else the value is compared as written. The IPv6 arm now clears host bits as well (`canonicalizeIpv6Cidr`), which EC2 does (measured), so a recorded `2001:db8::5/64` no longer reads as moved. Test: `db-compute-normalization-boundaries-6854.test.ts`. |
| Route matched by destination alone | `ec2/read-state.ts` `readRouteCurrentState` | A route a virtual private gateway propagates, or the table's `local` route, at the same destination read as this `AWS::EC2::Route` after it was deleted out of band. | Only a route whose `Origin` is not `EnableVgwRoutePropagation` / `CreateRouteTable` is this resource's; with none, the route reads as gone (also for a failed deploy's rollback settle and the replaced-survivor existence read, which then see the route gone). Boundary: an `AWS::EC2::Route` imported at the VPC CIDR (the `local` route) always reads as gone; cdkd's own create cannot make one. Test: `ec2-provider-readcurrentstate.test.ts`. |

## The rules

### RDS, DocumentDB, Neptune (`rds/drift.ts`, `docdb/read-state.ts`, `neptune/read-state.ts`, `db-associated-roles.ts`)

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) | Verdict |
| --- | --- | --- | --- | --- |
| `AssociatedRoles` repeated entry and `FeatureName: ''` | `db-associated-roles.ts` `canonicalAssociatedRoles` (RDS cluster and instance, Neptune cluster) | AWS holds one association per (role, feature) and no empty feature; the deploy path collapses both the same way before any call (`associatedRoleList`). | Another role, another feature, a feature against none, and a role ARN in another case differ. A malformed list is left as it is. | Keep |
| `AssociatedRoles`, log exports, Neptune `VpcSecurityGroupIds` unordered | `getDriftUnorderedPaths` of the three providers | Sets to the RDS API (Add/Remove role calls name one entry; the describe calls answer in RDS's own order). | Only those paths. | Keep |
| RDS instance `ProcessorFeatures` / `AdditionalStorageVolumes` unordered | `rds/drift.ts` | Features are keyed by `Name`, volumes by `VolumeName`. | Only those paths. | Keep |
| Log exports repeated entry | `docdb/read-state.ts`, `neptune/read-state.ts` | A log type is enabled or not; a repeat names nothing more. | Another set differs. | Keep |
| DBCluster `'true'` / `'false'` and whole-number strings | `rds/drift.ts` `canonicalizeDriftProperties` | CloudFormation passes template scalars as strings; the deploy path sends the same boolean / number. | Only the exact `'true'` / `'false'` (not `'True'`), and only `^\d+$` (a fraction or exponent stays a string). | Keep |
| DocumentDB serverless capacity as a numeric string | `docdb-shared.ts` `docdbServerlessScaling` | The deploy path sends `Number(value)`. | An empty string or a non-number is unusable and left as it is. | Keep |
| Storage volume numeric strings and `StorageType` case | `rds/additional-storage-volumes.ts` `canonicalAdditionalStorageVolumes` | The deploy path sends the integer; RDS reads a storage type in any case and answers lower case (#5640). | `^\d+$` only; another type differs. | Keep |
| Live processor features / volume members narrowed to the declared ones | `rds/drift.ts` `withDeclaredProcessorFeatures`, `withDeclaredVolumeMembers` | RDS lists every feature of the class and every member of a volume, defaults included; CloudFormation drift compares only declared values. | A declared value that differs, a declared member the live side lacks, and a live volume the baseline does not name stay drift. | Keep (CloudFormation parity) |
| Read replica source, bare identifier against ARN | `rds/read-replica.ts` `sameReplicaSource`, `rds/drift.ts` `canonicalizeDriftPair` | RDS identifiers are case-insensitive and stored lower-cased; a bare identifier names the replica's own region and account. | Another name, another region, and another account (both ARNs) differ. A bare record against an ARN of another account cannot occur: RDS supports no cross-account read replica, and a same-region readback is built from the replica's own ARN. | Keep |
| Pending modifications read as applied (`StorageType`, Multi-AZ `AllocatedStorage` / `Iops`, log exports, processor features, `LocalWriteForwardingStatus: requested`, option group `pending-apply`) | `rds/read-state.ts`, `rds/instance-members.ts` | Not an AWS equivalence: RDS will apply the value at the maintenance window. The readback reports the requested configuration so a deploy without `ApplyImmediately` settles and a later drift run is not reported for what the template asked. | A pending value that differs from the baseline is drift; an out-of-band change applied immediately is drift. Residual: a pending value that never applies reads as applied until it is dropped. | Keep (deliberate, #5639 / #5640) |
| Unsettled-name convergence keeps only named live entries | `db-associated-roles.ts` `associatedRolesNamed`, docdb / neptune unsettled reads | Not drift: the post-update convergence after a failed update, which must not detach what an out-of-band change attached. | Drift reads the full live list. | Keep (not a drift rule) |
| Skipped keys | `getDriftUnknownPaths` of the three providers | Write-only inputs (restore and replica inputs, `SourceRegion`, `AllowMajorVersionUpgrade`), never read back. | Compared wherever the readback has the key. | Keep (skip, not an equivalence) |

### FSx (`fsx-filesystem/read-state.ts`)

| Rule | Where | Why | Boundary | Verdict |
| --- | --- | --- | --- | --- |
| Lustre `LogConfiguration: { Level: DISABLED }` equals no block | `canonicalizeDriftProperties` | FSx reports that block on a file system that never enabled logging (#5430, measured). | Only exactly `{ Level: 'DISABLED' }`: any other level, or a `Destination` beside it, is compared. | Keep |
| Windows `Aliases` case | `canonicalizeWindowsAliases` | FSx stores DNS aliases lower-cased whatever spelling it was given (API reference, `Aliases`; #5469). | Another name differs. | Keep |
| Windows `Aliases` unordered | `getDriftUnorderedPaths` | Alternate names with no order. `DnsIps` is NOT declared: a DNS server list may be a preference order. | Only that path. | Keep |
| Alias lifecycle | `readWindowsConfiguration` | See "Rules tightened". | `CREATE_FAILED` / `DELETING` are not held. | Tightened |

### Auto Scaling (`asg/read-state.ts`, `asg/shared.ts`, `asg/update-policy.ts`)

| Rule | Where | Why | Boundary | Verdict |
| --- | --- | --- | --- | --- |
| `MetricsCollection` folded per granularity | `canonicalizeDriftProperties`, `foldMetricsCollection` | Auto Scaling holds one metric set per granularity, whatever entry split enabled it; an entry with no metrics enables all (API reference). | Another metric set differs; an entry whose `Metrics` is unreadable stops the fold. | Keep |
| An ALL baseline against the per-metric readback | `canonicalizeDriftPair` | `EnableMetricsCollection` with no metrics enables every metric; the readback lists them one by one (#4021, measured list). | A readback missing any metric of `ALL_GROUP_METRICS` differs. Residual: a metric AWS adds later and that is not in the list is not reported when disabled. | Keep |
| `elbv2` / `elb` `TrafficSources` stripped | `readCurrentState` | Such a source is listed in `TargetGroupARNs` / `LoadBalancerNames` too (measured for `AttachTrafficSources`), where it is compared. | Other traffic source types are compared. | Keep |
| UpdatePolicy trigger keys: scalars as text, subnet / zone lists as sets | `update-policy.ts` `changedTriggers` | A launch template version `2` and `'2'` are one version; Auto Scaling reads `VPCZoneIdentifier` as a set (list or comma string). | Another version, another subnet set differ. Only decides whether the opt-in UpdatePolicy applies. | Keep |

### EC2 (`ec2/drift.ts`, `ec2/sg-*.ts`, `ec2/read-*.ts`, `ec2/instance-*.ts`)

| Rule | Where | Why | Boundary | Verdict |
| --- | --- | --- | --- | --- |
| Subnet `Ipv6CidrBlock` spelling | `drift.ts` `canonicalizeDriftPair`, `src/utils/ipv6-cidr.ts` | EC2 stores the network in compressed lower-case form (measured, host bits included). | Another network or prefix length differs. | Keep |
| Subnet booleans and netmask spellings | `canonicalizeDesiredProperties` | The deploy path sends the coerced boolean / integer. | Another value, an unusable value differ. | Keep |
| Standalone and inline ingress `IpProtocol` number against name | `canonicalizeDesiredProperties`, `src/utils/ip-protocol.ts` | EC2 stores `1` / `6` / `17` / `58` as names, lower-cased (#1643, measured). | Every other number, `-1` against `all`. | Keep |
| Route multi-destination narrowing | `canonicalizeDesiredProperties` | The create sends one destination; the record holds it. | Only the CFn-invalid multi-destination shape. | Keep |
| Instance `BlockDeviceMappings` narrowed to declared devices | `drift.ts`, `read-instance-state.ts` | A device the template does not declare (the AMI's root volume, a `VolumeAttachment` sibling's) is not this property's (#6384). | A declared device's change or removal is drift. Residual: a volume attached out of band at an undeclared device is not reported. | Keep (deliberate) |
| SG rule CIDR identity | `src/provisioning/sg-rule-identity.ts` `sgCidrKey`, used by `sgRuleKey` (inline-rule reconcile, standalone readback), `securityGroupRuleMatchesCfnIngress` (rule-id lookup, stale-id revoke), `ingressRuleIdentity` (the sibling-holder checks), `sg-sibling-rules.ts` `sgRuleOwnershipIdentity` (the drift strip of sibling-owned rules), `sg-own-write-rules.ts` `sgSettleRuleKey` (the post-write capture) and `sg-rule-by-id.ts` | EC2 clears host bits, writes IPv6 compressed and lower-cased, and refuses a second rule at another spelling of one network as `InvalidPermission.Duplicate` (all measured), so two spellings with one key are one rule. A paired live rule is read back in the record's CIDR spelling (`withRecordedCidrSpelling`). | Another network or prefix keys apart; a spelling EC2 refuses (a leading zero in an octet or prefix, `10.0.0.0/`) and any surrounding whitespace are keyed as written. The inline-rule update diff (`sg-revert-guard.ts` `sgRuleDiffKey`) still keys the CIDR as written: a template edit between two spellings revokes and re-authorizes the same rule (churn, no wrong rule). Residual: an observed baseline saved before this change by `drift --accept` or `state refresh-observed` holds AWS's spelling while the readback now answers the record's; the settle-key heal absorbs that unless the group also holds a rule the template does not declare, where one host-bit rule reads as drift until the next `--accept`. | Unified in the #6854 follow-up |
| SG rule identity fallback when the recorded `sgr-` id is gone | `sg-rule-by-id.ts`, `read-state.ts` | A rule re-authorized with the same protocol, ports and peer grants the same permission; EC2 refuses a duplicate permission. | Another peer, port or protocol differs; a description change is drift. | Keep |
| SG rule `-1` port equals an absent port; numeric-string ports; absent description equals `''` | `sg-support.ts`, `read-state.ts` | EC2's all-ports reading; CloudFormation passes ports as strings; EC2 stores no description as absent. | Another port, another description. | Keep |
| SG ingress with no record bag matched by `(group, protocol, ports)` | `read-state.ts` | No recorded peer to disambiguate with. | Only reached without a properties bag (not `cdkd drift`). | Keep (residual) |
| Instance `SsmAssociations` `DocumentName`, name against ARN | `instance-support.ts` `sameSsmDocument`, used by the `instance-ssm.ts` readback and lookup and by `sameSsmAssociations` | None: SSM refuses an association by the ARN of an own or an AWS document (measured), so a `DocumentName` ARN always names another account's shared document, never this account's same-named one. | Equal only when both are bare names and equal or both are ARNs and equal. A delete of an ARN-declared association with no exact live match takes the one association under its bare name only after `DescribeDocument` answers `InvalidDocument`; two or more under one name are never deleted. | Tightened in #6866 (PR #6867) |
| Route by destination | `read-state.ts` | See "Rules tightened". A `blackhole` route (its target deleted) still reads its target id; the target's own resource reports the deletion. | | Tightened |
| NAT regional address placed by zone name OR zone id | `nat-support.ts` | A zone name and its id name one zone. | Residual: a record pairing a name with another zone's id is not caught (unmeasured whether AWS accepts such a pair). | Keep |
| Monitoring `pending` = on, `disabling` = off | `read-instance-state.ts` | Transitional states toward the target value. | `enabled` / `disabled` compared as is. | Keep |

### ELBv2 (`elbv2/read-state.ts`, `elbv2/attributes.ts`)

| Rule | Where | Why | Boundary | Verdict |
| --- | --- | --- | --- | --- |
| `Targets` unordered | `getDriftUnorderedPaths` | Register / Deregister are set operations. | Only on the target group. | Keep |
| Target `Port` equal to the group port, AZ `all` | `attachRegisteredTargets` | AWS substitutes both for a target registered without them. | Any other port or zone is kept. | Keep |
| Attribute key the readback stopped reporting, undeclared | `canonicalizeDriftPair` | No Modify call removes a key; AWS returns some intermittently (#4144, measured). | A declared key that vanished, an empty readback, a key only the readback holds. | Keep |
| Attribute values as strings | `attributes.ts` `normalizeAttributes` | The Modify APIs take strings. | Update path only; non-scalar values dropped. | Keep |

### CodeBuild and Lambda

| Rule | Where | Why | Boundary | Verdict |
| --- | --- | --- | --- | --- |
| `S3Logs.EncryptionDisabled` absent = `false` | `codebuild/drift.ts` | The documented default; measured (#6659). | `true` on either side differs. | Keep |
| Event source mapping `FunctionName` | `lambda-eventsource/read-state.ts` | See "Rules tightened". | | Tightened |
| Event source mapping Kafka `ConsumptionMode` absent = `Stream` | `lambda-eventsource/read-state.ts` `canonicalizeDriftPair` | The SDK dropped the member before #3850; `Stream` is the default. | A live `Queue`, a template declaring another mode. | Keep |
| Event source mapping `Enabled` from a transitional `State` | `lambda-eventsource/shared.ts` `enabledFromState` | `Enabling` / `Disabling` move to the target value; `Creating` / `Updating` / `Deleting` carry no answer and read the declared value. | `Enabled` / `Disabled` compared as is. Residual: an out-of-band disable landing while `Updating` is not reported on that run. | Keep (residual) |
| EventInvokeConfig `FunctionName` name = unqualified ARN; empty destination member | `lambda-event-invoke-config-provider.ts` | One function (#4118); CloudFormation refuses an empty member. | A qualified ARN, another function, a set destination. | Keep |
| Network connector `ElasticIpConfiguration: { Type: None }` = absent | `lambda-network-connector-provider.ts` | Measured: a connector reset to None reads back with it, one that never had it without. | `None` against `ServiceManaged`. | Keep |
| Network connector subnet / SG / compute type lists unordered | `lambda-network-connector-provider.ts` | Sets. | Only those paths. | Keep |
| Function `FunctionScalingConfig` requested over applied; `ImageUri` tag without digest | `lambda-function/read-state.ts` | The requested configuration, as for RDS pending values; CloudFormation compares the declared `ImageUri`. | A requested value that differs is drift. | Keep (deliberate) |
| Permission statement read as its first action / principal | `lambda-permission-provider.ts` | AddPermission writes one action and one principal per statement. | Residual: a statement rewritten outside the Lambda API is read partly. | Keep (residual) |

### Change detection equalities (update diffs, lookups, settle waits)

Tests: `tests/unit/provisioning/change-detection-equalities-6854.test.ts`, a positive and a negative pair per row.

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) | Verdict |
| --- | --- | --- | --- | --- |
| KMS key ARN = its bare id; alias ARN = its alias name | `docdb/shared.ts` `sameKmsKey` | A key ARN and its id name one key, an alias ARN and `alias/<name>` one alias (KMS key identifier forms). | Another id, an alias against a key id, an absent side. Residual: the ARN's account and region are dropped; a key id is a random UUID and a cluster takes a key of its own region, so two keys sharing one id is not a reachable pair. | Keep |
| Create-only CloudFormation scalar spellings | `ec2/common.ts` `sameCreateOnlySent` | The create sends the coerced value (`"28"` and `28` one netmask, `"true"` one boolean, a numeric launch template `Version` as its string). | Another value, a spelling the coercion refuses (`"yes"`), `$Latest` against a number, any other key compared exactly. | Keep |
| Instance `EnclaveOptions.Enabled` boolean spelling | `ec2/instance-support.ts` `sameInstanceCreateOnlySent` | RunInstances is sent the coerced boolean. | `"false"` against `true`. | Keep |
| Instance `SecurityGroupIds` / `SecurityGroups` as sets | `ec2/instance-support.ts` `sameStringSet` | An instance's groups are a set (ModifyInstanceAttribute `Groups` replaces the set; DescribeInstances answers in its own order). | Another member, a missing member, a non-list. Residual: members are compared through `String()`, so a malformed non-string member could equal its text. | Keep |
| Instance profile name = its ARN | `ec2/instance-support.ts` `instanceProfileKey` | RunInstances takes the profile by name or ARN; a profile must be of the instance's own account. | Another name. Names are compared case-sensitively (IAM treats them case-insensitively), the strict direction. | Keep |
| `UseLatestRestorableTime` boolean spelling | `rds/instance-restore.ts` `sameCreateTimeValue` | CloudFormation passes booleans as strings; the handler reads the boolean. | Every other restore key compared exactly (a snapshot identifier in another case is a change, the strict direction). | Keep |
| Express writer identifier, case-insensitive | `rds/express-writer.ts` `sameDbIdentifier` | RDS identifiers are case-insensitive and reported lower-cased (RDS docs). | Another identifier, an absent one. | Keep |
| Endpoint revision weights, order-insensitive | `lambda-web-function-endpoint-provider.ts` `sameWeights` (the update's settle wait) | A weight list is keyed by revision; the service answers in its own order. | Another weight, another revision, a missing or repeated entry, an absent live list (the wait keeps polling). | Keep |

## Open decisions

- **Instance `SsmAssociations` `DocumentName`**: resolved by #6866 (PR #6867).
  The maintainer chose one rule for the drift readback, the update diff and the
  association lookup (an ARN and a bare name are different documents), so an
  edit between the two spellings now re-associates. What SSM reports as a
  shared document association's `Name` is still unmeasured (one account); if
  it is the bare name, drift reports the declared ARN association as absent
  (loud, no resource change) and the delete path's `DescribeDocument`
  fallback keeps the association from being left behind.
