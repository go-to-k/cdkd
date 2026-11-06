/**
 * EC2 `IpProtocol` value canonicalization (issue
 * [#1643](https://github.com/go-to-k/cdkd/issues/1643)).
 *
 * EC2 owns the spelling of a security-group rule's protocol: it accepts an
 * IANA protocol NUMBER or a protocol NAME, rewrites the four numbers it has a
 * name for before storing the rule, and lower-cases a name it is given. So the
 * value cdkd SENDS and the value AWS REPORTS are routinely two spellings of
 * ONE protocol.
 *
 * This lives in `src/utils/` rather than beside either consumer because it has
 * TWO, in different layers: `src/analyzer/drift-protocol-normalize.ts` (the
 * drift comparator) and `src/provisioning/providers/ec2-provider.ts` (rule
 * IDENTITY — the standalone-rule lookup, the inline-rule reconcile, and the
 * write-side revoke/authorize diff). Hosting it in the analyzer made the
 * provider carry the tree's only `src/provisioning/**` -> `src/analyzer/**`
 * import, which is both a layering break and a real hazard: an edit made for
 * the drift comparator would silently change which AWS rule a revoke matches.
 *
 * ## The rename set is MEASURED, not guessed
 *
 * Probed against real AWS (us-east-1, 2026-08-12) by authorizing one rule per
 * protocol on a scratch security group and reading `IpProtocol` back, for
 * ingress AND egress:
 *
 * - RENAMED: `1` -> `icmp`, `6` -> `tcp`, `17` -> `udp`, `58` -> `icmpv6`.
 * - NOT renamed: `-1`, `0`, `2`, `4`, `27`, `41`, `47`, `50`, `51`, `88`,
 *   `89`, `94`, `103`, `112`, `132`, `255` — all read back as the number.
 *
 * So the rename set is exactly the four protocols EC2 has a NAME for — a
 * CLOSED set, not the open-ended IANA list the issue worried about. `-1` is
 * unaffected, which is why #1633's live test came back clean.
 *
 * Case is also AWS's to decide: `TCP` / `Tcp` / `tcp` authorized on the same
 * port collapsed into ONE `tcp` permission in the readback, so a name is
 * matched case-insensitively and canonicalized to lower case. Only the four
 * KNOWN names are lowered — an unrecognized string is left exactly as-is
 * rather than folded, so this can never make two genuinely different values
 * compare equal.
 *
 * Known bound: only the CANONICAL decimal spelling is recognized. A
 * zero-padded `'06'` or a `'0x6'` misses the table and is returned verbatim,
 * so such a template still phantom-drifts. Neither form has been observed in
 * a CDK-synthesized template, and accepting them would mean parsing rather
 * than table lookup — which is what keeps the "closed, measured set" property
 * that makes this safe.
 */

/**
 * The protocol numbers AWS rewrites to a name, measured (see the module
 * docstring). Keyed by the number's STRING form, since that is the shape every
 * input is normalized to first.
 */
const PROTOCOL_NUMBER_TO_NAME: ReadonlyMap<string, string> = new Map([
  ['1', 'icmp'],
  ['6', 'tcp'],
  ['17', 'udp'],
  ['58', 'icmpv6'],
]);

/** The four names EC2 canonicalizes to, for the case-insensitive match. */
const CANONICAL_PROTOCOL_NAMES: ReadonlySet<string> = new Set(PROTOCOL_NUMBER_TO_NAME.values());

/**
 * Canonicalize ONE `IpProtocol` value the way EC2 does.
 *
 * Returns the input unchanged for any shape that is not a protocol value — an
 * unresolved intrinsic object (`{Ref: ...}`), `null`, a boolean.
 *
 * EVERY number is stringified, not only an integer one: an unquoted YAML
 * `IpProtocol: 47` parses to a number while AWS always reads back a string, and
 * `ec2-provider.ts`'s rule-identity key has stringified every number since
 * #1633 specifically so a legacy record holding the NUMBER `-1` still matches
 * AWS's `'-1'`. Narrowing that to integers would have silently regressed a
 * malformed `6.5` from `'6.5'` to the number `6.5`, and collapsed `NaN` /
 * `Infinity` onto one JSON `null` bucket — the exact merging that key exists
 * to avoid. The rename lookup is a table hit, so a non-integer simply misses it.
 */
export function canonicalizeIpProtocolValue(value: unknown): unknown {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number') {
    text = String(value);
  } else {
    return value;
  }

  const renamed = PROTOCOL_NUMBER_TO_NAME.get(text);
  if (renamed !== undefined) return renamed;

  const lowered = text.toLowerCase();
  if (CANONICAL_PROTOCOL_NAMES.has(lowered)) return lowered;

  return text;
}
