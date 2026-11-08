import type { IntrinsicFunctionResolver } from '../../intrinsic-function-resolver.js';
import { displayMasked, maskValueLeaves } from '../masking-display.js';
import { markNonRetryable } from '../../retryable-errors.js';
import { type ResolverContext } from '../support.js';

/**
 * Resolve an SSM Parameter Store dynamic reference
 *
 * Format: ssm:PARAMETER_NAME
 * Parts[0] = 'ssm'
 * Parts[1] = PARAMETER_NAME
 */
/**
 * Resolve Fn::Cidr intrinsic function
 *
 * Fn::Cidr returns an array of CIDR address blocks.
 * Syntax: { "Fn::Cidr": [ ipBlock, count, cidrBits ] }
 * - ipBlock: The user-specified CIDR address block to be split
 * - count: The number of CIDRs to generate
 * - cidrBits: The number of subnet bits for the CIDR (e.g., "64" for /64 in IPv6)
 */
export async function resolveCidr(
  resolver: IntrinsicFunctionResolver,
  args: [unknown, unknown, unknown],
  context: ResolverContext
): Promise<string[]> {
  const [rawIpBlock, rawCount, rawCidrBits] = args;
  const ipBlock = (await resolver.resolveValue(rawIpBlock, context)) as string;
  const count = Number(await resolver.resolveValue(rawCount, context));
  const cidrBits = Number(await resolver.resolveValue(rawCidrBits, context));

  if (!ipBlock || typeof ipBlock !== 'string') {
    throw markNonRetryable(
      new Error(
        `Fn::Cidr: ipBlock must be a string, got ${typeof ipBlock}: ${JSON.stringify(maskValueLeaves(resolver, ipBlock, context))}`
      )
    );
  }

  // `count` / `cidrBits` through the builder (PR #3575 review): as
  // `Number()` results they cannot carry a control character, but they come
  // back from `resolveValue`, so a numeric secret whose text survives
  // `Number()` would otherwise print (`"0064"` or `"1e3"` does not survive,
  // and is not masked).
  resolver.logger.debug(
    // Leaf-masked like the refusal above (issue #2827 review): `ipBlock`
    // comes back from `resolveValue`.
    `Resolving Fn::Cidr: ipBlock=${displayMasked(resolver, JSON.stringify(maskValueLeaves(resolver, ipBlock, context)), context)}, count=${displayMasked(resolver, String(count), context)}, cidrBits=${displayMasked(resolver, String(cidrBits), context)}`
  );

  const isIpv6 = ipBlock.includes(':');
  const results: string[] = [];

  if (isIpv6) {
    // IPv6 CIDR calculation
    // Parse the base IPv6 address and prefix
    const [baseAddr, prefixStr] = ipBlock.split('/');
    const basePrefix = parseInt(prefixStr!, 10);
    const subnetPrefix = 128 - cidrBits; // cidrBits = host bits, so subnet prefix = 128 - cidrBits

    // Expand IPv6 address to full form
    const expanded = expandIPv6(resolver, baseAddr!);
    const addrBigInt = ipv6ToBigInt(resolver, expanded);

    // Calculate subnet size
    const subnetSize = BigInt(1) << BigInt(128 - subnetPrefix);

    // Mask the base address to the network prefix
    const prefixMask =
      (BigInt(1) << BigInt(128)) -
      BigInt(1) -
      ((BigInt(1) << BigInt(128 - basePrefix)) - BigInt(1));
    const networkBase = addrBigInt & prefixMask;

    for (let i = 0; i < count; i++) {
      const subnetAddr = networkBase + subnetSize * BigInt(i);
      results.push(`${bigIntToIPv6(resolver, subnetAddr)}/${subnetPrefix}`);
    }
  } else {
    // IPv4 CIDR calculation
    const [baseAddr, prefixStr] = ipBlock.split('/');
    const basePrefix = parseInt(prefixStr!, 10);
    const subnetPrefix = 32 - cidrBits;

    const parts = baseAddr!.split('.').map(Number);
    const baseInt = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
    const subnetSize = 1 << (32 - subnetPrefix);
    const prefixMask = (0xffffffff << (32 - basePrefix)) >>> 0;
    const networkBase = (baseInt & prefixMask) >>> 0;

    for (let i = 0; i < count; i++) {
      const subnetAddr = (networkBase + subnetSize * i) >>> 0;
      const a = (subnetAddr >>> 24) & 0xff;
      const b = (subnetAddr >>> 16) & 0xff;
      const c = (subnetAddr >>> 8) & 0xff;
      const d = subnetAddr & 0xff;
      results.push(`${a}.${b}.${c}.${d}/${subnetPrefix}`);
    }
  }

  // The RESULT is derived from `ipBlock`, so it inherits its provenance
  // (issue #2827 review, item D2: one of the five encodings the fix's own
  // comment had claimed were all leaf-masked).
  //
  // As NEEDLE masks the two on this line are MUTUALLY redundant, and no test
  // can discriminate either one (measured both ways, review round 4:
  // stripping the leaf walk reds nothing, and so does stripping the outer
  // call; only removing BOTH reds). Since issue #3100 the leaf arm also
  // consults the pass's log-twin registry, which only ever masks MORE: a
  // computed CIDR equal to a string an earlier write masked by position is
  // masked by the leaf walk and not by the outer call, an over-mask. For the
  // needle part the leaf arm is `displayMasked`,
  // so the only thing that could separate per-leaf from whole-JSON masking is
  // `maskSecretsInText`'s asymmetry — the whole-string arm has no floor while
  // the substring arm is floored at `MIN_NEEDLE_LENGTH` = 4 — and
  // reaching it needs a needle of 3 characters or fewer equal to a WHOLE leaf.
  // `results` holds only values this method COMPUTED: dotted-decimal (min 9
  // characters, `0.0.0.0/0`) or colon-hex (min 17, `bigIntToIPv6` never
  // compresses), over `[0-9a-f:./-]` plus `NaN` / `Infinity` — nothing
  // `JSON.stringify` escapes, and nothing short enough. So the two orders
  // produce identical output for every needle set.
  //
  // BOTH stay, because the redundancy is a property of what `results` holds
  // TODAY rather than of the site: the day this pushes something it did not
  // compute, the leaf walk is the mask that still works.
  resolver.logger.debug(
    `Fn::Cidr result: ${displayMasked(resolver, JSON.stringify(maskValueLeaves(resolver, results, context)), context)}`
  );
  return results;
}

