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

cdkd requires Node.js 20 or later. If the user asks to install it, prefer an explicit version so the action is reproducible:

```bash
npm install --global @go-to-k/cdkd@<version>
cdkd --version
```

Do not silently upgrade an existing installation during an unrelated deployment.

## Establish the deployment boundary

Before any AWS-changing command:

1. Read the CDK project's `cdk.json`, package scripts, stack definitions, and local instructions.
2. Identify the AWS profile, account ID, region, CDK app, named stack, and environment classification.
3. Verify the active identity explicitly:

   ```bash
   AWS_PROFILE=<profile> AWS_REGION=<region> aws sts get-caller-identity
   ```

4. State the resolved account, region, stack, and intended operation before proceeding.
5. Confirm that the credentials have direct permissions for every deployed resource. cdkd calls AWS service APIs directly; the CDK bootstrap deploy role alone is not sufficient.

Keep these ownership rules:

- Use cdkd by default only for development and test workloads. Upstream explicitly describes it as not yet production-ready. For production, keep the existing AWS CDK CLI or another established production workflow unless the user explicitly approves cdkd after that limitation and the workload-specific risks are explained.
- Do not run `cdkd deploy` against an existing CloudFormation-managed stack as an implicit migration. Continue using `cdk deploy`, or plan an explicit `cdkd import --migrate-from-cloudformation` operation.
- Treat `cdkd import`, `cdkd export`, `cdkd orphan`, and `cdkd state orphan` as changes to the system of record. Explain the ownership change and obtain explicit confirmation before running them.
- Never edit the S3 state object by hand. Use cdkd state and recovery commands.

To stop managing something WITHOUT deleting it from AWS, orphan it: `cdkd orphan <stack/ConstructPath>` drops one resource from cdkd state (the AWS resource stays), and `cdkd state orphan <stack>` removes the whole stack's state record (all AWS resources stay). Remove the corresponding construct from the CDK app in the same change — otherwise the next `cdkd deploy` re-creates what the template still declares.

For a proposed CloudFormation migration, read the deployed CloudFormation template and compare its logical IDs with the current synthesized template so local changes do not accidentally leave retained resources unmanaged. Preview resource matching with the non-migrating form:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd import <stack> --dry-run
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

