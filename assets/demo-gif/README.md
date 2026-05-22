# cdk-vs-cdkd demo GIF

Source files for `assets/cdk-vs-cdkd.gif` — the side-by-side `cdk deploy` vs `cdkd deploy` demo shown in the project README.

## What gets recorded

- **Left pane**: `cdk deploy CdkdDemoCdk --require-approval never`
- **Right pane**: `cdkd deploy CdkdDemoCdkd --yes`
- Same 5-resource stack (S3 / DynamoDB / SQS / SNS / SSM), each deployed to a separate stack name so they don't collide in AWS.
- Recording ends after 35 seconds — by then cdkd has finished and printed `real Xs` (timing proof from `time(1)`), while cdk is still mid-deploy. The contrast IS the visual claim.

## Reproducing

Prerequisites: AWS credentials, [`vhs`](https://github.com/charmbracelet/vhs) (`brew install vhs`), `tmux`, JetBrainsMono Nerd Font, and the [cdkd CLI](../../README.md#installation) on PATH.

```bash
cd assets/demo-gif
pnpm install
cdk bootstrap        # one-time per account/region
vhs cdk-vs-cdkd.tape # generates ../cdk-vs-cdkd.gif

# clean up AWS resources after recording (both stacks finish naturally)
cdk destroy CdkdDemoCdk --force
cdkd destroy CdkdDemoCdkd --yes
```

`cdk-vs-cdkd.tape` is the [vhs](https://github.com/charmbracelet/vhs) script (theme, font, layout, timing). `run.sh` is the tmux orchestrator that places `cdk` and `cdkd` in side-by-side panes. `tmux-clean.conf` strips the tmux status bar and adds pane titles so the recording looks polished.

## Costs

Both deploys provision real AWS resources (5 each, all `RemovalPolicy.DESTROY`). Cost is well under \$0.10 per recording iteration. Destroy immediately after each run.
