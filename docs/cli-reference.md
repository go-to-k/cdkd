---
title: CLI Reference
description: "cdkd CLI reference overview — output streams, --region, --role-arn, exit codes, and the index of the per-command reference pages."
---

# CLI Reference

This is the hub for cdkd's CLI documentation. It indexes the per-command
reference pages and documents the behaviours that apply across every command:
which commands put a payload on stdout, how a region is resolved, how
`--role-arn` works, and what each exit code means. For the basic invocations,
see [Installation & Quick Start](getting-started.md).

## CLI reference pages

The detailed per-command / per-flag reference is split across these pages:

- **[Deploy: waits & concurrency](cli-deploy.md)** — the concurrency knobs,
  the per-resource-type wait-semantics table, and `--no-wait` / `--full-wait`.
- **[Deploy: tuning](cli-deploy-tuning.md)** — VPC route DependsOn relaxation,
  observed-state capture, name prefixing, per-resource timeouts, and CDK
  annotation messages.
- **[Deploy: safety & compatibility flags](cli-deploy-safety.md)** —
  `--allow-unsupported-types`, `--prefer-sdk-route`,
  `--recreate-via-cc-api`, `--replace`, `--recreate-via-sdk-provider`,
  `--strict-getatt`, `--allow-unaddressed`, and `--no-cfn-fallback`.
- **[Destroy flags & guards](cli-destroy.md)** — data guards,
  `DeletionPolicy: Snapshot`, `--remove-protection`, interrupting a destroy,
  confirmation prompts, and `--purge-events`.
- **[`cdkd bootstrap`](cli-bootstrap.md)** — provisioning the state bucket and
  per-region cdkd-owned asset storage.
- **[`cdkd gc`](cli-gc.md)** — garbage-collecting cdkd-owned storage.
- **[`cdkd list`](cli-list.md)** — listing the stacks an app synthesizes, and
  the patterns that select them.
- **[`cdkd synth`](cli-synth.md)** — synthesizing templates, the assembly
  directory, and CDK annotation handling.
- **[`cdkd diff`](cli-diff.md)** — previewing what a deploy would change.
- **[`cdkd drift`](cli-drift.md)** — detecting and resolving drift against live
  AWS resources.
- **[`cdkd rollback`](cli-rollback.md)** — reverting a failed deploy.
- **[`cdkd force-unlock`](cli-force-unlock.md)** — clearing a lock a crashed or
  cancelled run left behind.
- **[`cdkd export`](cli-export.md)** — handing a stack over to CloudFormation.
- **[`cdkd scrub`](cli-scrub.md)** — state secret hygiene (clean + audit).
- **[`cdkd publish-assets`](cli-publish-assets.md)** — synth + build + publish
  without deploying.
- **[`cdkd events`](cli-events.md)** — reading deployment-event history.
- **[`cdkd state`](cli-state.md)** — inspecting and operating on the S3
  state store directly, with no CDK app.

The sections below cover the cross-command behaviours: output streams,
`--region`, `--role-arn`, exit codes, and the `local *` command family.

## Output streams: when stdout is a payload

A `--json` flag is not what makes a stream a payload stream — it picks the
payload's *encoding*. Five commands write a machine-consumable document to
stdout with no flag involved, and each of them reserves stdout
unconditionally:

| Command | What stdout carries |
| --- | --- |
| `cdkd synth` | The CloudFormation template of the selected stack, or of the only stack when the app has one. |
| `cdkd list` | The stack listing in every mode: one display id per line by default, YAML under `--long` / `--show-dependencies`, JSON under `--json`. |
| `cdkd state list` | The state-record listing: one `Stack (region)` reference per line by default, JSON under `--json`. |
| `cdkd local invoke` | The function's response payload. |
| `cdkd local invoke-agentcore` | The agent's response — buffered, or streamed frame by frame under SSE / `--ws`. |

