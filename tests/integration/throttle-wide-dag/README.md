# throttle-wide-dag

Failure-seeking integration test that stresses cdkd's **concurrency limiter**
(`src/deployment/dag-executor.ts`), its **throttle / retry classifier**
(`src/deployment/retryable-errors.ts` + `src/deployment/retry.ts`), and the
**event-driven DAG executor** at SCALE.

## Background

cdkd dispatches every ready resource as soon as its dependencies complete,
bounded only by `--concurrency` across the whole stack. A wide stack — many
independent resources created in one burst — is the case most likely to trip
an AWS-side rate limit (`TooManyRequestsException` / `Rate exceeded`, surfaced
as HTTP 429). The retry helper classifies 429 (and 503) as transient and backs
off (`1s -> 2s -> 4s -> 8s`, capped). This fixture exists to verify that a
throttle during a large burst is RETRIED (the deploy still succeeds) rather
than treated as fatal — and to surface DAG-scheduling or partial-failure bugs
that only appear at scale.

The resources are deliberately CHEAP, fast, and quota-friendly so the fixture
can run at ~100 resources without cost or quota blow-ups. No VPC — every
resource is a control-plane-only create.

## Fixture

`CdkdThrottleWideDagExample` (`lib/throttle-wide-dag-stack.ts`) — ~100 resources:

| Type | Count | Role |
| --- | --- | --- |
| `AWS::SSM::Parameter` | 80 | Fast, high create rate -> most likely to throttle |
| `AWS::IAM::Role` | 10 | Broadens the throttle surface to a second service |
| `AWS::SNS::Topic` | 10 | Third service in the burst |

### DAG shape

- **Independent set (throttle pressure):** 70 of the 80 parameters + all 10
  roles + all 10 topics have NO dependencies, so they form one large ready-set
  the executor sheds across the `--concurrency` budget at once.
- **Chained subset (DAG depth):** 10 parameters form a serial chain
  `ChainParam0 -> ChainParam1 -> ... -> ChainParam9`. Each `ChainParam(K)` (K>=1)
  embeds the previous parameter's name via `Fn::Sub`, creating an implicit Ref
  edge. cdkd must serialize the chain in strict order while everything else
  runs in parallel — a scheduling bug (dispatching a child before its parent
  completes) would surface as a deploy ordering failure.

## Automated run (`verify.sh`)

Env: `AWS_REGION` (default `us-east-1`), `STATE_BUCKET` (required),
`CDKD_CONCURRENCY` (default `40` — intentionally high vs. the `10` default to
maximise throttle pressure).

1. Install fixture deps (`pnpm install --ignore-workspace`).
2. **Deploy** all ~100 resources with `--concurrency 40 --verbose`.
   - Prints any `⏳ Retrying ... / TooManyRequests / Rate exceeded / 429`
     activity observed (documents that the retry path was exercised when AWS
     throttled — throttling is probabilistic, so a clean run is also valid).
   - Asserts the deploy exited **0**. A non-zero exit on a throttle means the
     classifier did NOT retry it -> a **real finding**; the throttle error is
     printed.
3. Asserts all resources reached AWS:
   - cdkd state records exactly 100 resources.
   - 80 SSM parameters under `/CdkdThrottleWideDagExample/` (paginated count).
   - The deepest chain parameter (`/.../chain/9`) holds a `child-of-...`
     `Fn::Sub` value -> the executor serialized the chain in DAG order.
   - 10 IAM roles + 10 SNS topics exist.
4. **Destroy** all ~100 resources with the same high `--concurrency` and assert
   the delete burst also exits 0 (the destroy path must absorb ~100 deletes
   without throttle-failing).
5. Asserts **0 orphans**: 0 SSM parameters / 0 IAM roles / 0 SNS topics remain,
   and the cdkd state file is gone.

`verify.sh` is BSD-portable (no `grep -P`, no `date -d`), captures the real
deploy/destroy exit codes, and ends with an explicit PASS line.

Run via the skill: `/run-integ throttle-wide-dag`.

## Scenario tag

`wide-dag-throttle-retry` (see `.scenarios.json`).
