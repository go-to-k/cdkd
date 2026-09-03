---
title: CLI Reference
description: "cdkd CLI reference overview — output streams, --region, --role-arn, exit codes, and the index of the per-command reference pages."
---

# cdkd CLI Reference

This document covers cdkd-specific CLI flags that need more detail than
fits in the README. For the basic command invocations (`deploy`, `diff`,
`destroy`, `synth`, `list`, `state`, etc.), see
[Installation & Quick Start](getting-started.md).

## CLI reference pages

The detailed per-command / per-flag reference is split across these pages:

- **[Deploy: waits & concurrency](cli-deploy.md)** — the concurrency
  knobs, the per-resource-type wait-semantics table, and `--no-wait` /
  `--full-wait`.
- **[Deploy: tuning](cli-deploy-tuning.md)** — VPC route DependsOn
  relaxation, observed-state capture, name prefixing, per-resource
  timeouts, and CDK annotation messages.
- **[Deploy: safety & compatibility flags](cli-deploy-safety.md)** —
  `--allow-unsupported-types`, `--allow-unsupported-properties`,
  `--recreate-via-cc-api`, `--replace`, `--recreate-via-sdk-provider`,
  `--strict-getatt`, `--allow-unaddressed`, and `--no-cfn-fallback`.
- **[cdkd bootstrap](cli-bootstrap.md)** — provisioning the state bucket
  and per-region cdkd-owned asset storage.
- **[cdkd gc](cli-gc.md)** — garbage-collecting cdkd-owned storage.
- **[cdkd diff](cli-diff.md)** — previewing what a deploy would change.
- **[cdkd drift](cli-drift.md)** — detecting and resolving drift against
  live AWS resources.
- **[Destroy flags & guards](cli-destroy.md)** — data guards,
  `DeletionPolicy: Snapshot`, `--remove-protection`, interrupting a
  destroy, confirmation prompts, and `--purge-events`.
- **[cdkd rollback](cli-rollback.md)** — reverting a failed deploy.
- **[cdkd export](cli-export.md)** — handing a stack over to CloudFormation.
- **[cdkd scrub](cli-scrub.md)** — state secret hygiene (clean + audit).
- **[publish-assets](cli-publish-assets.md)** — synth + build + publish
  without deploying.
- **[events](cli-events.md)** — reading deployment-event history.

The sections below cover the cross-command behaviors that apply everywhere:
output streams, `--region`, `--role-arn`, exit codes, and the `local *`
command family pointer.

## Output streams: when stdout is a payload

A `--json` flag was never what made a stream a payload stream -- it picks the
payload's ENCODING. Five commands write a machine-consumable document to stdout
with no flag involved, and each reserves stdout
UNCONDITIONALLY — their DEFAULT output contract is the one that changed:

| Command | What stdout carries |
| --- | --- |
| `cdkd synth` | the CloudFormation template (single stack only -- see below) |
| `cdkd list` | the stack listing in EVERY mode: one display id per line by default, YAML under `--long` / `--show-dependencies`, JSON under `--json` |
| `cdkd state list` | the state-record listing: one `Stack (region)` reference per line by default, JSON under `--json` (`--long` / `--tree` are human views swept along -- see below) |
| `cdkd local invoke` | the function's response payload |
| `cdkd local invoke-agentcore` | the agent's response (buffered, or streamed frame by frame under SSE / `--ws`) |

**The discriminator is the output's SHAPE, not the flag**: a line-oriented
RECORD SET is a payload; a formatted human VIEW -- aligned columns, a rendered
tree, a metadata block -- is not. That is why the other three `cdkd state`
subcommands with a `--json` mode (`state resources`, `state show`,
`state info`) keep the `--json` gate: their flagless output is a formatted view
with no record-set mode behind it, so reserving stdout there would move an
operator's prose off the stream they are already reading it on for no
consumer's benefit.

