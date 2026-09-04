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
  `--allow-unsupported-types`, `--allow-unsupported-properties`,
  `--recreate-via-cc-api`, `--replace`, `--recreate-via-sdk-provider`,
  `--strict-getatt`, `--allow-unaddressed`, and `--no-cfn-fallback`.
- **[Destroy flags & guards](cli-destroy.md)** — data guards,
  `DeletionPolicy: Snapshot`, `--remove-protection`, interrupting a destroy,
  confirmation prompts, and `--purge-events`.
- **[`cdkd bootstrap`](cli-bootstrap.md)** — provisioning the state bucket and
  per-region cdkd-owned asset storage.
- **[`cdkd gc`](cli-gc.md)** — garbage-collecting cdkd-owned storage.
- **[`cdkd diff`](cli-diff.md)** — previewing what a deploy would change.
- **[`cdkd drift`](cli-drift.md)** — detecting and resolving drift against live
  AWS resources.
- **[`cdkd rollback`](cli-rollback.md)** — reverting a failed deploy.
- **[`cdkd export`](cli-export.md)** — handing a stack over to CloudFormation.
- **[`cdkd scrub`](cli-scrub.md)** — state secret hygiene (clean + audit).
- **[`cdkd publish-assets`](cli-publish-assets.md)** — synth + build + publish
  without deploying.
- **[`cdkd events`](cli-events.md)** — reading deployment-event history.

The sections below cover the cross-command behaviours: output streams,
`--region`, `--role-arn`, exit codes, and the `local *` command family.

## Output streams: when stdout is a payload

A `--json` flag is not what makes a stream a payload stream — it picks the
payload's *encoding*. Five commands write a machine-consumable document to
stdout with no flag involved, and each of them reserves stdout
unconditionally:

| Command | What stdout carries |
| --- | --- |
| `cdkd synth` | The CloudFormation template — single-stack apps only. |
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

The `tail -1` on the last line is not decoration. Two things on
`cdkd local invoke` and `cdkd local invoke-agentcore` still reach stdout
without passing through cdkd's logger, so on those two commands the payload is
the **last** stdout line rather than the whole stream — see "Known
limitations" below. The other three commands need no such qualifier.

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

The template is emitted only when the app has exactly one stack, matching
`cdk synth`. With several stacks, stdout is empty and the whole summary goes to
stderr. stdout on `cdkd synth` is the template or it is nothing; the summary is
never a payload. Use `--output <dir>` and read the per-stack template files from
the assembly directory to get every stack's template.

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

Two things on `cdkd local invoke` and `cdkd local invoke-agentcore` reach stdout
without passing through cdkd's logger, so take the **last** line
(`cdkd local invoke ... | tail -1 | jq`):

1. **The container's own stdout.** The Lambda runtime emulator puts `START` /
   `END` / `REPORT` *and* every handler log line — `console.error` included —
   on the container's stdout, so any handler that prints lands ahead of the
   response.
2. **cdk-local's own logger.** cdkd reuses cdk-local for the container-image
   build path, and cdk-local has a separate logger with no reservation concept,
   so `Building container image (platform=...)` and `Skipping docker build ...`
   print on stdout for a container-image Lambda.

## `--region` / `AWS_REGION` (every command)

**Prefer `AWS_REGION` or your AWS profile.** `--region` is deprecated on cdkd's
own commands: it is hidden from `--help`, it prints a deprecation warning, and it
will be removed in a future release. It is not a no-op while it lasts — it still
outranks both the environment variable and the profile. The `cdkd local`
long-running servers (`start-service`, `start-alb`, `start-cloudfront`,
`start-agentcore`) are the exception: they carry their own `--region`, which is
neither hidden nor deprecated.

**A region is folded to its canonical lower-case spelling before it reaches an
AWS client.** `--region US-EAST-1`, `AWS_REGION=US-EAST-1` and
`AWS_DEFAULT_REGION=US-EAST-1` all behave exactly as `us-east-1` does.

The `cdkd local` family is where that is not yet uniform:

