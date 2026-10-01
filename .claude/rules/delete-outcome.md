---
description: the shared ResourceDeleteResult helpers
paths:
  - 'src/deployment/delete-outcome.ts'
  - 'src/deployment/deploy-engine.ts'
  - 'src/deployment/deploy-engine/delete.ts'
  - 'src/deployment/deploy-engine/update.ts'
  - 'src/deployment/deploy-engine/replacement.ts'
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
the sentence every skip renders, in the log AND the `Error` failing sites throw.
Two wording rules are load-bearing: it says cdkd did NOT CONFIRM the delete and
the resource MAY STILL EXIST, never why (a refusing custom-resource handler DID
get the call), and it lacks the phrases the already-deleted classifiers
substring-match (`does not exist`, `not found`, `NoSuchEntity`). Skips are
handled OUTSIDE the `catch`. Callers put a flag or a `cdkd` command on its line,
so it SHOWS each value only when plain and describes it otherwise — a skip
reason must stay plain prose to be shown ([#4265](https://github.com/go-to-k/cdkd/issues/4265)).
A caller whose line carries no command passes `commandFreeLine`, so the
physical id, possibly the only trace of the resource, is shown, bounded.

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