On those commands everything cdkd's own logger prints goes to **stderr**:
`Synthesizing CDK app...`, `cdkd synth`'s `Synthesis complete!` summary block,
`cdkd local invoke`'s `Target: ...` / `Starting container ...` lines, the CDK
app's re-emitted stderr, and `--verbose` debug output. The lines are **moved,
not suppressed** — a terminal shows what it always did, and `2>&1` restores the
single-stream view.

```bash
cdkd synth > template.yaml 2> progress.log
cdkd synth | yq '.Resources | keys'
cdkd list --long | yq '.[].name'
cdkd list | while read -r id; do echo "found stack: $id"; done
cdkd state list | while read -r ref; do echo "found state for: $ref"; done
cdkd local invoke MyStack/Handler --event e.json | tail -1 | jq .body
```

The `tail -1` on the last line is not decoration. For a target cdkd builds
as a container image, one thing on `cdkd local invoke` and
`cdkd local invoke-agentcore` still reaches stdout without passing through
cdkd's logger, so there the payload is the **last** stdout line rather than
the whole stream — see "Known limitations" below. The other three commands
need no such qualifier.

### Which commands reserve stdout, and which do not

The discriminator is the output's **shape**, not a flag: a line-oriented record
set is a payload, while a formatted human view — aligned columns, a rendered
tree, a metadata block — is not.

| Command | When stdout is reserved |
| --- | --- |
| `cdkd synth`, `cdkd list`, `cdkd state list`, `cdkd local invoke`, `cdkd local invoke-agentcore` | Always, in every mode. |
| `cdkd state resources`, `cdkd state show`, `cdkd state info`, `cdkd drift`, `cdkd events` | Under `--json` only — see below. |
| `cdkd deploy`, and the long-running `cdkd local` servers — `start-api`, `run-task`, `start-service`, `start-agentcore`, `start-alb`, `start-cloudfront` | Never. Their stdout is a human surface: the deploy banner and progress, the route table, task output, prefixed container logs. |

The middle row is gated on `--json` because those commands' flagless output is a
formatted human view with no record-set mode behind it. Reserving stdout there
would move an operator's prose off the stream they are reading it on.

`cdkd state list --long` and `--tree` are formatted views and are swept along:
the reservation is taken at command entry, before the mode is known, so those
two modes also send cdkd's logger prose to stderr. Both still write their view
to stdout, so only interleaved prose moves — to stderr, where an operator at a
terminal still sees it and where it stops corrupting a redirect to a file.

### `cdkd synth` on a multi-stack app

The template is emitted when the SELECTION is exactly one stack — name one
(`cdkd synth MyStack`), or let the app's only stack select itself. That matches
`cdk synth`. Selecting several leaves stdout empty and prints the ids you can
pass; the whole summary goes to stderr either way. stdout on `cdkd synth` is
one template or it is nothing, never two documents and never the summary. Use
`--output <dir>` and read the per-stack template files from the assembly
directory to get every stack's template at once.

### `cdkd synth`'s stdout parses back to the template

Quoting is handed to the `yaml` package — the library the AWS CDK CLI uses for
the same job — and every string scalar is checked against that library's own
parser under both a YAML 1.1 reader (which is what `yq` is) and a 1.2 one,
quoting anything that would not come back unchanged. Two visible consequences:

- **Scalars keep their type.** A number stays a number
  (`ExpirationInDays: 90`, not `"90"`) and a numeric string stays a string
  (`schemaVersion: "2.2"`). The document a parser hands back is deep-equal to
  the per-stack template JSON in the `--output` assembly directory.
- **The document starts at column 0.** `cdkd synth` does not open with a blank
  line, matching what `cdkd list --long` prints.

`cdkd list --long` / `--show-dependencies` render through the same renderer and
carry the same guarantee. One output detail worth knowing there: an AWS account
id is a string in the payload, so it is emitted quoted
(`account: "123456789012"`) and reads back as a string, matching what `--json`
returns.

### Known limitations

