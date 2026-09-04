---
title: Drift Detection
description: Detect, accept, or revert divergence between cdkd state and AWS reality with cdkd drift — no synth required.
---

# Drift detection

`cdkd drift` (state-driven; no synth) compares each managed resource
against AWS reality and reports divergence — including console-side
changes to keys you did NOT template (S3 public-access-block, IAM Role
tags, Lambda env keys, etc.).

```bash
cdkd drift                       # auto-detect single stack, exit 1 if drift
cdkd drift MyStack --json        # machine-readable, for CI gating
cdkd drift MyStack --accept --yes   # state ← AWS (catch up after a console edit)
cdkd drift MyStack --revert --yes   # AWS ← state (undo a console edit)
cdkd state refresh-observed MyStack # populate the drift baseline without redeploying
```

## The drift baseline

Drift is compared against **observed state** — the properties cdkd read
back from AWS at deploy time — not against the raw template. Each
`cdkd deploy` refreshes that baseline as it works; for a stack whose
baseline predates observed-state capture (or when you want to reset it
without deploying), `cdkd state refresh-observed` populates it in place.

See **[`cdkd drift`](cli-drift.md)** for the full reference: every flag,
exit codes, how secret and unresolvable references are reported, and the
`--accept` / `--revert` resolution paths.

The deploy-side opt-out that turns baseline capture off —
[`--no-capture-observed-state`](cli-deploy-tuning.md#no-capture-observed-state)
— is documented on the deploy tuning page, along with what drift reports
once capture is off and the v2 → v3 upgrade flow that backfills the
baseline on the first deploy after an upgrade from cdkd earlier than 0.47,
which is where observed-state capture shipped.
