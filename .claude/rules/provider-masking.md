---
description: Masking a resolved property value in a provider log line (the maskSecrets capability and its rules)
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - secret masking in provider log lines

Why `delete()` has no masker, and the rest of the delete path: [provider-delete-path.md](provider-delete-path.md).

Provider interface, registry, Custom Resources, and "Adding a New SDK Provider": [providers.md](providers.md).

### Masking a resolved property value in a provider log line

A provider's `properties` bag arrives RESOLVED, so a
`{{resolve:secretsmanager:...}}` scalar is already PLAINTEXT by the time
`create()` / `update()` sees it. cdkd's masking historically lived at two
boundaries only — the deploy engine's error / reason text
(`maskSecretsInText` in `deploy-engine.ts`) and the intrinsic resolver's own
debug line — so a provider that interpolated one of those values into its OWN
`logger.warn` sat outside all of it. `NoEcho` redaction has the same shape: it
covers the resolver's debug output, not the value handed to the provider.

Issue #1932 item 3 closes that with a capability on the context rather than a
new global:

```typescript
export interface SecretMaskingContext {
  maskSecrets?: (text: string) => string;
}
export interface CreateContext extends SecretMaskingContext { /* ... */ }
export interface UpdateContext extends SecretMaskingContext { /* ... */ }
```

Threaded by all three EXTERNAL callers — `deploy-engine.ts` (CREATE, UPDATE and
every replacement create), `rollback-executor.ts` (both re-creates, both UPDATE
arms) and `drift --revert` — each bound to the bag its own resolution pass
filled. The five providers that re-create inside their own `update()` pass no
context, because they forward the outer call's `properties` and have none.

Rules for a provider:

- **Apply it to any line interpolating a value from `properties`.** The unhappy
  path is usually the one that prints — a warning about a mis-shaped value
  exists precisely to name that value.
- **Know which sink you are protecting, because they are not equally covered.**
  A provider's own `this.logger.*` line reaches NO engine sink at all, so it is
  unmasked outright. A THROWN message is masked by `DeployEngine` at the
  message level on all three of its sinks (the error line, the durable
  `deployments/{runId}.jsonl` event via `maskSecretsInEvent`, and the re-thrown
  cause via `maskSecretsInError`) — so its residual is only the escaping and
  length gaps below. Both still need masking; the difference is how much is left
  when you skip it. Issue #2176 measured the full picture across all ~80
  providers.
- **Mask the VALUE before stringifying it; the message is a fallback.** Two
  independent reasons, and the first is the one that bites:
  - **Escaping.** A masker matches by literal occurrence. `JSON.stringify`
    escapes `"`, `\` and newlines, so a secret containing any of them no
    longer OCCURS in the finished line. That is every Secrets Manager JSON
    document — measured: `super"secret-plaintext-value` came through a
    message-level mask completely unchanged.
  - **Length.** `maskSecretsInText` masks an exact whole-value match at ANY
    length but only scans for SUBSTRING needles of >= `MIN_NEEDLE_LENGTH` (4).
    A message is always longer than the value inside it, so it reaches only the
    scan and a 1-3 character secret survives.

  Do both: walk the value masking every string leaf (and key) before
  interpolating, AND route the assembled message through the masker. Walk
  rather than test the top level, since a secret nested in an object leaf is
  stringified — and escaped — identically. The masker is idempotent, so the
  overlap between the two passes is free.

  **Use `maskDeep` from `src/provisioning/masked-retry-logger.ts` for the walk
  — do NOT hand-roll one.** Issue #2176 found SIX private copies
  (`elbv2`, `cognito`, `sns-topic`, `dynamodb-table`, `dynamodb-globaltable`,
  `apigatewayv2`), FOUR of which had no depth cap. These copies encode a
  security contract: a hardening applied to one silently leaves the others
  behind. Two of the six were nearly missed a second time because the sweep
  grepped for the known copies' SPELLINGS (`maskDeep`, `MASK_WALK_MAX_DEPTH`)
  rather than for the walk's SHAPE — the survivors were named `maskLeaf` /
  `maskLeafValue` with no named constant.
- **Read it defensively.** `context?.maskSecrets ?? ((t: string) => t)`.
  Absent means unmasked, which is the back-compatible default that let this
  ship without editing ~130 providers. `create()` / `update()` are also called
  by `cdkd drift --revert`, the import path, and tests.
