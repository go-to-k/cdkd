---
title: CLI Reference
description: "Every cdkd command grouped by task, plus what holds for all of them: shared options, --role-arn, region resolution, the stdout contract and exit codes."
---

# CLI Reference

Start here to find the page for a command. The second half of the page covers
what is true of every command: the options they share, which identity and
region they run in, what they write to stdout, and what their exit codes mean.

```bash
cdkd bootstrap          # once per account: state bucket and asset storage
cdkd diff MyStack       # what a deploy would change
cdkd deploy MyStack     # create or update the stack
cdkd destroy MyStack    # delete its resources
```

For a guided first run, see [Getting Started](getting-started.md).

## CLI reference pages

| You want to | Command | What it does |
| --- | --- | --- |
| **Set up** | [`cdkd bootstrap`](cli-bootstrap.md) | Create the state bucket and a region's asset storage. |
| **Preview** | [`cdkd list`](cli-list.md) | List the stacks in the app. Also documents stack selection patterns. |
| | [`cdkd synth`](cli-synth.md) | Synthesize the app and print a stack's template. |
| | [`cdkd diff`](cli-diff.md) | Show what a deploy would change. |
| **Deploy** | `cdkd deploy` | [Deploy: waits & concurrency](cli-deploy.md) lists every flag and covers wait modes and the stack lock. |
| | | [Deploy: tuning](cli-deploy-tuning.md) covers timeouts, naming, the drift baseline and CDK annotations. |
| | | [Deploy: safety & compatibility flags](cli-deploy-safety.md) covers replacements, routing and the stateful guard. |
| | [`cdkd publish-assets`](cli-publish-assets.md) | Build and upload assets without deploying. |
| | `cdkd import` | [Importing Existing Resources](import.md): adopt resources that already exist. |
| **Tear down** | `cdkd destroy` | [Destroy flags & guards](cli-destroy.md): data guards, snapshots and prompts. |
| | `cdkd orphan` | [Orphan vs Destroy](orphan-vs-destroy.md): stop managing a resource without deleting it. |
| **Recover** | [`cdkd rollback`](cli-rollback.md) | Revert a deploy that failed or was interrupted. |
| | [`cdkd force-unlock`](cli-force-unlock.md) | Delete a lock a crashed or cancelled run left behind. |
| **Inspect** | [`cdkd events`](cli-events.md) | Read what past deploys and destroys did. |
| | [`cdkd state`](cli-state.md) | Read and operate on the state bucket, with no CDK app. |
| | [`cdkd drift`](cli-drift.md) | Compare recorded state against live AWS resources. |
| **Maintain** | [`cdkd gc`](cli-gc.md) | Delete assets no stack references any more. |
| | [`cdkd scrub`](cli-scrub.md) | Remove resolved secret values from stored state. |
| | [`cdkd export`](cli-export.md) | Hand a stack over to CloudFormation. |
| **Run locally** | `cdkd local` | [Local Execution](local-emulation.md): run Lambda, API, ECS and other workloads on your machine. |

`cdkd <command> --help` prints the flags of any command.

## Options every command takes

| Flag | Default | Description |
| --- | --- | --- |
| `--profile <profile>` | default credential chain | AWS profile for the base credentials and shared config. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for cdkd's AWS calls. See [`--role-arn`](#role-arn). |
| `-y`, `--yes` | `false` | Answer confirmation prompts with the recommended response. |
| `--verbose` | `false` | Debug-level logging. |
| `-V`, `--version` | | Print the cdkd version (top level only). |
| `-h`, `--help` | | Print help for the command. |

Commands that read a CDK app (`deploy`, `diff`, `synth`, `list`,
`publish-assets` and the others that synthesize) also take:

| Flag | Default | Description |
| --- | --- | --- |
| `-a`, `--app <command>` | `CDKD_APP`, then `cdk.json` | The CDK app command, or a path to a synthesized assembly directory. |
| `--output <path>` | `cdk.out` | Directory to synthesize into. |
| `-c`, `--context <key=value...>` | | Context values. Repeatable. |

Commands that read or write state also take:

| Flag | Default | Description |
| --- | --- | --- |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET`, then `cdk.json`, then `cdkd-state-{accountId}` | The S3 bucket holding state. |
| `--state-prefix <prefix>` | `cdkd` | Key prefix for state files in that bucket. |

Stack arguments are matched the same way on every command that takes them.
[Selecting stacks](cli-list.md#selecting-stacks) has the rules.

## `--role-arn`

`--role-arn` makes cdkd assume an IAM role and run its AWS calls as that role.
`CDKD_ROLE_ARN` is the equivalent environment variable; the flag wins when both
are set.

```bash
cdkd deploy --role-arn arn:aws:iam::123456789012:role/cdkd-deploy
CDKD_ROLE_ARN=arn:aws:iam::123456789012:role/cdkd-deploy cdkd deploy
```

| Fact | Value |
| --- | --- |
| Accepted value | `arn:<partition>:iam::<account>:role/<name>`, at most 2048 characters |
| Anything else, including `--role-arn ""` | Refused before any request is sent |
| Empty `CDKD_ROLE_ARN` | Counts as unset |
| When the role is assumed | Once, at command start |
| Session | 1 hour, named `cdkd-<unix-ms>` |

cdkd uses the assumed role in two ways, and they do not reach the same places.

```text diagram=cli-role-arn-identities
        Your base credentials
  (--profile, AWS_PROFILE, default chain)
                   |
                   v
            STS AssumeRole            once, at command start; 1-hour session
                   |
        +----------+-----------------------+
        | passed to each client            | exported as AWS_* variables
        v                                  v
  AWS calls cdkd makes              Programs cdkd starts
  Always the role                   (your CDK app during synthesis)
                                    No profile selected: the role
                                    Profile selected:    the profile
