# lambda-env-removal

cdkd nested-map-key removal integration test (Lambda environment variable).

A Lambda's `Environment.Variables` is a **nested map**. Removing a key from it
must reach AWS (`UpdateFunctionConfiguration` replaces the whole env map). cdkd
previously compared the nested map **asymmetrically** (only the new-side keys),
so a key present only in the old (state) side — a genuine removal — compared
equal (`NO_CHANGE`) and never re-provisioned, leaving the dropped env var live on
the function. Top-level property removal and array-element removal were already
detected; only nested-map-key removal was missed. Found by the 2026-06-29
bug-hunt sweep (Round 6).

The fix makes `valuesEqual`'s object compare **symmetric** (a key-count mismatch
is a real add or remove). cdkd stores the resolved template properties in
`state.properties` (AWS-observed defaults live in the separate
`observedProperties`), so old-side keys are template-derived too — a mismatch is
a genuine change, not an AWS default.

## What it covers

- `AWS::Lambda::Function`

## Phases

1. **Deploy** with env `{KEEP, TOREMOVE}` — assert both present on AWS.
2. **Re-deploy** with `CDKD_TEST_UPDATE=true` (env `{KEEP}`) — assert `TOREMOVE`
   is **gone** from AWS and `KEEP` remains (a pre-fix run leaves `TOREMOVE` live).
3. **Destroy** — assert the function is gone and the cdkd state file is removed.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```
