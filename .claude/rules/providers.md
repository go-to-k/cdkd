---
description: ResourceProvider interface, Provider Registry, and adding a new SDK Provider
paths:
  - 'src/provisioning/**'
---

# Provider Pattern

`ResourceProvider` (create / update / delete / getAttribute) is declared in `src/types/resource.ts`. `CreateContext` and `UpdateContext` both extend `SecretMaskingContext`: an optional `maskSecrets?: (text: string) => string` a provider MUST apply to any log line interpolating a RESOLVED property value. Register each type with `ProviderRegistry.getInstance().register('AWS::IAM::Role', new IAMRoleProvider())`.

## Where the rest lives

Loaded under `src/provisioning/providers/**`: [replay + refusals](provider-replay-and-refusals.md), [property fidelity](provider-property-fidelity.md), [diff/record folds](provider-diff-record-folds.md), [secret masking](provider-masking.md), [delete path](provider-delete-path.md), [AWS response reads](provider-aws-response-reads.md), [nested key divergences](provider-nested-key-divergence.md), [resource identity](provider-resource-identity.md), [Custom Resources](provider-custom-resources.md). Per-file notes for `src/provisioning/**`: [layout-provisioning.md](layout-provisioning.md).

## Adding a New SDK Provider

1. New file in `src/provisioning/providers/`; register it in `registerAllProviders()` (`src/provisioning/register-providers.ts`).
2. Refresh the CFn schema fixture (`node scripts/refresh-cfn-schemas.mjs --only-missing`) and classify each unaccounted property into `handledProperties` or `unhandledByDesign` so `property-coverage` stays green ([docs/provider-rules.md](../../docs/provider-rules.md#handledproperties-against-the-cfn-schema)).
3. A provider that FORWARDS a nested config blob belongs in `NESTED_KEY_TARGETS` (`scripts/gen-nested-key-coverage.ts`); one building FRESH SDK objects sets `freshObjectMapper: true` too. Adding an EXISTING type there needs an explicit `node scripts/refresh-cfn-schemas.mjs '<AWS::Service::Type>'`: `--only-missing` skips types that already have a fixture, and an older capture lacks the `definitionShapes` / `nestedPropertyPaths` sections the generator reads. Then re-run `vp run gen:all-matrices`.
4. Add the type to [docs/supported-resources.md](../../docs/supported-resources.md) and [docs/import.md](../../docs/import.md) — `provider-docs-coverage.test.ts` matches the exact type string and fails CI on a missing one.
5. A provider gating a stabilization wait on `CDKD_NO_WAIT` (or `CDKD_FULL_WAIT`) must appear in 4 places: the wait-semantics table and its intro in [docs/cli-deploy.md](../../docs/cli-deploy.md), and the option's help string + JSDoc in [src/cli/options.ts](../../src/cli/options.ts). Settle what "done" means BEFORE adding the wait, per that table's wait-semantics rule — it is the single source of truth for per-type completion, including when a default may take the fast side ([#1282](https://github.com/go-to-k/cdkd/issues/1282)).

Full guide: [docs/provider-development.md](../../docs/provider-development.md)
