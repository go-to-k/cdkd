---
title: Troubleshooting internals
description: "The mechanisms behind the Troubleshooting entries: lock acquisition, retry schedules, orphan prevention, and proxy handling."
unlisted: true
---

# Troubleshooting internals

The [Troubleshooting](troubleshooting.md) pages give the fix for each error.
This page holds the mechanism behind some of those entries, for someone
changing cdkd or reading a run closely. Nothing here is needed to apply a fix.

## Lock acquisition

`cdkd deploy`, `cdkd rollback` and `cdkd scrub` retry a held lock 3 times at
2-second intervals: 4 attempts, about 6 seconds. Two refinements:

- When an attempt fails but cdkd then finds no lock, the holder released it in
  between. cdkd tries again at once without counting that as a retry, up to 3
  extra attempts per command.
- Past those, an attempt that finds no readable lock waits the same 2 seconds.
  If the last one still fails, the message says `No lock could be read after
  the last failed attempt` instead of naming a holder. A `lock.json` that is
  not a readable lock also fails this way.

The commands that write state without deploying fail fast on contention:
`cdkd destroy`, `cdkd state destroy`, `cdkd import`, `cdkd export`,
`cdkd orphan`, `cdkd drift --accept`, `cdkd drift --revert` and
`cdkd state refresh-observed`. The exception is `cdkd export`'s nested-stack
children, which retry 6 times at 5-second intervals, a ceiling of about 30
seconds.

Nested-stack children are locked separately. A child teardown reached from
`cdkd deploy` (because the template no longer declares the child) or from
`cdkd rollback` fails fast on the child's lock, even though the parent's lock
was acquired with retry.

`cdkd orphan` and `cdkd state orphan` differ in how they treat the lock:

| Command | Lock behaviour |
| --- | --- |
| `cdkd orphan '<path>'...` | Takes the lock; fails fast when it is held |
| `cdkd state orphan '<stack>'...` | Takes no lock; refuses while one is held; `--force` deletes that lock, including a live one |
| `cdkd state orphan '<stack>' --resource <logicalId>` | Takes the lock like `cdkd orphan`; `--force` does not bypass a held one |

### The lock record

`lock.json` holds `owner`, `timestamp`, `expiresAt` and an optional
`operation`. `expiresAt` is what the expiry check, the `expires in` clause of
the error and the renewal loop all read. It is `timestamp` plus the 30-minute
TTL, rewritten every 2 minutes while the holder runs. The TTL therefore
measures silence, not duration: it tolerates fourteen consecutive missed
renewals before it lapses. A truncated `lock.json` with no `expiresAt` is
treated as expired.

### Signals

`deploy`, `destroy`, `state destroy` and `rollback` handle both `SIGINT` and
`SIGTERM`. The first signal finishes in-flight operations, saves state and
releases the lock. On a deploy it also records a rollback journal.

GitHub Actions escalates `SIGINT` to `SIGTERM` about 7.5 s later and to
`SIGKILL` about 2.5 s after that. A job whose in-flight AWS operation outlasts
that window is killed before the lock release runs.

A second signal force-quits with exit `130`. `destroy` and `state destroy`
fire an un-awaited lock release. `deploy` does not attempt one, because a
deploy may hold locks on several stacks. `rollback` has no second-signal path:
further signals are absorbed by its graceful handler, so stopping it takes
`SIGKILL`, and the lock then has to be cleared.

## The state save and its conflict check

The write of `state.json` is guarded by an S3 precondition on the ETag cdkd
read. A conflicting write is refused instead of overwritten, and cdkd does not
retry the save: a re-run re-reads state and plans against whatever the other
writer left. The lock excludes other cdkd processes; the ETag precondition is
a separate guard on the object.

## Cross-region state bucket

When the state bucket is in a different region from the SDK client, S3
answers a HEAD request with an empty-body 301. The AWS SDK v3 region-redirect
middleware does not handle that response, and the protocol parser produces a
synthetic `Unknown` exception with the literal message `UnknownError`.

cdkd avoids the condition by looking up the bucket region with
`GetBucketLocation` (a GET, which does not hit the same path) and rebuilding
its S3 clients for that region. Three components do this before any
operation: the state backend, the lock manager, and the custom-resource
response path that reads the pre-signed `ResponseURL`.

On the state-bucket path cdkd rewrites the synthetic error into a sentence
keyed on the HTTP status, which names the region. The lock path does not
rewrite and surfaces the raw 301.

## How cdkd prevents orphans

1. **In-memory state update per resource.** Each resource updates the
   in-memory state as soon as it is provisioned.
2. **Partial state save per resource.** After each successful resource the
   state is persisted to S3, serialized through a save chain to avoid ETag
   conflicts. A crash mid-deploy therefore loses at most the in-flight
   operations.
