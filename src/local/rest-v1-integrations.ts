/**
 * Boot-time SSRF warning for `cdkd local start-api`'s REST v1 HTTP / HTTP_PROXY
 * integrations (#457).
 *
 * The REST v1 integration dispatch itself (`AWS`, `HTTP`, `HTTP_PROXY`, `MOCK`)
 * lives in cdk-local: `cdkd local start-api` runs cdk-local's `startApiServer`,
 * which `http-server.ts` re-exports verbatim. What cdkd still owns here is the
 * warning `local-start-api.ts` prints once per route at server boot.
 *
 * `Integration.Uri` is passed to `fetch()` verbatim; nothing blocks private,
 * loopback or link-local destinations. {@link warnSsrfRiskyUri} surfaces a warn
 * when a Uri's hostname is a well-known internal address literal (IMDS,
 * loopback, link-local, RFC1918) so users see the risk in their logs. Blocking
 * is deliberately not done — this is a developer-loop tool, not a security
 * boundary, and the source URI is the user's own CDK template.
 */

/**
 * Classify a hostname or IP literal against well-known internal address
 * spaces. Used by `warnSsrfRiskyUri` at server boot to surface a warn
 * line per HTTP / HTTP_PROXY integration whose URI points at a
 * potentially-sensitive destination. Best-effort; does NOT do DNS
 * resolution — only matches hostname literals that are already an IP.
 *
 * Returns `undefined` when the host appears safe (public DNS name) OR
 * cannot be classified (DNS name that may resolve to an internal IP
 * the helper cannot see without async DNS).
 *
 * Exported for unit testing.
 */
export function classifyInternalHost(host: string): string | undefined {
  // Trim IPv6 brackets if present.
  const h = host.replace(/^\[|\]$/g, '');
  // AWS IMDS specifically (most actionable warning).
  if (h === '169.254.169.254' || h === '[fd00:ec2::254]' || h === 'fd00:ec2::254') {
    return 'AWS IMDS (169.254.169.254) — credentials exfiltration risk';
  }
  // IPv4 loopback (127.0.0.0/8).
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return 'IPv4 loopback (127.0.0.0/8)';
  // IPv6 loopback.
  if (h === '::1') return 'IPv6 loopback (::1)';
  // IPv4 link-local (169.254.0.0/16 — includes IMDS handled above).
  if (/^169\.254\.\d+\.\d+$/.test(h)) return 'IPv4 link-local (169.254.0.0/16)';
  // IPv6 link-local (fe80::/10).
  if (/^fe[89ab][0-9a-f]?:/i.test(h)) return 'IPv6 link-local (fe80::/10)';
  // RFC1918 private ranges.
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return 'RFC1918 private (10.0.0.0/8)';
  if (/^192\.168\.\d+\.\d+$/.test(h)) return 'RFC1918 private (192.168.0.0/16)';
  // 172.16.0.0/12 — 172.16-172.31.
  const m = /^172\.(\d+)\.\d+\.\d+$/.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) {
    return 'RFC1918 private (172.16.0.0/12)';
  }
  return undefined;
}

/**
 * Emit a `logger.warn` line for each HTTP / HTTP_PROXY integration
 * whose `Integration.Uri` parses to a hostname classified as internal
 * by `classifyInternalHost`. Called once at server boot from
 * `cdkd local start-api`'s discovery pass; per-route deduplicated.
 *
 * cdkd does NOT block the URI — this is a developer-loop tool, not a
 * security boundary, and warn-and-proceed matches the precedent set by
 * the cognito JWKS pass-through fallback. The right v2 follow-up is an
 * `--allow-internal-uri` flag (and an opposite default block) once the
 * surface is well-understood.
 */
export function warnSsrfRiskyUri(
  uri: string,
  routeLabel: string,
  warn: (msg: string) => void
): void {
  let host: string;
  try {
    // Strip placeholders so URL() does not reject `{paramName}` shapes
    // — the substituted value at request time is what matters, but the
    // template Uri's literal host segment IS the right thing to
    // classify here.
    const sanitized = uri.replace(/\{[^/{}]+\}/g, 'x');
    host = new URL(sanitized).hostname;
  } catch {
    return; // Malformed Uri; route-discovery handles the error.
  }
  const classification = classifyInternalHost(host);
  if (classification !== undefined) {
    warn(
      `Integration URI for ${routeLabel} points at ${host} — ${classification}. ` +
        `cdkd does NOT block this; ensure the upstream is intentional.`
    );
  }
}
