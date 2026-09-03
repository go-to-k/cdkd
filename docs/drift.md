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

See **[cli-reference.md `cdkd drift`](cli-reference.md#cdkd-drift)**
for the full reference: `--no-capture-observed-state` deploy opt-out
(per-command vs per-project, mid-flight reversibility), v2→v3 state
upgrade flow, exit codes, and what changes when capture is off.
