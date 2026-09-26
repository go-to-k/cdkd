---
description: the two name-collision predicates and the rule for admitting a name
paths:
  - 'src/deployment/retryable-errors.ts'
  - 'src/deployment/deploy-engine.ts'
  - 'src/deployment/rollback-executor.ts'
---

# Name-collision classification

A Cloud Control poll failure must NEVER get a pattern-table entry:
[cloud-control-wait.md](cloud-control-wait.md).

**A positive verdict is DESTRUCTIVE.** `--replace` delete-first removes the live
OLD resource; the rollback executor's reverse-replacement arm removes the live
NEW one. A false positive is a deleted resource.

## `isNameCollisionError(message)`

NOT in the transient table — a collision is retryable only where the old name
holder was just deleted.

- Accepts BOTH spellings: Lambda raises the SINGULAR `Function already exist:`,
  so a plural-only pattern misses every `AWS::Lambda::Function`.
- A lookbehind refuses negated / modal forms ("does NOT already exist", "MUST
  already exist") — otherwise a create rejected for a missing PREREQUISITE is
  reported as a collision pointing at `--replace`.

## `isNameCollisionErrorFrom(error, logicalId)`

Issue [#3208](https://github.com/go-to-k/cdkd/issues/3208). What the sites
holding the error call; the string form stays for text-only callers. It walks
the bounded `cause` chain for the error name and the Cloud Control
`ccErrorCode === 'AlreadyExists'`:

1. **The prose needs BOTH an AWS-authored link (`isAwsAuthoredFailure`) and a
   top-level message relaying it** (issue
   [#3816](https://github.com/go-to-k/cdkd/issues/3816)). The first keeps a cdkd
   refusal quoting a template value out; the second is how a provider OPTS OUT —
   Glue and CloudFront reword a collision delete-first cannot clear. Dropping
   either re-opens a delete. The `AlreadyExists` code matches only as a whole
   token outside a name or ARN (not after `-` `:` `/`, not before `-`).
   Residual: an AWS error echoing a template value still classifies.
   A provider that recognises a collision AWS words WITHOUT "already exists"
   declares it with `markNameCollision` on its wrapper (Route 53's CNAME
   conflict), never by appending the phrase — cdkd-authored text is not read.
2. **Anchored on `logicalId`, checked FIRST at every depth**, ahead of every
   read; a link naming another resource returns `false` at once. It compares
   logical IDs, so a child sharing the parent stack's id still passes.

It reaches the SDK error only if providers thread the caught value as `cause` —
enforced by `scripts/check-provider-error-cause.ts`.

## Admitting a name to `NAME_COLLISION_ERROR_NAMES`

The list is COMPLETE, not illustrative. A name is admissible only when the
service declares it for the duplicate-name condition **and nothing else**:
Lambda's `ResourceConflictException` also means "PENDING state", so crediting it
would delete a live function under `--replace`. `DuplicateListenerException` (a
PORT already bound) and `DuplicateTagKeysException` (repeated keys in one
request) are pinned EXCLUDED. Do not widen the prose matcher to a bare `exists`
either — it is substring-matched against every service's text.
