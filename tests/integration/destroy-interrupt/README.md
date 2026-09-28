# destroy-interrupt

Integration test for the **graceful-SIGINT destroy path** (issue
[#816](https://github.com/go-to-k/cdkd/issues/816)) and the
**Custom-Resource replay fail-fast** (issue
[#804](https://github.com/go-to-k/cdkd/issues/804)). Both shipped with
unit + clean-destroy coverage only; this fixture is their first
end-to-end real-AWS verification. It also carries the refusal of
`destroy --all` and wildcard patterns when the app cannot be synthesized
(issue [#3839](https://github.com/go-to-k/cdkd/issues/3839)).

## Setup

- VPC with two isolated subnets (no NAT / IGW; cheap, but VPC + subnets +
  SecurityGroup + the Lambda hyperplane ENI must delete in order, so the
  destroy spans several seconds — long enough for a mid-destroy SIGINT to
  land during deletion)
- S3 Gateway VPC endpoint (free) so the VPC-attached Lambda can PUT to
  the cfn-response pre-signed S3 URL without internet egress
- VPC-attached Lambda (`HandlerFn`) backing a `cdk.CustomResource`
  (`CrProbe`) — on a destroy re-run the backing Lambda may already be
  gone, which is exactly the #804 case
- Four `AWS::SSM::Parameter` resources padding the delete loop so the
  SIGINT reliably lands while deletion is in flight, and confirming
  partial-destroy state preservation

## Behavior under test

### #816 — first Ctrl-C is graceful

A first `kill -INT` mid-destroy must:

1. stop scheduling new deletes (drain),
2. let in-flight `provider.delete` calls finish,
3. flush the trimmed incremental state (state PRESERVED, not deleted),
4. RELEASE the stack lock, and
5. exit non-zero.

Pre-fix the process died mid-destroy: the lock was stranded for its
30-minute TTL and the `finally` cleanup never ran.

### #804 — re-run does not stall on the Custom Resource

On a re-run after a first interrupted/partial destroy, replaying the CR
delete used to stall ~10 minutes invoking `GetFunction` against the
backing Lambda the first run already deleted. The fail-fast +
incremental destroy persistence make the re-run resume cleanly and
quickly.

### #3839 — no synthesized app, no app scope

With an app that cannot be synthesized, `destroy --all` and a wildcard
used to fall back to every stack record in the state bucket, other apps'
included. Both must exit 1 before any prompt, lock or delete, surfacing the
synth error, while an exact stack name still reaches the state fallback.

## What `verify.sh` asserts

1. **Deploy** clean; state file present.
2. **No app scope** (`--app` pointed at a command that exits 3):
   `destroy '<stack>*'` exits 1, naming the pattern and the synth error
   (`Caused by: CDK app exited with code 3`); the state object's ETag is
   unchanged, no lock object is left and the backing Lambda is still
   present. `destroy --all` and an exact-name control run under a fresh,
   EMPTY `--state-prefix`, so a regressed `--all` can never reach another
   stack: `--all` exits 1 with the same refusal, and the exact name exits 0
   (`No matching stacks found in state`) instead of being refused.
3. **First Ctrl-C**: launch `cdkd destroy --force` in the background,
   poll its log for delete-loop evidence (bounded ~30s), send ONE
   `kill -INT`. When the interrupt lands mid-destroy: (a) the drain
   notice is logged, (b) the lock object is GONE (released), (c) the
   state file is PRESERVED (trimmed, lists the not-yet-deleted
   resources). If the destroy finishes before the interrupt can land (a
   fast-account race), that is logged and accepted — the run falls
   through to the clean-end asserts instead of hard-failing.
4. **Re-run**: `cdkd destroy --force` again to completion — exits 0
   (clean resume), finishes in < 180s (no 10-minute CR stall), and the
   log carries no `Pending` / long-Lambda-waiter signature.
5. **Clean end-state**: state + lock gone; backing Lambda gone; VPC gone
   (subnets / SG / ENI implicitly cleared); no leftover ENIs; no
   leftover SSM parameters.

The SIGINT timing is robust to races: the contract under test (lock
released + state preserved on interrupt) is only asserted when an
interrupt actually lands; a too-fast destroy is an acceptable
non-interrupt outcome.

## Run

```bash
# Use /run-integ from a Claude Code session (preferred):
/run-integ destroy-interrupt

# Or directly:
AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> bash verify.sh
```

## Scenarios

- `destroy-interrupt` — graceful SIGINT (#816) + CR replay fail-fast (#804) + no app scope without a synthesized app (#3839)
- `custom-resource-async-poll` — Lambda-backed CR via cfn-response S3 URL
- `vpc-lambda-eni-release` — Lambda hyperplane ENI cleanup on destroy
