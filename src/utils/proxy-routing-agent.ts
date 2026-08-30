/**
 * An `http.Agent` that routes each request through the environment's proxy, or
 * direct, according to `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`.
 *
 * WHY A ROUTING AGENT AND NOT A PLAIN PROXY AGENT
 *
 * `NodeHttpHandler` picks its agent by PROTOCOL alone — `httpsAgent` for an
 * `https:` request, `httpAgent` otherwise — and never consults the request's
 * host. `https-proxy-agent` does not read `NO_PROXY` either. So a statically
 * chosen proxy agent cannot express "this host is exempt", which is the whole
 * of what `NO_PROXY` means. Deciding per REQUEST is the only place the host is
 * known, and `agent-base` gives us that hook: when `connect()` returns an
 * `http.Agent` rather than a socket, the base class delegates the request to it
 * via `socket.addRequest(req, connectOpts)`.
 *
 * That delegation is also why the INNER agents carry `keepAlive` rather than
 * this one: the sockets pool on whichever agent `connect()` hands back, so a
 * `keepAlive` set only here would never be consulted.
 *
 * WHY THE INNER CACHE IS PER INSTANCE
 *
 * Node's `Agent.prototype.destroy()` walks `[this.freeSockets, this.sockets]`,
 * and the second is the ACTIVE set — it aborts in-flight requests, not just
 * idle sockets. `NodeHttpHandler.destroy()` forwards to `httpAgent` and
 * `httpsAgent` unconditionally, external instances included, and cdkd destroys
 * clients mid-run (`deploy` drops the STS client right after
 * `GetCallerIdentity`). A module-global inner cache would therefore let one
 * client's teardown kill another client's live request. Each `AwsClients`
 * client gets its own routing agent, so the cache is scoped to `this` and
 * {@link destroy} forwards to the inner agents — without that forwarding the
 * tunneled sockets would outlive the client and keep the process alive.
 *
 * The cost of not sharing is duplicate CONNECT + TLS handshakes where two
 * clients talk to the same host. Pooling is per host either way, so sharing
 * could never remove the FIRST handshake to each distinct AWS endpoint, and
 * most runtime traffic goes through the per-service `AwsClients` singleton, so
 * the duplicates are few. This is also what the SDK already does: it builds a
 * `keepAlive` agent per client on the unproxied path.
 */

import { Agent as HttpAgent } from 'node:http';
import type { ClientRequest } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { Agent, type AgentConnectOpts } from 'agent-base';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';

/**
 * Applied to every inner agent.
 *
 * The SDK sets these itself, but ONLY when it is handed a plain option bag —
 * an external `Agent` instance is passed through untouched
 * (`@smithy/node-http-handler`'s `NodeHttpHandler` constructor). Since a
 * routing agent IS such an instance, omitting them would silently drop
 * connection reuse for every proxied run, and a concurrent deploy would
 * renegotiate TLS per request.
 */
const INNER_AGENT_OPTIONS = { keepAlive: true, maxSockets: 50 } as const;

/**
 * Build the absolute URL `getProxyForUrl` needs from what `connect()` is given.
 *
 * An IPv6 literal is bracketed, or the `host:port` join produces a string no
 * URL parser accepts (`https://::1:443`) and `NO_PROXY` could never match an
 * IPv6 entry. Unreachable with AWS hostnames; handled because the alternative
 * is a silent wrong answer rather than an error.
 */
function requestUrl(options: AgentConnectOpts): string {
  const secure = options.secureEndpoint;
  const rawHost = options.host ?? 'localhost';
  const host = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost;
  const port = options.port ?? (secure ? 443 : 80);
  return `${secure ? 'https' : 'http'}://${host}:${port}`;
}

export class ProxyRoutingAgent extends Agent {
  /**
   * Inner agents by `<scheme>|<proxy url or "direct">`.
   *
   * Keyed on the proxy URL and not merely on "proxied or not" because
   * `NO_PROXY` is not the only thing that varies per host: `HTTP_PROXY` and
   * `HTTPS_PROXY` may name different proxies, and a single agent bound to one
   * of them would quietly send the other scheme's traffic to the wrong place.
   */
  private readonly innerAgents = new Map<string, HttpAgent>();

  connect(_req: ClientRequest, options: AgentConnectOpts): HttpAgent {
    const secure = options.secureEndpoint;
    const proxyUrl = getProxyForUrl(requestUrl(options));
    const key = `${secure ? 'https' : 'http'}|${proxyUrl || 'direct'}`;

    const cached = this.innerAgents.get(key);
    if (cached) return cached;

    const agent = createInnerAgent(secure, proxyUrl);
    this.innerAgents.set(key, agent);
    return agent;
  }

  override destroy(): void {
    for (const agent of this.innerAgents.values()) {
      agent.destroy();
    }
    this.innerAgents.clear();
    super.destroy();
  }
}

function createInnerAgent(secure: boolean, proxyUrl: string): HttpAgent {
  if (!proxyUrl) {
    // No proxy for this host — `NO_PROXY` matched, or no proxy variable is set
    // for this scheme. A plain agent keeps the request byte-identical to the
    // unproxied path.
    return secure ? new HttpsAgent(INNER_AGENT_OPTIONS) : new HttpAgent(INNER_AGENT_OPTIONS);
  }
  // `HttpsProxyAgent` opens a CONNECT tunnel and upgrades it to TLS, so the
  // origin's own certificate is what gets validated; `HttpProxyAgent` rewrites
  // the request line for a plain `http:` origin. Which one applies is decided
  // by the ORIGIN's scheme, not the proxy's — a plain `http://` proxy serves
  // both.
  return secure
    ? new HttpsProxyAgent<string>(proxyUrl, INNER_AGENT_OPTIONS)
    : new HttpProxyAgent<string>(proxyUrl, INNER_AGENT_OPTIONS);
}
