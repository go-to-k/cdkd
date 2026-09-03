---
description: ResourceProvider interface, Provider Registry, Custom Resources, and adding a new SDK Provider
paths:
  - 'src/provisioning/**'
---

# Provider Pattern

```typescript
interface ResourceProvider {
  create(logicalId: string, resourceType: string, properties: Record<string, unknown>, context?: CreateContext): Promise<ResourceCreateResult>;
  // `CreateContext` and `UpdateContext` both extend `SecretMaskingContext`
  // (issue #1932): an optional `maskSecrets?: (text: string) => string` that a
  // provider MUST apply to any log line interpolating a RESOLVED property
  // value. See "Masking a resolved property value in a provider log line".
  update(logicalId: string, physicalId: string, resourceType: string, properties: Record<string, unknown>, previousProperties: Record<string, unknown>, context?: UpdateContext): Promise<ResourceUpdateResult>;
  delete(logicalId: string, physicalId: string, resourceType: string, properties?: Record<string, unknown>, context?: DeleteContext): Promise<void | ResourceDeleteResult>;
  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown>;
}
```

Register Provider for each resource type in Provider Registry:

```typescript
const registry = ProviderRegistry.getInstance();
registry.register('AWS::IAM::Role', new IAMRoleProvider());
```

## Where the rest lives

The per-topic detail below is loaded only when a file under `src/provisioning/providers/**` enters context, so the shared helpers in `src/provisioning/*.ts` no longer pay for it.

| topic | file |
| --- | --- |
| create / update context, `replayingState`, pre-flight refusals, `effectiveProperties` | [provider-replay-and-refusals.md](provider-replay-and-refusals.md) |
| property fidelity on the wire: substituted values, dropped and never-emitted keys | [provider-property-fidelity.md](provider-property-fidelity.md) |
| diff-side / record-side folds, empty collections, `UpdateContext`, retiring a failed create | [provider-diff-record-folds.md](provider-diff-record-folds.md) |
| masking a resolved property value in a provider log line | [provider-masking.md](provider-masking.md) |
| the delete path: `expectedRegion` + the `assertRegionMatch()` region-check helper, `forceDataDelete`, warn-and-continue arms, skip reporting | [provider-delete-path.md](provider-delete-path.md) |
| reading AWS responses: type != populated, id forms that break `import()`, malformed-value defaults | [provider-aws-response-reads.md](provider-aws-response-reads.md) |
| fixing a nested CFn -> SDK key divergence | [provider-nested-key-divergence.md](provider-nested-key-divergence.md) |
| confirming WHICH resource you are acting on: globally-unique names, `*AlreadyExists` short-circuits, a state record's physical id | [provider-resource-identity.md](provider-resource-identity.md) |
| Lambda-backed Custom Resources: response shapes, `NoEcho`, transient-authz retry, log-tail diagnostics | [provider-custom-resources.md](provider-custom-resources.md) |

Per-file notes for `src/provisioning/**`: [layout-provisioning.md](layout-provisioning.md).

## Custom Resources

Lambda-backed Custom Resources -- response shapes, `NoEcho`, the transient-authz retry, the
log-tail diagnostics, the delete fail-fast -- live in
[provider-custom-resources.md](provider-custom-resources.md).


## An "already exists" error is scoped to the API's NAMESPACE, not to your region

A globally unique NAME over a regionally located resource means an
`*AlreadyExists` / `*AlreadyOwned` error, a state record's physical id, and a
successful create can each denote a resource in a region you are not deploying
to. `AWS::S3::Bucket` is where that came apart, three separate ways. The full
rule is in
[.claude/rules/provider-resource-identity.md](provider-resource-identity.md),
auto-loaded under `src/provisioning/providers/`.

## Adding a New SDK Provider