Everything **cdkd's own logger** prints on those commands -- `Synthesizing
CDK app...`, `cdkd synth`'s `Synthesis complete!` summary block, `cdkd local
invoke`'s `Target: ...` / `Starting container ...` lines, the CDK app's
re-emitted stderr, and its `--verbose` debug output -- goes to **stderr**.
Two things on the two `cdkd local` commands are NOT cdkd's logger and still
reach stdout; they are listed under "known residuals" below. As with `--json`, the lines are
**moved, not suppressed**: a terminal shows what it always did, and `2>&1`
restores the old single-stream view.

```bash
cdkd synth > template.yaml 2> progress.log
cdkd synth | yq '.Resources | keys'
cdkd list --long | yq '.[].name'
cdkd list | while read -r id; do echo "found stack: $id"; done
cdkd state list | while read -r ref; do echo "found state for: $ref"; done
cdkd local invoke MyStack/Handler --event e.json | tail -1 | jq .body
```

The `tail -1` on the last line is not decoration: two things on
`cdkd local invoke` still reach stdout without passing through cdkd's logger,
so its payload is the LAST stdout line rather than the whole stream. They are
listed under "known residuals" below, and the same applies to
`cdkd local invoke-agentcore`. The other three commands need no such
qualifier.

Four consequences worth stating explicitly:

- **`cdkd synth` on a MULTI-stack app writes nothing to stdout.** The template
  is emitted only when the app has exactly one stack (matching `cdk synth`), so
  with several stacks stdout is empty and the whole summary goes to stderr.
  stdout on `cdkd synth` is the template or it is nothing; the summary is never
  a payload. Use `--output <dir>` and read the per-stack template files from the
  assembly directory to get every stack's template.
- **Known residuals on `cdkd local invoke` / `invoke-agentcore`: two things
  still reach stdout**, because neither passes through cdkd's logger.
  **Until they are fixed, take the LAST line**
  (`cdkd local invoke ... | tail -1 | jq`), which is what cdkd's own integ
  fixtures do:
  1. **The container's own stdout**, piped through by `streamLogs`. The Lambda
     runtime emulator puts `START` / `END` / `REPORT` *and* every handler log
     line -- `console.error` included -- on the container's stdout, so any
     handler that prints lands ahead of the response.
  2. **cdk-local's own logger.** cdkd reuses cdk-local for the container-image
     build path, and cdk-local has a SEPARATE logger with no reservation
     concept, so `Building container image (platform=...)` and `Skipping
     docker build ...` print on stdout for a container-image Lambda.

  A THIRD was listed here and is now FIXED, named
  rather than deleted so it is not reported again: `docker pull` progress
  reached stdout because the pull runs with the child inheriting cdkd's
  descriptors, and cdkd runs it unconditionally for an image pulled from ECR --
  so it needed no flag at all. While a reservation is held that child's stdout
  is redirected to stderr.
- **`cdkd state list --long` and `--tree` are formatted views, and they are
  swept along.** The reservation is taken at command entry, before the mode is
  known, so those two modes also send cdkd's logger prose to stderr even though
  their stdout is a human view rather than a record set. That is deliberate and
  costs nothing: both still write their view to stdout, so only interleaved
  prose moves -- to stderr, where an operator at a terminal still sees it and
  where it stops corrupting a redirect to a file. The alternative, a mode-aware
  condition, is exactly the flag-shaped gating this contract exists to remove.
- **`cdkd synth`'s stdout parses, and it parses back to the template.** This
  used to be the exception: the renderer left YAML indicator characters
  unquoted, so a template containing `"*"` -- any IAM policy `Resource` /
  `Action`, any CORS rule -- emitted a bare `- *` that a YAML parser rejects,
  and reserving stdout did not change it. This was fixed by handing the
  quoting to the `yaml` package -- the library the AWS CDK CLI uses for the
  same job -- and checking every string scalar against that library's own
  parser under BOTH a YAML 1.1 reader (which is what `yq` is) and a 1.2 one,
  quoting anything that would not come back unchanged. Two visible consequences, both
  of which make the output MATCH the template rather than diverge from it:
  - **Scalars keep their type.** A number stays a number (`ExpirationInDays:
    90`, not `"90"`) and a numeric string stays a string (`schemaVersion:
    "2.2"`). The document a parser hands back is now deep-equal to the
    per-stack template JSON in the `--output` assembly directory.
  - **The document starts at column 0.** `cdkd synth` no longer opens with a
    blank line, matching what `cdkd list --long` always printed -- the two
    consumers of one renderer used to disagree about it.

  `cdkd list --long` / `--show-dependencies` render through the SAME renderer
  and gain the same guarantee. The one output change you may notice there is an
  AWS account id: it is a string in the payload, so it is now emitted quoted
  (`account: "123456789012"`) and reads back as a string, matching what
  `--json` has always returned.

`cdkd deploy` and the long-running `cdkd local` servers -- `start-api`,
`run-task`, `start-service`, `start-agentcore`, `start-alb`,
`start-cloudfront` -- are deliberately NOT in this set: their stdout is a
human surface (the deploy banner and progress, the route table, task output,
prefixed container logs), not a payload, so nothing about them moved.

## `--region` / `AWS_REGION` (every command)

**A region is folded to its canonical lower-case spelling before it reaches an
AWS client.** `--region US-EAST-1`, `AWS_REGION=US-EAST-1` and
`AWS_DEFAULT_REGION=US-EAST-1` all behave exactly as `us-east-1` does.

One known exception, pinned by a test rather than left implicit:
`cdkd local start-api` folds the flag but not the env vars, so an upper-cased
`AWS_REGION` still reaches the Lambda containers it starts. Its three sibling
`cdkd local *` commands do fold both.

This is not cosmetic. Everything downstream of the value is case-SENSITIVE, and
in different ways:

| consumer | what a raw spelling does |
| --- | --- |
| SigV4 credential scope | `AuthorizationHeaderMalformed` (S3), `InvalidSignatureException` (Lambda / ECR), `SignatureDoesNotMatch` (STS) |
| SDK endpoint resolution | `CN-NORTH-1` resolves the **commercial** `amazonaws.com` instead of `amazonaws.com.cn` |
| ARN region segments | an ARN no IAM policy matches and every SDK call rejects |
| EC2 `region-name` filters | matches nothing, so `Fn::GetAZs` returns an EMPTY list |

Previously only the four
`cdkd local *` commands folded, so `cdkd deploy --region
US-EAST-1` died at the state-bucket preflight before doing anything. DNS is
case-insensitive, which is why such a deploy got far enough to fail confusingly
rather than being rejected outright.

One value is deliberately NOT folded: the region `cdkd bootstrap` keys its
**marker** off, and with it the asset bucket / ECR repo names it creates. That
value stays verbatim because the marker READ that looks for an existing marker
is paired with the marker WRITE, and both must use the same spelling or a
recorded custom asset name stops being reused; aligning that pair is
future work. The clients
`cdkd bootstrap` builds ARE folded.

The marker reads on the TEARDOWN and DEPLOY paths therefore try the canonical
key first and the spelling you passed second, so a marker written under a raw
key — by this cdkd or by an older one — is still found. `cdkd bootstrap`'s own
existing-marker read is the exception, and deliberately so: it reads the single
raw key it is about to write, because that read and that write are one pair. See the `cdkd gc` and `cdkd bootstrap --destroy` sections
above.

**Resolution order** is `--region` → `AWS_REGION` → `AWS_DEFAULT_REGION` →
**the region your AWS profile resolves** → `us-east-1`.

`AWS_DEFAULT_REGION` is read even though the JS SDK itself does not (measured:
with only that variable set, the SDK resolves the *profile's* region instead).
The AWS CLI honours it, so reading it here is what stops cdkd disagreeing with
a CLI command you just ran.

The profile step removes an
incoherence rather than adding a preference: cdkd ALREADY consulted your
profile, because every command builds its pre-flight AWS clients without a
region and lets the SDK resolve one. Only the region *value* — the one that
keys the bootstrap marker and answers `AWS::Region` — fell back to the literal.
One command, two regions.

**Currently this applies to the bootstrap-marker family** (`cdkd bootstrap`,
`cdkd gc`, `cdkd bootstrap --destroy`), which move together because one writes
the key the other two read. The commands whose region keys the *state file*
still use the `us-east-1` literal; moving them is future work, and it
needs its own migration answer for the same reason.

### The reconciliation

Changing what a bare command targets could strand storage you already have, so
an **inferred** region yields to what exists:

| your profile | existing opt-in | cdkd uses |
| --- | --- | --- |
| `ap-northeast-1` | marker in `ap-northeast-1` | `ap-northeast-1` |
| `eu-west-1` | marker only in `us-east-1` | `us-east-1`, and says so |
| `eu-west-1` | none anywhere | `eu-west-1` (nothing to strand) |

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

Assume a different IAM role for cdkd's AWS API calls. Equivalent env
var: `CDKD_ROLE_ARN`. CLI flag takes precedence when both are set.

```bash
cdkd deploy --role-arn arn:aws:iam::123456789012:role/cdkd-deploy
# or
CDKD_ROLE_ARN=arn:aws:iam::123456789012:role/cdkd-deploy cdkd deploy
```

cdkd does an `STS AssumeRole` once at command start (1-hour session,
session name `cdkd-<unix-ms>`) and writes the resulting temporary
credentials into `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN` so every later AWS SDK client picks them up via
the standard default credentials chain. No re-plumbing of credential
arguments through cdkd's ~13 `AwsClients` instantiation sites is
required.

### Why the assumed role MUST have admin-equivalent permissions

Unlike `cdk deploy`, **cdkd does not route through CloudFormation**.
There is no cfn-exec-role to delegate to. Every IAM / EC2 / Lambda /
CloudFront / DynamoDB / etc. API call is issued from cdkd directly,
using whatever identity the SDK default chain resolves to (which, when
`--role-arn` is set, is the assumed role).

That means **CDK CLI's `cdk-hnb659fds-deploy-role-*` is NOT enough**:

| Role | Trust policy | Permissions | Works for cdkd? |
| --- | --- | --- | --- |
| `cdk-hnb659fds-deploy-role-*` | IAM principals | CFn + asset-publish only (no raw EC2 / Lambda / IAM) | **No** — permission-denied during provisioning |
| `cdk-hnb659fds-cfn-exec-role-*` | `Service: cloudformation.amazonaws.com` | admin-equivalent | **No** — only assumable by CFn service, not by cdkd's IAM identity |
| Custom admin-equivalent role | IAM principals | admin-equivalent on the resources you deploy | **Yes** |

CDK CLI achieves "no local admin needed" through a two-step delegation
(IAM principal → deploy-role → CFn change set → cfn-exec-role's admin).
cdkd has no analogous chain — what you grant the assumed role is what
runs against AWS, end of story. The `--role-arn` flag exists so CI
runners with limited base credentials can still drive a cdkd deploy
against a separate-account or higher-privilege role; it does NOT
reduce the permissions the eventually-used identity needs.

### When the `--role-arn` session expires

Default session is 1 hour. For deploys that genuinely take longer
(rare; even `bench-cdk-sample` runs in ~3 min), the user re-runs the
cdkd command — in-flight credentials remain valid until expiry, but a
re-run is the simplest recovery path. cdkd does not currently auto-
refresh the session.

### `--profile` vs `--role-arn`

Independent. `--profile` selects which entry from `~/.aws/credentials`
or `~/.aws/config` provides the **base** credentials; `--role-arn`
then assumes a role from those base credentials. Use both together
when the IAM principal lives in profile A and the deploy role lives
in account B that profile A trusts.

## Exit codes

cdkd commands distinguish three outcomes via the process exit code so
CI / bench scripts can react without grepping log output:

| Exit | Meaning | Emitted by |
| --- | --- | --- |
| `0` | Success — command completed and no resources are in an error state | All commands |
| `1` | Command-level failure — auth error, bad arguments, synth crash, unhandled exception. **`cdkd drift` also exits `1` when drift is detected**, and **`cdkd diff --fail` exits `1` when any change is detected** (the operative meaning is "non-zero outcome", not "command crashed") | All commands (default for any thrown error) |
| `2` | **Partial failure** — work completed but one or more resources failed, was SKIPPED, or was only partially COMPARED; state.json is preserved and re-running typically resolves it | `cdkd destroy`, `cdkd state destroy` (per-resource delete failures, and per-resource **skips**), `cdkd deploy` (resources left UNADDRESSED — a skipped DELETE or a replacement's surviving predecessor; suppressible with `--allow-unaddressed`), `cdkd publish-assets` (per-stack asset publish failures), `cdkd rollback` (per-op failures / skipped-with-warning ops; the journal is kept for re-run), `cdkd drift` (nothing drifted, but cdkd REFUSED to compare a secret-bearing property — re-running does not clear it, but spelling the reference as a full ARN does — see the drift section) |

The implementation hangs off a `PartialFailureError` class in
`src/utils/error-handler.ts`. `handleError` reads the error's
`exitCode` property (defaults to 2 for `PartialFailureError`), so
callers cannot accidentally collapse the partial-failure case into the
general `1` bucket by re-throwing through `withErrorHandling`.

When exit `2` is emitted, the per-stack summary line in the run log
also switches glyphs:

```text
✓ Stack X destroyed (N deleted, 0 errors)                       # exit 0
⚠ Stack X partially destroyed (N deleted, M errors). State preserved — re-run 'cdkd destroy' / 'cdkd state destroy' to clean up.   # exit 2
⚠ Stack X partially destroyed (N deleted, S skipped, 0 errors). cdkd could not address the skipped resource(s) ...   # exit 2
```

`cdkd deploy` switches the same way — a run that left a resource
unaddressed no longer claims to have completed successfully:

```text
✓ Deployment completed successfully                                                  # exit 0
⚠ Stack X deployed, but N resource(s) were left unaddressed — they may still exist in AWS. This counts toward a non-zero exit (2 unless something else fails; pass --allow-unaddressed to exit 0).   # exit 2
⚠ Stack X deployed, but N resource(s) were left unaddressed — they may still exist in AWS. Exiting 0 because --allow-unaddressed was passed.               # exit 0
```

Note the second line does not promise exit `2`: in a multi-stack run a later
stack can still FAIL, and a real failure takes precedence with exit `1`.

The warning is printed in both cases where a resource survived — the second and
third lines above; only the exit code differs between them. See [`--allow-unaddressed` (deploy)](cli-deploy-safety.md#allow-unaddressed-deploy)
for which two cases produce it and how they differ in recoverability.

### Skipped resources on destroy

A **skipped** resource is one cdkd could not ADDRESS, so it may still exist
and still be billing. Three causes today:

- a state record whose composite `physicalId` does not decode
  (`AWS::Glue::Table`, `AWS::AppSync::{DataSource,Resolver,ApiKey}`,
  `AWS::EC2::NetworkAclEntry`) — no AWS call is issued at all, and the
  per-resource warning names the expected format;
- a state record missing the id or the property the delete call is addressed
  BY, in EVERY source cdkd can read it from — also no AWS call at
  all. A malformed `AWS::Lambda::LayerVersion` version ARN (the layer version
  stays published); an `AWS::Lambda::Permission` with neither a `FunctionName`
  property nor a function ARN in its physicalId (the statement stays on the
  function's resource policy, i.e. an invoke grant outliving the stack); a
  Custom Resource with no properties or no `ServiceToken` (its handler never
  receives a `Delete` request, so whatever it manages elsewhere is untouched);
  an `AWS::Lambda::Permission` whose physicalId carries no StatementId; an
  `AWS::IAM::Policy` with neither a policy name in its physicalId nor a
  `PolicyName` property, or one naming no `Roles` / `Groups` / `Users` at all
  (an inline policy exists only as an attachment, so a record naming no
  principal cannot be deleted — the policy stays ATTACHED wherever it is); an
  `AWS::IAM::UserToGroupAddition` missing `GroupName` or
  `Users` (the users keep every permission the group grants). Each warning
  names what survived and how to repair it. Where the resource's PARENT is
  part of the same destroy — the Lambda function, the IAM role / group / user
  — that parent's own delete removes the skipped resource anyway, so AWS ends
  clean and only the cdkd record is stale; the warning says so, and
  `cdkd state orphan <stack>` clears it;
- a **nested stack** (`AWS::CloudFormation::Stack`) whose own destroy skipped
  a resource or was interrupted. Here the child's *other* resources were
  deleted first, so "skipped" means the child stack as a whole was not
  destroyed — not that nothing happened. The record to repair lives in the
  child's state file (`<parent>~<childLogicalId>`), which the summary names.

It is deliberately distinct from the neighbouring outcomes:

| | AWS resource | cdkd state record | Counts as |
| --- | --- | --- | --- |
| deleted | gone | dropped | `N deleted` |
| retained (`DeletionPolicy: Retain`) | kept **on purpose** | dropped | `N retained` |
| **skipped** | **may still exist** | **KEPT** | `N skipped`, exit `2` |
| failed | may still exist | kept | `N errors`, exit `2` |

`N unverified` is a FIFTH figure on the same summary line and deliberately not
a row in that table. It is not an outcome:
the resource was deleted and its record dropped exactly as the `deleted` row
says. What it counts is **pre-flight safety guards that ran, could not reach a
verdict, and were therefore not enforced** — cdkd proceeded anyway, which is
correct (refusing on an unanswerable probe would strand every least-privilege
destroy) but must not be invisible afterwards, since the attack such a guard
exists to catch works by DENYING the permission the probe needs. So it moves no
other counter, forces no state preservation and does **not** change the exit
code: a destroy showing `1 unverified` and `0 errors` exits `0`. It appears on
every summary arm and only when non-zero, so a run with no suppressed guard
prints exactly what it always did. A warning beneath the line names the
resources; the durable half is a `RESOURCE_GUARD_INDETERMINATE` event, which
outlives the run — see
[docs/deployment-events.md](deployment-events.md). `cdkd state destroy` prints
the same figure but records no events at all.

The state record is kept on purpose: without it you would have neither
the AWS resource deleted nor an id to go and delete it with. To finish
the destroy, repair whatever the per-resource warning names — the
`physicalId` for the decode failures, the missing property (`FunctionName`,
`ServiceToken`, `GroupName` / `Users`) for the missing-field causes — in state
(`cdkd state show <stack>` to inspect) and re-run, or delete the resource by
hand and drop the record with `cdkd state orphan <stack>`. The summary line names the exact
state file(s) to open, which for a nested-stack skip is the child's.

#### A skip on `cdkd deploy`, not just on destroy

The same provider outcome reaches `cdkd deploy`, which issues a DELETE for
every resource removed from the template plus one for the old resource of a
replacement. Each site handles it in the way that resource's situation allows:

| Deploy-side site | On a skip |
| --- | --- |
| a resource removed from the template | warns, prints `⚠ <id> (<type>) skipped (<reason>)`, **keeps the state record**, and counts it under `Skipped (not deleted)` in the summary. Because the record is kept, the resource is still a pending DELETE and the next `cdkd deploy` re-attempts it — but the run exits `2`, since the template as written was not applied |
| the old resource of a replacement (`--replace`, `--recreate-via-*`, an UPDATE the type does not support in place) | **fails the resource** — the replacement create would otherwise run beside a live old one, or collide with its name |
| the cleanup delete after a create-first replacement | warns; the new resource is already created and recorded, so the old one is untracked whether the delete failed or was skipped. Delete it by hand |
| a rollback delete (automatic, or `cdkd rollback`) | counted as a per-op **failure** at four of the five arms, so the journal segment is kept and re-running `cdkd rollback` re-attempts it. The exception is the delete of the NEW resource AFTER the old one was re-created: that arm's delete is already best-effort (the revert itself succeeded and state points at the old resource), so a skip warns and counts as a warning — the new resource is left untracked and must be deleted by hand |

A deploy-side skip changes the exit code too. This reverses the earlier
rule recorded here — that a skip on deploy stayed exit `0` because a kept record
means the next run heals it, while `cdkd destroy` has no next run. Self-healing
is still the real difference between the two verbs, and the table above keeps
it; what it does not justify is reporting SUCCESS in the meantime. The deploy
did not apply the template it was given, and a pipeline reading only the exit
code was being told it had. `--allow-unaddressed` restores exit `0` for callers
who accept that (see [`--allow-unaddressed` (deploy)](cli-deploy-safety.md#allow-unaddressed-deploy)).

#### A nested stack whose child FAILED is an error, not a skip

The third outcome a child stack's destroy can report is a resource that was
ATTEMPTED and FAILED. That is **not** a skip — a skip asserts no AWS call was
issued — so the parent's `AWS::CloudFormation::Stack` row FAILS, exactly as a
failed delete of any other resource type does:

```text
✗ Failed to delete Child: Nested stack MyStack~Child failed to destroy: 1 resource(s) failed to delete.
  The child's state is PRESERVED and still lists them — inspect it with 'cdkd state show MyStack~Child',
  resolve the failure, and re-run the destroy. ...