- **Never cache it on `this`.** Providers are registered as SINGLETONS and
  serve concurrent resources, so a stashed masker is the wrong deploy's.
- **Prefer ONE masked sink over per-value masking.** `buildMfaConfigRequest` in
  `cognito-provider.ts` builds
  `const warn = (m: string) => logger?.warn(maskSecrets(m));` once and routes
  every warning through it, so a warning added later is masked by construction.
  `ssm-parameter-provider.ts`'s `create()` is the reference for the whole shape
  (issue #2176): one `mask`, one `warn`, one `debug`, built at the top of the
  operation and used everywhere below.

  **Per-site masking DOES drift, measured rather than predicted.** Issue #2176's
  sweep found raw `${JSON.stringify(...)}` sites sitting in files that had
  ALREADY been hardened for this contract — `dynamodb-table-provider.ts` masked
  one argument of a `warn` call and left the other beside it raw. A sink is what
  makes the next line correct by default.
- **Mask in the OPERATION POLLER, not in the arm that calls it.** Where the
  service is operation-based — Cloud Map's `Create*Namespace` /
  `Update*Namespace` return an `OperationId` and report the rejection later in
  `Operation.ErrorMessage`, quoting the offending value back — a shared poller
  constructs the error, and every arm's catch opens with
  `if (error instanceof ProvisioningError) throw error;`. That passthrough
  re-throws the poller's error VERBATIM, so threading the masker into the arm
  is INERT on the path that actually fires, and for these types a FAILED
  operation is the normal rejection route rather than an edge case. Mask the
  raw `ErrorMessage` where it is read, and thread the masker from every
  CREATE / UPDATE caller of the poller — an arm an earlier pass already fixed
  is not evidence that its poller was (`pollOperation` in
  `servicediscovery-provider.ts`, issue #2063). The DELETE callers are the one
  exemption and stay unthreaded: `DeleteContext` carries no masker by the
  contract above, and their payload is a physical id rather than a resolved
  property bag.

Why a FUNCTION and not the `RecordedSecretValues` bag: the bag is keyed by
PLAINTEXT, so handing it to ~130 providers makes every one of them a place a
`[...secrets.keys()]` can leak from; the function grants the capability with no
read path back to the values, keeps `src/provisioning/**` free of a
`src/deployment/secret-redaction.ts` import, and can be WIDENED later (to cover
`NoEcho` parameters, say) by changing the callers alone. The codebase already
had this shape — `drift.ts` hands `withRetry` a masking `logger.debug` rather
than the bag.

THE ONE PROVIDER THAT DOES GET THE PAIRS, and why it is not a hole in that
rule: `NestedStackProvider` must SEED a child `DeployEngine` with the parent's
`plaintext -> {{resolve:...}}` map, and a function cannot substitute — seeding
needs the pairs, not the ability to mask (issue
[#1903](https://github.com/go-to-k/cdkd/issues/1903)). So the bag travels a
channel only that provider reads — `getCurrentResourceSecrets()` from
`src/deployment/resource-secrets-scope.ts`, an `AsyncLocalStorage` the deploy
engine and `rollback-executor.ts` bind around each provider CREATE / UPDATE
call — instead of widening `CreateContext`, which is the type all ~130
providers see. The idiom is the one that provider already lives in
(`getCurrentNestedStackContext()`).

**A provider reading it MUST NOT enumerate or log its KEYS**: they are secret
plaintext, and the only sanctioned use is handing the map on as a redaction
seed. Do not reach for this accessor in a new provider — if a provider needs to
mask, it needs `maskSecrets`, which is the whole point of the paragraph above.

What it does NOT cover: cdkd's dynamic-reference secret model only
(`{{resolve:secretsmanager:...}}`, `SecureString` ssm). A `NoEcho: true`
template PARAMETER is outside that model — the resolver redacts it in its own
debug line but never RECORDS the value, and no masker built from a
`RecordedSecretValues` bag can reach it. That residual is PERSISTED, not
log-only: a `NoEcho` value quoted back inside an AWS error reaches
`deployments/*.jsonl`, since the event masker reads the same bag (issue #1998).
