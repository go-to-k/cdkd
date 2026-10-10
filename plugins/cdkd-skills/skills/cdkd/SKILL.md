---
name: cdkd
description: Install cdkd and use it safely from an AWS CDK project. Use when bootstrapping, synthesizing, diffing, deploying, inspecting, rolling back, migrating, or destroying dev/test stacks with cdkd.
---

<!--
  This file is the DISTRIBUTED end-user skill, installed via the Claude Code
  plugin marketplace (`/plugin install cdkd-skills@cdkd`), `gh skill`, or
  `npx skills`. It ships together with the repo-internal contributor skill at
  .claude/skills/use-cdkd/SKILL.md, which defers to this file for the
  safe-usage flow. When cdkd CLI behavior changes, update this file AND bump
  the `version` fields in plugins/cdkd-skills/.claude-plugin/plugin.json and
  .claude-plugin/marketplace.json in the same PR.
-->

# Use cdkd Safely

Use cdkd for rapid iteration in development and test environments. It complements the AWS CDK CLI; it is not the default production deployment engine.

## Install cdkd

Before installing or upgrading, verify the current release and runtime requirement from the npm registry:

```bash
npm view @go-to-k/cdkd version engines --json
```

cdkd requires Node.js 22.12 or later. If the user asks to install it, prefer an explicit version so the action is reproducible:

```bash
npm install --global @go-to-k/cdkd@'<version>'
cdkd --version
```

Do not silently upgrade an existing installation during an unrelated deployment.

## Establish the deployment boundary

Before any AWS-changing command:

1. Read the CDK project's `cdk.json`, package scripts, stack definitions, and local instructions.
2. Identify the AWS profile, account ID, region, CDK app, named stack, and environment classification.
3. Verify the active identity explicitly:

   ```bash
   AWS_PROFILE='<profile>' AWS_REGION='<region>' aws sts get-caller-identity
   ```

4. State the resolved account, region, stack, and intended operation before proceeding.
5. Confirm that the credentials have direct permissions for every deployed resource. cdkd calls AWS service APIs directly; the CDK bootstrap deploy role alone is not sufficient.

Keep these ownership rules:

- Use cdkd by default only for development and test workloads. Upstream explicitly describes it as not yet production-ready. For production, keep the existing AWS CDK CLI or another established production workflow unless the user explicitly approves cdkd after that limitation and the workload-specific risks are explained.
- Do not run `cdkd deploy` against an existing CloudFormation-managed stack as an implicit migration. Continue using `cdk deploy`, or plan an explicit `cdkd import --migrate-from-cloudformation` operation.
- Treat `cdkd import`, `cdkd export`, `cdkd orphan`, and `cdkd state orphan` as changes to the system of record. Explain the ownership change and obtain explicit confirmation before running them.
- Never edit the S3 state object by hand. Use cdkd state and recovery commands.

To stop managing something WITHOUT deleting it from AWS, orphan it: `cdkd orphan '<stack/ConstructPath>'` drops one resource from cdkd state (the AWS resource stays), `cdkd state orphan '<stack>' --resource <logicalId>` drops one resource's record without the CDK app (also for a resource whose construct is already gone from the template), and `cdkd state orphan '<stack>'` removes the whole stack's state record (all AWS resources stay) — never run that bare form on a stack that is still deployed, since the next deploy re-creates or collides with every resource. Remove the corresponding construct from the CDK app in the same change — otherwise the next `cdkd deploy` re-creates what the template still declares.

