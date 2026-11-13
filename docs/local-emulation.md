---
title: Local Execution
description: "Run the Lambda functions, APIs, ECS tasks and services, load balancers, CloudFront distributions and AgentCore runtimes in your CDK app on your own machine with cdkd local."
---

# Local Execution

`cdkd local` runs the workloads in your CDK app on your own machine, in Docker
containers. The commands read the same cloud assembly that `cdkd deploy` reads,
so you deploy nothing and maintain no `template.yaml`. You can test a handler
edit a few seconds after saving it.

With Docker running, from the directory that holds your `cdk.json`:

```bash
# run one Lambda once
cdkd local invoke MyStack/Handler --event event.json

# serve the app's APIs on localhost
cdkd local start-api --port 3000

# use the deployed stack's table names, ARNs, ...
cdkd local invoke MyStack/Handler --from-state
```

## Which command do I want

Pick the command by the resource you want to run.

| In your CDK app | Command | Runs |
| --- | --- | --- |
| A Lambda function | [`cdkd local invoke`](local-invoke.md) | Once, then exits |
| API Gateway (REST, HTTP, WebSocket) or a Function URL | [`cdkd local start-api`](local-start-api.md) | Until {kbd:ctrl+c} |
| An ECS task definition | [`cdkd local run-task`](local-run-task.md) | Until the task exits |
| An ECS service | [`cdkd local start-service`](local-start-service.md) | Until {kbd:ctrl+c} |
| An Application Load Balancer | [`cdkd local start-alb`](local-start-alb.md) | Until {kbd:ctrl+c} |
| A CloudFront distribution | [`cdkd local start-cloudfront`](local-start-cloudfront.md) | Until {kbd:ctrl+c} |
| A Bedrock AgentCore Runtime, one request | [`cdkd local invoke-agentcore`](local-invoke-agentcore.md) | Once, then exits |
| A Bedrock AgentCore Runtime, many requests | [`cdkd local start-agentcore`](local-start-agentcore.md) | Until {kbd:ctrl+c} |
| A Lambda Web Function | [`cdkd local start-web-function`](local-start-web-function.md) | Until {kbd:ctrl+c} |
| A Lambda MicroVM image | [`cdkd local start-microvm`](local-start-microvm.md) | Until {kbd:ctrl+c} |

`start-alb` starts the ECS services and Lambda functions behind the load
balancer itself, so you do not run `start-service` next to it.

## Requirements

Docker must be running, because every command runs your code in a container:

- A Lambda function runs in the AWS Lambda Runtime Interface Emulator (RIE)
  image for its runtime. A container-image function runs in its own image;
  `local invoke` and `local start-api` mount an RIE into it.
- An ECS container runs from its own image, next to the ECS metadata sidecar
  that AWS publishes.
- An AgentCore agent runs in the agent's image.
- A Lambda Web Function runs its code bundle in the AWS Lambda base image
  for its runtime, with its own HTTP server in place of the RIE.
- A Lambda MicroVM image is built from its own `Dockerfile` and runs as one
  container per MicroVM.

`local start-cloudfront` is the one command that can run without Docker. It
serves a distribution made of S3 origins and CloudFront Functions inside the
cdkd process. It needs Docker once the distribution has a Lambda Function URL
origin or a Lambda@Edge association.

The first run pulls the images it needs, so it is slower than later runs. A
language-specific Lambda base image is roughly 600 MB and a `provided.*` image
roughly 50 MB. Later runs reuse the cached image. `--no-pull` skips the
`docker pull` check, and each command page says which images that covers.

## Naming the target

Every command takes the resource to run as its argument, called the target.
You can write it in three ways:

```bash
# CDK display path
cdkd local invoke MyStack/MyApi/Handler

# stack name, a colon, the logical ID
cdkd local invoke MyStack:MyApiHandler1234ABCD

# bare name
cdkd local invoke Handler
```

- The CDK display path is the construct path. A prefix is enough, so you do
  not type the trailing `/Resource`.
- The stack-qualified logical ID works in any app.
- The bare name works only when the app has exactly one stack.

A stack inside a CDK `Stage` is addressed by its full display path, for example
`MyStage/MyStack/MyApi/Handler`.

`invoke` and `run-task` require a target. On the other commands it is
optional. Without one, `start-api` serves every API it finds, and
`start-service`, `start-alb`, `start-cloudfront`, `start-web-function`,
`start-microvm` and the two AgentCore commands open a picker when you run them in an interactive terminal.

## Where values come from

A local command runs before anything is deployed, so some environment values
do not exist yet. Take a function with two variables:

```ts
new lambda.Function(this, 'Handler', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda'),
  environment: {
    LOG_LEVEL: 'debug',           // a literal string
    TABLE_NAME: table.tableName,  // a reference to a table that has no name yet
  },
});
```

`LOG_LEVEL` reaches the container as written. `TABLE_NAME` is a `Ref` to the
table in the synthesized template, and only a deployment gives the table a
name. With no extra flag, cdkd leaves `TABLE_NAME` out of the container and
prints a warning that names it.

Every `cdkd local` command treats environment values this way. Each value is
handled according to its kind:

