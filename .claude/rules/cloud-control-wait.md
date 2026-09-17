---
description: Why a Cloud Control poll failure must never be answered by a new RETRYABLE_ERROR_MESSAGE_PATTERNS entry, what waitForOperation does instead, and the CloudControlWaitAbandonedError contract
paths:
  - 'src/deployment/retryable-errors.ts'
---

# `waitForOperation`: the poll's transport fence

Issue [#3236](https://github.com/go-to-k/cdkd/issues/3236). Globbed at
**`src/deployment/retryable-errors.ts`** rather than at the provider it
describes, because the reader who most needs it is the one about to type the
WRONG fix, and that fix is typed HERE in the pattern table below. A provider
editor reaches it from `cloud-control-provider.ts`'s
`CloudControlWaitAbandonedError` JSDoc, which names this file; the provider's
own JSDoc carries the mechanism. Not indexed from `layout-provisioning.md` or
`layout-deployment.md` — `rule-file-payload.test.ts` refuses a pointer in
either, so it is indexed from its sibling satellite instead.

## The one-line fix that is the WRONG fix

**Never add a transport / throttle / 5xx pattern to
`RETRYABLE_ERROR_MESSAGE_PATTERNS` in `src/deployment/retryable-errors.ts` to
make a failed poll recoverable.** That table drives the deploy engine's outer
`withRetry`, which re-invokes `create()` — a SECOND `CreateResource` for a
resource the first call is already creating, which is
[#2039](https://github.com/go-to-k/cdkd/issues/2039)'s duplicate-create. The
reporter of #3236 had this right: the outer retry arm is CORRECT to decline,
and the fix belongs inside the poll.

Re-polling is safe for the opposite reason, and the reason is structural rather
than a judgement call: `GetResourceRequestStatus` invokes no resource handler,
and the `RequestToken` is unchanged across attempts, so no number of re-polls
can create, mutate or delete anything.

## What the defect was

`waitForOperation` polled with no per-poll error handling, so a failure of ANY
kind propagated out of the loop and took the `RequestToken` — which lives only
in that parameter list — with it. The Cloud Control operation keeps running
server-side regardless, so a CREATE that AWS went on to complete left a LIVE
resource with no state record: invisible to rollback, to `cdkd destroy`, and to
`cleanupFailedCreateRemnant`, whose first guard admits only a
`CloudControlOperationFailedError`. Reported against an `AWS::RDS::DBInstance`
that reached `available` while a VPN dropped; the untracked instance then
blocked the deletion of five tracked resources.

FOUR call sites reach it — `create()`, `update()`, `delete()` and
`disableCcProtection()` — so the fence is CREATE / UPDATE / DELETE behavior at
once, and the issue's CREATE framing under-scoped its own blast radius.

## Scoping, budget, and the two bounds

The `try` wraps the `send` EXPRESSION alone, never the loop body. The loop's
own deliberate throws (`No progress event`, the FAILED
`CloudControlOperationFailedError`, `CANCEL_COMPLETE`) are all raised AFTER the
send resolves, so no widening could be needed — and a widening is actively
wrong, because `isTransientPollFailure` reads the MESSAGE and a FAILED event's
`StatusMessage` can carry the resource handler's report of ITS OWN downstream
socket error. A widened `try` would then spin on a settled, FAILED operation
until the deadline and report the wrong error.
`tests/unit/provisioning/cloud-control-wait-abandoned.test.ts` pins exactly
that case; the earlier `stabilization failed` case could not see it, since that
message classifies non-transient and is re-thrown unchanged either way.

Two bounds, and the outer one is not the fence's to move:

- The existing `while (Date.now() - startTime < maxWaitMs)` budget. Re-polling
  can only consume time the wait already had.
  `slow-cc-operation-timeouts.ts` couples that floor to the two OUTER
  per-resource deadlines deliberately, so a separate attempt budget able to
  outlive it would break the coupling and re-open the
  `opensearch-domain-getatt` class of failure.
- `POLL_TRANSIENT_GRACE_MS` (2 min), over ONE UNBROKEN run of failures — reset
  by any answered poll, so it measures a single outage rather than a session's
  total flakiness. Two minutes because everything reaching this loop has
  already outlasted the SDK's three STANDARD-mode attempts, and because waiting
  the full budget instead (up to 60 min for a slow type) buys nothing the
  resume hint does not.

  **It is a per-call ARGUMENT, defaulting to that constant, and exactly one
  caller overrides it**: `disableCcProtection` passes
  `PROTECTION_FLIP_TRANSIENT_GRACE_MS` (10 s, issue
  [#3253](https://github.com/go-to-k/cdkd/issues/3253)). That flip is
  best-effort and its every failure is swallowed, so a long wait there is dead
  wall clock on a destroy that is failing anyway. The tradeoff is recorded at
  the call site rather than hidden: for an outage of roughly 13 s to 120 s the
  old behaviour recovered and the new one does not, which costs a retry rather
  than data loss. A new call site takes the default and should have to say why
  it does not.

`isTransientPollFailure` fails CLOSED: an unmodelled shape aborts the wait
exactly as before #3236. That is the safe direction, because the errors it must
NOT absorb are the ones a retry can only re-derive —
`RequestTokenNotFoundException` (the token is genuinely gone),
`AccessDeniedException`, `ValidationException`. Its message arm is DERIVED from
`POLL_TRANSPORT_ERROR_CODES` rather than hand-spelled: a hand-written
`E[A-Z]{3,10}` was wrong about a code's LENGTH — eleven characters follow the
`E` in `ECONNREFUSED`, the exact code the issue reported — so the arm matched
nothing for the case it was added for.

Throttles and transient 5xx are in scope alongside transport, and the throttle
case is the WORSE of the two: aborting propagates AWS's `Rate exceeded`
wording, which `RETRYABLE_ERROR_MESSAGE_PATTERNS` matches, so the outer
`withRetry` duplicates the create. Measured — `isRetryableTransientError`
answers TRUE for that message and FALSE for `connect ECONNREFUSED ...`.

## `CloudControlWaitAbandonedError`

Thrown at THREE exits, whenever cdkd stops waiting while the operation is, as
far as cdkd knows, still running: the transient grace, the wall-clock deadline
(which had always lost the token for the same reason), and a NON-transient poll
failure, which is not retried but must not lose the handle either. Carries the
`RequestToken`, the last `Identifier` any poll reported, and a pasteable
`aws cloudcontrol get-resource-request-status` line — SANITIZE, then QUOTE,
then SUPPRESS, the full treatment `replacement-protection-advice.ts` gives a
pasted id (issue [#2669](https://github.com/go-to-k/cdkd/issues/2669)).
Quoting alone is NOT it, and the gap was reachable: the region comes from
`config.region()`, i.e. `--region` / `AWS_REGION` / a profile's `region =`
line, so a region carrying a newline is inert once `shellQuote` wraps it and
still renders a two-line "recovery command". The region flag is DROPPED when
sanitizing changed it (absent is legal — the user supplies their own) and a
changed TOKEN suppresses the whole command, since a command naming the wrong
operation is worse than none. The identifier clause is rendered BEFORE the
command so nothing user-chosen follows it on that line.

Three contracts a change here must keep:

1. **It is NOT a `CloudControlOperationFailedError`.** Three readers key on
   that class — `cleanupFailedCreateRemnant`'s first guard, `delete()`'s
   structured `ErrorCode: NotFound` absorption, and `isUpdateUnsupportedError`'s
   chain walk — and all three ask what the HANDLER reported, which here is
   NOTHING. The remnant cleanup is the sharp end: it deletes by
   `error.physicalId`, and an identifier seen on an IN_PROGRESS event names a
   resource whose create may be about to SUCCEED.
2. **Every already-deleted classifier on the state-drop path tests
   `isWaitAbandonedError` BEFORE its substring match**, and treats a true
   answer as "not already deleted".

   FOUR are GOVERNED by the population fence, and three of them are in files
   the provider cannot see:
   `cloud-control-provider.ts`'s own `delete()` catch,
   `deploy-engine.ts`'s replacement delete-then-CREATE arm and its
   template-removal delete arm, and `destroy-runner.ts`'s per-resource delete
   loop. Each reacts to a true verdict by DROPPING THE STATE ROW — the
   replacement arm worse still, by creating the replacement beside a resource
   whose delete may be in flight.

   **Wording is NOT the protection, and an earlier revision of this file said
   it was.** The message interpolates the LOGICAL ID and the last-seen
   IDENTIFIER, both user- or template-chosen, so a resource named
   `PageNotFound` satisfies the needles however it is worded. Hence the marker
   in `src/provisioning/wait-abandoned.ts` — a LEAF, because all four consumers
   sit on the deploy-engine → rollback-executor → registry → provider ring.
   Round 1 guarded ONE site with a local `instanceof` and was reviewed
   believing the class was closed;
   `tests/unit/provisioning/wait-abandoned-guard-population.test.ts` fences the
   POPULATION.

   **Say FOUR GOVERNED, never "every classifier".** A FIFTH guard —
   `cleanupFailedCreateRemnant`'s early return — is outside the population by
   construction: its partner is the REGEX helper `isNotFoundMessage`, which
   carries no literal needles, so no needle-driven scan can find it. It has a
   behavioural case instead.

   The scan PARSES (TypeScript compiler API) and scores a CALL, not a
   substring — a hand-rolled `if (`-matcher missed the repo's dominant
   spelling (a `return a || b` helper) and a dropped-parens dead conjunct
   passed a substring test. All twelve exemptions record a MEASUREMENT: none
   of those files imports or constructs `CloudControlProvider`. It also
   SELF-PROBES the real tree — blanking each governed site's own guard and
   re-entering the scan — because four review rounds found it claiming more
   than it checked and only a hand-run mutation caught each one.

   The message ALSO still avoids the already-deleted phrases where it can (the
   list `src/deployment/delete-outcome.ts` carries) — a belt-and-braces second
   layer, asserted over the RENDERED text rather than the template since the
   cause is interpolated. `ENOTFOUND` is the live near-miss: those four
   consumers match case-SENSITIVELY, so a future lowercasing of the message
   would introduce the phrase. `cleanupFailedCreateRemnant` is the exception
   that proves it — its `isNotFoundMessage` is case-INSENSITIVE, so
   `getaddrinfo ENOTFOUND ...` DOES match `/not\s*found/i` (measured), and that
   arm takes the marker check rather than a wording promise.
3. **CREATE is marked non-retryable; DELETE and UPDATE are not.** A CREATE
   replay is the duplicate-create above, and the marker is what refuses it,
   since a throttle-caused abandonment interpolates `Rate exceeded`. A DELETE
   replay is idempotent (a second `DeleteResource` meets the already-gone
   signal `delete()` absorbs) and an UPDATE replay re-sends the same patch,
   which is what every other UPDATE failure already gets.

## Not covered

Automated RESUME — persisting the token so a later `cdkd deploy` re-polls it
and adopts the result — is remedy (b) of #3236 taken only as far as the thrown
error. The user-facing route is the printed command plus `cdkd import`
(`docs/troubleshooting.md`). Carrying it further means a state-schema field and
deploy-engine plumbing.
