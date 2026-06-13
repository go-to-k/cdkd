# IAM Propagation Stress Example

A **race detector** for IAM-propagation bugs on cdkd's fast SDK path.

cdkd creates an IAM role and then has a service assume it within ~1 second,
before IAM finishes propagating the just-created role / its trust policy.
CloudFormation never hits this because its deployment latency lets IAM settle;
cdkd does **not**, so every "role created -> assumed within ~1s" edge is a
potential failure. The race is already handled **narrowly** for a few
consumers — RDS Enhanced Monitoring ([#794](https://github.com/go-to-k/cdkd/issues/794)),
ECS CapacityProvider ([#805](https://github.com/go-to-k/cdkd/issues/805)),
Custom Resource ([#756](https://github.com/go-to-k/cdkd/issues/756)) — but
**many other consumers are unprotected**.

This single stack creates SEVERAL brand-new IAM roles, each consumed
IMMEDIATELY by a DIFFERENT service in one deploy, so the DAG carries many
independent fresh-role-immediate-assume edges at once. The more such edges run
concurrently in one deploy, the higher the chance an unprotected consumer
races IAM propagation and the deploy fails.

## Stack

`CdkdIamPropagationStressExample` contains four race edges:

| Edge | Fresh role | Immediate consumer | What AWS validates at create time |
|------|------------|--------------------|-----------------------------------|
| 1 | `WorkerLambdaRole` (explicit, not the implicit CDK-managed role) | `WorkerFn` (`AWS::Lambda::Function`) | `CreateFunction` validates the role can be assumed by `lambda.amazonaws.com` |
| 2 | `StateMachineRole` | `StressStateMachine` (`AWS::StepFunctions::StateMachine`) | `CreateStateMachine` validates the role trust + permissions (the SFN provider has **no** propagation retry of its own) |
| 3 | EventBridge target role (CDK auto-created for the SFN target) | `StressRule` (`AWS::Events::Rule`) with an SFN target | `PutTargets` validates the rule can assume the target role to `StartExecution` |
| 4 | `PublisherRole` (fresh principal) | `StressQueue` `AWS::SQS::QueuePolicy` + `StressTopic` `AWS::SNS::TopicPolicy` | the resource-policy PUT validates the principal ARN |

Everything is cheap and deployable: **no VPC, no NAT, no long-lived compute**.
The point is breadth of fresh-role edges, not resource count. The EventBridge
rule is `enabled: false` on a 365-day schedule so it never actually fires (no
per-minute cost / no spurious executions) — but `PutTargets` still validates
the fresh target role at create time, which is the race we want.

Every resource carries a `cdkd:integ-fixture=iam-propagation-stress` tag (cdkd
does **not** apply `aws:cdk:path`, so the fixture owns this tag).

## The pass condition

**Deploy SUCCEEDS.** A deploy failure here is a real cdkd finding — an
unprotected consumer raced IAM propagation. `verify.sh` therefore prints WHICH
resource failed plus the error (deploy log tail + `cdkd events` per-resource
`RESOURCE_FAILED` lines + the partial state's `logicalId -> type` map) so
triage is trivial, then still attempts destroy / cleanup.

## What `verify.sh` asserts

1. **Deploy succeeds** — all four fresh-role edges create without an
   IAM-propagation failure (the race-detecting step).
2. **Each role consumer works**:
   - invoke the Lambda and assert its marker (edge 1 — fresh exec role
     assumed cleanly);
   - `start-execution` + poll `describe-execution` to `SUCCEEDED` (edge 2 —
     fresh SFN role works AND the SFN -> Lambda invoke grant works);
   - `list-targets-by-rule` shows the SFN target bound to a role (edge 3 —
     `PutTargets` accepted the fresh target role);
   - the SQS queue + SNS topic both carry a non-empty resource policy (edge 4
     — the fresh principal did not bounce).
3. **Destroy is clean** — the Lambda, state machine, rule, queue, topic, and
   state file are each asserted GONE from AWS (state-empty alone can miss an
   orphan carrying no stack name).

The script is BSD/macOS-portable (no `grep -P`, no `date -d`), recovers the
real deploy exit code from `PIPESTATUS` (so a `tee`'d non-zero is not masked),
and prints `[verify] PASS` only on full success. An EXIT trap aggressively
sweeps leftover state, the lock, and the deployment-events sidecar.

## Run

```bash
/run-integ iam-propagation-stress
```
