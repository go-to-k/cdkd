# Import Attribute Persistence Example

Integ probe for `cdkd import` persisting the `attributes` map a provider's
`import()` returns into state (issue #1098, PR #1099).

Pre-fix, `buildStackState` in `src/cli/commands/import.ts` hardcoded
`attributes: {}` on every adopted resource row, so the attribute map the
provider computed was immediately discarded. Because `attributes` is what
backs `Fn::GetAtt` resolution against state, an adopted resource began life
with an empty attribute map while the same resource created by `cdkd deploy`
had it populated.

## Configuration

One stack, one resource:

- **IAM Managed Policy** (`AWS::IAM::ManagedPolicy`, logical id pinned to
  `Policy` via `overrideLogicalId`): a customer-managed policy with a single
  inert `s3:GetObject` statement scoped to a bucket that does not exist. It is
  never attached to any principal. Free, creates and deletes instantly, and
  `DeletePolicy` needs no prior detach pass.

The type was chosen because `IAMManagedPolicyProvider.import()`
(`src/provisioning/providers/iam-managed-policy-provider.ts`) returns a
**non-empty** attribute map on the explicit-ARN branch:

```ts
return { physicalId: explicit, attributes: { PolicyArn: explicit } };
```

The existing `import-nested-stack` fixture cannot cover this path — its only
leaf type is `AWS::SSM::Parameter`, whose `import()` returns `attributes: {}`,
so that fixture passes identically with and without the fix.

## Features Tested in cdkd

1. **Deploy**: `CreateManagedPolicy` for the probe resource.
2. **`cdkd state orphan`**: drops the state record while leaving the AWS
   resource live — the setup for re-adoption, and asserted explicitly (the
   policy must survive the orphan).
3. **Selective import**: `cdkd import --resource Policy=<arn>` routes the ARN
   through `input.knownPhysicalId`, which `resolveExplicitPhysicalId` returns
   first, so the provider takes the `explicit.startsWith('arn:')` branch
   (GetPolicy verification, then populated attributes).
4. **Attribute persistence** (the key assertion, issue #1098): the imported
   `Policy` state row's `attributes` map is non-empty AND
   `attributes.PolicyArn` equals the policy ARN. Both checks fail against a
   pre-fix binary, where `attributes` is `{}`.
5. **Destroy**: `DeletePolicy` + state cleanup, with a not-found-signalled
   probe confirming the policy is genuinely gone (a throttle or auth error is
   reported as UNDETERMINED rather than being misread as deletion success).

## Run

```bash
STATE_BUCKET=<your-cdkd-state-bucket> ./verify.sh
```

Phases: (1) deploy, (2) capture + confirm the policy ARN on AWS, (3)
`state orphan` and assert state is gone but the policy is not, (4) `import`
with the explicit ARN override, (5) assert the imported physical id, (6)
assert the imported `attributes` map is populated with `PolicyArn`, (7)
destroy and assert both the policy and the state file are gone.
