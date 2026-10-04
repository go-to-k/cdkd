---
description: 'The refusal class that propagates out of Fn::Sub and its throw sites'
paths:
  - 'src/deployment/intrinsic-function-resolver.ts'
  - 'src/deployment/intrinsic-resolver/**'
  - 'src/utils/error-handler.ts'
  - 'src/deployment/secret-region-classification.ts'
  - 'src/cli/commands/scrub.ts'
  - 'src/cli/commands/drift.ts'
---

# Intrinsic-resolution refusals

Issue [#1740](https://github.com/go-to-k/cdkd/issues/1740). Per-site reasons:
`IntrinsicResolutionRefusalError`'s JSDoc in `error-handler.ts`.

- Warn-and-keep-the-raw-`${...}` answers an unknown `Fn::Sub` variable, and must
  NEVER answer a deliberate refusal: that ships a literal
  `${Resource.Attribute}` to AWS under a green deploy.
- Refusals throw `IntrinsicResolutionRefusalError` and the `Fn::Sub` catch
  RE-RAISES it. Refusing arms: `guardedPhysicalIdFallback`'s `*Arn` / `*Url`
  shape hard-fail, `--strict-getatt`, `rejectPlaceholderArnAttribute`, the
  unknown-account guard, a declared resource, an unbound declared
  parameter with no `Default`, and an `Fn::GetAtt` cdkd cannot build or
  CloudFormation does not define (`refuseUnconstructibleAttribute` /
  `refuseUndefinedAttribute`, [#4077](https://github.com/go-to-k/cdkd/issues/4077) —
  never answer `undefined`, which `Fn::Join` / `Fn::Sub` render as text); an UNDECLARED head, or a bound or defaulted
  parameter, warns. `resolveSub`'s own LIST refusal (#3809) is thrown only
  after the walk and its final dynamic-reference pass, so a later reference
  still records its needle. `resolveSplit`'s two refusals,
  `refuseCoercedInheritedSecret` and the unsupported-service arm — for a
  `{{resolve:...}}` token holding a SECRET, on the TEMPLATE route only
  (#2743); an untainted one, and
  ANY token in persisted text (the public `resolveDynamicReferences` entry:
  drift, rollback replay, cross-stack reads), must keep warning and staying as
  written. The refusal of a SECRET result of a RESOLVABLE token assembled from a
  secret (#4166; its needle half reads the INHERITED bag only) is template-route only too, and for `secretsmanager` / `ssm-secure` it runs BEFORE the lookup (#4266), so the assembled id never reaches AWS. Both use the class too: a refusal is a property of
  the THROW, not of the catch that inspects it.
- **A stale-record refusal is worded from the HEAL OUTCOME** (#1852): "not enriched ... file an issue" only when the re-read completed without the attribute or was never attempted; a failed / not-found read says so and names the real remedy, as the PREVIEW's read when the healer is `readOnly` (`cdkd diff`'s heals nothing). Never promise "the next update heals it" alone — a no-change deploy runs no update. They stay `markNonRetryable`: the outcome is memoized per deploy.
- **`cdkd scrub` needs a distinction the base class cannot make.** A PERMANENT
  refusal is an unremediable FINDING (the rest of the stack is still scrubbed,
  exit non-zero); a USER-FIXABLE one must REFUSE the stack, since a re-run after
  the fix scrubs it. Exactly one site is permanent — `resolveGetStackOutput`'s
  cross-account refusal, which throws `CrossAccountSecretRefusalError`. Scrub
  matches THAT subclass: matching the base class downgrades the fixable siblings
  and prints `No plaintext secrets found` over surviving plaintext.
  `MalformedProducerRecordRefusalError` (another stack's damaged record) becomes
  a finding. `cdkd drift` branches on the BASE class.
- **All but the time-dependent sites `markNonRetryable` at the `throw`** — they
  decide from inputs a retry cannot change, yet interpolate template text a
  substring-matching classifier reads as transient. The CLASS stays UNMARKED:
  the unknown-account arm and `refuseUnservedAttribute` ARE time-dependent.
- **Where the intrinsic SITS decides what the user sees.** In a resource
  property it fails the resource; in a stack Output `deploy` catches it
  per-output and exits 0 (`--strict-getatt` fails the deploy); in
  `Conditions`, the class-agnostic `evaluateConditions` downgrades it to
  `false`.