One thing on `cdkd local invoke` and `cdkd local invoke-agentcore` reaches
stdout without passing through cdkd's logger, so take the **last** line
(`cdkd local invoke ... | tail -1 | jq`) when it applies: **the container-image
build path.** For a container-image Lambda, and for an AgentCore runtime cdkd
builds, `Building container image (platform=...)` and `Skipping docker build
...` print on stdout rather than stderr.

The container's own stdout is not on that list: the Lambda runtime emulator's
`START` / `END` / `REPORT` lines and every handler log line go to stderr on
these two commands.

## `--region` / `AWS_REGION` (every command)

**Prefer `AWS_REGION` or your AWS profile.** `--region` is deprecated on cdkd's
own commands: it is hidden from `--help`, it prints a deprecation warning, and it
will be removed in a future release. It is not a no-op while it lasts — it still
outranks both the environment variable and the profile. That now holds on
**every** command: the four `cdkd local` long-running servers
(`start-service`, `start-alb`, `start-cloudfront`, `start-agentcore`) used to
carry their own visible, undeprecated `--region` inherited from the emulation
engine, and now carry the same hidden, warned flag as everywhere else. The flag
keeps working; it stopped appearing in those four `--help` outputs and started
printing the removal warning.

**A region is folded to its canonical lower-case spelling before it reaches an
AWS client.** `--region US-EAST-1`, `AWS_REGION=US-EAST-1` and
`AWS_DEFAULT_REGION=US-EAST-1` all behave exactly as `us-east-1` does.

The `cdkd local` family is where that is not yet uniform:

| Command | What is folded |
| --- | --- |
| `local invoke`, `local run-task`, `local invoke-agentcore` | The flag and both environment variables. |
| `local start-api` | The flag only, so an upper-cased `AWS_REGION` still reaches the Lambda containers it starts. |
| `local start-service`, `local start-alb`, `local start-cloudfront`, `local start-agentcore` | The flag, `--stack-region` and both environment variables. These four hand their whole option bag to the emulation engine, so the fold runs just before the handler rather than inside it; your exact `--stack-region` spelling is still kept for the state-record match. |

The fold is not cosmetic. Everything downstream of the value is case-sensitive,
and in different ways:

| Consumer | What a raw spelling does |
| --- | --- |
| SigV4 credential scope | `AuthorizationHeaderMalformed` (S3), `InvalidSignatureException` (Lambda / ECR), `SignatureDoesNotMatch` (STS) |
| SDK endpoint resolution | `CN-NORTH-1` resolves the **commercial** `amazonaws.com` instead of `amazonaws.com.cn` |
| ARN region segments | An ARN no IAM policy matches and every SDK call rejects |
| EC2 `region-name` filters | Matches nothing, so `Fn::GetAZs` returns an empty list |

### The bootstrap marker keeps your exact spelling

One value is deliberately not folded: the region `cdkd bootstrap` keys its
**marker** off, and with it the asset bucket / ECR repo names it creates. That
value stays verbatim because the marker read that looks for an existing marker
is paired with the marker write, and both must use the same spelling or a
recorded custom asset name stops being reused. The AWS clients `cdkd bootstrap`
builds *are* folded.

