# Design: CloudFormation Macros / `Fn::Transform` support

Tracking issue: [#463](https://github.com/go-to-k/cdkd/issues/463). Status: **Design — not yet implemented.**

## 1. Goal & non-goals

### Goal

A CDK app whose synth template declares `Transform: [...]` at the top level, or contains snippet-level `Fn::Transform` blocks inside any resource / output / mapping, deploys cleanly via `cdkd deploy`. From the analyzer / provisioning pipeline's point of view, behavior is identical to a non-macro template — the expansion is fully transparent.

Concretely, in scope for v1:

- `Transform: ['AWS::Serverless-2016-10-31']` (SAM transform — `AWS::Serverless::Function` / `Api` / `SimpleTable` / `LayerVersion` / etc. → native CFn resources).
- `Transform: ['AWS::Include']` (S3 snippet inclusion, both top-level and snippet-level `Fn::Transform: {Name: 'AWS::Include', Parameters: {Location: 's3://...'}}`).
- `Transform: ['AWS::LanguageExtensions']` (`Fn::ForEach` / `Fn::Length` / `Fn::ToJsonString` / `Fn::FindInMap` enhanced lookups).
- User-authored **custom macros** (any `AWS::CloudFormation::Macro` resource that the user has deployed into their account).
- Deploy path only.

### Non-goals

- `cdkd diff` / `cdkd local *` against macro-containing templates. Pre-expansion can be added to those code paths in a follow-up PR after the deploy path proves; this design only commits to expansion being a reusable helper. Until then they hard-error with a clear "macros not supported in this command yet" pointer.
- **Multi-stage macros** (a macro that emits another macro reference, requiring a second round-trip). CFn supports this but it is vanishingly rare in CDK apps. v1 detects and rejects with a clear error pointing at the multi-stage pattern; v2 can iterate.
- **Local re-implementation** of AWS-published macros (`AWS::Serverless`, `AWS::Include`, `AWS::LanguageExtensions`) in TypeScript. CDK CLI does not do this either — the macro spec surface is too large and AWS evolves it.
- **`AWS::CodeDeployBlueGreen` transform**. CDK does not emit this; explicitly out of scope.

## 2. Why this is hard for cdkd

CloudFormation expands transforms **server-side** as part of `CreateChangeSet` / `CreateStack` / `UpdateStack`. The expanded template is what CFn deploys; the original template is what the user wrote. `aws cloudformation get-template --template-stage Processed` returns the post-expansion result.

cdkd's whole architecture sidesteps CFn — it parses the synth template directly, builds a DAG, and provisions via SDK calls. So:

1. **There is no implicit expansion step.** `Transform: [...]` and `Fn::Transform: {...}` reach `IntrinsicFunctionResolver` as opaque nodes. The resolver has no handler for `Fn::Transform` (confirmed via grep: zero hits in `src/deployment/intrinsic-function-resolver.ts` and `src/analyzer/template-parser.ts`). The top-level `Transform` key is silently dropped because the deploy engine only walks `Resources` / `Outputs`.
2. **DAG edges can be hidden inside an unexpanded macro.** A `Fn::Transform` snippet may emit additional `Ref` / `Fn::GetAtt` calls when expanded. cdkd's `template-parser.ts:extractRefsFromValue` never descends into `Fn::Transform` payloads, so the DAG may miss edges and dispatch resources out of order.
3. **Custom macros are user-authored Lambdas** invoked by CFn over a documented protocol. cdkd would have to either (a) reimplement that protocol (invoke the Lambda directly with a fabricated CFn-shape event) or (b) hand the template to CFn for expansion and read it back.

The core trade-off is therefore: **expand the macros ourselves** (small surface for AWS-published transforms, requires invoking the user's Lambda for custom macros) **or delegate the expansion to CFn** (one extra API round-trip per `cdkd deploy`, but always correct).

## 3. Approaches considered

### Approach A — Round-trip via CFn

cdkd hands the synth template to CloudFormation, asks it to expand the transforms, reads back the expanded template, and feeds that into the existing analyzer / provisioner pipeline.

**Mechanism:**

1. Detect `Transform: [...]` or any `Fn::Transform: {...}` node in the synth template.
2. Pick a transient stack name (`cdkd-macro-expand-<short-uuid>`).
3. Call `CreateChangeSet` with `ChangeSetType: CREATE`, the synth template as `TemplateBody` (or `TemplateURL` for > 51,200 bytes — reuse `src/cli/upload-cfn-template.ts` from PR #450, already shipped), and `Capabilities: ['CAPABILITY_AUTO_EXPAND', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_IAM']`. `CAPABILITY_AUTO_EXPAND` is required for any transform.
4. Wait for `ChangeSetStatus: CREATE_COMPLETE` (or `FAILED` — `StatusReason` carries the macro error verbatim, surface it).
5. `GetTemplate(ChangeSetName, TemplateStage: 'Processed')` returns the expanded template.
6. `DeleteChangeSet` (and `DeleteStack` against the transient stack name in `REVIEW_IN_PROGRESS` state — `CreateChangeSet --change-set-type CREATE` against a non-existent stack creates the stack in `REVIEW_IN_PROGRESS`; `DeleteStack` cleans it up cheaply).
7. Return the expanded template to the synthesis layer.

**Pros:**

- Always correct (CFn is the source of truth for macro semantics).
- Custom macros work transparently — cdkd never touches the user's Lambda.
- One implementation path covers SAM + Include + LanguageExtensions + custom macros.
- No drift from AWS as transforms evolve.

**Cons:**

- 30–60s added to `cdkd deploy` (changeset creation + waiter; for SAM specifically the first call also pulls the SAM macro layer).
- Requires `cloudformation:CreateChangeSet` + `DescribeChangeSet` + `GetTemplate` + `DeleteChangeSet` + `DeleteStack` IAM permissions — even for cdkd users who deliberately bypass CFn elsewhere. Privacy / sovereignty: the template is uploaded to AWS even for users who chose cdkd specifically to avoid CFn.
- The transient stack name + changeset accumulate per deploy if cleanup races a `^C` (mitigated by `try/finally` plus an explicit periodic-sweep in a separate command, e.g. `cdkd state cleanup-macro-expand`).
- For SAM specifically, the expanded template may reference resource types cdkd does not yet have providers for (`AWS::Serverless::*` are gone after expansion, but their expansion can include `AWS::ApiGateway::*` / `AWS::Lambda::*` / `AWS::DynamoDB::*` which cdkd already handles). The user-visible failure surfaces at provider lookup, not at expansion.

### Approach B — Local expansion of AWS-managed transforms only

Re-implement `AWS::LanguageExtensions` (`Fn::ForEach`, `Fn::Length`, `Fn::ToJsonString`) and `AWS::Include` (S3 fetch + JSON / YAML merge) in TypeScript. Hard-reject `AWS::Serverless-2016-10-31` and custom macros with a "use `cdk deploy` for SAM / custom macros" pointer.

**Pros:**

- Zero CFn dependency. No extra IAM permissions. No 30–60s overhead.
- For the common CDK case (`AWS::LanguageExtensions`, which CDK auto-emits when synth uses the matching constructs), this is fast and offline.
- Local code can be unit-tested deterministically.

**Cons:**

- Maintenance burden: AWS evolves the spec (new intrinsics added to `LanguageExtensions`), and cdkd must track every change. The `Fn::ForEach` semantics (placeholder substitution, ordered output naming, nested-loop edge cases) are non-trivial.
- Custom macros are categorically impossible.
- SAM is out of reach (the surface is too large and AWS does not publish a portable spec — the macro implementation is a Lambda inside AWS's account).
- Half-supported macros (locally for AWS-managed, error for custom) make the UX inconsistent: users have to learn which transforms cdkd handles natively.

### Approach C — Hybrid

Local expansion for the AWS-managed transforms cdkd can confidently implement (`AWS::LanguageExtensions`, `AWS::Include`), CFn round-trip for everything else (SAM, custom macros, anything cdkd has not implemented yet).

**Pros:**

- Common CDK case (`LanguageExtensions` only) takes the fast offline path.
- Less-common case (SAM, custom macros) still works via CFn round-trip — never "use a different tool" UX.
- The degradation path is explicit and visible (cdkd logs which transforms are being expanded locally vs round-tripped).

**Cons:**

- Two code paths to maintain. Local expansion still carries the spec-drift risk of Approach B; CFn round-trip still carries the cost of Approach A.
- Adds complexity to the detection phase — must classify each transform.
- The win over pure A is small in absolute time: `LanguageExtensions`-only templates are typically tens of KB and CFn round-trip for them is ~5s, not 30s. The 30–60s cost only materializes for SAM (which has a heavy macro layer).

## 4. Recommendation

**Approach A (CFn round-trip).**

Rationale:

- **Correctness is non-negotiable.** Macros affect every resource shape downstream. A subtly-wrong local expansion is harder to debug than a slow-but-correct round-trip.
- **The cost is bounded.** 30–60s on the first deploy of a SAM-using stack. Users who opt into macros already pay this on `cdk deploy` (the cost is just less visible there because it overlaps with CFn's own work).
- **Custom macros work for free.** Any user-authored macro is just a Lambda CFn invokes; cdkd never has to know its protocol.
- **The privacy concern is mitigated by scope.** Users who do not declare a `Transform` never hit the round-trip — the detection step is a pure-string check over the template (`'Transform' in template || JSON.stringify(template).includes('Fn::Transform')`). If they do declare one, they have already opted into AWS-side expansion regardless of which tool they use.
- **The fast offline win of Approach C is not worth the maintenance burden** for the realistic v1 user base. Cdkd can revisit local expansion for `AWS::LanguageExtensions` specifically as an optimization (PR series after A lands) if benchmark data shows the round-trip is the dominant cost on real-world CDK apps.

The recommendation may be revisited if a future user demands offline / no-CFn-IAM operation; at that point a `cdkd deploy --local-expand-only` flag could opt into Approach B with an explicit reject for unsupported transforms.

## 5. Implementation phases

A phased rollout keeps each PR reviewable and lets us bail to a follow-up if any phase exposes design issues.

### Phase 1 — detection + reject-with-pointer (no expansion)

- Add `containsMacro(template): boolean` helper in `src/synthesis/macro-detector.ts`.
- Detection rule: `template.Transform` is set (string or array), OR a recursive walk finds any `{Fn::Transform: {...}}` key in `Resources` / `Outputs` / `Mappings` / `Conditions` / `Rules`.
- In the synthesis layer, after `assemblyReader.getAllStacks(...)` returns, check each stack's template via `containsMacro`. If any returns true and Phase 2 is not yet wired, hard-error with: `Stack '<X>' uses CloudFormation macros (Transform: [...] / Fn::Transform). cdkd macro support is in progress — see https://github.com/go-to-k/cdkd/issues/463. Use 'cdk deploy' for this stack in the meantime.`
- This phase ships first as a UX win — silent dropping → clear error.

### Phase 2 — CFn round-trip expansion helper

- Add `src/synthesis/macro-expander.ts` with `expandMacros(template, opts): Promise<ExpandedTemplate>`.
- `opts` carries `accountId` / `region` / `stateBucket` (re-uses cdkd's existing AWS client factory + `src/cli/upload-cfn-template.ts` for the > 51 KB case).
- The helper mints `cdkd-macro-expand-<8-char-random>` as the transient stack name, runs the CreateChangeSet → wait → GetTemplate → DeleteChangeSet → DeleteStack sequence, and returns the processed template plus a list of warnings (e.g. "expansion took 47s — consider caching" — see Phase 3).
- The helper has a `try / finally` to guarantee `DeleteChangeSet` + `DeleteStack` even on cdkd-side error.
- Failure modes:
  - `CreateChangeSet` rejection (bad template, missing macro permission, macro not found) → re-throw as `SynthesisError` with the CFn `StatusReason` verbatim.
  - Waiter timeout (> 10 min) → re-throw with a "macro expansion timed out, this typically means the macro Lambda is slow or stuck" message.
  - `DeleteChangeSet` / `DeleteStack` cleanup failure → log at WARN with the transient stack name so the user can sweep it (or a periodic-sweep command can).
- Wire the helper into `Synthesizer.synthesize()` — see "Where in the pipeline" below.

### Phase 3 — caching / UX polish

- Cache key: SHA-256 of the synth template body. The cache value is the expanded template (and a timestamp).
- Cache location: `cdk.out/.cdkd-macro-cache/<sha>.json` (local-only, gitignored, regenerated on synth).
- On `cdkd deploy`, if the cache hit is fresh AND the stack template hash matches, skip the round-trip entirely. This makes the common case (re-deploy with no template change) free.
- Log lines surface the cost: `Expanding CloudFormation macros (round-trip via CFn, may take 30-60s)...` then `... done in 41s`.
- Add `cdkd state cleanup-macro-expand` command that lists + deletes any stranded `cdkd-macro-expand-*` stacks (recovery for `^C`-killed runs).

### Phase 4 — extend to diff / local commands

- `cdkd diff` and `cdkd local *` reuse the same `expandMacros` helper but consult the Phase 3 cache first to avoid surprise latency in interactive commands.

Each phase is a separate PR. Phase 1 is shippable on its own (it improves UX even without expansion). Phase 2 is the substantive change. Phases 3–4 are pure optimizations / coverage extensions.

## 6. Where in the pipeline does expansion run?

Insert between `Synthesizer` reading the assembly manifest and the analyzer / provisioner consuming each stack's template.

Concretely, in `src/synthesis/synthesizer.ts:Synthesizer.synthesize()`:

```
loop {
  AppExecutor.execute(...)         // CDK app subprocess → cdk.out
  assemblyReader.readManifest(...)
  if (missing context) { resolve + retry }
  else { break }
}
stacks = assemblyReader.getAllStacks(...)

// === NEW: macro expansion runs here ===
for (const stack of stacks) {
  if (containsMacro(stack.template)) {
    stack.template = await expandMacros(stack.template, opts)
  }
}

return { manifest, assemblyDir, stacks }
```

This placement matters for two reasons:

- **After** the context-provider loop, because the synth template is final at this point (context resolution can change resource shapes; expanding before that would force a re-expansion on every retry).
- **Before** the DAG builder (`src/analyzer/dag-builder.ts`) and intrinsic resolver (`src/deployment/intrinsic-function-resolver.ts`), because those consume `template.Resources` and assume every reference is resolvable. If `Fn::Transform` reaches them, they will mis-parse the DAG (Issue #463 cause #2 above).

`AssetPublisher` runs in parallel with the deploy critical path and consumes the assembly directory directly, not the in-memory template. Asset publishing is **not** affected by macro expansion — assets are referenced by their cdk.out paths regardless of how the template is shaped.

## 7. State management implication

Question: does cdkd record the **pre-expansion** template (what the user authored) or the **post-expansion** template (what cdkd actually deployed)?

Recommendation: **post-expansion.** Rationale:

- cdkd state is the source of truth for what was deployed. The pre-expansion template is recoverable from the CDK source code at any time (re-synth). The post-expansion template is the only artifact that maps to the actual AWS-side resource set; storing it lets `cdkd diff` / `cdkd state show` / `cdkd drift` work without re-running macro expansion on every state read.
- The post-expansion template is what `state.resources[*].properties` was generated from, so consistency with the rest of cdkd state is structural.
- For `Fn::ImportValue` / `Fn::GetStackOutput` resolution against the state of another stack, the consumer reads `state.outputs` (already resolved post-expansion). No pre-expansion data is ever needed.

This means a `cdkd deploy` that adds a new macro to an existing stack will trigger expansion, store the post-expansion template's `Resources` keys in state, and a subsequent `cdkd destroy` will work off the post-expansion logical IDs — same shape as a `cdk deploy` followed by `cdk destroy` against a SAM stack.

**Schema bump:** No schema change required. cdkd state already stores `state.resources` (post-resolution properties) and never persisted the raw template. The "template" cdkd talks about lives only in cdk.out + in-memory during the deploy. The Phase 3 cache file under `cdk.out/.cdkd-macro-cache/` is *not* state — it is an optimization that can be deleted at any time.

## 8. Out of scope (explicitly)

- **Local re-implementation of any AWS-managed transform.** Approach B was considered and rejected. A future "opt-in offline expansion for `AWS::LanguageExtensions`" can ship as a separate flag if benchmark data justifies it.
- **`cdk deploy --hotswap`-style fast-path for SAM.** Out of scope for v1.
- **Mixed-account / cross-account macro Lambdas.** If a custom macro lives in another AWS account, the user must already have configured CFn to cross the boundary; cdkd's round-trip will work as long as the calling identity for CFn has the right `lambda:InvokeFunction` grants (which is a pre-existing CFn-side configuration, not a cdkd concern).
- **Pre-expansion of the template for `cdkd diff` / `cdkd local *` in Phase 2.** Wired in Phase 4 once the helper proves out on the deploy path.

## 9. Open questions for AWS-API verification

Before Phase 2 lands, the following need empirical verification (per memory rule `feedback_verify_cfn_semantics_empirically.md`):

1. **Does `CreateChangeSet --change-set-type CREATE` against a non-existent stack name accept a template with `Transform: ['AWS::Serverless-2016-10-31']` and `CAPABILITY_AUTO_EXPAND` without requiring the stack to first exist in `REVIEW_IN_PROGRESS`?** AWS docs are ambiguous — the typical SAM workflow is `aws cloudformation deploy --capabilities CAPABILITY_AUTO_EXPAND`, which is a higher-level wrapper. Verify with a literal `aws cloudformation create-change-set --stack-name does-not-exist --change-set-type CREATE --template-body file://sam.json --capabilities CAPABILITY_AUTO_EXPAND CAPABILITY_NAMED_IAM`.
2. **Does `GetTemplate --template-stage Processed` against a changeset that was created but not executed return the post-macro-expansion template?** AWS docs are clear that `Processed` returns the expanded form, but only document the case where the stack exists. The changeset-only path is less documented and may require `ChangeSetName` parameter on `GetTemplate`.
3. **Does `DeleteStack` against a stack in `REVIEW_IN_PROGRESS` succeed without any other prerequisites?** This is the cleanup path for the transient expansion stack. Worth confirming there is no minimum lifetime / no requirement to execute the changeset first.
4. **What is the median + p95 latency of `CreateChangeSet --change-set-type CREATE` with `AWS::Serverless-2016-10-31`?** The 30–60s estimate is folklore — measure against a few representative SAM templates (small, medium, large) and document the real distribution in the Phase 2 PR.
5. **How do nested macros behave under `CAPABILITY_AUTO_EXPAND`?** If a SAM template's expansion produces a `Fn::Include` snippet that pulls in another macro, does the changeset complete in one round or does it require a second `CreateChangeSet` against the already-expanded body? This affects the multi-stage scope decision in §1 (currently rejected, but if AWS handles it in one round we may be able to support it for free).
6. **For `AWS::Include` snippet-level transforms with `Location: 's3://...'`, is the S3 fetch authenticated under the caller's identity or under a CFn service role?** Affects the IAM permission documentation in `docs/cli-reference.md`.

These are verification tasks, not design uncertainties — the design works regardless of the answers, but the implementation PR should embed the empirical results inline.

## 10. Pointers (for the implementing PR)

- `src/synthesis/synthesizer.ts` — the insertion point (see §6 for the diff sketch).
- `src/synthesis/assembly-reader.ts` — defines the `StackInfo.template` shape that `containsMacro` reads.
- `src/deployment/intrinsic-function-resolver.ts` — confirm no regression on `Fn::Transform` (post-expansion, the resolver should never see one; if it does, that is a bug in the expander).
- `src/analyzer/template-parser.ts` — same: post-expansion the DAG builder must work unchanged.
- `src/cli/commands/retire-cfn-stack.ts` — precedent for `CreateChangeSet` + waiter + `DeleteChangeSet` cleanup pattern; the SDK call shapes are the closest existing template to copy.
- `src/cli/upload-cfn-template.ts` (PR #450) — the > 51,200-byte `TemplateURL` upload helper. Reuse for large macro-containing templates.
- `src/utils/error-handler.ts` — add a new `MacroExpansionError` class with exit code 2, mirroring `SynthesisError`.

Related memory rules: `feedback_describe_type_before_cfn_handler.md`, `feedback_verify_cfn_semantics_empirically.md`, `feedback_design_alternatives_full_palette.md`.