For a proposed CloudFormation migration, read the deployed CloudFormation template and compare its logical IDs with the current synthesized template so local changes do not accidentally leave retained resources unmanaged. Preview resource matching with the non-migrating form:

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd import '<stack>' --dry-run
```

`--migrate-from-cloudformation` itself is intentionally incompatible with `--dry-run`: it writes cdkd state, adds retain policies, and retires the CloudFormation stack record. Do not bootstrap, import, or migrate until the user approves that ownership-change plan.

## Reference CloudFormation-managed stacks (mixed estates)

A cdkd-deployed stack can consume values from a producer stack that stays managed by CloudFormation (`cdk deploy`): when an `Fn::ImportValue` or `Fn::GetStackOutput` reference is not found in cdkd state, cdkd falls back to CloudFormation (`ListExports` / stack outputs). Use this for the common split — shared infrastructure stays on the CDK CLI while dev/test app stacks deploy via cdkd — WITHOUT migrating or re-deploying the producer. Keep these boundaries:

- The active credentials need `cloudformation:ListExports` and `cloudformation:DescribeStacks` for the fallback. Without them cdkd logs a warning and fails with the ordinary not-found error.
- Such references are weak: neither engine blocks deleting the CloudFormation producer while cdkd consumers reference it (CloudFormation's export-in-use protection cannot see cdkd consumers). Check downstream cdkd consumers explicitly before deleting or exporting a producer stack.
- Pass `--no-cfn-fallback` on `cdkd deploy` / `cdkd diff` when the user wants cdkd-state-only resolution (minimal IAM, or fail-fast on export-name typos).

## Check compatibility and bootstrap

Have cdkd synthesize the app:

```bash
cdkd synth
```

`cdkd synth` validates the synthesized app and does not accept a stack selector.

If it fails, isolate the cause by running the project's normal synthesis (`cdk synth` or the project's own build/test scripts): if that also fails, fix the CDK app first; if it succeeds, the difference is a cdkd issue worth reporting upstream.

Check [supported resources](https://cdkd.dev/supported-resources/) and any property-level preflight errors before deployment. Do not add `--allow-unsupported-properties` merely to bypass a security-relevant encryption, IAM, networking, or TLS warning.

For a new cdkd-managed stack, bootstrap cdkd once per target AWS account after the preflight checks:

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd bootstrap
```

This creates cdkd's S3 state storage and cdkd-owned asset storage. It does not replace or remove the normal CDK bootstrap resources. The current default state bucket is account-scoped; older region-suffixed buckets are handled as a legacy layout. Use a custom `--state-bucket` or `CDKD_STATE_BUCKET` only when the project has an intentional isolation or naming requirement.

## Preview before deployment

Use an explicit stack name when more than one stack exists or whenever ambiguity would be risky:

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd diff '<stack>'
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd deploy '<stack>' --dry-run
```

Review the complete plan for replacements, deletions, IAM changes, unsupported properties, retained resources, and state-bucket selection. Do not hide confirmation prompts with `--yes` or force flags by default.

To check mechanically whether the change would lose an existing resource, run the diff with `--fail-on=destructive`. It exits `1` when a change replaces, deletes, or orphans an existing resource (always walking nested stacks), and lists each one after the diff; additions and in-place updates exit `0`. Exit `3` means `cdkd deploy` would refuse the stack regardless, and takes precedence over the list. On exit `1` with listed resources, show them to the user and get explicit confirmation before deploying; exit `1` with no list means the command itself failed:

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd diff '<stack>' --fail-on=destructive
```

`--fail-on` takes `any-change`, `destructive`, or `never` (default); `--fail` / `--no-fail` are aliases for `any-change` / `never`. The AWS CDK CLI's `broadening` is not available on `--fail-on` or `--require-approval`.

`cdkd deploy --require-approval=destructive` (or `any-change`) makes the deploy itself ask after the diff and before changing the stack; it is also read from `"requireApproval"` in `cdk.json`, except that a `"broadening"` value there is ignored with a warning and nothing is asked. It asks only on a terminal: without one — an agent's non-interactive shell, or CI — that stack's deploy fails instead of asking. That failure is not "nothing changed" for the whole run: a nested stack is asked only when its parent's deploy reaches it, so the parent may already have changed and then rolls back (or keeps the changes under `--no-rollback`), and other stacks in the same run that do not depend on it still deploy. Treat the failure as the stop it is: check `cdkd state show` / `cdkd events` for what did change, report the destructive changes to the user, and do not add `--yes` (which approves without asking) unless the user approved that exact scope.

## Deploy and choose what "done" means

