# termination-protection

Real-AWS integ for stack-level `terminationProtection` (issue
[#5238](https://github.com/go-to-k/cdkd/issues/5238)).

Stack: `CdkdTerminationProtection`, one `ssm.StringParameter`. The run uses the
non-default state prefix `cdkd-integ-termination-protection`.

## What it exercises

`terminationProtection` is set from the CDK code (`true`, unless
`CDKD_TEST_UPDATE=true` flips it off — nothing else about the stack changes
between those two modes). `verify.sh` asserts:

1. Deploying with it `true` records `terminationProtection: true` in the
   state file.
2. `cdkd destroy --force` refuses (exit 2); the parameter is untouched.
3. `cdkd state destroy` (no CDK app, driven from the state record alone)
   refuses the same way (exit 2), and the refusal names `--remove-protection`
   as the bypass; the parameter and the state record are both untouched.
4. Redeploying with `terminationProtection` turned off in code (the only
   change) clears the recorded flag — the state record no longer carries the
   key at all.
5. Turning it back on and redeploying restores `terminationProtection: true`.
   `cdkd state destroy --remove-protection` then succeeds (exit 0) and removes
   both the parameter and the state record.

## Run

```bash
/run-integ termination-protection
```