The marker reads on the teardown and deploy paths therefore try the canonical
key first and the spelling you passed second, so a marker written under a raw
key is still found. `cdkd bootstrap`'s own existing-marker read is the
exception: it reads the single raw key it is about to write, because that read
and that write are one pair. [`cdkd gc`](cli-gc.md) and
[`cdkd bootstrap --destroy`](cli-bootstrap.md#teardown-cdkd-bootstrap-destroy)
describe the marker reads on their own paths.

### Resolution order

`--region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → **the region your AWS
profile resolves** → `us-east-1`.

The AWS JS SDK does not read `AWS_DEFAULT_REGION` on its own; the AWS CLI does,
so cdkd reads it too and stays in step with a CLI command you just ran.

The last three steps — `AWS_DEFAULT_REGION`, the profile, and the `us-east-1`
fallback — apply to the **bootstrap-marker family**: `cdkd bootstrap`,
`cdkd gc`, and `cdkd bootstrap --destroy`. These three move together because one
writes the key the other two read. Every other command resolves `--region` →
`AWS_REGION` and falls back to the `us-east-1` literal.

The `cdkd local` family resolves its region per command; each command's page
gives its own chain.

### The reconciliation

Changing what a bare command targets could strand storage you already have, so
an **inferred** region yields to what exists:

| Your profile | Existing opt-in | cdkd uses |
| --- | --- | --- |
| `ap-northeast-1` | Marker in `ap-northeast-1` | `ap-northeast-1` |
| `eu-west-1` | Marker only in `us-east-1` | `us-east-1`, and says so |
| `eu-west-1` | None anywhere | `eu-west-1` (nothing to strand) |

A region you **name** is always obeyed as given — `--region X` means operate on
X, never "guess what I meant" — and `--region` is the escape hatch in both
directions. The hold prints:

```text
cdkd asset storage exists in us-east-1, but your AWS profile resolves eu-west-1.
Continuing to use us-east-1 so the existing storage is not orphaned. Pass
'--region eu-west-1' to target your profile's region, or '--region us-east-1'
to silence this message.
```

## `--role-arn`

Assume a different IAM role for cdkd's AWS API calls. Equivalent env var:
`CDKD_ROLE_ARN`. The CLI flag takes precedence when both are set.

```bash
cdkd deploy --role-arn arn:aws:iam::123456789012:role/cdkd-deploy
# or
CDKD_ROLE_ARN=arn:aws:iam::123456789012:role/cdkd-deploy cdkd deploy
```

cdkd does an `STS AssumeRole` once at command start (1-hour session, session
name `cdkd-<unix-ms>`) and hands the resulting temporary credentials to every
AWS SDK client it builds afterwards, so the role is the identity behind every
call cdkd makes.

It also exports them as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN`, which is how a program cdkd *starts* — your CDK app during
synthesis, the local-emulation engine behind `cdkd local *` — picks the role up.
**That second channel works only while no profile is selected.** The AWS SDK
skips its environment-variable credentials entirely once `AWS_PROFILE` is set,
and cdkd leaves your profile in place on purpose (it is where the region and the
rest of your shared config come from). So with `--profile` — or an exported
`AWS_PROFILE` — those variables are inert for anything cdkd launches, and a
subprocess runs as the profile. Everything cdkd itself does still runs as the
role; the split is spelled out under
[`--profile` vs `--role-arn`](#profile-vs-role-arn) below, and cdkd warns
about it at the start of the run.

### What the assumed role needs

Unlike `cdk deploy`, **cdkd does not route through CloudFormation**. There is no
cfn-exec-role to delegate to. Every IAM / EC2 / Lambda / CloudFront / DynamoDB /
etc. API call is issued from cdkd directly, using whatever identity the SDK
default chain resolves to — which, when `--role-arn` is set, is the assumed
role.

So the role needs the actions for the resource types your stacks deploy, plus
cdkd's own bookkeeping set — the same permissions your own principal would have
needed, moved onto the role.
[Permission errors](troubleshooting.md#access-denied-error) has the policy to
start from. `AdministratorAccess` is not part of it; scope the role to the
services your stacks actually use.

That also means **CDK CLI's `cdk-hnb659fds-deploy-role-*` is not enough**:

| Role | Trust policy | Permissions | Works for cdkd? |
| --- | --- | --- | --- |
| `cdk-hnb659fds-deploy-role-*` | IAM principals | CFn + asset-publish only (no raw EC2 / Lambda / IAM) | **No** — permission-denied during provisioning |
| `cdk-hnb659fds-cfn-exec-role-*` | `Service: cloudformation.amazonaws.com` | Broad, for CloudFormation to use | **No** — only assumable by the CFn service, not by cdkd's IAM identity |
| A role you create for cdkd | IAM principals | The resource actions your stacks need + cdkd's bookkeeping set | **Yes** |

CDK CLI achieves "no local admin needed" through a two-step delegation (IAM
principal → deploy-role → CFn change set → cfn-exec-role). cdkd has no
analogous chain — what you grant the assumed role is what runs against AWS. The
`--role-arn` flag exists so CI runners with limited base credentials can drive a
cdkd deploy against a separate-account or dedicated deploy role; it does **not**
reduce the permissions the eventually-used identity needs — it moves them onto
the role.

### When the `--role-arn` session expires

The session is 1 hour. cdkd does not auto-refresh it. For a deploy that
genuinely takes longer, re-run the cdkd command — in-flight credentials remain
valid until expiry, so a re-run is the simplest recovery path.

### `--profile` vs `--role-arn`

`--profile` selects which entry from `~/.aws/credentials` or `~/.aws/config`
provides the **base** credentials; `--role-arn` then assumes a role from those
base credentials. They combine, and the division of labour is fixed:

| Flag | What it decides |
| --- | --- |
| `--profile` (or `AWS_PROFILE`) | Which credentials answer the `AssumeRole` call, and which shared-config settings — the region above all — apply |
| `--role-arn` (or `CDKD_ROLE_ARN`) | Which identity every AWS call after that runs as |

```bash
# `ci` authenticates the AssumeRole; the role in 222222222222 does the work.
cdkd deploy --profile ci --role-arn arn:aws:iam::222222222222:role/cdkd-deploy
```

So the role **wins** for credential purposes: once it is assumed, the profile no
longer selects the principal for any call cdkd makes, and neither does an
`AWS_PROFILE` you exported without passing the flag. What the profile still
needs is `sts:AssumeRole` on the target role, and the role's trust policy has to
allow the profile's principal.

One bound is worth knowing when you combine them, and cdkd warns about it at the
start of the run. A profile stays selected in the environment, because it is also
where the region and the rest of your shared config come from — and the AWS SDK
prefers a selected profile over exported credentials. cdkd's own calls are
unaffected (they carry the role explicitly), but your CDK app resolves the
profile when cdkd runs it during synthesis. Pass the region explicitly if you
want to drop `--profile` and rely on `--role-arn` alone.

**Your CDK app therefore sees two accounts at once, and they can differ.** cdkd
resolves `CDK_DEFAULT_ACCOUNT` with its own `sts:GetCallerIdentity`, which
carries the role — so an env-agnostic stack (`env` unset, or
`account: process.env.CDK_DEFAULT_ACCOUNT`) synthesizes for the **role's**
account, which is where it will be deployed and is what you want. But a context
lookup the app performs itself — `Vpc.fromLookup`, `HostedZone.fromLookup`,
`StringParameter.valueFromLookup` — runs on the app's own SDK chain, which
resolves the **profile**. Same-account use is unaffected. Cross-account, a
lookup either fails or silently answers from the wrong account, and the fix is
to drop `--profile` (pass `--region` and let `--role-arn` supply the identity
alone) or to hard-code `env` on the stack rather than looking it up.

The emulated function or task a `cdkd local *` command runs is a deliberate
exception, on **four** of the eight commands: `local invoke`, `local start-api`,
`local run-task` and `local invoke-agentcore`. On those, everything **cdkd**
resolves *for* the workload stays on your own identity — the credentials it is
given, any role it assumes on the container's behalf (`--assume-role` /
`--assume-task-role`), the ECS task secrets read into its environment, and the
`${AWS::AccountId}` substituted into it — so `--role-arn` cannot quietly hand
your local code more permission than you asked for. That holds however you
selected a profile, including not selecting one: cdkd captures your own
credentials before it assumes the role, and puts them back on the container's
environment afterwards. What cdkd does for *itself* still uses the role,
including reading state and pulling the container image (which leaves an ECR
login for the role's account in your Docker config).

Read "what cdkd resolves" strictly — the next section is what it excludes.

### What the local emulation engine resolves does NOT get that treatment

The guarantee above is about what **cdkd** resolves. A `cdkd local` command also
hands work to the local emulation engine, and the engine builds its own AWS
clients from the region and the `--profile` flag alone. It never sees the
opt-out cdkd applies to its own clients, so **anything the engine resolves for
your workload, while `--role-arn` is set and no profile is selected, it resolves
as the role.**

That is the rule to reason from; the table below is what has been measured
against it, not the set of everything it covers.

| What reaches the role | On | Prevented by |
| --- | --- | --- |
| The **credential triple** is copied into the container, so your code runs as the role | `start-alb` (its Lambda front-door containers), `start-cloudfront` (Function URL and Lambda@Edge containers), `start-agentcore` | the `--profile` **flag** only |
| The ECS task **secrets** are fetched with the role and injected as plaintext into the container's environment | `start-service`, `start-alb` | the `--profile` flag, or an exported `AWS_PROFILE` |
| `${AWS::AccountId}` resolves to the **role's** account, and is substituted into the container's environment variables, its secret references and its image URIs | `start-service`, `start-alb`, `start-agentcore` | the `--profile` flag, or an exported `AWS_PROFILE` |
| **`--from-cfn-stack`** reads the stack — including `GetParameters` with decryption, whose plaintext lands in the container's environment | **all eight commands** — the four the guarantee covers included | the `--profile` flag, or an exported `AWS_PROFILE` |

The last row is the one to read twice: the four commands the guarantee covers
are covered for what **cdkd** resolves, and `--from-cfn-stack` is the engine
resolving. `--from-state` is cdkd's own equivalent and is not affected.

Two more things worth knowing. `start-service`'s own ECS workload containers are
not in the first row — they receive credentials through the metadata sidecar,
which is seeded from `--profile` alone, so the triple never reaches them. And
the mitigations are not uniform: everywhere else in this section `--profile` and
an exported `AWS_PROFILE` behave the same, but the credential-triple row reads
the **flag** specifically and an exported `AWS_PROFILE` leaves it open.

cdkd emits no warning for any of this. On the first three rows the code path
that warns is one the engine does not take at all. On the last row, over the
four commands the guarantee covers, it does run — but it only warns when a
profile is selected, which is exactly the case that row is already mitigated in.

So when you pass `--role-arn` to any `cdkd local` command, pass the `--profile`
flag with it, or do not give it a role whose permissions you would not hand to
the code running in the container.

One case has nothing to put back. If your own credentials come from AWS IAM
Identity Center (SSO), an EC2 instance role, or an ECS container role, there is
no `AWS_ACCESS_KEY_ID` in your shell for cdkd to capture. Rather than let the
container inherit the assumed role, cdkd forwards **no** credentials at all —
the container falls back to whatever its own SDK chain finds, which for a plain
`cdkd local invoke` is nothing, and the handler's first AWS call fails with
`Could not load credentials from any providers`. Pass `--profile <name>` to give
the emulated function an identity (cdkd resolves the profile and mounts it for
the container), or `--assume-role <arn>` to run it as its deployed execution
role. A missing credential you can see beats a privileged one you cannot.

### If you were already combining them, three things move

cdkd used to publish an assumed role through the `AWS_*` environment variables
alone, which the SDK ignores whenever a profile is selected — so
`--profile` together with `--role-arn` ran every call as the *profile*. Now the
role wins, and for anyone who had that combination in a script, three things
change on the first run after upgrading. All three are the same correction seen
from different places: cdkd genuinely runs as the role now.

**1. The default state bucket follows the role's account.** cdkd derives
`cdkd-state-<accountId>` from the identity it runs as, so with both flags the
account is the **role's**. Your stacks' state is in the profile account's bucket
and cdkd will no longer find it — a deploy would create the stack again in the
role's account and leave the original resources behind. Copy the state into the
role account's bucket before the first run. Pointing `--state-bucket` back at
the profile account's bucket does **not** work: cdkd sends
`ExpectedBucketOwner` on every state call, so a bucket owned by a different
account is rejected.

**2. Cross-account `Fn::GetStackOutput` assumes the producer role AS the role.**
The `RoleArn` hop that reads another account's state used to be answered by the
profile's principal; it is now answered by the `--role-arn` role. The producer
role's trust policy has to name the **`--role-arn` role**, not your profile's
principal. Until it does, the first deploy that resolves such a reference fails
with `AssumeRole into <producer-role> failed: AccessDenied` — which names the
producer role and not the changed principal, so it is worth checking the trust
policy before you go looking elsewhere.
[Cross-Stack References](cross-stack-references.md) covers the feature;
[the cross-account section of the internals page](cross-stack-internals.md)
carries the policy documents.

**3. `CDK_DEFAULT_ACCOUNT` becomes the role's account.** An env-agnostic stack
now synthesizes for the account it is actually deployed into, which is the
point — but the CDK app's own context lookups still resolve your profile, so a
cross-account run can synthesize for one account while `Vpc.fromLookup` reads
another. The paragraph under
[`--profile` vs `--role-arn`](#profile-vs-role-arn) has the detail and the two
ways out.

## Exit codes

cdkd commands distinguish four outcomes via the process exit code, so CI and
bench scripts can react without grepping log output:

| Exit | Meaning |
| --- | --- |
| `0` | Success — the command completed and no resource is in an error state. |
| `1` | Command-level failure — auth error, bad arguments, synth crash, unhandled exception. The default for any thrown error. |
| `2` | Partial failure — work completed, but one or more resources failed, were skipped, or were only partially compared. State is preserved and re-running typically resolves it. |
| `3` | The command completed and reported that the operation it previews **cannot start**. Unlike `2`, re-running changes nothing until a person resolves what it named. Used only by `cdkd diff` today. |

Two commands use `1` for a non-crash outcome, because there the operative
meaning is "non-zero result", not "the command crashed":

- **`cdkd drift` exits `1` when drift is detected.**
- **`cdkd diff --fail` exits `1` when any change is detected.**

`cdkd diff` also exits **`3`** when it finds a condition that would make
`cdkd deploy` refuse to start — a rollback-orphaned resource whose physical
name another cdkd stack already records, or a state record container this
preview repaired or dropped and the deploy refuses (a resource `properties`
map, the `outputs` bag, the `resources` map or one of its entries, the
`orphans` field or one of its records), or a rollback-orphan record the preview
keeps whose `properties` or `attributes` map the deploy refuses, or a resource
whose `Type` changes into or out of `AWS::CloudFormation::Stack` — the second and
third of those only on the stack you named, not on a nested child (see
[docs/cli-diff.md](cli-diff.md#exit-3-the-deploy-would-refuse)). The full preview is printed
first, with the reasons under a `Blocking (cdkd deploy will refuse):` heading;
the exit code is separate from `--fail` on purpose, so a CI job that gates on
drift does not report the same code for "there is work to do" and "the work
cannot begin".

The `cdkd local` family adds two codes of its own:

| Exit | Meaning |
| --- | --- |
| `130` | Interrupted by `^C`, on every `cdkd local` command. `local start-service` and `local start-alb` also exit `130` on SIGTERM, because they bind it to the same handler; `local start-api`, `local start-cloudfront` and `local start-agentcore` exit `0` there. |
| `N` | `cdkd local run-task` propagates its essential container's own exit code. |

Per-command detail is on each command's page under
[Local Execution](local-emulation.md).

Exit `2` is carried by the error itself rather than decided by the command that
catches it, so an intermediate handler re-throwing a partial failure cannot
collapse it into the general `1` bucket.

### What exit `2` means per command

| Command | The partial-failure case |
| --- | --- |
| `cdkd destroy`, `cdkd state destroy` | Per-resource delete failures, and per-resource **skips**. |
| `cdkd deploy` | Resources left **unaddressed** — a skipped DELETE, or a replacement's surviving predecessor. Suppressible with `--allow-unaddressed`. |
| `cdkd state refresh-observed` | Per-resource read-back failures; the affected resources keep their previous baseline. |
| `cdkd publish-assets` | Per-stack asset publish failures. |
| `cdkd rollback` | Per-op failures, or ops skipped with a warning. The journal is kept so the run can be repeated. |
| `cdkd drift` | Nothing drifted, but at least one comparison did not happen for a reason you can act on — cdkd **refused to compare** a secret-bearing property, a read failed, an import refused a baseline, a recorded baseline holds a mask cdkd could not certify, or a state row is unreadable. |

For `cdkd drift`, whether re-running clears it depends on the cause — a refused
comparison needs the reference spelled as a full ARN, for instance. See [`cdkd drift`](cli-drift.md).

### The summary line at exit `2`

When exit `2` is emitted, the per-stack summary line in the run log switches
glyphs:

```text
✓ Stack X destroyed (N deleted, 0 errors)                       # exit 0
⚠ Stack X partially destroyed (N deleted, M errors). State preserved — re-run 'cdkd destroy' / 'cdkd state destroy' to clean up.   # exit 2
⚠ Stack X partially destroyed (N deleted, S skipped, 0 errors). cdkd could not address the skipped resource(s) ...   # exit 2
```

`cdkd deploy` switches the same way — a run that left a resource unaddressed
does not claim to have completed successfully:

```text
✓ Deployment completed successfully                                                  # exit 0
⚠ Stack X deployed, but N resource(s) were left unaddressed — they may still exist in AWS. This counts toward a non-zero exit (2 unless something else fails; pass --allow-unaddressed to exit 0).   # exit 2
⚠ Stack X deployed, but N resource(s) were left unaddressed — they may still exist in AWS. Exiting 0 because --allow-unaddressed was passed.               # exit 0
```

The second line does not promise exit `2`: in a multi-stack run a later stack
can still fail, and a real failure takes precedence with exit `1`.

The warning is printed in both cases where a resource survived — the second and
third lines above; only the exit code differs between them. See
[`--allow-unaddressed` (deploy)](cli-deploy-safety.md#allow-unaddressed-deploy)
for which two cases produce it and how they differ in recoverability.

A CI or bench script that treats any non-zero from `cdkd destroy` as a hard
failure may want to branch on `2` separately, to schedule a retry rather than
page someone.

### Skipped resources on destroy

A skipped resource is one cdkd could not address, so it may still exist and
still be billing. What causes a skip, what each command does with one, and
how to clear it are on
[Skipped resources on destroy](cli-destroy.md#skipped-resources-on-destroy).

## `local *` (run AWS workloads locally)

The `cdkd local` command family runs AWS workloads on the developer's machine —
Lambda functions, API Gateway routes, ECS tasks, ECS Services, ALB front-doors,
CloudFront distributions, and Bedrock AgentCore Runtimes — without an AWS
deploy. Most commands run the workload in Docker; `local start-cloudfront`
serves a CloudFront-Functions + S3-origin distribution in-process (no Docker),
and reaches for Docker/RIE only when the distribution has a Lambda Function URL
origin or a Lambda@Edge association.

The full reference for all `cdkd local *` subcommands (`local invoke` /
`local start-api` / `local run-task` / `local start-service` / `local start-alb` /
`local start-cloudfront` / `local invoke-agentcore` / `local start-agentcore`)
lives in **[Local Execution](local-emulation.md)**.

## Related

- [Installation & Quick Start](getting-started.md) — the basic invocations
- [Core Concepts](concepts.md) — what cdkd stores and how it decides what to change
- [Troubleshooting](troubleshooting.md) — symptom-first index of common failures
- [Supported Resources](supported-resources.md) — per-type provider coverage
