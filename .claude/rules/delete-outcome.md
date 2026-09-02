---
description: src/deployment/delete-outcome.ts - the shared ResourceDeleteResult helpers (skip reporting, suppressed-guard reporting) and why the module is a leaf
paths:
  - 'src/deployment/delete-outcome.ts'
  - 'src/deployment/deploy-engine.ts'
  - 'src/deployment/rollback-executor.ts'
  - 'src/cli/commands/destroy-runner.ts'
  - 'src/provisioning/cloud-control-provider.ts'
---

# src/deployment/delete-outcome.ts

Pointed at from [layout-deployment.md](layout-deployment.md). Split out under
issue [#2301](https://github.com/go-to-k/cdkd/issues/2301) because the entry
below is read only by the five files above, while `layout-deployment.md`'s
`src/deployment/**` glob loaded it into every session touching any of the 16
tracked files in that directory -- `secret-redaction.ts` among them, whose
payload the addition took over its 112,000 B cap.

## The skip pair (issue [#1762](https://github.com/go-to-k/cdkd/issues/1762))

Deploy-side consumption of `ResourceDeleteResult` (issue [#1762](https://github.com/go-to-k/cdkd/issues/1762)) — the twin of what `src/cli/commands/destroy-runner.ts` does for `cdkd destroy`. Two of the module's four exports: `deleteSkipReason(result)` (the `'skipped'` arm's `reason`, or `undefined` for the back-compat `void` return ~80 providers still use — a function rather than an inline test at eleven call sites so the `void` reading lives in ONE place) and `deleteSkippedMessage(logicalId, physicalId, reason, duringClause)` (the sentence every deploy-side skip renders, in the log line AND in the `Error` the sites that must FAIL the resource throw). Two wording rules are load-bearing: it says the resource was NOT deleted and MAY STILL EXIST (a skip issues no AWS call at every producer but `NestedStackProvider.delete`, which is why a replacement site cannot create its replacement beside it), and it must contain none of the phrases the callers' already-deleted classifiers substring-match (`does not exist` / `was not found` / `not found` / `No policy found` / `NoSuchEntity` / `NotFoundException` / `ResourceNotFoundException`) — reading a skip as "already gone" is the mis-accounting the issue removes, and both the engine's DELETE branch and its update-not-supported fallback carry such a classifier. The call sites additionally handle the skip OUTSIDE their `catch`, so a `reason` (provider text) can never reach one. **The module must stay a LEAF — no imports beyond the type**, for the same reason as `src/provisioning/nested-stack-messages.ts`: the deploy engine and the rollback executor both consume it and already sit on a dense import ring.

## The guard pair (issue [#2301](https://github.com/go-to-k/cdkd/issues/2301))

`withIndeterminateGuard(result, guard)` and `deleteIndeterminateGuards(result)`
are the WRITE and READ halves of `ResourceDeleteResult.indeterminateGuards` — an
`IndeterminateGuard` is a PRE-FLIGHT SAFETY GUARD that ran, could not reach a
verdict, and was therefore not enforced while cdkd proceeded.
`CloudControlProvider.confirmDeleteTargetIdentity` is the one producer today;
`destroy-runner.ts` is the one consumer, persisting each as a
`RESOURCE_GUARD_INDETERMINATE` deployment event and counting it into
`DestroyRunnerResult.guardIndeterminateCount`. `deploy-engine.ts` and
`rollback-executor.ts` still DISCARD the field
([#2422](https://github.com/go-to-k/cdkd/issues/2422)).

Write and read live in ONE file deliberately: the field's whole job is to
survive the hop from a provider to a recorder, and a sanitizer that does not sit
beside its constructor is how the two drift.

Two shapes are decisions rather than style. `withIndeterminateGuard` returns its
input BY IDENTITY when there is no guard, so the ~80 providers that return `void`
keep the back-compat shape and the hot path allocates nothing; and it preserves
a `'skipped'` outcome WITH its `reason` when both facts hold at once, because a
guard that could not answer and a delete that could not be addressed are
independent — collapsing either into the other loses one of them.
`deleteIndeterminateGuards` DROPS a malformed entry rather than defaulting it,
which is the OPPOSITE of `deleteSkipReason`'s choice and deliberately so: there
a default is the user's only signal that a live resource survived, so inventing
`UNSPECIFIED_SKIP_REASON` beats silence, while here a guard row naming neither a
check nor a cause cannot be acted on AND would inflate the destroy summary's
tally. What a provider owes when it reports one — proceed rather than refuse,
and name the GUARD rather than the API or the type — is in
[provider-delete-path.md](provider-delete-path.md), beside the other delete-path
return rules.