```text diagram=local-value-resolution
                Value in the synthesized template
        ┌───────────────────────┼──────────────────────────┐
        ▼                       ▼                          ▼
     Literal        Intrinsic (Ref, Fn::GetAtt, ...)   {{resolve:...}}
  passed through    --from-state: cdkd S3 state        looked up with your
    unchanged       --from-cfn-stack: CloudFormation   credentials; a failed
                    neither: dropped with a warning    lookup stops the command
        └───────────────────────┼──────────────────────────┘
                                ▼
                        --env-vars file
        replaces any of the three; an overridden key is never looked up
                                │
                                ▼
                      Container environment
```

To give a reference such as `TABLE_NAME` a value, choose one of these:

| What you want | Do this |
| --- | --- |
| The values of a stack deployed with `cdkd deploy` | `--from-state` |
| The values of a stack deployed with the AWS CDK CLI | `--from-cfn-stack` |
| One variable pointed at something local | `--env-vars overrides.json` |

```bash
# TABLE_NAME is the deployed table's name
cdkd local invoke MyStack/Handler --from-state

# TABLE_NAME is whatever the file says
cdkd local invoke MyStack/Handler --env-vars overrides.json
```

A `{{resolve:...}}` value is a CloudFormation dynamic reference to a Secrets
Manager secret or an SSM parameter. cdkd looks it up with your credentials
before the container starts, and no flag is needed for that.

[Value resolution in local execution](local-emulation-value-resolution.md) has
the `--env-vars` file format, what each state flag can and cannot resolve, and
the rules for dynamic references.

## Credentials inside the container

By default the container gets your own AWS credentials, so the AWS calls your
code makes reach real AWS as you. They come from, in order:

| Source | Used when |
| --- | --- |
| `--assume-role` (or the command's equivalent below) | The flag is given and the role can be assumed, or [emulated](#when-the-role-does-not-trust-you). |
| `--profile <name>` | The flag is given. |
| Your default credential chain | Neither flag is given: `AWS_ACCESS_KEY_ID` and its pair, `AWS_PROFILE`, the shared credentials and config files, IAM Identity Center. |

Under [`--aws-emulator`](#aws-emulator) the container gets the emulator's
credentials and nothing else. With a role flag from the table below, cdkd
assumes the role in the emulator, and the container gets the role's emulator
credentials instead, so the emulator checks the role's policies. The role's
trust policy must allow the emulator's identity (see
[Trusting yourself in the role](#trusting-yourself-in-the-role)). When it does
not, cdkd warns and the container keeps the emulator's keys (`local run-task`
and `local start-api` stop instead).

Your credentials usually allow more than the
deployed role does, which means a missing IAM permission goes unnoticed. To see
IAM errors locally, run the code under the deployed role:

| Command | Flag |
| --- | --- |
| `local invoke` | `--assume-role [arn]` |
| `local start-api` | `--assume-role <arn>`, `--assume-role <LogicalId>=<arn>`, `--assume-role-auto` |
| `local run-task` | `--assume-task-role [arn]` |
| `local start-service`, `local start-alb` | `--assume-role [arn]` (`--assume-task-role` also works) |
| `local start-cloudfront` | `--assume-role [arn]`, for Lambda origins |
| `local invoke-agentcore`, `local start-agentcore` | `--assume-role [arn]` |
| `local start-web-function` | `--assume-role [arn]`, the revision's `ExecutionRoleArn` |
| `local start-microvm` | `--assume-role <arn>`; the role is not in the template, so the ARN is required |

### Trusting yourself in the role

cdkd assumes the role with your own credentials, so the role's trust policy
must allow `sts:AssumeRole` from you. A role CDK creates by default trusts only
the service that runs the code, such as `lambda.amazonaws.com` for a Lambda
function or `ecs-tasks.amazonaws.com` for an ECS task. Without a change, the
assume is refused with AccessDenied, and on `local invoke`, `local start-api`,
`local run-task` and `local invoke-agentcore` cdkd then
[emulates the role's permissions](#when-the-role-does-not-trust-you) instead.
To run as the real role, add a statement to the role's trust policy in the
stack you develop against:

```ts
(fn.role as iam.Role).assumeRolePolicy?.addStatements(
  new iam.PolicyStatement({
    actions: ['sts:AssumeRole'],
    // Trust the account. The caller also needs an IAM policy that allows
    // sts:AssumeRole on this role. To trust one principal only, use
    // new iam.ArnPrincipal('arn:aws:iam::123456789012:role/DeveloperRole').
    principals: [new iam.AccountPrincipal(this.account)],
  }),
);
```

`role.grantAssumeRole(principal)` does not do this. It refuses an account
principal at synth time, and for an ARN principal it changes nothing in the
trust policy.

Keep this change out of production stacks, because it lets that principal act
as the function.

The same statement works in [AWS Emulator](#aws-emulator): deployed there with
`cdkd deploy --aws-emulator`, it trusts the emulator's own user, which signs
cdkd's AssumeRole.

### When the role does not trust you

When the role flag's AssumeRole is refused with AccessDenied, `local invoke`,
`local start-api`, `local run-task`, `local invoke-agentcore`,
`local start-service`, `local start-alb`, `local start-cloudfront`,
`local start-agentcore`, `local start-web-function` and `local start-microvm`
emulate the role instead of running with your own credentials. cdkd reads the role's inline
and attached managed policies, then gets credentials for you with those
policies as session policies. Only what both you and the role allow is allowed,
so a permission the role lacks fails locally. No CDK change is needed.

| Your credentials | How cdkd gets the credentials |
| --- | --- |
| An IAM user | `sts:GetFederationToken` with the session policies. |
| Anything else (IAM Identity Center, a role session) | `sts:AssumeRole` of the role you name with `--emulate-role-via <arn>`, with the session policies. |
| Anything else, without `--emulate-role-via` | No emulation: cdkd warns and handles the refusal as before. |

`--emulate-role-via` names a role you can already assume, such as your
developer role. It also takes precedence for an IAM user.

Under [`--aws-emulator`](#aws-emulator), `local invoke`, `local start-api`,
`local run-task` and `local invoke-agentcore` do not use
`sts:GetFederationToken`. The emulator's own user has no IAM policies, so a
session made from it would be allowed nothing. Let the role trust the emulator's
identity instead, such as the account root
(`arn:aws:iam::000000000000:root`), or pass `--emulate-role-via`.

```bash
cdkd local invoke MyStack/Handler --from-state --assume-role \
  --emulate-role-via arn:aws:iam::123456789012:role/DeveloperRole
```

cdkd warns once per role in each run, because it is an approximation:

- Resource-based policies, KMS key policies, and `aws:PrincipalArn` conditions
  or `NotPrincipal` elements that name the role see your identity instead, so
  what they grant or deny the role is not reproduced.
- The role's own tags are not reproduced. Conditions on `aws:PrincipalTag`,
  used by ABAC, SCPs and resource-based policies, see your tags instead of the
  role's. The role's session tags are not reproduced either.
- SCPs and RCPs apply the same way, because the role is in your account. The
  exception is their conditions on the principal, such as `aws:PrincipalArn`
  and `aws:PrincipalTag`.
- Policy variables such as `${aws:username}` and `${aws:userid}` take the
  emulated session's values, not the role's. A role session has no
  `aws:username`.
- A GetFederationToken session cannot call IAM, and of STS only
  `GetCallerIdentity`.

Reading the role needs `iam:GetRole`, `iam:ListRolePolicies`,
`iam:GetRolePolicy` and `iam:ListAttachedRolePolicies`, and the role must be in
your own account.

cdkd does not emulate, and warns, when the role has a permissions boundary.
STS combines session policies as a union, so a boundary cannot be added as one
more of them, and the emulation could allow what the boundary denies. cdkd also
does not emulate when the role's policies do not fit in session policies: more
than 10 managed policies, more than 2,048 characters of inline policy JSON plus
managed policy ARNs, or STS answering `PackedPolicyTooLarge`. In each case it
then handles the refusal as before: `local invoke` and
`local invoke-agentcore` run with your own credentials, and `local start-api`
and `local run-task` stop with the AssumeRole error.

`--role-arn` is a different flag. It names the role cdkd assumes for its own
AWS calls.

> [!NOTE]
> Under `--role-arn`, what the workload runs as, and every input cdkd
> resolves for it (container credentials, task secrets, `{{resolve:...}}`,
> `--from-cfn-stack`, `--assume-role` hops), uses your own identity, not the
> role. No startup warning applies. When your own credentials are not a static
> access key, the container gets what your credential chain resolves without
> the environment variables, which hold the role. See
> [Credentials and --role-arn](cli-reference-credentials.md#role-arn-with-cdkd-local).

## Common flags

Every `cdkd local` command accepts the flags below. Each command page lists
only the flags of its own.

| Flag | Default | Description |
| --- | --- | --- |
| `-a`, `--app <cmd-or-dir>` | `cdk.json` / `CDKD_APP` | CDK app command, or a synthesized cloud assembly directory. `-a cdk.out` skips synthesis. |
| `--output <path>` | `cdk.out` | Output directory for synthesis. |
| `-c`, `--context <key=value...>` | — | CDK context value. Repeatable. |
| `--no-pull` | off | Skip `docker pull` and use the cached image. |
| `--from-state` | off | Resolve intrinsic values from cdkd's S3 state. |
| `--from-cfn-stack [name]` | off | Resolve them from a deployed CloudFormation stack. The bare form uses the stack's own name. |
| `--stack-region <region>` | — | Region of the state record, and of the CloudFormation client under `--from-cfn-stack`. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json`, then `cdkd-state-{accountId}` | S3 bucket read by `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role cdkd assumes for its own AWS calls. |
| `--aws-emulator [url]` | `CDKD_AWS_EMULATOR`; bare flag: `https://127.0.0.1:9297` | Run against a local AWS Emulator. See [AWS Emulator](#aws-emulator). |
| `--ca-bundle <file>` | the host `AWS_CA_BUNDLE`, then the profile's `ca_bundle` | PEM CA bundle every workload container trusts. See [Local AWS endpoints](#local-aws-endpoints). |
| `-y`, `--yes` | off | Answer interactive prompts with the recommended response. |
| `--verbose` | off | Verbose logging. |

Every command also accepts `--env-vars`, and every command except
`local start-cloudfront` accepts `--container-host`:

| Flag | Default | Description |
| --- | --- | --- |
| `--env-vars <file>` | — | JSON environment-variable overrides. |
| `--container-host <ip>` | `127.0.0.1` | IP that published container ports bind to. Must be numeric, because Docker rejects a hostname here. |

`local start-web-function` and `local start-microvm` take `--host <ip>` in
place of `--container-host`: it sets where their own local URLs listen.

### Which region is used

The region for AWS calls comes from `AWS_REGION`, then `AWS_DEFAULT_REGION`,
then the synthesized stack's own `env.region`. An upper-cased region such as
`US-EAST-1` is changed to lower case before any AWS call.

A deprecated `--region` flag still overrides all three and prints a removal
warning. `--help` does not list it.

A Lambda container gets that region as `AWS_REGION`, and `AWS_DEFAULT_REGION`
beside it. On `local invoke`, `local start-api` and `local invoke-agentcore`,
when none of those three is set, the container gets the region of the loaded
state record (`--from-state` / `--from-cfn-stack`), then your AWS profile's
`region`, which is where `cdkd deploy` put an env-agnostic stack. The same
region is used for the `--assume-role` STS call. With no region anywhere, the
container gets none.

`local run-task`, `local start-service` and `local start-alb` give every task
container its region the same way: `AWS_REGION`, `AWS_DEFAULT_REGION`,
`--stack-region` or the stack's own `env.region`, the loaded state record's
region, then your AWS profile's `region`. A container's own `Environment` or
`--env-vars` entry still wins.

## Local AWS endpoints

When your shell points the AWS SDK at a local endpoint, such as an AWS API
emulator, the containers follow it too:

| Host setting | What every workload container gets |
| --- | --- |
| `AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_<SERVICE>`, or the profile's `endpoint_url` | The same variables. A value from the template or `--env-vars` wins. |
| `--ca-bundle <file>` | The bundle mounted read-only, with `AWS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE` and `SSL_CERT_FILE` pointed at it. |
| `AWS_CA_BUNDLE`, else the profile's `ca_bundle` (no `--ca-bundle`) | The bundle mounted read-only, with `AWS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS` pointed at it. `REQUESTS_CA_BUNDLE` and `SSL_CERT_FILE` replace a runtime's whole trust store, so only `--ca-bundle` and `--aws-emulator` set them. |
| `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true`, or the profile's `ignore_configured_endpoint_urls = true` | No endpoint variables. |

An endpoint on `127.0.0.1`, `localhost` or `::1` keeps its URL inside the
container. cdkd starts a small forwarder container in the workload's network
namespace that carries the connection to your machine, so the certificate
still matches and S3 keeps path-style addressing. If it cannot reach the
endpoint, cdkd prints a warning once and the workload starts anyway. A Lambda
invoke waits for the forwarder, which stops with the workload. A `run-task`,
`start-service` or `start-alb` container starts inside a forwarder that is
already up, so its first AWS call goes through, and cdkd removes that
forwarder with the task (see
[local-run-task.md](local-run-task.md#aws-credentials-in-containers)).

The mounted bundle holds the certificates of your file plus the public root
CAs, so calls to other HTTPS hosts keep working. A private key in the file is
not copied. Certificate verification is never switched off.

```bash
# endpoint, credentials and CA from the shell reach the Lambda container
export AWS_ENDPOINT_URL=https://127.0.0.1:4566
cdkd local invoke MyStack/Handler --ca-bundle ./local-ca.pem
```

### AWS Emulator

`--aws-emulator [url]` wires a command to a local
[AWS Emulator](https://github.com/aws/aws-emulator) in one flag. The URL
defaults to `https://127.0.0.1:9297`, and its port selects the run directory
`~/.aws/emulator/<port>/`. `CDKD_AWS_EMULATOR=1` (or a URL) turns it on
without the flag. For the whole workflow, from deploy to local runs, see
[Develop Locally with AWS Emulator](aws-emulator.md).

The URL is optional, so a word right after the flag is taken as the URL:
`--aws-emulator MyStack/Handler` is refused, because the target is not an
`http(s)` URL, with the advice to put the flag after the target or to write
`--aws-emulator=<url>`, such as `--aws-emulator=https://127.0.0.1:9297`. A
value that is not an `http(s)` URL, or that carries a user name, password,
query or fragment, is refused without being printed.

```bash
cdkd local invoke MyStack/Handler --from-state --aws-emulator
cdkd local start-api --from-cfn-stack --aws-emulator https://127.0.0.1:9297
```

| What | Under `--aws-emulator` |
| --- | --- |
| Pre-flight | cdkd checks `/__admin/health`, trusting the run's `ca.pem`, and stops with the fix when nothing answers. |
| cdkd's own AWS calls | `--from-state`, `--from-cfn-stack`, `{{resolve:...}}`, STS and the `--role-arn` hop go to the emulator, signed with its keys. |
| Container credentials | The keys in the run's `emulator_credentials` only. Your own are removed, as are `AWS_PROFILE`, the shared-file variables and the `--profile` credentials file. `--profile` is not resolved. `run-task --assume-task-role` assumes the role in the emulator and gives its credentials instead. |
| Container trust | The run's `ca.pem`, with the four trust variables above. |
| Other container variables | `AWS_ENDPOINT_URL`, `AWS_EC2_METADATA_DISABLED=true`, `AWS_DISABLE_HOST_PREFIX_INJECTION=true`. |
| Reachability | For a loopback URL, the forwarder checks the emulator from inside the container network (its health endpoint when a CA is known, else a TCP connect); a failure stops the command. |

When `emulator_credentials` is missing but the emulator answers, it runs with
`--auth off`, and containers get fixed placeholder keys. Getting a stack into
the emulator in the first place takes the same flag on `bootstrap` and
`deploy`: see [Deploying into AWS Emulator](#deploying-into-aws-emulator).

A handler that misses the endpoint fails with a credential error rather than
reaching real AWS, because the container holds no real credentials.

AWS Emulator answers SQS calls with real-shaped queue URLs
(`https://sqs.<region>.amazonaws.com/<account>/<queue>`), and the AWS SDK for
JavaScript v3 sends each SQS request to its queue URL's host, which would
leave the emulator. A sidecar in each workload rewrites the queue URLs in the
emulator's answers to its own loopback address, so the next call stays local.
It runs with an `https` emulator URL whose run wrote `ca.pem`, and always in
[mixed mode](#aws-emulator-mixed-mode); a container's own
`AWS_ENDPOINT_URL_SQS` wins.

| Case | What to do |
| --- | --- |
| The host network, a plain `http` URL, or no run `ca.pem` | No sidecar runs; pass `useQueueUrlAsEndpoint: false` to the `SQSClient`. |
| A queue URL from an environment variable (`--from-state`, `--from-cfn-stack`, `--env-vars`) | Not rewritten; pass `useQueueUrlAsEndpoint: false` to the `SQSClient`. |

To keep some services on real AWS while the rest goes to the emulator, see
[AWS Emulator mixed mode](#aws-emulator-mixed-mode).

### Deploying into AWS Emulator

Every cdkd command that talks to AWS takes `--aws-emulator [url]` (and
`CDKD_AWS_EMULATOR`): `bootstrap`, `deploy`, `diff`, `destroy`, `rollback`,
`gc`, the `state` commands and the rest. So the whole loop needs no shell
setup. AWS Emulator itself runs the deployed functions and REST APIs on its
embedded runtimes; `cdkd local ... --aws-emulator` runs the same functions
under the official Lambda runtimes and container images (native dependencies,
layers, ECS, ALB, CloudFront and AgentCore targets), picks up code edits
without a redeploy, and offers `--debug-port` and logs in your terminal:

```bash
cdkd deploy --aws-emulator                                     # bootstraps the emulator, then resources and file assets
cdkd local invoke MyStack/Handler --from-state --aws-emulator  # run against what was deployed
cdkd destroy --aws-emulator
```

The emulator keeps its state in memory, so each start begins empty.
`cdkd deploy` and `cdkd import` bootstrap it themselves: they create the state
bucket when it is missing, and `deploy` creates each stack region's asset
storage without a prompt. An explicit `cdkd bootstrap --aws-emulator` still
works, for example to use custom asset-storage names. See
[Bootstrap in AWS Emulator](cli-bootstrap.md#bootstrap-in-aws-emulator).

Under the flag, the emulator's identity is the only one cdkd uses:

| What | Under `--aws-emulator` |
| --- | --- |
| Pre-flight | The same `/__admin/health` check as above; nothing runs when it fails. |
| Every AWS call | Sent to the emulator, trusting the run's `ca.pem`, signed with its keys. |
| Your own identity | `--profile`, `--role-arn`, `CDKD_ROLE_ARN`, `AWS_PROFILE` and the `AWS_ACCESS_KEY_ID` triple are ignored, with one line naming them. |
| Region | `--region` or `AWS_REGION` when set, else the region in the run's `config`. |
| Process environment | `AWS_ENDPOINT_URL`, `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` name the emulator and its run files, so nothing falls back to real AWS. |
| Cloud Control | Status is polled every 100 ms instead of the backoff used against AWS. |
| Docker image assets | Refused before anything is built: the emulator's ECR names the real `amazonaws.com` registry. |

On a `cdkd local` command the flag also drops `--profile` and your credential
variables, and keeps the `--role-arn` hop, which the emulator answers. In
[mixed mode](#aws-emulator-mixed-mode) it keeps your identity for the excepted
services' calls.

> [!NOTE]
> cdkd creates a REST API (`AWS::ApiGateway::RestApi`, e.g. `LambdaRestApi`)
> through its SDK provider, which works on AWS Emulator. A REST API created
> through Cloud Control in the emulator (by a release before v0.343.0) is
> recorded under the identifier the emulator returned, which is not the API
> id, so its resources and methods fail. Destroy and redeploy that stack once.

`CDKD_AWS_EMULATOR` applies to every command, so a shell that exports it for
`cdkd local` also deploys into the emulator.

The flag is specific to AWS Emulator. Other local AWS endpoints, such as
LocalStack, keep working through the standard `AWS_ENDPOINT_URL*` and
`AWS_CA_BUNDLE` variables.

### AWS Emulator mixed mode

`--aws-emulator` is the switch for the target environment: with it, every AWS
call goes to AWS Emulator — the workload's own calls and the calls cdkd makes
for it. Mixed mode keeps chosen services on real AWS. Mark each one in the
`--env-vars` file by setting its standard `AWS_ENDPOINT_URL_<SERVICE>`
variable to `"real-aws"`, under `Parameters` for every workload or under one
resource's section (logical ID or CDK path, or an ECS container name) for that
workload only:

```json
{
  "Parameters": {
    "AWS_ENDPOINT_URL_SECRETS_MANAGER": "real-aws",
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME": "real-aws"
  }
}
```

Every service you do not mark stays on the emulator, so a forgotten entry
fails closed: the call reaches the emulator, never a shared real environment.

#### What it is for

| Setup | What goes where |
| --- | --- |
| AI agent | Sessions and state in the emulator's DynamoDB; Bedrock excepted, since the emulator cannot run real models. Run the agent with `cdkd local invoke-agentcore` or `cdkd local start-agentcore`. |
| Read real, write safe | Secrets Manager or S3 excepted, so the handler reads real values; its DynamoDB and SQS writes land in the emulator, never in real data. |

#### Why only a local runner can split traffic

AWS Emulator runs a deployed function inside its own runtime, where every SDK
call goes to the emulator. A per-service split has to be made where the
workload's container environment is assembled, one endpoint variable per
service and per workload. `cdkd local` assembles that environment, so it can
keep one service on real AWS and send the rest to the emulator.

#### Where a value comes from, and where a call goes

Take one handler line and the CDK code behind its variable:

```ts
const table = new dynamodb.Table(this, 'MyTable', {
  partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
});
const handler = new lambda.Function(this, 'Handler', {
  // ...
  environment: { TABLE_NAME: table.tableName }, // synthesizes to { Ref: MyTable }
});
table.grantWriteData(handler);
```

```ts
await ddb.send(new PutItemCommand({ TableName: process.env.TABLE_NAME, Item: item }));
```

Two questions decide what happens:

1. **Where does `TABLE_NAME` come from?** `table.tableName` is `Ref: MyTable`
   in the template. `--from-state` replaces it with the table name recorded
   in cdkd's state for that stack; without a state flag the variable is
   dropped with a warning.
2. **Where does the PutItem request go?** Wherever `--aws-emulator` points:
   the emulator with the flag, real AWS without it.

| | Without `--from-state` | With `--from-state` |
| --- | --- | --- |
| Without `--aws-emulator` | `TABLE_NAME` is dropped (a warning names it); PutItem → real AWS with no table name, so it fails | `TABLE_NAME` = the real table's name (from `cdkd deploy`); PutItem → real AWS |
| With `--aws-emulator` | `TABLE_NAME` is dropped, and one hint names `--from-state` / `--from-cfn-stack` / `--env-vars`; PutItem → emulator with no table name, so it fails | `TABLE_NAME` = the emulator's table name (from `cdkd deploy --aws-emulator`); PutItem → emulator |

With `AWS_ENDPOINT_URL_DYNAMODB: "real-aws"` in the bottom-right cell,
`TABLE_NAME` is the real table's name and the PutItem goes to real AWS, while
every other service stays on the emulator. `--from-cfn-stack` answers the
first question the same way, from the CloudFormation stack instead of cdkd's
state. An `--env-vars` value for `TABLE_NAME` wins in every cell.

#### Deploy to both sides before using an exception with a state flag

With `"real-aws"` exceptions and `--from-state`, names come from two copies of
the stack: the emulator's for every service, and the real one for the
excepted services. Deploy the same stack, with the same stack name and CDK
context, to both sides first:

```bash
cdkd deploy --aws-emulator  # the emulator copy: every service's names
cdkd deploy                 # the real copy: the excepted services' names
cdkd local invoke MyStack/Handler --from-state --env-vars env.json --aws-emulator
```

With `--from-cfn-stack`, deploy the real copy with `cdk deploy` instead. When
one side has no copy, the names of its resources cannot be resolved, and a
warning names the side and why; the excepted resources then keep the
emulator's names.

#### One env.json, with and without the flag

The same file works in both runs. Without `--aws-emulator`, a `"real-aws"`
value is a no-op: the variable is dropped and everything goes to real AWS, as
it always does without the flag. With the flag, it marks the exception.

| Value of `AWS_ENDPOINT_URL*` in `--env-vars` | Without `--aws-emulator` | With `--aws-emulator` |
| --- | --- | --- |
| `"real-aws"` on `AWS_ENDPOINT_URL_<SERVICE>` | Dropped (a no-op) | That service goes to real AWS |
| `"real-aws"` on the bare `AWS_ENDPOINT_URL` | Dropped | Refused: mark each service, or drop the flag |
| A literal URL on `AWS_ENDPOINT_URL_<SERVICE>` | Used as it is | Used as it is, never signed again |
| A literal URL on the bare `AWS_ENDPOINT_URL` | Used as it is | With no exception, replaced by the emulator's endpoint; with exceptions, used as it is |
| `"aws-emulator"` (the old form) | Refused, with the migration | Refused, with the migration |

A variable the AWS SDKs never read, such as `AWS_ENDPOINT_URL_SECRETSMANAGER`,
is refused with the SDK spelling (`AWS_ENDPOINT_URL_SECRETS_MANAGER`).

#### Credentials and signing

| What | In mixed mode |
| --- | --- |
| A container that keeps an exception | Your real identity: the default chain, `--profile` or `--assume-role`, as env keys. For `run-task`, `--assume-task-role` assumes the role in real AWS and gives it only to a container that also excepts STS. |
| A bare role flag (`--assume-role`, `--assume-role-auto`, `--assume-task-role`) | The role is assumed in real AWS, so cdkd reads it from the state record only when `Parameters` excepts IAM (`AWS_ENDPOINT_URL_IAM`). Otherwise the record's roles are the emulator's, and cdkd warns and does not assume one: pass the role's real ARN to the flag. |
| A container that keeps none | The emulator's keys only, as with `--aws-emulator` alone: no real credential and no `--profile` credentials file. |
| Calls to non-excepted services | Through a re-signing sidecar in the workload's network namespace (`AWS_ENDPOINT_URL=https://127.0.0.1:47297`), which drops the request's signature and signs it again with the emulator's keys. No real-key signature reaches the emulator. |
| Calls to excepted services | Straight to real AWS: each gets its real regional endpoint in its own `AWS_ENDPOINT_URL_<SERVICE>`. |
| `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS` | Forced to `false`, so an image cannot make the SDK skip the endpoints. |
| The CDK app's own synth | The emulator with its keys, as with `--aws-emulator` alone: exceptions apply to the workload and to cdkd's own calls, never to synth. |
| cdkd's own process | Keeps your identity only for the excepted calls (and the STS hops that establish it); every other call it makes goes to the emulator with its keys. |
| Container trust | A CA bundle with the emulator's CA, a CA made for this run (for the sidecar's certificate) and the public roots. |
| Your shell's `AWS_ENDPOINT_URL*` and a profile's `endpoint_url` | Ignored, with one notice, for containers and for cdkd's own calls. |

With no `"real-aws"` entry, `--aws-emulator` keeps its "emulator keys only"
guarantee.

#### cdkd's own calls follow the same routing

| cdkd's call | Goes to real AWS when |
| --- | --- |
| `{{resolve:secretsmanager:...}}` in a function's environment | That workload excepts `SECRETS_MANAGER` |
| `{{resolve:ssm:...}}` / `{{resolve:ssm-secure:...}}` | That workload excepts `SSM` |
| ECS task `Secrets` (`ValueFrom`) on `local run-task` | That container excepts the ARN's service |
| `--from-state` / `--from-cfn-stack` names | Per resource type: an excepted service's resources come from the real copy |
| `${AWS::AccountId}` lookups | `Parameters` excepts `STS` |
| `--role-arn`, `--assume-role`, `--profile` resolution (STS) | Always: they establish the real identity |
| The ECR login and pull of a deployed image | That workload excepts `ECR` (otherwise the pull is refused) |
| An AgentCore `fromS3` code bundle | That runtime excepts `S3` |
| A literal layer ARN | That function excepts `LAMBDA` |

To run an image that exists only in real ECR (not pushed to the emulator),
except ECR for that workload; the image's token and pull then come from real
ECR with your real identity, while its runtime calls stay on the emulator:

```json
{
  "MyStack/ImageHandler": { "AWS_ENDPOINT_URL_ECR": "real-aws" }
}
```

Names follow each workload's own exceptions: per function (`local invoke`,
`local start-api`), per runtime (`local invoke-agentcore`) and per container
(`local run-task`, `local start-service`, `local start-alb`). A read for no
workload in particular follows the `Parameters` exceptions alone.

Without that exception, a deployed image in ECR is refused before any request
leaves the machine: its URI always names the real registry host, and AWS
Emulator serves no registry Docker can pull from. The error names
`AWS_ENDPOINT_URL_ECR`; a cached image still runs with `--no-pull`. Under the
same condition every `docker pull` and `docker build` cdkd starts uses a
per-run Docker client config with no credential for any ECR host (the host's
`auths`, `credHelpers` and `credsStore` entries for ECR hosts and
`public.ecr.aws`, and those in `DOCKER_AUTH_CONFIG`, are left out; podman's
`REGISTRY_AUTH_FILE` points at it too), so the host's credential helper never
answers a request to real ECR. `docker run` of an ECR image carries
`--pull never`, since the image was pulled or verified beforehand.

#### Limits

- **S3 uploads up to 100 MiB per request.** The signature covers the body, so
  the sidecar holds each body in memory. SDK streaming uploads (`aws-chunked`)
  are decoded and signed again. Past 100 MiB a request fails with HTTP 413
  (`EntityTooLarge`); every SDK's managed uploader uses multipart parts far
  smaller than that.
- A global-endpoint service (IAM, Route 53, CloudFront, ...) can be excepted
  only in its signing region; elsewhere it is refused with the reason.
- `--env-vars` is read when the command starts; a piped file
  (`<(jq ...)`, `/dev/stdin`) works and is read once. Rewriting the file while
  the command starts up is not supported; the run then fails closed.
- Port `47297` is reserved for the sidecar inside a workload, and a workload
  on the host network cannot use mixed mode.
- A Java handler needs its own trust store: the JVM reads none of the trust
  variables.
- An SDK that does not read `AWS_ENDPOINT_URL` (older than the
  "service-specific endpoints" support) would send non-excepted calls to real
  AWS; current JavaScript v3, boto3, Go v2 and Java 2.x SDKs read it.

> [!IMPORTANT]
> The `"aws-emulator"` value that once routed a single service TO the
> emulator is refused. Run with `--aws-emulator`, which sends every service
> there, and mark the services that must stay on real AWS with `"real-aws"`.

## Reaching a server on the host

Inside a container, `localhost` is the container itself. An AWS endpoint
override is forwarded for you ([Local AWS endpoints](#local-aws-endpoints)).
To reach another server on your machine, such as a tunnel to a VPC resource,
use the hostname `host.docker.internal`:

```json
{
  "Parameters": {
    "DATABASE_HOST": "host.docker.internal"
  }
}
```

Save that as `overrides.json` and pass it with `--env-vars overrides.json`.

Do not point an S3 endpoint at a host name such as `host.docker.internal`: the
SDK then switches to virtual-hosted addressing (`<bucket>.host.docker.internal`),
which does not resolve. Keep the loopback URL and let cdkd forward it.

Docker Desktop resolves the name natively. On Linux, cdkd adds the
`host.docker.internal:host-gateway` mapping itself, which needs Docker 20.10
or newer. On a daemon that does not support the mapping, cdkd skips it without
an error.

## Stopping a server

Press {kbd:ctrl+c} to stop a long-running command. cdkd then removes every
container, sidecar, Docker network and temporary file the command created.

If Docker itself hangs during that cleanup, press {kbd:ctrl+c} a second time.
cdkd exits immediately and skips the cleanup, so containers can be left
behind. `local start-web-function` and `local start-microvm` are the
exceptions: a second signal exits at once only while a `docker run` is still
in flight; otherwise they print that they are still removing the containers
and wait for that to finish. Find and remove them yourself:

```bash
docker ps --filter name=cdkd-local-
docker rm -f <container-id>
```

On `start-api` and `run-task` with `--profile`, the forced exit also names a
temporary credentials file that it did not remove. The file holds live
credentials, so delete it once the containers are gone.

## finch on macOS and Windows

This section applies only when the `CDK_DOCKER` environment variable names
finch and you are on macOS or Windows. There, finch runs containers inside a
Lima VM and copies each environment value onto a command line that other
processes on your machine can read. cdkd therefore refuses to pass a secret
to finch:

| Command | Refused |
| --- | --- |
| `local run-task`, `local start-service` | A task with a `Secrets` entry |
| `local start-alb` | A service with a `Secrets` entry, and a Lambda target with a decrypted SecureString |
| `local invoke-agentcore`, `local start-agentcore` | A decrypted SecureString in the runtime's environment |
| `local start-cloudfront` | A decrypted SecureString in a Lambda Function URL or Web Function endpoint origin's environment |
| `local start-web-function` | A decrypted SecureString in the revision's environment |
| Any command | A resolved `{{resolve:...}}` value |

The error names the secrets. You have two ways forward:

- Use Docker, podman or nerdctl, or run finch on Linux, which is not affected.
- Set `CDKD_ALLOW_SECRETS_ON_ARGV=1` to accept the exposure.

### AWS credentials under finch

cdkd still forwards AWS credentials to a container under finch, so that finch
stays usable, and it prints a warning naming the variables. The warning
matters most for two kinds of credentials that are otherwise absent from your
environment: the session credentials of `--assume-role` or
`--assume-task-role`, and credentials resolved from `--profile`.

Credentials that are already in cdkd's own environment reach finch's command
line on every finch command, including pulls and builds. finch does that by
itself, so cdkd prints no warning for it.

### How finch is recognised

cdkd recognises finch by the file name that `CDK_DOCKER` resolves to: `finch`
or `finch.exe`, in any letter case. A wrapper script or a symbolic link under
another name is not recognised.

## What cdkd trusts in the assembly

A local command runs code from the cloud assembly: the handler runs in a
container, and a Docker asset's build command runs on your machine. Treat an
assembly you did not synthesize yourself as untrusted input.
[Assembly paths in local execution](local-emulation-assembly-trust.md) lists
the paths cdkd refuses to use and the ones it accepts with a warning.

## In this section

- [Value resolution in local execution](local-emulation-value-resolution.md):
  the `--env-vars` file, what `--from-state` and `--from-cfn-stack` resolve,
  and `{{resolve:...}}` references
- [Assembly paths in local execution](local-emulation-assembly-trust.md):
  which directories named by a cloud assembly cdkd refuses to mount, build or
  serve

## Related

- [CLI Reference](cli-reference.md): every cdkd command
- [Deploy safety](cli-deploy-safety.md): what cdkd refuses to read out of a
  cloud assembly on the deploy path
- [State Store](state-management.md): what `--from-state` reads
- [Getting Started](getting-started.md): installing cdkd and deploying a first
  stack
