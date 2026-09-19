---
description: the shared ResourceDeleteResult helpers
paths:
  - 'src/deployment/delete-outcome.ts'
  - 'src/deployment/deploy-engine.ts'
  - 'src/deployment/rollback-executor.ts'
  - 'src/cli/commands/destroy-runner.ts'
  - 'src/provisioning/cloud-control-provider.ts'
---

# `delete-outcome.ts`

**Keep it a LEAF — no imports beyond the type**: the deploy engine and rollback
executor both consume it.

**Skip pair** ([#1762](https://github.com/go-to-k/cdkd/issues/1762)).
`deleteSkipReason` returns the `'skipped'` arm's `reason`, or `undefined` for
the `void` return, keeping that reading in ONE place. `deleteSkippedMessage` is
the sentence every skip renders, in the log AND the `Error` failing sites throw. Two wording rules are load-bearing: it says the resource was NOT deleted
and MAY STILL EXIST (no AWS call is issued at any producer but
`NestedStackProvider.delete`), and it contains none of the phrases the
already-deleted classifiers substring-match (`does not exist`, `not found`,
`NoSuchEntity`). Skips are handled OUTSIDE the `catch`.

**Guard pair** ([#2301](https://github.com/go-to-k/cdkd/issues/2301)).
`withIndeterminateGuard` / `deleteIndeterminateGuards` are the WRITE and READ
halves of `indeterminateGuards` — a PRE-FLIGHT SAFETY GUARD that ran, reached no
verdict, and so went unenforced. Both live in ONE file so the field survives its
producer-to-recorder hop. The writer returns its input BY IDENTITY with no guard
and preserves a `'skipped'` outcome WITH its `reason` when both hold, since the
facts are independent; the reader DROPS a malformed entry rather than defaulting
it — the OPPOSITE of `deleteSkipReason`, where a default is the only signal a
live resource survived.

See [provider-delete-path.md](provider-delete-path.md).
