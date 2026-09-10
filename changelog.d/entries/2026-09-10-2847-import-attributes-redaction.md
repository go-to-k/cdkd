- **`cdkd import` no longer writes an unredacted AWS readback into `ResourceState.attributes`** (issue [#2847](https://github.com/go-to-k/cdkd/issues/2847)). `attributes` was the only bag on an imported record no redactor touched (`properties` since the GHSA fix, `observedProperties` since [#2828](https://github.com/go-to-k/cdkd/issues/2828)).

  **The choke point**: `resolveImportedProperties` redacts `attributes` against the same secrets map that just redacted `properties`, on the THROW arm too — a resolve that failed partway has already put a plaintext in the bag.

  **The Cloud Control surface**: `CloudControlProvider.import` surfaced the whole `GetResource` model, whose keys are not GetAtt-compatible attribute names. It is narrowed to the type's schema-declared `readOnlyProperties`; uncertified keys are MASKED (`***`) rather than dropped, and LEAF-WISE so containers stay walkable — a dropped key or a masked container dead-ends in `constructAttribute`'s wrong physical-id return, while a masked leaf is refused by name. An unresolvable schema certifies nothing and warns naming `cloudformation:DescribeType`.

  **The `Ref` reader**: for types whose CFn `Ref` is a state key, `refStateLookupFromResource` returned the first non-empty string — `***` is one — so `{"Ref": X}` resolved to the mask unrefused. It now skips a masked leaf and records a redacted read, so the deploy fails by name.

  **Not closed**: a credential that is itself a read-only attribute is still in the clear. The same payload lands unnarrowed in `observedProperties` — by design, it is the drift baseline, but an unreferenced model key has no expression to redact onto ([#2868](https://github.com/go-to-k/cdkd/issues/2868)). The deploy path rewrites the whole model into `attributes` ([#2925](https://github.com/go-to-k/cdkd/issues/2925)).

  Changed: `import.ts`, `cloud-control-provider.ts`, `intrinsic-function-resolver.ts`, `deploy-engine.ts`, `orphan-rewriter.ts`, new `read-only-properties.ts`.
