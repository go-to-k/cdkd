---
title: "Design: drift skips of readable members, and the IAM name rules, and what each may equate (#6854, lane E)"
unlisted: true
---

# Design: drift skips of readable members, and the IAM name rules, and what each may equate (#6854, lane E)

This page is one of the #6854 slices of the #6852 normalization audit (the
analyzer slice is `docs/design/6852-drift-normalization-rules.md`). It covers
two groups the other slices did not own:

- `getDriftUnknownPaths` entries that skipped a member AWS can read and that
  an update can change, so an out-of-band change to it was never reported:
  DLM `PolicyDetails` (and a default policy's shorthand fields), EMR
  `AutoTerminationPolicy` / `ManagedScalingPolicy`, and Glue
  `OpenTableFormatInput`.
- The IAM providers' name case folds, the attachment lists compared as
  unordered sets, and the role's inline `Policies` paired by name.

A rule may equate two values only when AWS treats them as one. Where AWS
behavior is unknown the values compare as different.

Tests: `tests/unit/provisioning/unowned-skip-drift-6854.test.ts` (the skips)
and `tests/unit/provisioning/iam-name-fold-boundaries-6854.test.ts` (the IAM
rules) hold a positive and a negative case per rule, beside each rule's own
suite (named in the tables).

## Measurements (us-east-1, 2026-11-23)

| Probe | Result |
| --- | --- |
| DLM custom policy (one schedule, `RetainRule.Count: 7`), `GetLifecyclePolicy` | Every sent member read back verbatim; added: `ResourceLocations: [CLOUD]`, `PolicyLanguage: STANDARD`, the schedule's `CopyTags: false`, `CreateRule.Location: CLOUD`, `RetainRule.Interval: 0` |
| The same policy updated to two target tags and two schedules, out of alphabetical order | Read back in the order sent (tags, schedules, times) |
| DLM default policy with every shorthand field | The fields read back inside `PolicyDetails` (not at the top level), beside `PolicyType`, `PolicyLanguage: SIMPLIFIED`, `ResourceType: VOLUME`; `Exclusions` gains empty `ExcludeVolumeTypes` / `ExcludeTags`; `DefaultPolicy` reads back as `true` |
| `UpdateLifecyclePolicy` of `RetainInterval` alone on the default policy | Only that field changed |
| EMR cluster with `AutoTerminationPolicy: {IdleTimeout: 3600}` and `ManagedScalingPolicy` (`ComputeLimits` only) | `GetAutoTerminationPolicy` / `GetManagedScalingPolicy` return each as sent, nothing filled in |
| `PutManagedScalingPolicy` with every optional limit, `ScalingStrategy: ADVANCED`, `UtilizationPerformanceIndex: 50`; `PutAutoTerminationPolicy` 7200 | Read back as sent |
| `Remove*Policy`, then `Get*Policy` | An empty answer, no error |
| Glue Iceberg table created with `OpenTableFormatInput.IcebergInput: {MetadataOperation: CREATE, Version: "2"}` | `GetTable` has no `OpenTableFormatInput` and no `IcebergTableMetadata`; only `Parameters.table_type: ICEBERG` and `metadata_location` (an S3 key) |
| `CreateRole` of an existing role name upper-cased, and of the same name under another path | `EntityAlreadyExists` both |
| `CreatePolicy` of an existing managed policy name upper-cased, and under another path | `EntityAlreadyExists` both |
| `AttachRolePolicy` with the role name upper-cased, then again with the stored name | Both accepted; `ListEntitiesForPolicy` lists the role once, in its stored case |
| `AddRoleToInstanceProfile` with the profile and role names upper-cased | Accepted; `GetInstanceProfile` answers the stored case |
| `PutRolePolicy` `CasePol`, then `PutRolePolicy` `casepol` with another document | One policy: `ListRolePolicies` lists `CasePol`; its document is the second one. `GetRolePolicy` and `DeleteRolePolicy` with `CASEPOL` act on it |

The probe for `AddUserToGroup` with lower-cased group and user names
(accepted; the stored case is reported) is #6854 lane D's, in
`docs/design/6854-d-drift-cc-normalization-rules.md`. Every probe resource
was deleted afterwards (the EMR cluster terminated) and its absence checked.

## Skips of readable members

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) | Tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| DLM custom policy `PolicyDetails` compared as its declared members | `dlm-lifecycle-policy-provider.ts` `readCurrentState`, `getDriftUnknownPaths`, `canonicalizeDriftPair`; `drift-declared-projection.ts` | Not an equivalence of two values: DLM fills members the template omitted (measured above), so only the declared ones have a template value. | Every declared member is compared, lists by position (DLM keeps the order sent): a changed, removed, added or reordered schedule, tag or time is drift. An undeclared member is dropped only when it holds the value DLM fills (the measured defaults above, plus DLM's documented defaults for a default policy's fields, `DLM_FILLED_DEFAULTS`); any other undeclared member, such as a `FastRestoreRule`, `ShareRules` or `CrossRegionCopyRules` added out of band to a schedule (which the next update's whole `PolicyDetails` would wipe), is drift. On the template baseline the comparator walks only the template's keys inside an object, so a member added directly under `PolicyDetails` (not inside a list) reports only on an observed baseline, as for every type. A template that does not declare `PolicyDetails` skips it. A template string whose string form equals the API's number or boolean (`"7"`, `7`) is one value; `"07"` and `7`, and a case difference, stay drift. | `unowned-skip-drift-6854.test.ts`, `dlm-lifecycle-policy-provider.test.ts` | Tightened: was skipped whole |
| DLM default policy shorthand fields (`CreateInterval`, `RetainInterval`, `CopyTags`, `ExtendDeletion`, `CrossRegionCopyTargets`, `Exclusions`) | same | DLM returns them inside `PolicyDetails`; the readback emits the one form the record declares (`PolicyDetails` when it declares `PolicyDetails`, else the fields lifted to the top level), because `UpdateLifecyclePolicy` takes one form, not both, and a revert overlays the readback. `update()` refuses a bag holding both before any call. | Each declared field is compared as above (`Exclusions`' filled empty lists are undeclared members). An undeclared field is not compared. | `unowned-skip-drift-6854.test.ts` | Tightened: was skipped whole |
| DLM `DefaultPolicy` | `getDriftUnknownPaths` | Not compared: `update()` refuses a change (no update parameter). The readback emits it as the template's `VOLUME` / `INSTANCE` (DLM's `ResourceType`), so a revert's previous side matches the template and `update()` does not refuse; a baseline captured before that lacks it and takes the recorded value (`canonicalizeDriftPair`). | Always skipped. | `dlm-lifecycle-policy-provider.test.ts` | Keep |
| EMR `AutoTerminationPolicy` / `ManagedScalingPolicy` | `emr-cluster/read-state.ts` `readDeclaredPolicies`, `emr-cluster-provider.ts` `getDriftUnknownPaths`, `canonicalizeDriftPair` | Not an equivalence: read with `Get*Policy` when declared and compared as declared members; EMR returns each as put (measured). | A changed member, or the policy removed (an empty answer emits the key as `{}`), is drift; an added member is drift on an observed baseline (the template baseline walks only the template's keys inside an object). A `Get*Policy` that fails (denied, throttled) omits only that key, with a warning naming the error class, and the key is not compared on that read (the readback takes the baseline's value); the unsettled-update read (`readUnsettled`) fails instead, so a convergence never takes an unread policy as removed. An undeclared policy is neither read nor compared. The number-string fold as above. | `unowned-skip-drift-6854.test.ts` | Tightened: was skipped whole |
| Glue `AWS::Glue::Table` `OpenTableFormatInput` | `glue/dispatch.ts` `glueGetDriftUnknownPaths` | Not compared: `GetTable` does not return it (measured), and cdkd sends nothing for it on update, so no revert could restore it. | Always skipped. The Iceberg format version lives only in the table's S3 metadata file. | `glue-provider-roundtrip.test.ts`, `glue-database-input-members.test.ts` | Keep |

A record whose `observedProperties` was captured before these keys were read
lacks them. `canonicalizeDriftPair` gives such a baseline the declared value
(what the deploy sent), so the first drift after the upgrade compares the key
instead of skipping it until the next capture. A declared value holding a
`{{resolve:` reference or a mask is not what was sent (and `drift --revert`
would send it verbatim), so that baseline takes the readback's value instead.

## IAM name rules

IAM documents role, user, group, instance profile and managed policy names as
unique regardless of case, and the measurements above show the path is not
part of that uniqueness and that an inline policy name is one policy in any
case.

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) | Tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| A declared attached principal settles on a live one in another case | `iam-managed-policy/read-state.ts` `managedPolicyOwnWriteMembers` (`stringListMember` fold) | One role / user / group per name ignoring case; `AttachRolePolicy` accepts another case and lists the stored one (measured). | Case only: `my-role2` is not `My-Role` and is re-read. Affects only the post-write capture's re-read schedule. | `iam-name-fold-boundaries-6854.test.ts`, `iam-case-only-principal-rename-6774.test.ts` | Keep |
| A declared profile role settles on a live one in another case | `iam-instance-profile-provider.ts` `readCurrentState` (`stringListMember` fold) | Same; `AddRoleToInstanceProfile` accepts another case and answers the stored one (measured). | Case only. | same | Keep |
| A user is in the declared group when a group of that name in another case lists it | `iam-user-group/read-state.ts` `readUserToGroupAdditionState` | Group names are unique ignoring case; `AddUserToGroup` accepts another case (lane D's measurement). | Case only: `Admins2` is not `Admins`. | same | Keep |
| A principal respelled only in case is neither a leaver nor a newcomer | `iam-policy/update.ts` (the leaving checks, `stays`) | Same principal. | Case only: a role differing beyond case leaves and loses the policy. | `iam-name-fold-boundaries-6854.test.ts`, `iam-policy-provider-target-shape.test.ts` | Keep |
| An inline policy renamed only in case is not renamed away | `iam-policy/update.ts` `renamedAway` | One inline policy per name ignoring case: the put in the new case replaces the document, and a delete of the old case would delete it (measured). | Case only: `MyPolicy2` is renamed away and removed. | same | Keep (required) |
| Managed policy `Roles` / `Users` / `Groups` unordered | `iam-managed-policy-provider.ts` `getDriftUnorderedPaths` | `ListEntitiesForPolicy` documents no order; an attachment is a set member. | Sorted only: another name, a case-only difference, and a repeated entry (IAM lists a repeated attach once, measured) stay drift. | `iam-name-fold-boundaries-6854.test.ts` | Keep |
| `AWS::IAM::User` `Groups` unordered | `iam-user-group-provider.ts` `getDriftUnorderedPaths` | `ListGroupsForUser` documents no order; membership is a set. | As above; `AWS::IAM::Group` declares none. | same | Keep |
| Role inline `Policies` paired by name | `iam-role/read-state.ts` `readInlinePolicies` | Not an equivalence: the readback orders the live policies by the template's names, exact case, and appends the rest sorted. | A live policy whose name differs from the declared one in case only is listed under its own name, so it is drift on a template baseline (stricter than IAM, which holds one policy: a case-only respelling in the template keeps the stored case, measured). The observed baseline holds the stored case, so it compares clean there. The role / user / group UPDATE pairs inline names exactly too, so a case-only rename deletes the policy it just wrote: #6874. | `iam-name-fold-boundaries-6854.test.ts` | Keep (strict); update defect filed (#6874) |
| A profile role respelled only in case is neither removed nor added | `iam-instance-profile-provider.ts` (`heldRoles`, the add / remove checks) | Same role; an instance profile holds at most one role. | Case only: another role name is removed and added. | `iam-case-only-principal-rename-6774.test.ts` | Keep |
