---
title: "Design: the drift command's comparison steps and the Cloud Control read-back tables, and what each may equate (#6854)"
unlisted: true
---

# Design: the drift command's comparison steps and the Cloud Control read-back tables, and what each may equate (#6854)

This page is the `cdkd drift` command and Cloud Control slice of the
normalization audit (#6852 covers `src/analyzer/`, in its own page in this
directory). It lists every rule the drift command
applies outside the analyzer before it compares, the sibling-owned member
strips, and the Cloud Control read-back tables: what each equates, the AWS
behavior that makes the two spellings one value, and the boundary.

A rule may equate two values only when AWS treats them as one; where AWS
behavior is unknown the values compare as different. A rule that only changes
what an update SENDS (the Cloud Control read-back tables) equates nothing in a
comparison; it is listed with the request it shapes.

Tests: `tests/unit/cli/drift-cc-normalization-boundaries-6854.test.ts` holds a
positive and a negative case per comparison rule, beside each rule's own suite
(named in the table).

## Measurements (us-east-1, 2026-11-23)

| Probe | Result |
| --- | --- |
| Role trust policy naming a role whose path is `/prodcase6854/`, with the path upper-cased | `MalformedPolicyDocument`: Invalid principal in policy |
| The same with the role name lower-cased | `MalformedPolicyDocument`: Invalid principal in policy |
| The same with no path | `MalformedPolicyDocument`: Invalid principal in policy |
| The exact ARN; then the role deleted | Accepted; afterwards the trust policy reads back the `AROA…` unique id |
| S3 bucket policy, path upper-cased / name lower-cased | `MalformedPolicy`: Invalid principal in policy (exact ARN accepted) |
| `GetRole` with the role name lower-cased | Answers the role, with its stored-case ARN |
| `AddUserToGroup` with the group and user names lower-cased | Accepted; `ListGroupsForUser` and `GetGroup` answer the stored case |

Every probe resource was deleted afterwards and its absence checked.

## The rules

### Drift command steps (`src/cli/commands/drift/**`)

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) | Tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| IAM unique id equals the principal's ARN (the live half) | `command.ts` `createIamPrincipalUniqueIdResolver` | IAM renders a role / user principal as `AROA…` / `AIDA…`; `GetRole` / `GetUser` prove the id belongs to the ARN. | The answer's ARN must equal the ARN being resolved (from either side) exactly. Another account, path, or a name or path in another case stays drift. IAM trust and S3 bucket policies refuse such an ARN (measured); other services are unmeasured, and a mismatch is reported, never hidden. | `drift-bucket-policy-recorded-principal-6680.test.ts` | Tightened: was case-insensitive |
| Derived Pattern B name | `compare.ts` `canonicalizeDerivedPatternBName` | Not an AWS equivalence: cdkd created the resource under the name its generator derives (legacy stack prefix, sanitize, truncate), and these names cannot change without replacement. | Only a live name the generator reproduces from the declared one under either prefix setting, in this stack's scope: another stack's prefix, another name, a case-only difference, a non-string or empty value stay drift. | `drift-derived-pattern-b-name.test.ts` | Keep |
| Rotation `AutomaticallyAfterDays` beside `ScheduleExpression` | `baseline-keys.ts` `stripDerivedEchoMembers` | Secrets Manager documents `AutomaticallyAfterDays` in a read as calculated from the schedule, and refuses both in one request. | Only beside a non-null `ScheduleExpression`, only for `AWS::SecretsManager::RotationSchedule`. Set alone it stays compared; the expression is always compared. | `drift-rotation-schedule-echo-6497.test.ts`, boundaries suite | Keep |
| A key the readback omits at its default | `revert-payload.ts` `withAbsentDefaultKeys` | Not an equivalence: it adds the key to the comparison. The provider hook naming the keys (`getDriftAbsentMeansDefaultKeys`) is audited with each provider. | Only a listed key the baseline lacks and AWS holds. | boundaries suite | Keep (compares more) |
| Key order | `revert-payload.ts` `deepEqualUnordered` | JSON objects are unordered. | Lists by position and length; `null`, absent and an `undefined` member differ; no type coercion; no case folding; two non-plain values (`Date`) are never proven equal. | boundaries suite | Keep |
| Inline policies paired by name in the plan | `plan.ts` `restoredInlinePolicies` | Display only: names a policy the revert restores. | A pair whose documents differ is listed. | `drift-plan-grant-members-6627.test.ts` | Not an equality rule |
| Read-only schema positions | `baseline-keys.ts` `readOnlyUncomparedDriftPaths`, `read-only-properties.ts` `getReadOnlyPropertyPaths` | CloudFormation drift compares only what a template can declare, and a registry `readOnlyProperties` position cannot be declared. | Only exact undeclared read-only paths of a Cloud Control readback; a declared one, a writable sibling of a read-only leaf, and a path through a list stay compared; an unreadable schema skips nothing. | boundaries suite | Keep (CloudFormation parity) |