For an ordinary development deployment:

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd deploy '<stack>'
```

Choose the wait mode from what happens after deployment:

- Default: normal interactive development when no immediate consumer needs every asynchronous resource fully serving.
- `--full-wait`: use before smoke tests, DNS cutovers, or follow-on jobs that require CloudFormation-like completion, including CloudFront `Deployed` and ECS service steady state.
- `--no-wait`: use only when the user accepts background stabilization and nothing immediately depends on completion. Never combine it with `--full-wait`.

For example, a deploy followed by a website smoke test should use:

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd deploy '<stack>' --full-wait
```

Do not report success solely because resources appeared in AWS. Require a zero command exit status and complete the relevant verification.

## Verify and diagnose

After deployment, inspect cdkd's state and recorded deployment events:

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd state info
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd state show '<stack>' --stack-region '<region>'
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd events '<stack>' --stack-region '<region>'
```

Also verify the stack outputs, the critical AWS resource state, and an application-level smoke test when applicable. Treat a non-zero exit as an unsuccessful command, but interpret it per command: exit `1` normally indicates failure, while `diff --fail` / `diff --fail-on` and `drift` also use it to report detected changes; exit `2` indicates partial failure for commands that support it. Inspect state and events, then follow the command-specific recovery guidance.

For an interrupted or failed deployment:

1. Read the original error and `cdkd events '<stack>'`.
2. Inspect `cdkd state show '<stack>'` before retrying.
3. Re-run the same command when the failure is safely retryable.
4. Use `cdkd rollback '<stack>'` for a failed `--no-rollback` or interrupted deployment when rollback is appropriate.
5. Use `cdkd force-unlock '<stack>'` only after proving no deployment is still running.

## Detect and reconcile drift

`cdkd drift '<stack>'` compares each managed resource's live AWS configuration against cdkd state (state-driven; no synth) and exits `1` when drift is detected. Reconcile in one of two explicit directions:

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd drift '<stack>'           # detect only
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd drift '<stack>' --accept  # state <- AWS (keep the live change)
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd drift '<stack>' --revert  # AWS <- state (undo the live change)
```

`--accept` and `--revert` are mutually exclusive; both honor `--dry-run`. `--revert` changes live AWS resources — treat it as a destructive operation (see below).

## State secret hygiene (clean + audit)

cdkd resolves CloudFormation dynamic references (`{{resolve:secretsmanager:...}}`) and, on the DEPLOY path, stores the UNRESOLVED expression rather than the resolved plaintext, so the value does not land in the `state.json` a deploy writes, nor in `cdkd state show`, `cdkd diff`, or `cdkd drift` output for such a record. A normal `cdkd deploy` already scrubs state this way as a side effect. That describes what the deploy path is designed to do; it is NOT a guarantee about `state.json`. The redaction substitutes only at positions it can certify against the template, and where it cannot — a reshaped container, an identity key AWS normalised, a bag refreshed with no recorded secrets to match on — it leaves the value it was handed, and that configuration is reachable on the deploy path itself through the observed-properties refresh of an unchanged resource. Other commands widen it further: `cdkd state refresh-observed` when the stored properties hold a raw intrinsic shape rather than the reference as a string, and `cdkd import` for the `attributes` bag it captures from a live read.