/** Expand IPv6 address to full 8-group form */
export function expandIPv6(_resolver: IntrinsicFunctionResolver, addr: string): string {
  // Handle :: expansion
  if (addr.includes('::')) {
    const [left, right] = addr.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - leftParts.length - rightParts.length;
    const middle = Array.from({ length: missing }, () => '0000');
    const all = [...leftParts, ...middle, ...rightParts];
    return all.map((p: string) => p.padStart(4, '0')).join(':');
  }
  return addr
    .split(':')
    .map((p) => p.padStart(4, '0'))
    .join(':');
}

/** Convert expanded IPv6 string to BigInt */
export function ipv6ToBigInt(_resolver: IntrinsicFunctionResolver, expanded: string): bigint {
  const parts = expanded.split(':');
  let result = BigInt(0);
  for (const part of parts) {
    result = (result << BigInt(16)) | BigInt(parseInt(part, 16));
  }
  return result;
}

/** Convert BigInt to compressed IPv6 string */
export function bigIntToIPv6(_resolver: IntrinsicFunctionResolver, n: bigint): string {
  const parts: string[] = [];
  for (let i = 7; i >= 0; i--) {
    parts.push(((n >> BigInt(i * 16)) & BigInt(0xffff)).toString(16));
  }
  // Simple format — don't compress with :: for clarity
  return parts.join(':');
}