1. Create new file in `src/provisioning/providers/`
2. Implement `ResourceProvider` interface
3. Register in `src/provisioning/register-providers.ts` within the `registerAllProviders()` function
4. Refresh the CFn schema fixture for the new type: `node scripts/refresh-cfn-schemas.mjs --only-missing` (requires AWS credentials with `cloudformation:DescribeType`). Then classify every unaccounted property into `handledProperties` (if `create()`/`update()` wires the field) or `unhandledByDesign` (with a one-line rationale) so the new `property-coverage` test stays green — see [docs/provider-development.md](../../docs/provider-development.md) §3c. If the provider FORWARDS a nested config blob (a `handledProperties` entry whose value is a nested object/array the provider re-shapes for the SDK), ALSO add it to `NESTED_KEY_TARGETS` in `scripts/gen-nested-key-coverage.ts` — the critic's first run audits every nested key spelling against the SDK model (the #1370 silent-drop class, issue #1373). If the provider builds FRESH SDK objects naming each member rather than forwarding the blob, set `freshObjectMapper: true` too, after measuring the finding count — see the "Know what membership does and does not guarantee" bullet above (issue #1432).

   Adding an EXISTING type to `NESTED_KEY_TARGETS` needs a different refresh invocation: `node scripts/refresh-cfn-schemas.mjs '<AWS::Service::Type>'` with an explicit type argument, NOT `--only-missing`. `--only-missing` skips every type that already has a fixture file, and a fixture captured before the `definitionShapes` / `nestedPropertyPaths` extension does not carry the sections the generator reads — 14 of 134 fixtures had them as of 2026-08-12, i.e. exactly the then-current target set. `loadReport` throws naming the missing capture and the command rather than auditing zero paths, so the failure is loud; the point of this note is that the fix is not the command the previous paragraph names (issue #1699). The refresh is additive for an unchanged type — it rewrites `generatedAt` and adds the capture sections, leaving `properties` / `readOnlyProperties` / `createOnlyProperties` untouched — but re-run `vp run gen:all-matrices` afterwards, because `primaryIdentifier` also arrives with it and feeds `gen-enrichment-coverage` (opting `AWS::Lambda::EventSourceMapping` in this way retired a false `Id` enrichment gap the stale capture had been reporting; PR #1694).
5. Write tests
6. Add the resource type to [docs/supported-resources.md](../../docs/supported-resources.md) (deploy/manage capability table) AND to [docs/import.md](../../docs/import.md) (import-side coverage: auto-lookup vs override-only vs sub-resource)
7. **If the provider gates a stabilization wait on `process.env['CDKD_NO_WAIT']`** (i.e. `--no-wait` skips a multi-minute poll for this type), add the resource type to the `--no-wait` docs in ALL of: the `--no-wait` table + intro and the `--no-wait` resource list in [docs/cli-deploy.md](../../docs/cli-deploy.md), and the `noWaitOption` help string + JSDoc in [src/cli/options.ts](../../src/cli/options.ts). (The README no longer enumerates flags — its former `--no-wait` feature bullet's per-type list lives in docs/cli-deploy.md's `--no-wait` list, published at https://cdkd.dev/cli-deploy/.) Enforced by `tests/unit/provisioning/no-wait-doc-coverage.test.ts` (fails CI if a `CDKD_NO_WAIT`-honoring provider has no handled type in the cli-deploy.md table). The `AWS::Lambda::MicrovmImage` provider shipped honoring `--no-wait` but missed this list — the test is the backstop.

   The same 4-site rule applies to the opposite end of the axis,
   `process.env['CDKD_FULL_WAIT']` (`--full-wait`, issue
   [#1275](https://github.com/go-to-k/cdkd/issues/1275)): a provider that
   waits ONLY under `--full-wait` belongs in the same wait-semantics table AND
   in the `--full-wait` section of
   [docs/cli-deploy.md](../../docs/cli-deploy.md). Enforced by
   `tests/unit/provisioning/full-wait-doc-coverage.test.ts` (added when
   `AWS::CloudFront::Distribution` joined `AWS::ECS::Service` as the second
   such type, issue [#1282](https://github.com/go-to-k/cdkd/issues/1282)).

   Before adding EITHER kind of wait, settle the completion definition per
   [docs/cli-deploy.md](../../docs/cli-deploy.md)'s wait-semantics rule:
   where CloudFormation and Terraform agree, match them; where they disagree,
   the default takes the dev/test-friendly side and `--full-wait` opts into the
   CloudFormation one. A default may take the fast side even where BOTH
   engines wait, but only under the 3-condition fast-side clause (issue
   #1282, recorded in the cli-deploy.md wait-semantics intro): (a) no
   in-deploy consumer of the waited-for state, (b) no failure signal in the
   wait, and (c) the comparison tool has both modes so the benchmark can
   report two like-for-like rows. Record the divergence in the table rather
   than leaving it implicit in provider code.

See [docs/provider-development.md](../../docs/provider-development.md) for details.