Check [supported resources](https://github.com/go-to-k/cdkd/blob/main/docs/supported-resources.md) and any property-level preflight errors before deployment. Do not add `--allow-unsupported-properties` merely to bypass a security-relevant encryption, IAM, networking, or TLS warning.

For a new cdkd-managed stack, bootstrap cdkd once per target AWS account after the preflight checks:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd bootstrap
```

This creates cdkd's S3 state storage and cdkd-owned asset storage. It does not replace or remove the normal CDK bootstrap resources. The current default state bucket is account-scoped; older region-suffixed buckets are handled as a legacy layout. Use a custom `--state-bucket` or `CDKD_STATE_BUCKET` only when the project has an intentional isolation or naming requirement.

## Preview before deployment

Use an explicit stack name when more than one stack exists or whenever ambiguity would be risky:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd diff <stack>
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd deploy <stack> --dry-run
```

Review the complete plan for replacements, deletions, IAM changes, unsupported properties, retained resources, and state-bucket selection. Do not hide confirmation prompts with `--yes` or force flags by default.

## Deploy and choose what "done" means

For an ordinary development deployment:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd deploy <stack>
```

Choose the wait mode from what happens after deployment:

- Default: normal interactive development when no immediate consumer needs every asynchronous resource fully serving.
- `--full-wait`: use before smoke tests, DNS cutovers, or follow-on jobs that require CloudFormation-like completion, including CloudFront `Deployed` and ECS service steady state.
- `--no-wait`: use only when the user accepts background stabilization and nothing immediately depends on completion. Never combine it with `--full-wait`.

For example, a deploy followed by a website smoke test should use:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd deploy <stack> --full-wait
```

Do not report success solely because resources appeared in AWS. Require a zero command exit status and complete the relevant verification.

## Verify and diagnose

After deployment, inspect cdkd's state and recorded deployment events:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd state info
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd state show <stack> --stack-region <region>
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd events <stack> --stack-region <region>
```

Also verify the stack outputs, the critical AWS resource state, and an application-level smoke test when applicable. Treat a non-zero exit as an unsuccessful command, but interpret it per command: exit `1` normally indicates failure, while `diff --fail` and `drift` also use it to report detected changes; exit `2` indicates partial failure for commands that support it. Inspect state and events, then follow the command-specific recovery guidance.

For an interrupted or failed deployment:

1. Read the original error and `cdkd events <stack>`.
2. Inspect `cdkd state show <stack>` before retrying.
3. Re-run the same command when the failure is safely retryable.
4. Use `cdkd rollback <stack>` for a failed `--no-rollback` or interrupted deployment when rollback is appropriate.
5. Use `cdkd force-unlock <stack>` only after proving no deployment is still running.

## Detect and reconcile drift

`cdkd drift <stack>` compares each managed resource's live AWS configuration against cdkd state (state-driven; no synth) and exits `1` when drift is detected. Reconcile in one of two explicit directions:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd drift <stack>            # detect only
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd drift <stack> --accept   # state <- AWS (keep the live change)
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd drift <stack> --revert   # AWS <- state (undo the live change)
```

`--accept` and `--revert` are mutually exclusive; both honor `--dry-run`. `--revert` changes live AWS resources — treat it as a destructive operation (see below).

## Reclaim asset storage

Content-addressed assets are deliberately kept on `cdkd destroy` (another stack or a future rollback may reference the same hash), so cdkd-owned asset storage grows over time. `cdkd gc` deletes only assets no state file references, one region per invocation, and never touches CDK's own bootstrap storage:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd gc --dry-run   # print the reclaim plan first
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd gc             # delete after reviewing the plan
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
- Destroy on PR close with `cdkd state destroy <stack> --yes`: it works from the state record alone (no checkout, `npm ci`, or synth — works even after the branch is deleted). When the environment contains protection-enabled resources (RDS / DynamoDB deletion protection, EC2 termination protection, and more), add `--remove-protection` so the teardown completes in one pass — appropriate for ephemeral PR environments; do not default it for long-lived stacks.
- Resources with `DeletionPolicy: Snapshot` leave a final snapshot behind on every close by default; add `--skip-final-snapshot` ONLY when the user confirms the environment's data is disposable (it is an explicit data-loss opt-out). To leave the state bucket fully empty, `cdkd destroy --purge-events` also removes the event history (after a `state destroy`, use `cdkd events prune <stack> --all`).
- A cancelled mid-deploy job can leave a stack lock; it expires after its TTL (30 minutes), or clear it with `cdkd force-unlock <stack>`.
- Housekeeping: sweep stale environments via `cdkd state list --json` on a schedule; reclaim unreferenced assets with `cdkd gc` outside deploy hours (it aborts while any stack is locked). Read outputs for PR comments with `cdkd state show <stack> --json`.

See the [README's CI section](https://github.com/go-to-k/cdkd/blob/main/README.md#use-in-ci-per-pr-environments) for a complete GitHub Actions example.

## Run workloads locally

`cdkd local *` runs Lambda functions, API Gateway APIs, ECS tasks and services, ALBs, CloudFront distributions, and Bedrock AgentCore runtimes on the developer's machine via Docker — no AWS deploy involved, so the deployment-boundary steps above do not apply to these commands:

```bash
cdkd local invoke <function>       # one-shot Lambda invoke
cdkd local start-api               # long-running local API Gateway
cdkd local run-task <task>         # one-shot ECS task
cdkd local start-service <service> # long-running ECS service emulator
```

The most important choice is the environment source: `--from-state` or `--from-cfn-stack`. A workload whose environment variables reference other resources (`Ref` / `Fn::GetAtt` table names, queue URLs — the common case) runs with those variables dropped unless one of the two fills them with the REAL values of the already-deployed resources — the physical IDs and attributes of the tables, queues, and buckets actually running in the AWS account:

```bash
cdkd local invoke <function> --from-state       # env vars <- the deployed resources' real values, when the stack was deployed with cdkd deploy
cdkd local invoke <function> --from-cfn-stack   # env vars <- the deployed resources' real values, when the stack was deployed with cdk deploy
```

`--from-state` and `--from-cfn-stack` are mutually exclusive — pick the one matching how the stack was deployed. Both make read-only AWS calls, so they need credentials; a plain local run without them does not.

With the environment source resolved, a local run is a hybrid: the handler executes on the developer's machine (edit and re-invoke — no deploy round-trip), while talking to the real deployed dev resources. That removes the usual local-testing overhead — no hand-maintained `.env` files mirroring resource names, and no local emulators to install and seed with test data, because the code reads and writes the actual dev-environment tables, queues, and buckets.

Most `cdkd local` commands require Docker, and the first run pulls base images (up to ~600 MB). See the [local execution guide](https://github.com/go-to-k/cdkd/blob/main/docs/local-emulation.md) for the full subcommand list (ALB, CloudFront, AgentCore) and flags.

## Command reference

Use the same verified profile, region, state bucket, and binary form throughout a workflow:

```bash
cdkd bootstrap
cdkd synth
cdkd diff <stack>
cdkd deploy <stack> --dry-run
cdkd deploy <stack>
cdkd deploy <stack> --full-wait
cdkd state info
cdkd state show <stack> --stack-region <region>
cdkd events <stack> --stack-region <region>
cdkd drift <stack>
cdkd gc --dry-run
cdkd destroy <stack>
```

Options such as `--app`, `--state-bucket`, and context values may come from CLI flags, environment variables, or `cdk.json`. Inspect the project instead of assuming defaults.

For current command behavior, consult the [README](https://github.com/go-to-k/cdkd/blob/main/README.md), [CLI reference](https://github.com/go-to-k/cdkd/blob/main/docs/cli-reference.md), [state management](https://github.com/go-to-k/cdkd/blob/main/docs/state-management.md), and [import guidance](https://github.com/go-to-k/cdkd/blob/main/docs/import.md).
