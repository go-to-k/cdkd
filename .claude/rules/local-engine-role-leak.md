---
description: What cdk-local's own AWS clients resolve as a `--role-arn` assumed role — the four `cdkd local start-*` commands cdkd's caller-identity restore does not cover, plus `--from-cfn-stack`, which reaches all eight
paths:
  - 'src/cli/commands/local-state-source.ts'
  - 'src/cli/commands/local-run-task.ts'
  - 'src/cli/commands/local-start-service.ts'
  - 'src/cli/commands/local-start-alb.ts'
  - 'src/cli/commands/local-start-cloudfront.ts'
  - 'src/cli/commands/local-start-agentcore.ts'
---

# What the local emulation engine resolves as the role

The half of issue [#3130](https://github.com/go-to-k/cdkd/issues/3130)'s class
that cdkd cannot close from `src/**`. The half it DID close, and the mechanism
that closed it: [local-caller-identity.md](local-caller-identity.md). Tracked as
issue [#3240](https://github.com/go-to-k/cdkd/issues/3240).

**FOUR commands, and the discriminator is mechanical**: of the eight `local-*`
modules, only `local-invoke`, `local-start-api`, `local-run-task` and
`local-invoke-agentcore` call cdkd's `applyRoleArnIfSet`. The four `start-*`
ones do not, so none of this module's capture-and-restore runs for them, and
NEITHER fence sees it: both derive from `src/**`. Issue
[#3240](https://github.com/go-to-k/cdkd/issues/3240). Re-derive with
`grep -l applyRoleArnIfSet src/cli/commands/local-*.ts` — two revisions of this
paragraph named two commands and were each wrong by two.

**The overwrite is cdk-local's own `applyRoleArnIfSet`**, run INSIDE the
emulator entry point from that package's `commonOptions()` `--role-arn` and its
`${envPrefix}_ROLE_ARN` (cdkd sets `CDKD_ROLE_ARN`). So correcting `process.env`
AROUND the call cannot work: it returns only when the emulator exits, after
every container has started. The real candidate is a cdk-local seam, i.e.
upstream work. `ecs-service-emulator.ts` is a shim that calls nothing.

**Reason from the RULE, not from the list below.** cdk-local builds its AWS
clients from the region and `options.profile` alone and never sees
`ignoreAssumedRole`, so ANYTHING cdk-local resolves for the workload, while
`--role-arn` is set and no profile is selected, it resolves AS THE ROLE. Four
instances are measured; the list went two → four commands and one → four
channels across review rounds, every miss because it was written as an
enumeration. The fourth is the one that breaks the shape of the first three:

1. **The credential triple** copied into the container, so the workload runs AS
   the role: `start-alb`'s Lambda front-door runners, `start-cloudfront`'s
   Function URL / Lambda@Edge containers, `start-agentcore`'s agent container.
   Gated on `options.profile`, the FLAG — an exported `AWS_PROFILE` does NOT
   mitigate it. `start-service`'s own ECS containers are NOT here: they take the
   metadata sidecar, seeded from `--profile` alone.
2. **ECS task SECRETS**, `start-service` / `start-alb`. **cdk-local's**
   `resolveEcsSecrets` — not cdkd's `src/local/ecs-secrets-resolver.ts`, which
   opts out correctly — builds its clients with `{region, profile}` alone, so
   with no profile the ambient chain reads the overwritten triple and the
   PLAINTEXT is fetched as the role. Either profile spelling mitigates it. This
   half survives a container-env-only fix.
3. **`${AWS::AccountId}`**, on `start-service` / `start-alb` /
   `start-agentcore`. cdk-local's `resolveCallerAccountId` takes
   `options.profile` only, so with none the STS hop answers as the ROLE and its
   account id is substituted into the container's env, its `secrets` `ValueFrom`
   references and its ECR image URIs. Either profile spelling mitigates it. The
   contrast is sharp rather than pedantic: for the covered four cdkd opts out
   here explicitly (`local-run-task.ts`, `local-invoke-agentcore.ts`), and
   `docs/cli-reference.md` names this very value as staying on the caller's
   identity.
4. **`--from-cfn-stack`, on ALL EIGHT commands** — the covered four included, so
   the covered/uncovered split does NOT bound this one. `local-state-source.ts`
   hands the options bag to cdk-local's `createLocalStateProvider` with no
   credential injection, and its `CfnLocalStateProvider` builds CloudFormation /
   Lambda / BedrockAgentCoreControl / SSM clients from `{region, profile}`. The
   SSM one issues `GetParameters` with `WithDecryption: true` and the plaintext
   lands in the container's environment. Either profile spelling mitigates it.
   cdkd's own `--from-state` twin runs as the role TOO, and deliberately — it is
   breaking change 1 in this work: its three annotated sites in
   `local-state-loader.ts` read cdkd's OWN state record, in the account the role
   deploys into, and yield no identity the workload holds. They carry
   `cdkd-local-role-identity:` comments saying exactly that. Do NOT "fix" them:
   an opt-out there does not even reach a different record — the bucket NAME is
   derived from a `GetCallerIdentity` made through `awsClientDefaults()`, i.e.
   the ROLE's account, and the state calls carry `ExpectedBucketOwner`, so
   caller credentials against a role-account bucket hard-fail 403. The difference from channel 4 is WHAT is
   resolved, not which identity resolves it — `--from-cfn-stack` pulls decrypted
   SecureString values INTO the container.

**The derivation is not exhausted.** Other cdk-local clients matching the same
predicate have been spotted but not traced to a workload-visible value: the ECR
login, the agentcore S3 bundle fetch, `defaultCredentialsLoader` (which takes no
profile key at all and feeds SigV4 signing), and the CloudFront / KVS clients.
Before adding an instance here, trace it to something the workload can observe;
before trusting this list, re-run the predicate.

No warning fires on any of this, for two different reasons. On channels 1-3 the
path that warns — cdkd's `applyRoleArnIfSet` — is one those commands never
reach. On channel 4 over the COVERED four it DOES run, but its warning is gated
on a selected `AWS_PROFILE`, which is exactly the case channel 4 is already
mitigated in: the shape that needs the warning is the one that never gets it.
Stated for users in `docs/cli-reference.md` and the command pages.
