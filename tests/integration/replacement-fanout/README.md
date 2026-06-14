# Replacement Fan-out Propagation Example (issue #807)

Stresses cdkd's replacement-propagation (`promoteReplacementDependents` in
`src/analyzer/diff-calculator.ts`) at **fan-out scale**. Issue #807 fixed the
basic case on ECS (a replaced `TaskDefinition`'s new revision is picked up by
its dependent `Service`). That fix was verified with a single dependent. This
fixture exercises the SAME propagation with **one base resource referenced by
many (10) dependents**, so a partial-propagation gap — any single dependent
left pointing at the stale value — is surfaced and pinpointed.

## What it tests

The stack reads `-c phase=a|b` at synth time, so a second deploy with
`-c phase=b` synthesizes a mutated template with no code change.

### Base resource (replaced on phase b)

| Resource | Type | Property changed | Effect |
| --- | --- | --- | --- |
| `BaseTopic` | `AWS::SNS::Topic` | `TopicName` suffix `-a` -> `-b` | **replacement** — new topic ARN |

`TopicName` is in the SNS entry of cdkd's replacement-rules registry
(`src/analyzer/replacement-rules.ts`), so changing it forces delete + recreate
and yields a new physical id. For SNS, `Ref` resolves to the topic ARN.

### Dependents (each must pick up the new ARN)

| Resource | Type | Reference shape | Expected on phase b |
| --- | --- | --- | --- |
| `Dependent0` .. `Dependent9` | `AWS::SSM::Parameter` (10x) | `Value` = `Fn::Sub("arn=<topicArn>\|idx=N", { arn: Ref(BaseTopic) })` | in-place `Value` update — SAME parameter id, NEW ARN embedded |
| `BaseTopicPolicy` | `AWS::SNS::TopicPolicy` | policy `Resource` = `Ref(BaseTopic)` ARN | re-points at the new topic ARN |

The dependents are **auto-named** (no explicit `Name`), so they keep their
physical id across the flip; only the resolved ARN inside changes. Each
parameter's `Value` embeds its index, so a dependent that kept a stale ARN is
trivially attributable.

No VPC. All resources are cheap and free (SNS topic + SSM `String` parameters +
a topic policy).

## Verify

```bash
export STATE_BUCKET="cdkd-state-<accountId>"
export AWS_REGION="us-east-1"
bash verify.sh
```

`verify.sh`:

1. installs fixture deps + expects the cdkd binary built at `../../../dist/cli.js`.
2. **Phase a** deploys with `-c phase=a` and captures the base topic ARN plus
   every dependent's AWS-resolved `Value` (baseline asserts all embed the
   phase-a ARN, and the `TopicPolicy` references it).
3. **Phase b** redeploys with `-c phase=b` (forces base replacement) and asserts:
   the base topic ARN CHANGED with the old topic gone and the new present;
   **every** dependent parameter re-resolved to the NEW ARN (any dependent left
   on the stale phase-a ARN FAILS, naming its index — a #807 fan-out gap); each
   parameter kept its physical id; the `TopicPolicy` re-points at the new ARN.
4. **Destroy** asserts the state file, base topic, and every dependent parameter
   are gone (no orphans).
5. prints `[verify] PASS` on success.