3. **Save before rollback.** If a resource fails, cdkd saves the in-memory
   state to S3 before attempting rollback, so resources completed concurrently
   with the failed one are tracked.
4. **Save after rollback.** After rollback completes, or is skipped with
   `--no-rollback`, state is saved again.
5. **Rollback journal.** On a `--no-rollback` failure, an interruption, or
   before an automatic rollback, cdkd writes `rollback-journal.json` beside
   `state.json`, recording which operations completed. `cdkd rollback` replays
   it.

### The journal's lifetime

- The next successful deploy and `cdkd destroy` delete the journal. Each first
  deletes, per its `DeletionPolicy`, any resource a failed create made that
  only the journal records.
- A successful deploy that cannot act on such a resource keeps the journal,
  reduced to that entry where it can. One that a state record may own is
  warned about and left in AWS. Either way the deploy exits `2`.
- After a clean automatic rollback the journal is reduced to a failed-only
  segment instead of deleted. The completed operations are already reverted,
  but the failed resource's pre-operation record is kept so
  `cdkd rollback --revert-failed` can still revert a possibly half-applied
  resource. The next successful deploy clears it.
- An automatic rollback that skipped an operation it could not revert
  (a `ROLLBACK_RESOURCE_SKIPPED` event) is not clean and keeps the full
  journal.
- A nested stack's successful deploy keeps its journal until the top-level
  stack's deploy succeeds, so a failure of the parent can revert the child.

### `cdkd rollback` exit `2`

A partial rollback exits `2`. Besides failed operations (journal kept) and
operations skipped with a warning (segment cleared, `ROLLBACK_RESOURCE_SKIPPED`
recorded), two more cases exit `2`:

- A reverted operation left a resource cdkd no longer tracks: a new copy
  retained by `UpdateReplacePolicy: Retain`, or one whose delete failed. Its
  `ROLLBACK_RESOURCE_SUCCEEDED` event carries the survivor's id and a `reason`.
- A reverse-replacement whose re-create returned the live new resource, so the
  replacement was not fully reversed. Its event carries a `reason` only.

## Retry schedules

cdkd retries create, update and delete operations during `cdkd deploy` and
the replays performed by `cdkd rollback` and `cdkd drift --revert`. The
schedule is chosen per error class.

| Class | Schedule | Retries | Sleep |
| --- | --- | --- | --- |
| Throttling and transient | `1s, 2s, 4s, 8s, 8s, 8s, 8s, 8s` | 8 | 47s |
| IAM propagation | `0.25s, 0.5s, 1s, 2s, 2s, ...` | 26 | 47.75s |
| Name cooldown | `2s, 4s, 8s, 10s, 10s, 10s, 10s, 10s` | 8 | 64s |

**Throttling and transient** covers rate limits, a resource still leaving
`Pending`, an async delete releasing a dependency, and HTTP 500 / 502 / 503 /
504, the same four the AWS SDK's own retry strategy treats as transient.

