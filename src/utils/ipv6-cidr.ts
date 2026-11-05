import { isIPv6 } from 'node:net';

/** Comparison-only IPv6 network spelling; never substitute it into an AWS request. */
export function canonicalizeIpv6Cidr(value: string): string | undefined {
  const match = /^([0-9a-fA-F:.]{2,45})\/(\d{1,3})$/.exec(value);
  if (!match || !isIPv6(match[1]!)) return undefined;
  const prefix = Number(match[2]!);
  if (prefix > 128) return undefined;
  try {
    // WHATWG URL parsing handles compression, case and embedded IPv4 notation.
    const address = new URL(`http://[${match[1]!}]/`).hostname.slice(1, -1);
    const [left, right] = address.split('::');
    const before = left ? left.split(':') : [];
    const after = right ? right.split(':') : [];
    const pieces =
      right === undefined
        ? before
        : [...before, ...new Array<string>(8 - before.length - after.length).fill('0'), ...after];
    const hostBits = BigInt(128 - prefix);
    const network =
      (BigInt(`0x${pieces.map((piece) => piece.padStart(4, '0')).join('')}`) >> hostBits) <<
      hostBits;
    const hex = network.toString(16).padStart(32, '0');
    const expanded = Array.from({ length: 8 }, (_, index) =>
      hex.slice(index * 4, index * 4 + 4)
    ).join(':');
    const compressed = new URL(`http://[${expanded}]/`).hostname.slice(1, -1);
    return `${compressed}/${prefix}`;
  } catch {
    return undefined;
  }
}