| Command | What is folded |
| --- | --- |
| `local invoke`, `local run-task`, `local invoke-agentcore` | The flag and both environment variables. |
| `local start-api` | The flag only, so an upper-cased `AWS_REGION` still reaches the Lambda containers it starts. |
| `local start-service`, `local start-alb`, `local start-cloudfront`, `local start-agentcore` | Neither. The `--from-state` state read folds `--region` and `--stack-region` for its own S3 client, but nothing folds the environment variables. Spell the region lower-case on these four. |

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
name `cdkd-<unix-ms>`) and writes the resulting temporary credentials into
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`, so every
later AWS SDK client picks them up via the standard default credentials chain.

### Why the assumed role must have admin-equivalent permissions

Unlike `cdk deploy`, **cdkd does not route through CloudFormation**. There is no
cfn-exec-role to delegate to. Every IAM / EC2 / Lambda / CloudFront / DynamoDB /
etc. API call is issued from cdkd directly, using whatever identity the SDK
default chain resolves to — which, when `--role-arn` is set, is the assumed
role.

That means **CDK CLI's `cdk-hnb659fds-deploy-role-*` is not enough**:

| Role | Trust policy | Permissions | Works for cdkd? |
| --- | --- | --- | --- |
| `cdk-hnb659fds-deploy-role-*` | IAM principals | CFn + asset-publish only (no raw EC2 / Lambda / IAM) | **No** — permission-denied during provisioning |
| `cdk-hnb659fds-cfn-exec-role-*` | `Service: cloudformation.amazonaws.com` | Admin-equivalent | **No** — only assumable by the CFn service, not by cdkd's IAM identity |
| Custom admin-equivalent role | IAM principals | Admin-equivalent on the resources you deploy | **Yes** |

CDK CLI achieves "no local admin needed" through a two-step delegation (IAM
principal → deploy-role → CFn change set → cfn-exec-role's admin). cdkd has no
analogous chain — what you grant the assumed role is what runs against AWS. The
`--role-arn` flag exists so CI runners with limited base credentials can drive a
cdkd deploy against a separate-account or higher-privilege role; it does **not**
reduce the permissions the eventually-used identity needs.

### When the `--role-arn` session expires

The session is 1 hour. cdkd does not auto-refresh it. For a deploy that
genuinely takes longer, re-run the cdkd command — in-flight credentials remain
valid until expiry, so a re-run is the simplest recovery path.

### `--profile` vs `--role-arn`

Independent. `--profile` selects which entry from `~/.aws/credentials` or
`~/.aws/config` provides the **base** credentials; `--role-arn` then assumes a
role from those base credentials. Use both together when the IAM principal lives
in profile A and the deploy role lives in account B that profile A trusts.

## Exit codes

cdkd commands distinguish three outcomes via the process exit code, so CI and
bench scripts can react without grepping log output:

| Exit | Meaning |
| --- | --- |
| `0` | Success — the command completed and no resource is in an error state. |
| `1` | Command-level failure — auth error, bad arguments, synth crash, unhandled exception. The default for any thrown error. |
| `2` | Partial failure — work completed, but one or more resources failed, were skipped, or were only partially compared. State is preserved and re-running typically resolves it. |

Two commands use `1` for a non-crash outcome, because there the operative
meaning is "non-zero result", not "the command crashed":

- **`cdkd drift` exits `1` when drift is detected.**
- **`cdkd diff --fail` exits `1` when any change is detected.**

The `cdkd local` family adds two codes of its own:

| Exit | Meaning |
| --- | --- |
| `130` | Interrupted by `^C`, on every `cdkd local` command. `local start-service` and `local start-alb` also exit `130` on SIGTERM, because they bind it to the same handler; the other servers exit `0` there. |
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
| `cdkd publish-assets` | Per-stack asset publish failures. |
| `cdkd rollback` | Per-op failures, or ops skipped with a warning. The journal is kept so the run can be repeated. |
| `cdkd drift` | Nothing drifted, but cdkd **refused to compare** a secret-bearing property. |

The `cdkd drift` case is the one re-running does not clear — spelling the
reference as a full ARN does. See [`cdkd drift`](cli-drift.md).

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
