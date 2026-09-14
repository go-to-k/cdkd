/**
 * The ONE spelling of the attribute-map rule an SDK provider's `create()` /
 * `update()` / `import()` result follows (issue #3077, closing the `?? ''`
 * shape `docs/provider-development.md` forbids under "Never store an
 * empty-string placeholder"):
 *
 *   an attribute cdkd could not read back is ABSENT from the map — never
 *   recorded as the empty string, and never as a present-but-`undefined` key.
 *
 * The consumers of `ResourceState.attributes` all key off exactly that
 * distinction, and a sentinel puts every one of them on the wrong branch:
 *
 *  - the deploy engine persists the map as-is, so `''` becomes the recorded
 *    value of a field AWS never assigned;
 *  - the intrinsic resolver serves a stored attribute whenever it is not
 *    `undefined`, so `''` shadows `constructAttribute` forever — the
 *    `AWS::EC2::Instance` IP / DNS / AZ arm re-describes the instance from
 *    AWS only on a MISS, the `Arn` arms of the RDS family rebuild the ARN
 *    only on a MISS;
 *  - the Outputs export pass publishes whatever the resolver returned, so a
 *    stored `''` is exported to every `Fn::ImportValue` consumer.
 *
 * It exists as a MODULE rather than a per-provider idiom because the rule was
 * prose and 96 attribute-position `?? ''` / `|| ''` / bare `''` sites across
 * 18 providers shipped anyway (measured 2026-09-14 with the TypeScript-compiler
 * walk that is now `tests/unit/provisioning/attribute-map.test.ts`). A helper
 * that DROPS the key is the one form a provider cannot spell wrong by habit.
 *
 * Two values are treated as "not read back":
 *
 *  - `undefined`: the SDK's spelling of an unassigned optional member.
 *  - `null`: no AWS SDK v3 read-back reports a scalar attribute as `null`, and
 *    a stored `null` takes the resolver's "not `undefined`" hit branch exactly
 *    like `''` does.
 *
 * Every other value is kept verbatim — INCLUDING an empty string AWS itself
 * reported (`false`, `0`, an empty array and an object likewise). The helper
 * stops cdkd MANUFACTURING `''` for a field it never read; a `''` that came
 * off the wire is a known value with a meaning the provider owns. The EC2
 * Instance provider is where that distinction is load-bearing: a `running`
 * instance with no public address is described with `PublicDnsName: ''` and
 * no `PublicIpAddress`, and CloudFormation answers `''` for both — a KNOWN
 * empty, recorded as such so a reference does not degrade to the instance id
 * on every resolution — while the same `''` on a `pending` instance means
 * "not yet", which that provider maps to `undefined` BEFORE calling this
 * helper (its `describedInstanceAttributes`). A caller that knows a `''`
 * means "unknown" is the one that must say so; this helper cannot tell.
 *
 * Deliberately NOT a general "compact this record" utility: it is scoped to
 * attribute maps. A property bag keeps its `undefined`-valued keys out by other
 * means (`.claude/rules/provider-property-fidelity.md`, "Remove the key rather
 * than setting it to `undefined`").
 *
 * A LEAF module (imports nothing) so every provider can take it without adding
 * an edge to the provider import ring.
 */

/**
 * Build an attribute map from read-back values, omitting every key whose value
 * is `undefined` or `null`.
 */
export function definedAttributes(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

/**
 * `String(value)` for a numeric read-back whose CloudFormation attribute is a
 * string (`Endpoint.Port`), or `undefined` when the field is unassigned — so
 * `definedAttributes` drops the key instead of recording the literal
 * `'undefined'`, which is what `String(described?.Port ?? '')` yields once its
 * `?? ''` is merely deleted.
 */
export function stringifyIfAssigned(value: number | string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}
