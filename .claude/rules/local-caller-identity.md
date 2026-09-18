---
description: src/utils/caller-credentials.ts — how the caller's own AWS identity is kept on the `cdkd local` PROCESS-ENVIRONMENT channel when `--role-arn` assumed a role for cdkd's own calls
paths:
  - 'src/utils/caller-credentials.ts'
  - 'src/utils/role-arn.ts'
  - 'src/cli/commands/local-invoke.ts'
  - 'src/cli/commands/local-start-api.ts'
  - 'src/cli/commands/local-invoke-agentcore.ts'
  # The INI channel: the credentials-file writer, and the one call site no
  # other glob above reaches (issue #3250 item 7).
  - 'src/cli/commands/local-profile-credentials-file.ts'
  - 'src/cli/commands/local-run-task.ts'
---

# The caller's identity on the `cdkd local` env channel

Rest of `src/utils/`: [layout-utils.md](layout-utils.md). The client-config
half of the same question, and why `awsClientDefaults` publishes the assumed
role at all: [proxy-support.md](proxy-support.md). The `cdkd local` surface
itself: [layout-local.md](layout-local.md).

Issue [#3130](https://github.com/go-to-k/cdkd/issues/3130).

## The channel

`applyRoleArnIfSet` publishes a `--role-arn` assumed role through two channels:
`setAssumedRoleCredentials`, which every SDK client under `src/**` receives, and
the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`
environment variables, for the consumers the first cannot reach — cdk-local's
own clients and the CDK app subprocess.

Every `cdkd local *` command COPIES that second triple into the emulated Lambda
/ AgentCore container (`forwardAwsEnv`, one near-identical copy per command
file). So `cdkd local invoke --role-arn <deploy-role> MyFn` ran the user's own
handler AS THE DEPLOY ROLE — normally the more privileged of the two identities,
and never what the flag asked for. A `--profile`-FLAG overlay happened to mask
it; an exported `AWS_PROFILE`, or no profile at all, did not.

**`awsClientDefaults({ ignoreAssumedRole: true })` cannot express the opt-out
here.** That option is a client-config key, and the value on this channel is
three environment variables whose original contents the assume has already
destroyed. Three review rounds closed the client half of this class one site at
a time while the env channel beside it stayed open, which is why the fence
below derives its population from the channel rather than from a list.

## The mechanism

`applyRoleArnIfSet` SNAPSHOTS the caller's triple immediately before
overwriting it (`setPreAssumeEnvCredentials`). The snapshot lives in
`aws-client-defaults.ts` beside the published role, so `resetAwsClientDefaults()`
drops both — either leaking between tests changes which identity the next test
resolves. `src/utils/caller-credentials.ts` is the only reader, because
`undefined` there is ambiguous on its own: no role assumed, or a role assumed
over a caller who had no static credentials.

Two entry points:

- `applyCallerIdentityCredentials(env)` corrects an env bag a forwarding site
  just copied. Called INSIDE each `forwardAwsEnv` rather than at its call sites,
  so a call site added later inherits it. A NO-OP when no role was assumed, so
  the overwhelmingly common path is byte-identical.
- `callerEnvCredentials()` hands the VALUE to a site that needs one rather than
  an env bag to correct — the `--sigv4` host-signing path in
  `local-invoke-agentcore.ts`, which signs `/invocations` as the agent's
  INVOKER and so had been signing as the deploy role.

**The question it answers is "what would the container have received without
`--role-arn`", not "who is the caller".** Those differ when a profile is
selected, and `resolveProfileCredentials` +
`applyProfileCredentialsOverlay` already answer the second — resolved through
`ignoreAssumedRole: true`, applied AFTER the restore, and deliberately
outranking it. Both are the caller; the flag is the more specific of the two.

## Nothing to restore is a STRIP, not an inherit

On an SSO / IMDS / container-role chain the triple was ABSENT before the assume.
Fabricating a replacement is not available, and leaving the role's in place is
the defect, so all three keys are REMOVED from the forwarded environment and the
container falls back to its own resolution. For a bare `cdkd local invoke` that
resolves nothing, and the handler's first AWS call fails with
`Could not load credentials from any providers` — the documented outcome
([docs/cli-reference.md](../../docs/cli-reference.md)), and the right one: a
missing credential the user can see beats a privileged one they cannot. The
remedy named there is `--profile <name>` (cdkd resolves it and mounts a
credentials file for the container) or `--assume-role <arn>`.

The restore is CREDENTIAL-ONLY: the region keys `forwardAwsEnv` copies are left
alone, the same invariant `applyProfileCredentialsOverlay` documents about
itself. A restored LONG-LIVED key pair strips any inherited session token, for
that helper's reason — a long-lived `AKIA...` beside a foreign session token
makes the SDK inside the container fail rather than fall back.

## The fence

`tests/unit/local/local-surface-env-identity.test.ts`, the sibling of
`local-surface-role-identity.test.ts`. The existing fence derives its population
from `awsClientDefaults(` call sites and therefore cannot see this channel at
all; this one derives from the channels themselves and requires one of three
verdicts per site: RESTORES (the enclosing function calls
`applyCallerIdentityCredentials`), READS-CALLER, or a
`cdkd-local-env-identity: <reason>` comment above it saying why what it writes is
already the right identity. Each verdict AND each site shape carries its OWN
floor, because a whole-population floor stays green while one arm empties.

**FOUR shapes, and two of them are not the environment.** The env channel is the
shared `AWS_CREDENTIAL_ENV_KEYS` population plus a direct mention of the quoted
key; the INI channel is `local-profile-credentials-file.ts`'s
`aws_access_key_id = ...` writer and its four call sites. That file writes a
host file which is bind-mounted read-only into the container, and it spells the
key in LOWERCASE, so it carried neither the quoted `'AWS_ACCESS_KEY_ID'` the env
fence looked for nor an `awsClientDefaults(` call the sibling looks for — it was
invisible to BOTH until issue
[#3250](https://github.com/go-to-k/cdkd/issues/3250) item 7. The writer chooses
no identity of its own (it renders its argument), so the verdicts live at the
call sites; it is a site anyway, so a NEW way of filling that file has to decide.

**The INI shape matches BOTH halves of the key pair** where the env shape
matches only the access-key id, and that asymmetry is deliberate: on the env
channel one helper always writes the three keys together, while an INI writer
emits one `key = value` line per key — so a future writer emitting only
`aws_secret_access_key` would be invisible under a single-key match, and that is
the half that is actually secret.

Bare mentions inside a template literal are excluded on purpose: those are error
messages telling a user which variable to set, they deliver no identity, and
requiring a verdict on one is noise the next author learns to paste past. So are
`import` lines, which name no identity and write nothing.

**`tests/unit/local/_local-surface-scope.ts` is what the two fences share** —
which files are in surface, what counts as a comment, how a line is stripped of
comments before it is classified, and when an annotation governs a line. Each of
those rules used to live twice and the env copy shipped NARROWER every time, so
the two disagreed about scope while the env fence's own header asserted they
could not. It is a module rather than two matching comments for that reason; the
per-site VERDICT logic is deliberately NOT shared, because two independent
judgments is the whole point.

The annotation lookup is a WALK, not a line budget: it climbs while the lines
are comments, blank, or open the construct the site sits in, and stops at the
first line that closes a statement. Two fixed spans were tried and both are
worse — at four, FOUR role-fence sites sat exactly on the boundary, so one
rewrapped word would have reported a fence failure that was really a formatting
change (issue #3250 item 6). Widening a span trades a LOUD false positive (the
site reads undeclared and the suite names it) for a QUIET false negative (the
site reads decided and nothing looks again), which is the wrong direction; the
walk is a different stop condition rather than a wider number.

## Residual

The four long-running `local start-*` commands, and `--from-cfn-stack` on all
eight, keep this escalation: cdk-local resolves those as the role, and neither
fence sees it. The rule to reason from, the four measured channels and the
unexhausted derivation are in
[local-engine-role-leak.md](local-engine-role-leak.md). Issue
[#3240](https://github.com/go-to-k/cdkd/issues/3240).