```

- Every AWS client cdkd builds is handed the role's temporary credentials, so
  cdkd's own calls always run as the role.
- cdkd also exports them as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
  `AWS_SESSION_TOKEN` for the programs it starts: your CDK app during
  synthesis, and the local emulation engine behind `cdkd local`.

The AWS SDK ignores those exported variables once a profile is selected. So
with `--profile` or an exported `AWS_PROFILE`, a program cdkd starts runs as
the profile. [`--profile` vs `--role-arn`](#profile-vs-role-arn) covers what
that means for your CDK app.

### What the assumed role needs

cdkd does not route through CloudFormation, so there is no execution role to
delegate to. Every IAM, EC2, Lambda and other service call is issued by cdkd
as the assumed role.

The role therefore needs the actions for the resource types your stacks
deploy, plus the actions cdkd uses for its own bookkeeping. `--role-arn` moves
those permissions onto the role; it does not reduce them.
[Permission errors](troubleshooting.md#access-denied-error) has a policy to
start from. Scope the role to the services your stacks use rather than
granting `AdministratorAccess`.

The roles `cdk bootstrap` creates do not work:

| Role | Why it does or does not work for cdkd |
| --- | --- |
| `cdk-hnb659fds-deploy-role-*` | No. It allows CloudFormation and asset publishing only, so provisioning is denied. |
| `cdk-hnb659fds-cfn-exec-role-*` | No. Only the CloudFormation service can assume it. |
| A role you create for cdkd | Yes, when IAM principals can assume it and it carries the permissions above. |

### When the `--role-arn` session expires

The session lasts 1 hour and cdkd does not refresh it. Credentials already in
use stay valid until they expire. If a deploy outlasts the session, run the
command again.

### `--profile` vs `--role-arn`

The two flags combine. `--profile` picks the credentials that answer the
`AssumeRole` call, and `--role-arn` picks the identity that does the work.

| Flag | What it decides |
| --- | --- |
| `--profile` (or `AWS_PROFILE`) | Which credentials call `AssumeRole`, and which shared-config settings apply, the region above all. |
| `--role-arn` (or `CDKD_ROLE_ARN`) | Which identity every AWS call cdkd makes after that runs as. |

```bash
# The ci profile authenticates the AssumeRole; the role in 222222222222 does the work.
cdkd deploy --profile ci --role-arn arn:aws:iam::222222222222:role/cdkd-deploy
```

The profile's principal needs `sts:AssumeRole` on the role, and the role's
trust policy has to allow that principal. Once the role is assumed, the
profile no longer selects the principal for any call cdkd makes. That is also
true of an `AWS_PROFILE` you exported without passing the flag.

cdkd leaves the profile selected in the environment, because the region and
the rest of your shared config come from it. It prints a warning at the start
of the run when a profile is selected and a role is assumed.

#### Your CDK app can see two accounts

When the profile and the role are in different accounts, synthesis uses both:

| What the app reads | Resolved by | Account |
| --- | --- | --- |
| `CDK_DEFAULT_ACCOUNT`, which an env-agnostic stack uses | cdkd, through `sts:GetCallerIdentity` | The role's |
| `Vpc.fromLookup`, `HostedZone.fromLookup`, `StringParameter.valueFromLookup` | The app's own SDK chain | The profile's |

A stack with `env` unset, or with `account: process.env.CDK_DEFAULT_ACCOUNT`,
is therefore synthesized for the role's account, which is where it is
deployed. A lookup in the same app fails or answers from the profile's
account. Either drop `--profile`, pass the region yourself and let `--role-arn`
supply the identity, or set `env` on the stack explicitly:

```ts
new ApiStack(app, 'ApiStack', {
  env: { account: '222222222222', region: 'us-east-1' },
});
```

#### What follows the role's account

cdkd runs as the role, so three things use the role's account and not the
profile's.

| What | Behaviour with both flags |
| --- | --- |
| Default state bucket | `cdkd-state-<accountId>` is derived from the role's account. |
| Cross-account `Fn::GetStackOutput` | The producer role is assumed by the `--role-arn` role, so its trust policy must name that role. |
| `CDK_DEFAULT_ACCOUNT` | The role's account, as above. |

State kept in the profile account's bucket is not found from the role's
account, and a deploy would create the stack again there. Copy the state into
the role account's bucket first. Pointing `--state-bucket` at the profile
account's bucket does not work: cdkd sends `ExpectedBucketOwner` on every
state call, so a bucket another account owns is rejected.

A producer role whose trust policy still names your profile's principal makes
the deploy fail with `AssumeRole into <producer-role> failed: AccessDenied`.
The message names the producer role, so check its trust policy first.
[Cross-Stack References](cross-stack-references.md) covers the feature, and
[Cross-stack reference internals](cross-stack-internals.md) has the policy
documents.

A script that combined both flags on an older cdkd, where every call ran as
the profile, meets all three on its first run after upgrading.

### `--role-arn` with `cdkd local`

`--role-arn` is for cdkd's own work. The function or task a `cdkd local`
command runs should keep your own identity, so the role cannot hand local code
more permission than you asked for. How well that holds depends on the command.

#### `local invoke`, `local start-api`, `local run-task`, `local invoke-agentcore`

On these four, everything cdkd resolves for the workload uses your own
identity, however you selected a profile and also when you selected none:

- the credentials the container is given;
- a role assumed for the container (`--assume-role`, `--assume-task-role`);
- ECS task secrets read into its environment;
- everything `--from-cfn-stack` reads, including SecureString parameters.

What cdkd does for itself still uses the role: reading state, and pulling the
container image, which leaves an ECR login for the role's account in your
Docker config.

| Case | What happens |
| --- | --- |
| A Lambda layer given as a literal ARN in `Properties.Layers`, on `local invoke` and `local start-api` | With `--role-arn` and no profile selected, the layer is downloaded as the role. Pass `--profile` or export `AWS_PROFILE` to keep it on your identity. |
| `${AWS::AccountId}` under `--from-state` | The account the state was read in, which is the role's. |
| `${AWS::AccountId}` under `--from-cfn-stack` | Your own account. The stack has to be readable by you. |
| Your credentials come from IAM Identity Center, an EC2 instance role or an ECS container role | cdkd has no access key to capture, so it forwards no credentials to the container. |

In the last case the handler's first AWS call fails with
`Could not load credentials from any providers`. Pass `--profile <name>` to
give the function an identity, or `--assume-role <arn>` to run it as its
deployed execution role.

#### `local start-service`, `local start-alb`, `local start-cloudfront`, `local start-agentcore`

These four hand the run to the local emulation engine, which builds its own
AWS clients from the region and the `--profile` flag alone. With `--role-arn`
set and no profile selected, anything the engine resolves for your workload is
resolved as the role. The cases below have been confirmed; treat the rule as
wider than the table.

| What reaches the role | On | Prevented by |
| --- | --- | --- |
| The role's credentials are copied into the container, so your code runs as the role | `start-alb`, `start-cloudfront`, `start-agentcore` | The `--profile` flag only |
| ECS task secrets are fetched as the role and injected into the container's environment | `start-service`, `start-alb` | `--profile`, or an exported `AWS_PROFILE` |
| `${AWS::AccountId}` resolves to the role's account in environment variables, secret references and image URIs | `start-service`, `start-alb`, `start-agentcore` | `--profile`, or an exported `AWS_PROFILE` |
| `--from-cfn-stack` reads the stack as the role, decrypted parameters included | All four | `--profile`, or an exported `AWS_PROFILE` |
| A role named by `--assume-role` or `--assume-task-role` is assumed by the `--role-arn` role | All four, when that flag is passed | `--profile`, or an exported `AWS_PROFILE` |

Notes on the table:

- On `start-cloudfront`, the `--from-cfn-stack` row also covers a deployed S3
  origin's objects and KeyValueStore entries.
- `start-service`'s ECS workload containers are not in the first row. They get
  credentials from a metadata sidecar seeded from `--profile` alone.
- `--from-state` is cdkd's own state read and is not affected on any command.

Each of the four prints a warning at startup when `--role-arn` or
`CDKD_ROLE_ARN` is set without the `--profile` flag, naming the rows that
apply. With only an exported `AWS_PROFILE` it names the first row, and
`start-service`, which has no such row, prints nothing.

> [!WARNING]
> When you pass `--role-arn` to one of these four commands, pass the
> `--profile` flag with it. Otherwise assume the code in the container can use
> every permission the role has.

## `--region` / `AWS_REGION` (every command)

Choose the region with `AWS_REGION` or your AWS profile.

```bash
AWS_REGION=us-west-2 cdkd deploy MyStack
cdkd deploy MyStack --profile staging     # the profile's region
```

`--region` is deprecated on every command except `cdkd bootstrap` and
`cdkd gc`, where it names the region to act on. Elsewhere it is hidden from
`--help`, prints a deprecation warning and will be removed in a future release.
Until then it still works and outranks the environment variable and the
profile.

### Resolution order

| Commands | Order, first match wins |
| --- | --- |
| `cdkd bootstrap`, `cdkd bootstrap --destroy`, `cdkd gc` | `--region`, `AWS_REGION`, `AWS_DEFAULT_REGION`, the profile's region, `us-east-1` |
| `cdkd local` commands | Per command. Each command's page gives its chain. |
| Every other command | `--region`, `AWS_REGION`, `us-east-1` |

The first row's three commands share one chain because `cdkd bootstrap` writes
the per-region marker that the other two read.

### An inferred region yields to existing asset storage

On the three bootstrap-family commands, a region cdkd inferred from your
profile gives way to asset storage that already exists, so a bare command does
not strand it. A region you name is always used as given.

| Your profile | Existing asset storage | cdkd uses |
| --- | --- | --- |
| `ap-northeast-1` | Marker in `ap-northeast-1` | `ap-northeast-1` |
| `eu-west-1` | Marker only in `us-east-1` | `us-east-1`, and says so |
| `eu-west-1` | None anywhere | `eu-west-1` |

The second row prints:

```text
cdkd asset storage exists in us-east-1, but your AWS profile resolves eu-west-1.
Continuing to use us-east-1 so the existing storage is not orphaned. Pass
'--region eu-west-1' to target your profile's region, or '--region us-east-1'
to silence this message.
```

### Region spelling is lower-cased

cdkd lower-cases a region before it reaches an AWS client, so
`AWS_REGION=US-EAST-1` behaves as `us-east-1`. Request signing, endpoint
resolution and ARNs are all case-sensitive, and an upper-cased region breaks
each of them.

| Command | What is lower-cased |
| --- | --- |
| Every command outside `cdkd local` | `--region`, `AWS_REGION` and `AWS_DEFAULT_REGION` |
| `local invoke`, `local run-task`, `local invoke-agentcore` | The flag and both environment variables |
| `local start-api` | The flag only. An upper-cased `AWS_REGION` reaches the Lambda containers it starts. |
| `local start-service`, `local start-alb`, `local start-cloudfront`, `local start-agentcore` | The flag, `--stack-region` and both environment variables |

On the last row, your exact `--stack-region` spelling is still used to match
the state record.

One value keeps the spelling you typed: the region `cdkd bootstrap` builds its
marker key and default asset-storage names from. Commands that read the marker
try the lower-case key first and your spelling second, so a marker written
under either is found. [`cdkd gc`](cli-gc.md) and
[`cdkd bootstrap --destroy`](cli-bootstrap.md#teardown-cdkd-bootstrap-destroy)
describe their own reads.

## Output streams: when stdout is a payload

Five commands write a machine-readable document to stdout in every mode, and
send everything else to stderr. No flag is needed.

| Command | What stdout carries |
| --- | --- |
| `cdkd synth` | The selected stack's CloudFormation template, or nothing. See [`cdkd synth`](cli-synth.md#the-stdout-contract). |
| `cdkd list` | The stack listing: one id per line, YAML under `--long` / `--show-dependencies`, JSON under `--json`. |
| `cdkd state list` | The state records: one `Stack (region)` per line, JSON under `--json`. |
| `cdkd local invoke` | The function's response payload. |
| `cdkd local invoke-agentcore` | The agent's response, buffered or streamed frame by frame. |

```bash
cdkd synth MyStack > template.yaml 2> progress.log
cdkd synth MyStack | yq '.Resources | keys'
cdkd list --long --json | jq -r '.[].name'
cdkd state list | while read -r ref; do echo "state for: $ref"; done
cdkd local invoke MyStack/Handler --event event.json | tail -1 | jq .body
```

On these commands, progress lines such as `Synthesizing CDK app...`, the CDK
app's own stderr and `--verbose` output all go to stderr. A terminal shows the
same text as before, and `2>&1` merges the streams again.

### Which commands reserve stdout

| Command | When stdout carries only the payload |
| --- | --- |
| `cdkd synth`, `cdkd list`, `cdkd state list`, `cdkd local invoke`, `cdkd local invoke-agentcore` | Always |
| `cdkd state resources`, `cdkd state show`, `cdkd state info`, `cdkd drift`, `cdkd events` | Under `--json` only |
| `cdkd deploy`, and the `cdkd local` servers (`start-api`, `run-task`, `start-service`, `start-agentcore`, `start-alb`, `start-cloudfront`) | Never. stdout is the progress display, the route table, or container logs. |

Without `--json`, the middle row's commands print a formatted view for a
person, and their progress lines stay on stdout with it.

`cdkd state list --long` and `--tree` are formatted views too. They still
write the view to stdout, and cdkd's progress lines go to stderr as on the
plain listing.

### Container-image builds print on stdout

For a container-image Lambda, or an AgentCore runtime cdkd builds,
`cdkd local invoke` and `cdkd local invoke-agentcore` print
`Building container image (platform=...)` and `Skipping docker build ...` on
stdout. The payload is then the last stdout line, which is why the example
above uses `tail -1`.

The container's own output is not affected. The Lambda runtime emulator's
`START`, `END` and `REPORT` lines and every handler log line go to stderr.

## Exit codes

| Exit | Meaning |
| --- | --- |
| `0` | Success. The command completed and no resource is in an error state. |
| `1` | The command failed: an auth error, bad arguments, a synthesis crash, or any other error. |
| `2` | Partial failure. Work completed, but a resource failed, was skipped, or was only partially compared. State is kept, and running again usually resolves it. |
| `3` | `cdkd diff` only: the deploy it previews would refuse to start. Running again changes nothing until you fix what it named. |
| `70` | cdkd stopped on an internal error, most likely a bug, and printed a message saying so. |
| `130` | `cdkd local` only: interrupted with {kbd:ctrl+c}. |

Notes on individual codes:

- **`1` as a result.** `cdkd drift` exits `1` when it finds drift, including a
  resource deleted outside cdkd. `cdkd diff --fail-on any-change` (or `--fail`)
  exits `1` on any change, and `--fail-on destructive` on a change that
  replaces, deletes or orphans a resource.
- **`3`.** The full preview is printed first, with the reasons under a
  `Blocking (cdkd deploy will refuse):` heading. It is separate from `--fail`,
  so a CI job can tell "there is work to do" from "the work cannot begin".
  [Exit 3](cli-diff.md#exit-3-the-deploy-would-refuse) lists the conditions.
- **`70`.** It replaces any code the command had set. A stack lock may still be
  held. It expires at its TTL, or you can release it with
  [`cdkd force-unlock`](cli-force-unlock.md) once nothing else is working on
  the stack.
- **`130`.** `local start-service` and `local start-alb` also exit `130` on
  SIGTERM. `local start-api`, `local start-cloudfront` and
  `local start-agentcore` exit `0` there.
- **`cdkd local run-task`** exits with its essential container's own exit code.
  A container that exits 70 therefore yields 70 without the internal-error
  message.

Each command's page has its own table, and
[Local Execution](local-emulation.md) links to the `cdkd local` ones.

### What exit `2` means per command

| Command | The partial-failure case |
| --- | --- |
| `cdkd destroy`, `cdkd state destroy` | A resource delete failed, or a delete was skipped. |
| `cdkd deploy` | A resource was left unaddressed: a skipped delete, a replacement's surviving predecessor, or a resource a failed create made whose delete then failed. |
| `cdkd publish-assets` | One or more stacks' assets failed to publish. |
| `cdkd rollback` | An operation failed or was skipped, or a reverted operation left an untracked resource or was not fully reversed. |
| `cdkd state refresh-observed` | A read-back failed, or AWS reports the resource as not found. Those resources keep their previous baseline. |
| `cdkd drift` | Nothing drifted, but at least one comparison did not happen for a reason you can act on. |

More on each:

- `cdkd deploy` exits `0` in that case under
  [`--allow-unaddressed`](cli-deploy-safety.md#allow-unaddressed-deploy).
- A skipped delete is one cdkd did not confirm, so the resource may still
  exist and still be billing.
  [Skipped resources on destroy](cli-destroy.md#skipped-resources-on-destroy)
  has the causes and remedies.
- `cdkd rollback` keeps its journal when an operation fails, so the run can be
  repeated. [`cdkd rollback`](cli-rollback.md) lists what it records.
- For `cdkd drift`, whether running again clears the code depends on the
  cause. With `--accept` or `--revert`, exit `2` also means the run refused a
  resource deleted outside cdkd, or left one not reverted. See
  [`cdkd drift`](cli-drift.md).

A script that treats any non-zero exit from `cdkd destroy` as a hard failure
can branch on `2` to schedule a retry.

### The summary line at exit `2`

The per-stack summary line changes with the exit code. On destroy:

```text
✓ Stack MyStack destroyed (12 deleted, 0 errors)                 # exit 0
⚠ Stack MyStack partially destroyed (10 deleted, 2 errors). State preserved — re-run 'cdkd destroy' / 'cdkd state destroy' to clean up.   # exit 2
```

The warning line continues with advice for the failure. When deletes were
skipped and none failed, it reads `(N deleted, S skipped, 0 errors)` and says
that cdkd did not confirm the skipped resources were deleted.

On deploy:

```text
✓ Deployment completed successfully                              # exit 0
⚠ Stack MyStack deployed, but 1 resource(s) were left unaddressed — they may still exist in AWS. This counts toward a non-zero exit (2 unless something else fails; pass --allow-unaddressed to exit 0).   # exit 2
⚠ Stack MyStack deployed, but 1 resource(s) were left unaddressed — they may still exist in AWS. Exiting 0 because --allow-unaddressed was passed.   # exit 0
```

The second deploy line does not promise exit `2`. In a multi-stack run a later
stack can still fail, and a failure exits `1`.

## Startup compile cache

cdkd turns on Node.js's on-disk compile cache, so every run after the first
starts faster. An upgraded cdkd never runs stale cached code: each version
caches into its own subdirectory, and the first run of a new version deletes
the others.

| To | Do |
| --- | --- |
| Find the cache | Look in `$XDG_CACHE_HOME/cdkd/compile-cache`, or `~/.cache/cdkd/compile-cache`. |
| Turn it off | Set `NODE_DISABLE_COMPILE_CACHE=1`. |
| Keep it somewhere else | Set `NODE_COMPILE_CACHE=<directory>`. Pick a directory only you can write to. |

The cache is never placed in the shared OS temp directory, because cached code
in a directory other users can write to is not safe to load. A relative
`XDG_CACHE_HOME` is ignored. With no home directory, the cache stays off.

## Related

- [Getting Started](getting-started.md): a first deploy, start to finish
- [Core Concepts](concepts.md): what cdkd stores and how it decides what to change
- [Troubleshooting](troubleshooting.md): common failures, by symptom
- [Supported Resources](supported-resources.md): provider coverage by resource type
