---
title: Orphan vs Destroy
description: "cdkd destroy deletes AWS resources and cdkd state; cdkd orphan removes only the state record — per resource or per stack — leaving the AWS resources intact."
---

# Orphan vs Destroy

`destroy` deletes the AWS resources **and** the state record;
`orphan` deletes **only** the state record (AWS resources stay
intact, just no longer tracked by cdkd). Mirrors aws-cdk-cli's
`cdk orphan`.

Two `orphan` variants at different granularities:

- `cdkd orphan <constructPath>...` — synth-driven, **per-resource**.
  Rewrites every sibling reference (Ref / Fn::GetAtt / Fn::Sub /
  dependencies) so the next deploy doesn't re-create the orphan.
- `cdkd state orphan <stack>...` — state-driven, **whole-stack**.
  Removes the entire state record. Works without the CDK app.

Both `cdkd destroy` (synth-driven) and `cdkd state destroy`
(state-driven, no synth) delete AWS resources + state.

See [`cdkd state`](cli-state.md) for the flags, prompts, and exit codes of the
two state-driven commands, and [State Store](state-store.md) for why they can
run without a CDK app at all.
