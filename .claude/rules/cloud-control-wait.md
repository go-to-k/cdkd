---
description: Cloud Control poll failures and the CloudControlWaitAbandonedError contract
paths:
  - 'src/deployment/retryable-errors.ts'
---

# `waitForOperation`: the poll's transport fence

Issue [#3236](https://github.com/go-to-k/cdkd/issues/3236); mechanism in
`cloud-control-provider.ts`'s JSDoc.

**Never add a transport / throttle / 5xx pattern to
`RETRYABLE_ERROR_MESSAGE_PATTERNS` to make a failed poll recoverable** — that
table drives the outer `withRetry`, which re-invokes `create()` and duplicates
the `CreateResource`. Re-polling is safe: `GetResourceRequestStatus` invokes no
handler and reuses the `RequestToken`.

Bounds:

- The `try` wraps the `send` EXPRESSION alone, never the loop body.
- `maxWaitMs` bounds everything; no attempt budget may outlive it.
  `POLL_TRANSIENT_GRACE_MS` (2 min) covers
  ONE UNBROKEN run of failures, reset by any answered poll; it is a per-call
  ARGUMENT, overridden only by `disableCcProtection` (10 s, issue
  [#3253](https://github.com/go-to-k/cdkd/issues/3253)).
- `isTransientPollFailure` fails CLOSED and must never absorb
  `RequestTokenNotFoundException`, `AccessDeniedException` or
  `ValidationException`; its message arm derives from
  `POLL_TRANSPORT_ERROR_CODES`. Throttles are in scope: an abandoned throttle
  propagates `Rate exceeded`, which that table matches.

## `CloudControlWaitAbandonedError`

Thrown at THREE exits, when cdkd stops waiting while the operation may still
run: transient grace, wall-clock deadline, non-transient poll failure. It
carries the `RequestToken`, the last `Identifier` and a pasteable recovery
command — SANITIZE, QUOTE, then SUPPRESS (issue
[#2669](https://github.com/go-to-k/cdkd/issues/2669)).

1. **Not a `CloudControlOperationFailedError`.** Its readers ask what the
   HANDLER reported, which here is NOTHING, and `cleanupFailedCreateRemnant`
   deletes by `error.physicalId`.
2. **Already-deleted classifiers on the state-drop path test
   `isWaitAbandonedError` BEFORE their substring match**, treating true as "not
   already deleted". FOUR governed sites drop the state row on true:
   `cloud-control-provider.ts`'s `delete()` catch, `deploy-engine.ts`'s
   replacement and template-removal delete arms, and `destroy-runner.ts`'s
   delete loop. Wording is not the protection; the marker lives in
   `src/provisioning/wait-abandoned.ts`, a LEAF.
3. **CREATE is non-retryable; DELETE and UPDATE are not**: a CREATE replay
   duplicates the create, the others are safe.
