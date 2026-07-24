---
description: ResourceProvider interface, Provider Registry, Custom Resources, and adding a new SDK Provider
paths:
  - 'src/provisioning/**'
---

# Provider Pattern

```typescript
interface ResourceProvider {
  create(logicalId: string, resourceType: string, properties: Record<string, unknown>): Promise<ResourceCreateResult>;
  update(logicalId: string, physicalId: string, resourceType: string, properties: Record<string, unknown>, previousProperties: Record<string, unknown>): Promise<ResourceUpdateResult>;
  delete(logicalId: string, physicalId: string, resourceType: string, properties?: Record<string, unknown>, context?: DeleteContext): Promise<void>;
  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown>;
}
```

The `context.expectedRegion` parameter on `delete` is the region recorded
in the stack state when the resource was created. Providers MUST verify
the AWS client's region against `context.expectedRegion` (via the shared
`assertRegionMatch()` helper in `src/provisioning/region-check.ts`)
before treating a `*NotFound` error as idempotent delete success — see
"DELETE idempotency" below and [docs/provider-development.md](../../docs/provider-development.md).

Register Provider for each resource type in Provider Registry:

```typescript
const registry = ProviderRegistry.getInstance();
registry.register('AWS::IAM::Role', new IAMRoleProvider());
```

## Custom Resources

