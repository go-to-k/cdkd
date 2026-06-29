# cdk-vs-cdkd demo GIF

Source files for `assets/cdk-vs-cdkd.gif` — the side-by-side `cdk deploy` vs `cdkd deploy` demo shown in the project README.

## What gets recorded

- **Left pane**: `cdkd deploy CdkdDemoCdkd -a cdk.out` (the featured tool, so left-to-right readers hit its "finished" punchline first).
- **Right pane**: `cdk deploy CdkdDemoCdk -a cdk.out`.
- Same 5-resource stack (S3 / DynamoDB / SQS / SNS / SSM), each deployed to a separate stack name so they don't collide in AWS.
- Recording ends after 35 seconds — by then cdkd has finished and printed `real Xs` (timing proof from `time(1)`), while cdk is still mid-deploy. The contrast IS the visual claim.

## Reproducing

Prerequisites: AWS credentials, [`vhs`](https://github.com/charmbracelet/vhs) (`brew install vhs`), `tmux`, JetBrainsMono Nerd Font, and the [cdkd CLI](../../README.md#installation) on PATH.

```bash
cd assets/demo-gif
pnpm install
cdk bootstrap        # one-time per account/region

# Pin an older cdk CLI for the right pane: newer `cdk deploy` output prints
# the change-set ARN (which embeds the AWS account id) and extra asset-publish
# log lines. The pin keeps the recorded output clean and account-id-free.
# run.sh also exports LANG/LC_ALL=en_US.UTF-8 so tmux renders cdkd's multibyte
# glyphs (the ✓/✗ marks, ─ rules, ✨ emoji) instead of substituting `_`.
CDK_BIN="npx -y aws-cdk@2.1116.0" vhs cdk-vs-cdkd.tape # generates ../cdk-vs-cdkd.gif

# clean up AWS resources after recording (both stacks finish naturally)
npx -y aws-cdk@2.1116.0 destroy CdkdDemoCdk --force
cdkd destroy CdkdDemoCdkd --yes
```

`cdk-vs-cdkd.tape` is the [vhs](https://github.com/charmbracelet/vhs) script (theme, font, layout, timing). `run.sh` is the tmux orchestrator that places `cdkd` and `cdk` in side-by-side panes (it reads `CDK_BIN` for the pinned cdk, defaulting to `cdk`). `tmux-clean.conf` strips the tmux status bar and adds pane titles so the recording looks polished.

## Costs

Both deploys provision real AWS resources (5 each, all `RemovalPolicy.DESTROY`). Cost is well under \$0.10 per recording iteration. Destroy immediately after each run.
