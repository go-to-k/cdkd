---
description: The caller's AWS identity on the `cdkd local` env channel
paths:
  - 'src/utils/caller-credentials.ts'
  - 'src/utils/role-arn.ts'
  - 'src/cli/commands/local-invoke.ts'
  - 'src/cli/commands/local-start-api.ts'
  - 'src/cli/commands/local-invoke-agentcore.ts'
  - 'src/cli/commands/local-profile-credentials-file.ts'
  - 'src/cli/commands/local-run-task.ts'
---

# The caller's identity on the `cdkd local` env channel

Issue [#3130](https://github.com/go-to-k/cdkd/issues/3130).

`applyRoleArnIfSet` publishes a `--role-arn` role both to every SDK client under
`src/**` and to the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN` variables. Every `cdkd local *` command copies that triple
into the emulated container (`forwardAwsEnv`), so uncorrected the user's handler
runs AS THE DEPLOY ROLE. `ignoreAssumedRole` cannot express the opt-out here: it
is a client-config key, not these variables.

## The mechanism

`applyRoleArnIfSet` SNAPSHOTS the caller's triple immediately before overwriting
it (`setPreAssumeEnvCredentials`). The snapshot sits in `aws-client-defaults.ts`
beside the published role, so `resetAwsClientDefaults()` drops both.
`applyCallerIdentityCredentials(env)` corrects a just-copied bag, and is called
INSIDE each `forwardAwsEnv` rather than at its call sites, so a site added later
inherits it.

It answers "what the container would have got without `--role-arn`", not "who
is the caller": `applyProfileCredentialsOverlay` answers the second, runs AFTER
the restore, and outranks it.

**Nothing to restore is a STRIP, not an inherit.** When the triple was ABSENT
before the assume (SSO / IMDS / container role), all three keys are REMOVED and
the container falls back to its own resolution: a missing credential the user
can see beats a privileged one they cannot. The restore is CREDENTIAL-ONLY
(region keys untouched), and a restored long-lived key pair strips any inherited
session token.

## The fence

`tests/unit/local/local-surface-env-identity.test.ts` derives its population
from the CHANNELS (env keys plus the INI writer in
`local-profile-credentials-file.ts`) and demands per site RESTORES,
READS-CALLER, or a `cdkd-local-env-identity: <reason>` comment. An annotation is
a CLAIM the fence cannot check.

Residual: the four `local start-*` commands and `--from-cfn-stack` on all eight
keep this escalation, unseen by either fence
([local-engine-role-leak.md](local-engine-role-leak.md)).