- Supports Lambda-backed Custom Resources
- Create/Update/Delete lifecycle
- ResponseURL uses S3 pre-signed URL for cfn-response handlers
- **Response-bucket region correction (issue #1195).** The response bucket is cdkd's STATE bucket, which can live in a different region from the deploy region (account-scoped region-free default bucket). Before the first response-bucket S3 operation (placeholder `PutObject` + `ResponseURL` presign in `generateResponseURL`), `ensureResponseClient()` lazily resolves the bucket's actual region via the shared `rebuildClientForBucketRegion` helper (#827) and swaps in a region-corrected client — a pre-signed URL's host is region-specific, so signing with the deploy region against a foreign-region bucket 301s (`PermanentRedirect`). The `bucketRegion` argument to `setResponseBucket` is only a starting hint; call sites that pass no region (destroy / drift / state paths) are corrected the same way.
- CDK Provider framework: isCompleteHandler/onEventHandler async pattern detection
- Async CRUD with polling (max 1hr), pre-signed URL validity 2hr
- Sets `disableOuterRetry = true` on the `ResourceProvider` interface so the deploy engine's outer `withRetry` loop does NOT re-invoke `provider.create()` on transient SDK errors. Each invocation derives a fresh pre-signed S3 URL and RequestId via `prepareInvocation()`; an outer retry would strand the first attempt's Lambda response at an S3 key nobody polls. Internal exponential-backoff polling on the response key handles eventual consistency on its own.
- **Transient IAM-authorization retry (CR-internal).** Because cdkd's fast SDK path attaches a backing Lambda's execution-role inline policy and invokes the function ~1s later, the function can cold-start before IAM propagates the policy to its assumed-role session — caching stale, policy-less credentials for the warm container's life. The CDK Provider framework's first invoke / `waitUntilFunctionActive` (`lambda:GetFunction`) then 403s ("not authorized to perform" / "not in the state functionActive") and the custom resource FAILs. CloudFormation never hits this because its deployment latency lets IAM settle; cdkd does NOT, so `invokeCustomResourceWithRetry()` re-invokes (default 2 retries; `CDKD_CR_AUTHZ_MAX_RETRIES`, 0 disables) when the FAILED reason matches the NARROW IAM-authz signal set (`CR_TRANSIENT_AUTHZ_SIGNALS` — `not authorized to perform` / `no identity-based policy allows` / `not in the state functionActive` / `cannot be assumed` / `is unable to assume`; generic timeouts / handler bugs are deliberately NOT retried). Each retry derives a fresh pre-signed URL/RequestId AND recycles the backing function's execution environment via a no-op `UpdateFunctionConfiguration` (so the next cold start re-assumes the role with the now-propagated policy — a plain re-invoke would reuse the same warm container's stale creds). This is the CR-path analogue of the IAM-propagation retry `withRetry` already applies to every other resource (the CR path opts out of `withRetry` via `disableOuterRetry`, so it retries internally instead). Verified end-to-end via the `custom-resource-provider` integ.
- Implements `getMinResourceTimeoutMs()` returning `asyncResponseTimeoutMs` (default 1h) so the deploy engine's per-resource deadline auto-lifts to the polling cap for CR resources only — Custom-Resource-heavy stacks no longer need `--resource-timeout 1h`. A user-supplied `--resource-timeout AWS::CloudFormation::CustomResource=<DURATION>` per-type override still wins as the explicit escape hatch.
- **Delete fail-fast when the backing Lambda is gone (issue #804).** `delete()` issues a single `GetFunction` pre-check before preparing the invocation; a definitive `ResourceNotFoundException` logs a warning and treats the Custom Resource as already deleted (warn-and-continue is the delete path's existing policy). Without it, a re-run after an interrupted / partially-failed destroy entered `waitForBackingLambdaReady`, whose SDK waiters classify `ResourceNotFoundException` as RETRY and poll `GetFunction` for the full 10-minute `maxWaitTime`. Inconclusive pre-check errors (throttle, IAM) fall through to the normal invoke path; SNS-backed tokens skip the pre-check; create / update never pre-check (they must fail loudly against a missing function).
- Implemented in `CustomResourceProvider`

## Reading a field off an AWS response: type != populated

An AWS SDK v3 response TYPE declaring a field does NOT mean the API you called
populates it. The models are shared across operations, so a `List*` summary can
declare `Tags?: Tag[]` and never carry tags. AWS documents the exception on the
COMMAND, not the model:

> IAM resource-listing operations return a subset of the available attributes
> for the resource. For example, this operation does not return tags, even
> though they are an attribute of the returned object. To view all of the
> information for an instance profile, see GetInstanceProfile.

`iam-instance-profile-provider` carried exactly this defect until PR #1127:
`import()` read tags off the `ListInstanceProfiles` summary, which typechecked
and always saw `undefined`. Because a tag-walk non-match is not an error, the
walk simply never matched and `cdkd import` reported the resource as
**not-found** — a silent wrong answer, not a crash. The provider's unit tests
hand-fed inline `Tags` and so agreed with the bug.

**When consuming a field from a `List*` / `Describe*` response:**

- Read the command doc
  (`node_modules/@aws-sdk/client-*/dist-types/commands/<Op>Command.d.ts`), not
  just the model in `models/models_*.d.ts`. Types prove SHAPE; only the command
  doc (or a live call against a populated account) proves POPULATION.
- Prefer a per-candidate `Get*` when the list form is documented as a subset.
  The extra call is the correct cost.
- A live probe that comes back empty because the account has no such resource is
  **inconclusive**, not confirmation.
- Ask of any test: "would this still pass if the API returned nothing for this
  field?" If yes, it pins your assumption, not the behavior.

## Adding a New SDK Provider

1. Create new file in `src/provisioning/providers/`
2. Implement `ResourceProvider` interface
3. Register in `src/provisioning/register-providers.ts` within the `registerAllProviders()` function
4. Refresh the CFn schema fixture for the new type: `node scripts/refresh-cfn-schemas.mjs --only-missing` (requires AWS credentials with `cloudformation:DescribeType`). Then classify every unaccounted property into `handledProperties` (if `create()`/`update()` wires the field) or `unhandledByDesign` (with a one-line rationale) so the new `property-coverage` test stays green — see [docs/provider-development.md](../../docs/provider-development.md) §3c.
5. Write tests
6. Add the resource type to [docs/supported-resources.md](../../docs/supported-resources.md) (deploy/manage capability table) AND to [docs/import.md](../../docs/import.md) (import-side coverage: auto-lookup vs override-only vs sub-resource)
7. **If the provider gates a stabilization wait on `process.env['CDKD_NO_WAIT']`** (i.e. `--no-wait` skips a multi-minute poll for this type), add the resource type to the `--no-wait` docs in ALL of: the `--no-wait` table + intro in [docs/cli-reference.md](../../docs/cli-reference.md), the `--no-wait` feature bullet in [README.md](../../README.md), and the `noWaitOption` help string + JSDoc in [src/cli/options.ts](../../src/cli/options.ts). Enforced by `tests/unit/provisioning/no-wait-doc-coverage.test.ts` (fails CI if a `CDKD_NO_WAIT`-honoring provider has no handled type in the cli-reference table). The `AWS::Lambda::MicrovmImage` provider shipped honoring `--no-wait` but missed this list — the test is the backstop.

See [docs/provider-development.md](../../docs/provider-development.md) for details.