### Sibling-owned member strips

A member another resource of the same stack writes onto the parent is removed
from both sides of the parent's comparison; the sibling resource compares it
as its own resource. A member the parent's template also declares stays
compared.

| Rule | Where | Why | Boundary | Tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| Managed policy ARNs a sibling `AWS::IAM::ManagedPolicy` attaches | `iam-sibling-managed-policies.ts` `withoutSiblingAttachedArns`, `collectPrincipalsAttachingPolicy` | The attachment is that policy's own `Roles` / `Users` / `Groups`. | Exact ARN and principal name; IAM holds no duplicate attachment. | `drift-iam-sibling-managed-policy-6324.test.ts`, boundaries suite | Keep |
| Groups a sibling `AWS::IAM::UserToGroupAddition` adds | `iam-sibling-managed-policies.ts` `collectGroupsAddedBySiblings`, `withoutSiblingOwned` (`foldCase`) | IAM resolves `AddUserToGroup` names ignoring case and reports the stored case (measured); group and user names are unique ignoring case. | Case only; any other spelling stays compared. | boundaries suite | Keep |
| Security group rules a standalone `SecurityGroupIngress` / `Egress` authorizes | `sg-sibling-rules.ts` `sgRuleOwnershipIdentity` | EC2 identifies a rule by protocol, ports and peer, refusing a second rule differing only in `Description`; protocol numbers and names and a numeric port string are CloudFormation spellings of one value. | Exact peer strings (CIDR, group id or name, prefix list; no CIDR normalization), exact parent group id; the peer owner id is not in the identity (`sg-` ids are unique in the region); a redacted or unparsable identity owns nothing. `Description` is compared on the standalone rule's own record. | `sg-sibling-rules-6418.test.ts`, boundaries suite | Keep |
| Table rows (ECS capacity provider associations, SNS subscriptions, lifecycle hooks, EMR task groups / fleets, EC2 attachments, EIP association, IAM inline policies) | `sibling-owned-members.ts`, `sibling-owned-members/rows.ts` | Each row's member is the sibling resource's configuration, compared on that resource. | Exact identity strings, counted as a multiset. An ECS `Cluster` ARN is matched by name only, since ECS refuses an association across accounts or regions. Residual: the inline-policy row drops a baseline member by name when the live readback has none of that name (#6616's known limit). | `sibling-owned-members-6610.test.ts` | Keep |

### Cloud Control read-back

| Rule | Where | What it does | Boundary | Tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| AWS-managed field strip | `src/analyzer/cc-api-strip.ts` | Removes timestamp, owner and generated-id names from the AWS side of a Cloud Control fallback readback (an SDK provider with no read). | AWS side only, so a baseline holding the name reports it as removed, never equal. Some types declare these names writable (`AWS::IoT::Command` `CreatedAt`, `AWS::OpsWorks::App` `StackId`), none of them on the fallback path. | `cc-api-strip.test.ts`, boundaries suite | Keep |
| Read-back defaults | `cc-read-back-default-paths.ts` | Update send-side: omits a measured read-back value the update API refuses. | Only the exact measured value, only when the patch does not touch the path and the desired bag lacks it or holds that value. | `cc-read-back-default-paths-6676.test.ts` | Not an equality rule |
| Empty read-back keys | `cc-read-back-empty-keys.ts` | Update send-side: omits an empty read-back value the update API refuses. | Only listed keys, only an empty live value; a `""` over a live non-empty string is sent. | `cc-read-back-empty-keys-6569.test.ts` | Not an equality rule |
| Exclusive read-back keys | `cc-read-back-exclusive-keys.ts` | Update send-side: removes the read-back spelling when the patch writes the write-only key AWS refuses beside it. | Only when the patch writes a listed write-only key and nothing declares the read-back key. | `cc-read-back-exclusive-keys-6818.test.ts` | Not an equality rule |
| Denied identity read | `identity-read-denied.ts` | Classifies an authorization refusal of a delete's identity read; credential and clock failures are not denials. | Classification only. | `loggroup-sfn-ecr-recorded-identity-6665.test.ts` | Not an equality rule |
