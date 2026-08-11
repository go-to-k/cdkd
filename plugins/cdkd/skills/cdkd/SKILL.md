---
name: cdkd
description: Install cdkd and use it safely from an AWS CDK project. Use when bootstrapping, synthesizing, diffing, deploying, inspecting, rolling back, migrating, or destroying dev/test stacks with cdkd.
---

<!--
  This file is the DISTRIBUTED end-user skill, installed via the Claude Code
  plugin marketplace (`/plugin install cdkd@cdkd`), `gh skill`, or `npx skills`.
  It ships together with the repo-internal contributor skill at
  .claude/skills/use-cdkd/SKILL.md, which defers to this file for the
  safe-usage flow. When cdkd CLI behavior changes, update this file AND bump
  the `version` fields in plugins/cdkd/.claude-plugin/plugin.json and
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

For a proposed CloudFormation migration, read the deployed CloudFormation template and compare its logical IDs with the current synthesized template so local changes do not accidentally leave retained resources unmanaged. Preview resource matching with the non-migrating form:

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> cdkd import <stack> --dry-run
```

`--migrate-from-cloudformation` itself is intentionally incompatible with `--dry-run`: it writes cdkd state, adds retain policies, and retires the CloudFormation stack record. Do not bootstrap, import, or migrate until the user approves that ownership-change plan.

## Check compatibility and bootstrap

Run the project's normal CDK synthesis or tests first. Then have cdkd synthesize the same app:

```bash
cdk synth <stack>
cdkd synth
```

`cdkd synth` validates the synthesized app and does not accept a stack selector.

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

## Guard destructive and migration commands

Before `destroy`, `state destroy`, `orphan`, `import`, `export`, `drift --accept`, or `drift --revert`:

1. Re-resolve the AWS identity, region, stack name, and current owner.
2. Show the exact command and explain which resources or state records change.
3. Check retention, snapshots, backups, and downstream consumers.
4. Obtain explicit user confirmation immediately before execution.

Do not use `--force`, `--yes`, `--purge-events`, or other confirmation-bypassing flags unless the user approved that exact destructive scope.

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
cdkd destroy <stack>
```

Options such as `--app`, `--state-bucket`, and context values may come from CLI flags, environment variables, or `cdk.json`. Inspect the project instead of assuming defaults.

For current command behavior, consult the [README](https://github.com/go-to-k/cdkd/blob/main/README.md), [CLI reference](https://github.com/go-to-k/cdkd/blob/main/docs/cli-reference.md), [state management](https://github.com/go-to-k/cdkd/blob/main/docs/state-management.md), and [import guidance](https://github.com/go-to-k/cdkd/blob/main/docs/import.md).
