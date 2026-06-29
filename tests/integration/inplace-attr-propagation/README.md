# inplace-attr-propagation

cdkd in-place upstream-attribute propagation integration test.

`Derived`'s value embeds `Fn::GetAtt[Base, Value]` (via `Fn::Sub`). When `Base` is
updated **in place** (its `Value` property changes, same physical id), the
resolved value of `Derived` changes too — CloudFormation re-evaluates and updates
`Derived`. cdkd previously resolved `Derived`'s GetAtt against the **current**
state at diff time, so `Derived` compared equal (`NO_CHANGE`) and never
re-provisioned, keeping the **stale** upstream value. Found by the 2026-06-29
bug-hunt sweep (Round 2).

The fix has two parts (both in `src/analyzer/diff-calculator.ts`):

1. `promoteInPlaceAttributeDependents` promotes a `NO_CHANGE` dependent to
   `UPDATE` when it reads (via `Fn::GetAtt` / `Fn::Sub` `${X.Attr}`) an attribute
   whose name matches a property that actually changed in the upstream's in-place
   update. (A plain `Ref` — the physical id, unchanged in place — or a GetAtt of
   an unchanged/computed attribute is correctly left `NO_CHANGE`.)
2. `resolveBestEffort` resolves a **clone** of each property, so the intrinsic
   resolver no longer mutates the shared desired template in place — the raw
   `Fn::GetAtt` survives for the deploy phase, which re-resolves it against the
   in-flight state where the upstream now holds its **new** value.

## What it covers

- `AWS::SSM::Parameter`

## Phases

1. **Deploy** `Base=world` — assert `Derived = "hello-world"`.
2. **Re-deploy** with `CDKD_TEST_UPDATE=true` (`Base=world2`) — assert `Derived`
   becomes `"hello-world2"` in the **same** deploy (a pre-fix run leaves it
   `"hello-world"`).
3. **Destroy** — assert both parameters are gone and the cdkd state file is
   removed.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```
