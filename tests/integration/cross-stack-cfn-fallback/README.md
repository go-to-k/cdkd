# CloudFormation-fallback cross-stack references (issue #1697)

This integ test exercises the CloudFormation fallback for cross-stack
references: a **cdkd-deployed consumer** references a producer stack that
is **managed by CloudFormation only** (created with raw
`aws cloudformation deploy`, never touched by cdkd — it has NO cdkd state
record), via BOTH intrinsics:

- `Fn::ImportValue 'CdkdCfnFallbackExport'` — resolved through the
  CloudFormation `ListExports` fallback after the cdkd exports index +
  state scan miss.
- `Fn::GetStackOutput { StackName: 'CdkdCfnFallbackProducer', OutputName:
  'SharedValue' }` — resolved through the CloudFormation `DescribeStacks`
  outputs fallback after the cdkd state read misses.

This is the mixed-estate scenario cdkd is positioned for: shared
infrastructure stays on the CDK CLI / CloudFormation while app stacks
deploy via cdkd.

## What verify.sh proves

1. **Both fallbacks resolve the CURRENT values.** The producer's output
   values carry a per-run suffix (fixed names, fresh values), and the
   consumer's two SSM parameters must land with exactly those values —
   a stale leftover from a prior run cannot satisfy the assertions.
2. **Weak-reference contract.** The consumer's `state.json` records NO
   `imports[]` and NO `outputReads[]` entries for the CFn-sourced
   resolutions (cdkd cannot destroy-protect a producer it does not
   manage).
3. **`--no-cfn-fallback` opt-out (live).** Re-deploying the consumer
   with the flag must FAIL at resolve time with the cdkd-state-only
   not-found error, and that error must not claim CloudFormation was
   searched.
4. **Clean teardown.** `cdkd destroy` removes the consumer's parameters
   and state; `aws cloudformation delete-stack` removes the producer.

The producer template's only resource is an
`AWS::CloudFormation::WaitConditionHandle` (free, nothing to leak); the
interesting surface is its `Outputs` / `Export`.