**IAM propagation** covers `Invalid IAM Instance Profile`, `cannot be
assumed`, `not authorized to perform`, `Policy Error: PrincipalNotFound`,
`not authorized to access the Log Destination`, `does not have a trust
relationship allowing` and similar. A message that also says `with an explicit
deny` is excluded and not retried at all: a policy's `Deny` does not
propagate away ([#4969](https://github.com/go-to-k/cdkd/issues/4969)). cdkd creates an IAM entity and consumes it
one to three seconds later, faster than IAM propagates, and this class usually
resolves in single-digit seconds. The dense schedule re-probes about every 2
seconds instead of idling through a 4s or 8s step. Its window is slightly
longer than the generic one, so nothing that recovers under the generic
schedule stops recovering.

A few of these patterns are also emitted for permanent problems. On those the
budget is spent and the permanent failure surfaces afterwards. The Step
Functions log-destination rejection is the main example.

**Name cooldown** covers `QueueDeletedRecently`, Step Functions'
`StateMachineDeleting` and S3's `conflicting conditional operation`. It is a
separate class because SQS's own message names a 60-second window, and a 47s
budget against a 60s window does not converge.

### Counters on the give-up line

- The seconds on the line count propagation backoff only. An interleaved
  throttle's own wait is excluded, so the figure compares against the 47.75s
  budget and is not total elapsed time.
- A throttle mid-sequence consumes an attempt without counting as a
  propagation retry, so the budget can run out at 25 or fewer retries.
- A sequence that spent its budget on transient server errors says
  `transient server-error retries (HTTP 5xx)`, and a mixed one reports both.
- A rollback's reverse-replacement re-create, the arm that revives the old
  resource after a replacement failed, retries on the same dense schedule and
  prints the same line.

### Providers outside the outer retry

`Custom::*` / `AWS::CloudFormation::CustomResource` and
`AWS::CloudFormation::Stack` are never wrapped by the outer schedule, so no
give-up line is produced for them. A custom resource's Lambda handler is an
ordinary `AWS::Lambda::Function` and does retry on the outer schedule.

The custom-resource provider retries internally, on two separate budgets:

| Failure | Budget |
| --- | --- |
| The handler returns `FAILED` with an authorization-shaped reason | `CDKD_CR_AUTHZ_MAX_RETRIES` re-invocations (default 2, clamped to 10) |
| An authorization-shaped error thrown by an SDK call the provider makes before the request reaches the handler | 26 retries over 47.75s, as the outer schedule |

A re-invocation re-runs the user's handler, so that budget stays small. A
pre-delivery throw reached no handler. `CDKD_CR_AUTHZ_MAX_RETRIES=0` disables
re-invocations only; it does not disable the pre-delivery retry or the retry
of the response-placeholder `PutObject`.

Two cases are never replayed:

- A throw after the invoke was accepted. The handler is running and will write
  to that attempt's response URL.
- The readiness waiters, which have already polled `lambda:GetFunction` for
  their own 600 seconds. A permanent denial there surfaces after one waiter
  timeout.

`AWS::CloudFormation::Stack` has no internal retry.

### Cloud Control polling

Polling is a different mechanism from the retry above. It waits for an
accepted operation to finish, on a `1s, 1.5s, 2.25s, 3.4s, 5.1s, 7.6s, 10s`
schedule (a 1.5x multiplier capped at 10s), against a 15-minute deadline. The
deadline is longer for known-slow types such as OpenSearch domains and RDS,
Redshift and ElastiCache clusters.

When cdkd cannot reach Cloud Control, the AWS SDK retries a few times and cdkd
re-polls the same request token for up to two more minutes. For the
deletion-protection flip that `cdkd destroy --remove-protection` does first,
the allowance is ten seconds, since that step is best-effort and the delete
reports on it. A local-address failure (`EADDRNOTAVAIL`, seen under heavy
parallel load) is treated like an outage: checking the status is a read, so
cdkd re-polls.

## Routing between the SDK provider and Cloud Control

A resource recorded `provisionedBy: cc-api` stays on Cloud Control on later
deploys. A cdkd release that adds SDK coverage for the property that sent it
there does not move it back by itself, because doing so for every type would
mean destroy-and-recreate churn on each release.

Types carrying an `'sdk-coverage'` exemption are the exception: Cloud Control
manages the type but is slower, and cdkd covers every property the resource
uses, so the next mutating deploy moves it back in place. For
`AWS::ElasticLoadBalancingV2::Listener`, Cloud Control also leaves a removed
`ListenerAttributes` key at its old value.

`cdkd diff` annotates routing with `[via CC API: <property>]`,
`[via CC API: sticky]` and `[returning to SDK provider]`. The last one does
not share the `via CC API:` prefix because the resource is leaving Cloud
Control.

A type exempt for the opposite reason, because Cloud Control cannot manage it
correctly, moves for correctness, logs a different line and ignores
`--pin-cc-api`.

## Ambiguous creates

The AWS SDK retries HTTP 5xx responses by default. For create calls that carry
no idempotency token, cdkd turns that retry off so the failure reaches its own
retry, which first looks for what the failed attempt may have made.

`CreateDistribution` is handled through `CallerReference`, CloudFront's
idempotency key. cdkd sends a value that is stable across every attempt of
one logical create, so CloudFront refuses the replay. The first attempt's
distribution cannot be adopted: `ListDistributions` returns `Comment` but not
`CallerReference`, and `GetDistribution` needs the `Id` the lost response
carried.

## Proxy handling

The AWS SDK for JavaScript v3 does not read the proxy environment variables
the way botocore (the AWS CLI) and Go's `net/http` do. Its
[guide](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/node-configuring-proxies.html)
states that a proxy is supplied "through a third-party HTTP agent" by whoever
constructs the client. cdkd therefore installs a routing agent on every SDK
client it builds.

Node's `NODE_USE_ENV_PROXY=1` is not a substitute. It rewires the global
agent, while every SDK client builds its own.

On spelling precedence, the AWS CLI prefers the lower-case variable as cdkd
does, while Go's `net/http` prefers the upper-case one.

A CIDR entry in `NO_PROXY` is ignored because a hostname never contains `/`,
so the entry falls into the exact-match branch and can never match.

## Related

- [Troubleshooting](troubleshooting.md)
- [State Store](state-management.md)
- [Roll Back a Failed Deploy](rollback.md)
- [Provisioning Layers](provisioning-layers.md)
