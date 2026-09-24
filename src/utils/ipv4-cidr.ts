/**
 * Return the host-bit-cleared form of an IPv4 CIDR (`100.68.0.18/18` ->
 * `100.68.0.0/18`), or `undefined` when the input is not an IPv4 CIDR at all
 * (an IPv6 CIDR, a `pl-…` prefix-list id, or anything malformed).
 *
 * AWS rewrites a non-canonical CIDR on `CreateRoute`, so a route id that
 * spells the template's CIDR can differ from the destination AWS reports
 * (issue #1771). `EC2Provider`'s import compares through this (issue #3661).
 * `src/cli/commands/export.ts` still carries a private copy of the same
 * function; fold it onto this one once the open PR holding that file lands.
 */
export function canonicalizeIpv4Cidr(value: string): string | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
  if (!match) return undefined;
  const octets = [match[1]!, match[2]!, match[3]!, match[4]!].map(Number);
  const prefixLength = Number(match[5]!);
  if (prefixLength > 32 || octets.some((octet) => octet > 255)) return undefined;
  const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const network = (address & mask) >>> 0;
  const networkOctets = [
    network >>> 24,
    (network >>> 16) & 0xff,
    (network >>> 8) & 0xff,
    network & 0xff,
  ];
  return `${networkOctets.join('.')}/${prefixLength}`;
}
