/**
 * The authority component of a URL (`<host>:<port>`), for every place cdkd
 * composes one from a host it was handed.
 *
 * A bare `${host}:${port}` is wrong for exactly one shape of host: an IPv6
 * literal, which RFC 3986 3.2.2 requires to be bracketed. `--host ::` otherwise
 * prints `http://:::3000`, and a `fetch()` built the same way throws
 * `Invalid URL` before any request is sent (go-to-k/cdkd#2338, mirroring
 * go-to-k/cdk-local#599, whose `src/utils/url-authority.ts` this follows).
 */

/**
 * Hex digits, `:`, and `.` for the IPv4-mapped form (`::ffff:127.0.0.1`). Not a
 * full grammar: the job is only to tell an address from a colon-bearing string
 * that is not one, which must pass through untouched rather than gain brackets.
 */
const IPV6_LITERAL_CHARS = /^[0-9A-Fa-f:.]+$/;

/**
 * Render `host` as it must appear inside a URL authority.
 *
 * - An IPv6 literal is bracketed; an already-bracketed one is bracketed exactly
 *   once, so a `URL.hostname` fed back in never becomes `[[::1]]`.
 * - A zone id (`fe80::1%en0`) is DROPPED: no URL parser accepts one, raw or
 *   percent-encoded, so propagating it would emit the unparseable authority
 *   this helper exists to prevent.
 * - Everything else (IPv4, a registered name, the empty string) is returned as-is.
 */
export function formatHostForAuthority(host: string): string {
  const wrapped = host.length > 1 && host.startsWith('[') && host.endsWith(']');
  const inner = wrapped ? host.slice(1, -1) : host;
  if (!inner.includes(':')) return host;
  const zoneAt = inner.indexOf('%');
  const literal = zoneAt === -1 ? inner : inner.slice(0, zoneAt);
  if (!IPV6_LITERAL_CHARS.test(literal)) return host;
  return `[${literal}]`;
}

/** `<host>:<port>` for use inside a URL, bracketing an IPv6 literal. */
export function formatAuthority(host: string, port: number | string): string {
  return `${formatHostForAuthority(host)}:${port}`;
}