That is a statement about what cdkd WRITES. The state bucket is versioned, so a write SUPERSEDES a plaintext version an older binary already wrote rather than erasing it: the earlier body stays readable with `GetObject` and a `VersionId`. A deploy's implicit scrub never purges those versions (they are the state-recovery history). A real `cdkd scrub` purges the earlier versions of each `state.json` it rewrites (and of the exports index it rewrites); `cdkd scrub --purge-history` also purges them for every record it examines and does not refuse, rewritten or not — the way to clear what a deploy left behind. Both need `s3:ListBucketVersions` and `s3:DeleteObjectVersion`, and warn rather than fail without them; a replicated bucket keeps its replica's copies. A green `--dry-run --fail` gate therefore means the CURRENT object holds no plaintext of a value the template names through a `{{resolve:...}}` reference, and nothing more — treat any value ever persisted in plaintext as compromised and ROTATE it. A secret the template never references (one an operator set out of band over a placeholder literal, or a key of a Cloud Control model) is recorded in the `observedProperties` drift baseline (and, for a Cloud Control resource, in `attributes`) as AWS returned it, BY DESIGN, and scrub cannot see it, since it learns a secret's value only by resolving a reference; so `state.json` is sensitive by construction. Likewise, a physical name DERIVED from a secret (a `{{resolve:...}}` reference or a `NoEcho` parameter in a name or other identifier property, e.g. an SQS `QueueName`) is the resource's identity: it is stored in plaintext in that resource's `physicalId`, in other resources' resolved `Ref` / `Fn::GetAtt` / `Fn::Sub` copies of it (or of an identifier embedding it), in the stack outputs and exports index entries that carry it, in the rollback journal and an `orphans` record, and in a deployment event's `physicalId` field; scrub rewrites neither the physical id nor other resources' copies and reports those records clean (an undeclared leftover output, or another resource's `orphans` record, that holds or embeds the secret's resolved value is rewritten; otherwise an undeclared output is dropped or kept and reported like any undeclared key; a leftover exports index entry is reported when it holds a recorded secret's value), and logs, `cdkd diff` output and deployment event text mask it only where cdkd recognises the read (an unrecognised read prints it, which is a bug to report; `cdkd state show` / `cdkd events` print it as stored) — as in CloudFormation, which advises keeping dynamic references out of identifier properties (https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references.html). Removal is in [A value your template never references is recorded as AWS holds it](https://cdkd.dev/import/#a-value-your-template-never-references-is-recorded-as-aws-holds-it).

`cdkd scrub '<stack>'` is the permanent state secret-hygiene command — clean and audit, not incident-only tooling. It synthesizes the app to learn which values are secrets, then rewrites the state record so each plaintext secret becomes its `{{resolve:...}}` expression, WITHOUT a redeploy. It mutates no AWS resource, but it is not read-only: a real run writes `state.json`, takes and releases the stack lock, and — for an export the stack owns whose indexed value has diverged from the `{{resolve:...}}` expression now in state — patches the region-wide cross-stack exports index, then purges the earlier versions of what it rewrote. `--dry-run` writes and purges none of them, and cannot be combined with `--purge-history`. Scrubbing a stack also scrubs every nested stack under it (a nested stack cannot be named on its own; name its parent). Use it to clean state written by an older cdkd, and use `--dry-run --fail` as a STANDING CI gate that continuously asserts no value the template names through a `{{resolve:...}}` reference lives in state as plaintext (a physical name derived from one aside, except in an output or exports index entry the template no longer declares) (secrets landing in IaC state is a structural, recurring concern, so it is worth checking on every build rather than once).

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd scrub '<stack>'            # scrub in place
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd scrub '<stack>' --dry-run  # report only, no write
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd scrub '<stack>' --dry-run --fail  # CI gate: exit 1 on any finding
```

`--fail` exits `1` for a finding scrub cannot REMEDY as well as for plaintext it
can — a state KEY holding a secret, a cross-stack read cdkd declines to perform,
a cross-stack read NAME still holding a secret's value from before a rotation,
while the template still reads a secret-bearing name of that shape (scrub matches only the current value, so it reports that name without printing
it and cannot rewrite it; a deploy that updates the stack does), and a record
whose `{{resolve:...}}` scan was ABANDONED because a reference did
not resolve (a deleted SSM parameter, a secret with no `SecretString`). The last
one matters most as a gate result: the resolver stops at the first failing token,
so a real secret AFTER it in the same value was never fetched, recorded no
needle, and would otherwise have let the stack report clean. Each such record is
named in a warning; resolve the reference and re-run.

Not every abandoned scan raises the exit code. A scan stopped by something scrub
cannot bind with template defaults alone — an unresolvable `Ref` / `Fn::GetAtt`,
a parameter with no `Default`, or a reference whose own argument holds a
`${...}` no `Fn::Sub` substitutes — is WARNED but does not fail `--fail`,
because a gate failure there could not be cleared. An `Fn::Sub` placeholder that
names no resource or parameter of the template, kept inside a `{{resolve:...}}`
reference, DOES fail it: fixing the template clears it. So **a green `--dry-run --fail` does not by
itself mean every record was examined**: read the warnings, since a record cdkd
could not certify may still hold a plaintext written by an older binary.

Scrub DROPS a stored output key today's template no longer declares whose value it cannot identify (a deleted output's leftover), naming the key but never its value, so `--dry-run --fail` also exits `1` until a real scrub or a deploy removes it. It keeps such a key when it may be a live export alias whose name scrub could not reproduce, and when another stack's state still records reading it — both are findings, so `--fail` exits `1`; when the other stacks' state cannot be read it drops nothing and exits `2`.

Scrubbing needs the CDK app (`--app` / `CDKD_APP` / `cdk.json`) because state records the resolved value with no marker of which values are secrets — only the template carries the references. Scrub only stops a plaintext secret being re-read out of state going forward; rotating it in Secrets Manager is what retires it.

## Reclaim asset storage

Content-addressed assets are deliberately kept on `cdkd destroy` (another stack or a future rollback may reference the same hash), so cdkd-owned asset storage grows over time. `cdkd gc` deletes only assets no state file references, one region per invocation, and never touches CDK's own bootstrap storage:

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd gc --dry-run  # print the reclaim plan first
AWS_PROFILE='<profile>' AWS_REGION='<region>' cdkd gc            # delete after reviewing the plan
```

Keep the default `--older-than 30d` age guard unless the user explicitly accepts a shorter window; it protects in-flight publishes and recent rollback targets.

## Guard destructive and migration commands

Before `destroy`, `state destroy`, `orphan`, `import`, `export`, `drift --accept`, `drift --revert`, or `gc`:

1. Re-resolve the AWS identity, region, stack name, and current owner.
2. Show the exact command and explain which resources or state records change.
3. Check retention, snapshots, backups, and downstream consumers.
4. Obtain explicit user confirmation immediately before execution.

Do not use `--force`, `--yes`, `--purge-events`, or other confirmation-bypassing flags unless the user approved that exact destructive scope.

## Use cdkd in CI (per-PR environments)

cdkd's main CI use case is per-PR preview environments: deploy on PR open/sync, destroy on close. Deploy time is CI job time, so the speedup compounds across every push. Key rules when authoring such workflows:

- Swap only the PR-environment workflow to cdkd; production and staging can stay on the CDK CLI (zero CDK code changes, one-line revert).
- One stack per PR: pass the PR number as CDK context (`-c prNumber=...`) and suffix the stack name in the app. State is keyed by (stack name, region) and locks are per-stack, so PR environments deploy concurrently.
- Credentials: have the workflow's OIDC base role hold ONLY `sts:AssumeRole` on a dedicated deploy role, switch into it with `--role-arn` / `CDKD_ROLE_ARN`, and pin the deploy role's trust policy to that base role. The deploy role needs direct permissions for every deployed resource — CDK's `cdk-hnb659fds-*` roles do not work with cdkd. Run `cdkd bootstrap` once per account beforehand.
- Non-interactive exception: in a CI workflow, `--yes` on `deploy` / `destroy` / `state destroy` is the sanctioned confirmation mechanism — the approval happened when a human reviewed the workflow. The interactive-confirmation rules above still apply whenever a human is driving the session.
- Gate a pull request on resource loss with `cdkd diff '<stack>' --fail-on=destructive`: beyond the command failing or a deploy-would-refuse exit `3`, it fails the job only when a change would replace, delete, or orphan an existing resource. `--require-approval` cannot ask without a terminal, so in CI it fails the deploy rather than pausing it; use the diff gate for review and keep `--yes` as the approval.
- Destroy on PR close with `cdkd state destroy '<stack>' --yes`: it works from the state record alone (no checkout, `npm ci`, or synth — works even after the branch is deleted). When the environment contains protection-enabled resources (RDS / DynamoDB deletion protection, EC2 termination protection, and more), add `--remove-protection` so the teardown completes in one pass — appropriate for ephemeral PR environments; do not default it for long-lived stacks.
- Resources with `DeletionPolicy: Snapshot` leave a final snapshot behind on every close by default, and so does an RDS DB cluster or standalone DB instance that declares NO `DeletionPolicy` (CloudFormation's default for them is `Snapshot`); add `--skip-final-snapshot` ONLY when the user confirms the environment's data is disposable (it is an explicit data-loss opt-out). To leave an object listing of the state bucket empty, `cdkd destroy --purge-events` also deletes the event history (after a `state destroy`, use `cdkd events prune '<stack>' --all`); on the versioned state bucket both also purge every earlier version under the stack's `deployments/` prefix, including history an earlier delete left behind a delete marker, unless a warning says otherwise.
- A cancelled mid-deploy job can leave a stack lock; it expires after its TTL (30 minutes), or clear it with `cdkd force-unlock '<stack>'`.
- Housekeeping: sweep stale environments via `cdkd state list --json` on a schedule; reclaim unreferenced assets with `cdkd gc` outside deploy hours (it aborts while any stack is locked). Read outputs for PR comments with `cdkd state show '<stack>' --json`.

See the [CI per-PR guide](https://cdkd.dev/ci-per-pr/) for a complete GitHub Actions example.

## Run workloads locally

`cdkd local *` runs Lambda functions, API Gateway APIs, ECS tasks and services, ALBs, CloudFront distributions, and Bedrock AgentCore runtimes on the developer's machine via Docker — no AWS deploy involved, so the deployment-boundary steps above do not apply to these commands:

```bash
cdkd local invoke '<function>'        # one-shot Lambda invoke
cdkd local start-api                  # long-running local API Gateway
cdkd local run-task '<task>'          # one-shot ECS task
cdkd local start-service '<service>'  # long-running ECS service emulator
```

The most important choice is the environment source: `--from-state` or `--from-cfn-stack`. A workload whose environment variables reference other resources (`Ref` / `Fn::GetAtt` table names, queue URLs — the common case) runs with those variables dropped unless one of the two fills them with the REAL values of the already-deployed resources — the physical IDs and attributes of the tables, queues, and buckets actually running in the AWS account:

```bash
cdkd local invoke '<function>' --from-state      # env vars <- the deployed resources' real values, when the stack was deployed with cdkd deploy
cdkd local invoke '<function>' --from-cfn-stack  # env vars <- the deployed resources' real values, when the stack was deployed with cdk deploy
```

`--from-state` and `--from-cfn-stack` are mutually exclusive — pick the one matching how the stack was deployed. Both make read-only AWS calls, so they need credentials; a plain local run without them does not.

With the environment source resolved, a local run is a hybrid: the handler executes on the developer's machine (edit and re-invoke — no deploy round-trip), while talking to the real deployed dev resources. That removes the usual local-testing overhead — no hand-maintained `.env` files mirroring resource names, and no local emulators to install and seed with test data, because the code reads and writes the actual dev-environment tables, queues, and buckets.

Most `cdkd local` commands require Docker, and the first run pulls base images (up to ~600 MB). See the [local execution guide](https://cdkd.dev/local-emulation/) for the full subcommand list (ALB, CloudFront, AgentCore) and flags.

## Command reference

Use the same verified profile, region, state bucket, and binary form throughout a workflow:

```bash
cdkd bootstrap
cdkd synth
cdkd diff '<stack>'
cdkd diff '<stack>' --fail-on=destructive
cdkd deploy '<stack>' --dry-run
cdkd deploy '<stack>'
cdkd deploy '<stack>' --require-approval=destructive   # terminal only; fails without one
cdkd deploy '<stack>' --full-wait
cdkd state info
cdkd state show '<stack>' --stack-region '<region>'
cdkd events '<stack>' --stack-region '<region>'
cdkd drift '<stack>'
cdkd scrub '<stack>'
cdkd gc --dry-run
cdkd destroy '<stack>'
```

Options such as `--app`, `--state-bucket`, and context values may come from CLI flags, environment variables, or `cdk.json`. Inspect the project instead of assuming defaults.

For current command behavior, consult the [documentation site](https://cdkd.dev) — in particular the [CLI reference](https://cdkd.dev/cli-reference/), [state management](https://cdkd.dev/state-management/), and [import guidance](https://cdkd.dev/import/).