⚠ Stack MyStack partially destroyed (2 deleted, 1 errors). State preserved ...   # exit 2
```

Before this change the parent swallowed the child's error count: it printed
`✓ Child (AWS::CloudFormation::Stack) deleted`, dropped the child's row, and —
because the parent itself had recorded no errors — deleted the parent's
`state.json` and its exports-index entries and exited **0**, while the child's
own `state.json` sat preserved describing live, billing resources that nothing
named any more. If you scripted around the old exit code, note that this
destroy now exits 2.

**`cdkd deploy` is affected too.** Removing an `AWS::CloudFormation::Stack`
from your template routes that row through the deploy engine's DELETE path, so
a child that fails to destroy now **fails the deploy** (and its siblings roll
back) where it previously recorded the row as deleted and carried on. Same
correctness argument, wider blast radius: verify a nested stack destroys
cleanly before removing it from the template.

The remedy the summary prints names the CHILD's state file
(`cdkd state orphan <parent>~<child>`), not the parent's — the resource that
failed lives in the child, and orphaning the parent would drop the very row
that keeps the child reachable. A run that has BOTH failures and skips prints
each remedy separately, since they are different in kind: a failure is
retryable (`cdkd destroy` again), while a skip needs its state record repaired
first.

The run-level exit message counts **entries**, not resources: a skipped
nested-stack row is one entry however many of the child's own resources it
covers. The per-stack summary lines above it give the exact breakdown.

If your bench / CI script previously treated any non-zero from `cdkd
destroy` as a hard failure (because it never had a non-zero outcome
before), you may now want to branch on `2` separately to schedule a
retry instead of paging.

## `local *` (run AWS workloads locally)

The `cdkd local` command family runs AWS workloads on the developer's
machine — Lambda functions, API Gateway routes, ECS tasks, ECS
Services, ALB front-doors, CloudFront distributions, and Bedrock
AgentCore Runtimes — without an AWS deploy. Most commands run the
workload in Docker; `local start-cloudfront` serves a
CloudFront-Functions + S3-origin distribution in-process (no Docker),
falling back to Docker/RIE only for a Lambda Function URL origin. The
full reference for all `cdkd local *` subcommands (`local invoke` /
`local start-api` / `local run-task` / `local start-service` /
`local start-alb` / `local start-cloudfront` / `local invoke-agentcore` /
`local start-agentcore`) lives in
**[docs/local-emulation.md](local-emulation.md)**.

