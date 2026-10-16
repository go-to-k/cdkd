---
title: Credentials and --role-arn
description: "What an assumed role needs to run cdkd, what follows the role's account when a profile is also selected, and how --role-arn interacts with cdkd local."
---

# Credentials and --role-arn

cdkd makes its AWS calls with your own credentials, or as an IAM role when you
pass `--role-arn`. This page covers three consequences of using a role: the
permissions the role needs, what changes when the role is in a different
account from your profile, and what the role can reach under `cdkd local`.

```bash
cdkd deploy --role-arn arn:aws:iam::222222222222:role/cdkd-deploy
cdkd deploy --profile ci --role-arn arn:aws:iam::222222222222:role/cdkd-deploy
```

The flag itself, its accepted values and how it combines with `--profile` are
on the [CLI Reference](cli-reference.md#role-arn).

## What the assumed role needs

The role needs permission for every AWS call a deploy makes, because cdkd
makes those calls itself. cdkd does not route through CloudFormation, so there
is no execution role to delegate to. Every IAM, EC2, Lambda and other service
call is issued by cdkd as the assumed role.

The role therefore needs two sets of actions:

- the actions for the resource types your stacks deploy;
- the actions cdkd uses for its own bookkeeping.

`--role-arn` moves those permissions onto the role. It does not reduce them.
[Permission errors](troubleshooting.md#access-denied-error) has a policy to
start from. Scope the role to the services your stacks use, and avoid granting
`AdministratorAccess`.

### The roles `cdk bootstrap` creates do not work

You cannot reuse the roles that `cdk bootstrap` created for the CDK CLI:

- `cdk-hnb659fds-deploy-role-*` allows CloudFormation and asset publishing
  only, so provisioning is denied.
- `cdk-hnb659fds-cfn-exec-role-*` can be assumed only by the CloudFormation
  service.

Create a role for cdkd. It works when IAM principals can assume it and it
carries the permissions above.

## When the profile and the role are in different accounts

cdkd runs as the role, so everything cdkd derives from "the current account"
uses the role's account and not the profile's. Three things follow the role:

| What | Behaviour with both flags |
| --- | --- |
| Default state bucket | `cdkd-state-<accountId>` is derived from the role's account. |
| Cross-account `Fn::GetStackOutput` | The producer role is assumed by the `--role-arn` role. |
| `CDK_DEFAULT_ACCOUNT` | The role's account. |

The third row is covered under
[Your CDK app can see two accounts](cli-reference.md#your-cdk-app-can-see-two-accounts).
The other two are below.

A script that combined both flags on an older cdkd, where every call ran as
the profile, meets all three on its first run after upgrading.

### State kept in the profile account's bucket is not found

cdkd looks for state in the role account's bucket. State that an earlier run
wrote to the profile account's bucket is not found there, so a deploy would
create the stack again in the role's account.

Copy the state into the role account's bucket before you deploy. Pointing
`--state-bucket` at the profile account's bucket does not work: cdkd sends
`ExpectedBucketOwner` on every state call, so a bucket that another account
owns is rejected.

### A cross-account producer role must trust the `--role-arn` role

`Fn::GetStackOutput` can read an output of a stack in another account by
assuming a role in that account, called the producer role. With `--role-arn`,
the `--role-arn` role is the one that assumes the producer role, so the
producer role's trust policy must name it.

A producer role whose trust policy still names your profile's principal makes
the deploy fail with `AssumeRole into <producer-role> failed: AccessDenied`.
The message names the producer role, so check its trust policy first.

The same holds for a cross-account reference CDK generates, which cdkd reads
through the producer account's CDK lookup role: with `--role-arn`, the
`--role-arn` role is the identity `cdk bootstrap --trust-for-lookup` must let
assume it.

[Use Another Stack's Outputs](cross-stack-references.md) covers the feature, and
[Cross-stack reference internals](cross-stack-internals.md) has the policy
documents.

## `--role-arn` with `cdkd local`

`--role-arn` is for cdkd's own work. The function or task that a `cdkd local`
command runs keeps your own identity, so that the role cannot hand local code
more permission than you asked for. This holds for all eight `cdkd local`
commands that run a workload, with or without a profile selected. Pass
`--profile` to choose which identity that is.

Everything cdkd resolves for the workload uses your own identity. It covers:

- the credentials the container is given;
- a role assumed for the container (`--assume-role`, `--assume-task-role`);
- ECS task secrets and `{{resolve:...}}` dynamic references read into the
  container's environment;
- a Lambda layer given as a literal ARN;
- everything `--from-cfn-stack` reads, including SecureString parameters.

What cdkd does for itself still uses the role. That means synthesis, reading
state with `--from-state`, and pulling the container image, which leaves an ECR
login for the role's account in your Docker config.

### Edge cases

- **`${AWS::AccountId}` under `--from-state`.** On `local invoke`,
  `local start-api`, `local run-task` and `local invoke-agentcore` it resolves
  to the account the state was read in, which is the role's.
- **`${AWS::AccountId}` otherwise.** It resolves to your own account. The stack
  has to be readable by you.
- **A `[default]` profile that sources the environment.** If your own
  credentials come from a profile that reads the `AWS_*` variables
  (`credential_source = Environment`, or a `credential_process` that echoes
  them), the workload's inputs resolve as the role: `--role-arn` has replaced
  those variables with the role's credentials by then. Pass `--profile` with a
  profile that does not read the environment.
- **Role hops are signed by you.** The `--assume-role`, `--ecr-role-arn` and
  `--layer-role-arn` hops are signed by your own identity, so the target role's
  trust policy must trust you, not only the `--role-arn` role. The credentials
  a hop returns still do the image pull or layer fetch.
- **Deployed S3 origins and KeyValueStores.** On `local start-cloudfront
  --from-state`, the deployed S3-origin and KeyValueStore reads run as you. A
  cross-account deploy may need your access to those.
- **Credentials that are not an access key.** When your credentials come from
  IAM Identity Center, an EC2 instance role or an ECS container role, cdkd has
  no access key to capture, so the container receives no credentials, and
  `local start-alb`, `local start-cloudfront` and `local start-agentcore` warn
  once at startup. The handler's first AWS call then fails with
  `Could not load credentials from any providers`. Pass `--profile <name>` to
  give the function an identity, or `--assume-role <arn>` to run it as its
  deployed execution role.

## Related

- [CLI Reference](cli-reference.md#role-arn): the flag, its values and `--profile`
- [Troubleshooting](troubleshooting.md#access-denied-error): a starting policy for permission errors
- [Use Another Stack's Outputs](cross-stack-references.md): reading another account's outputs
- [Local Execution](local-emulation.md): the `cdkd local` commands
