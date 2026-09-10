- **`cdkd import` no longer writes an unredacted AWS readback into `ResourceState.attributes`** (issue [#2847](https://github.com/go-to-k/cdkd/issues/2847)). `attributes` was the only bag on an imported record no redactor touched (`properties` since the GHSA fix, `observedProperties` since [#2828](https://github.com/go-to-k/cdkd/issues/2828)).

  **The choke point**: `resolveImportedProperties` redacts `attributes` against the same secrets map that redacted `properties`, on the THROW arm too: a resolve that failed partway already put plaintext in the bag.

  **The Cloud Control surface**: `CloudControlProvider.import` surfaced the whole `GetResource` model. It is narrowed to the type's schema-declared `readOnlyProperties`; uncertified keys are MASKED (`***`) rather than dropped, LEAF-WISE so containers stay walkable: a dropped key or masked container dead-ends in `constructAttribute`'s wrong physical-id return; a masked leaf is refused by name. An unresolvable schema certifies nothing and warns naming `cloudformation:DescribeType`.

  **The `Ref` reader**: a state-key `Ref` recovery returned the first non-empty string, and `***` is one. It now skips a masked leaf and REPORTS it, for an OPTED-IN caller only: `cdkd deploy` fails the resource — or the stack OUTPUT reading it — by name. `cdkd diff` / `scrub` / `import` are unchanged; `cdkd orphan` reports the site unresolvable, `--force` warns.

  **Not closed**: a read-only attribute that IS a credential stays in the clear. The same payload lands unnarrowed in the `observedProperties` drift baseline ([#2868](https://github.com/go-to-k/cdkd/issues/2868)); the deploy path rewrites the whole model back ([#2925](https://github.com/go-to-k/cdkd/issues/2925)); `cdkd export`'s mask blocker tests `properties` only ([#2932](https://github.com/go-to-k/cdkd/issues/2932)).

  Changed: `import.ts`, `cloud-control-provider.ts`, `intrinsic-function-resolver.ts`, `deploy-engine.ts`, `orphan-rewriter.ts`, new `read-only-properties.ts`.
