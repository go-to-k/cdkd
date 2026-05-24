import { getLogger } from '../utils/logger.js';

/**
 * Phase 3 of #262 (Issue #460) — in-process Cloud Map / Service Connect
 * service registry consumed by `cdkd local start-service` to surface a
 * single shared discovery table across multiple services and their
 * replicas.
 *
 * AWS-side mapping:
 *   - `AWS::ServiceDiscovery::PrivateDnsNamespace` (Cloud Map namespace) →
 *     `RegisteredNamespace` (string `name`).
 *   - `AWS::ServiceDiscovery::Service` (Cloud Map service) registered via
 *     `cloudMapOptions` on an ECS Service AND the Service Connect
 *     `ClientAliases[].DnsName` (which AWS-side ECS Agent registers in
 *     Cloud Map automatically when Service Connect is enabled) → one
 *     `RegisteredEndpoint` per replica that becomes routable from peer
 *     services in the same docker network.
 *
 * **Scope (v1)** — limited to the surfaces needed for the `--add-host`
 * DNS overlay (per the design's "DNS-only" combining-layer table at
 * §4):
 *   - A-record style resolution: `{discoveryName}.{namespace}` AND the
 *     bare `{discoveryName}` (the ClientAlias short form) resolve to a
 *     single IP per replica. Multiple replicas register independently;
 *     consumers connect to *one* of them via `--add-host` round-robin —
 *     docker uses the *first* matching `--add-host` entry, so multi-
 *     replica routing is approximated as "first-replica-wins". A full
 *     multi-instance DNS rotation (matching AWS's Cloud Map MULTIVALUE
 *     RoutingPolicy) is deferred to PR 3a's DNS-sidecar option (§6).
 *   - SRV records, Envoy sidecar, HttpNamespace, PublicDnsNamespace:
 *     out of scope (rejected upstream in the resolver layer or via the
 *     "deferred to follow-up PR" pointers).
 *
 * **Process scoping**: the registry is a singleton per `cdkd local
 * start-service` invocation. Multiple cdkd processes on the same host
 * do NOT share registry state — by design, since they'd be on different
 * docker networks anyway and the design § "Local docker network shape"
 * Option A pins "one docker network per CDK app per CLI invocation".
 * Tests construct fresh instances via `new CloudMapRegistry()` to avoid
 * test-cross-talk.
 */

/** One reachable replica registered in the discovery table. */
export interface RegisteredEndpoint {
  /** Docker IP address inside the per-service network (e.g. `172.17.0.5`). */
  ip: string;
  /** Container port the consumer should connect to. */
  port: number;
  /** Stable identity for unregister: typically `<serviceLogicalId>:<replicaIndex>`. */
  ownerKey: string;
}

/** A registration handle returned by `register()` for symmetric unregister. */
export interface RegistrationHandle {
  /** Fully-qualified key `{namespace}/{discoveryName}` for fast lookup. */
  readonly fqdn: string;
  /** Owner stamp used for `unregister`. */
  readonly ownerKey: string;
}

/** Internal entry — one per (fqdn, ownerKey) pair. */
interface RegistryEntry {
  namespace: string;
  discoveryName: string;
  endpoint: RegisteredEndpoint;
}

/**
 * Shape returned by `list()` for diagnostic / boot-log surfaces.
 * Aliases (e.g. bare `<discoveryName>` ClientAlias short-form) are
 * surfaced as additional entries; consumers iterate without needing to
 * know which entry is the canonical fqdn vs an alias.
 */
export interface RegistryListing {
  namespace: string;
  discoveryName: string;
  endpoints: ReadonlyArray<RegisteredEndpoint>;
  /** True when this row is an alias (bare `<discoveryName>`, no namespace). */
  isAlias: boolean;
}

/**
 * In-process registry. `register()` is called by the service runner
 * after each replica's main container boot; `unregister()` is called by
 * the shutdown / restart paths. `lookupHosts()` produces the
 * `--add-host` flag list a consumer task's `docker run` injects so
 * `<discoveryName>.<namespace>` and (when registered as an alias)
 * bare `<discoveryName>` both resolve to a registered endpoint inside
 * the consumer container.
 *
 * Concurrency note: docker-run callers are not concurrent for the same
 * replica (the runner boots replicas sequentially), but `lookupHosts()`
 * MAY be called concurrently with `register()` / `unregister()` of an
 * unrelated service. The implementation uses synchronous Map mutations
 * so a stale read returns the previous snapshot — never a partially-
 * mutated one. No async / mutex needed.
 */
export class CloudMapRegistry {
  /** Map<fqdn, RegistryEntry[]> — one per replica registered under that fqdn. */
  private readonly byFqdn: Map<string, RegistryEntry[]> = new Map();
  /**
   * Map<alias, fqdn> — secondary index for ClientAlias short forms.
   * Multiple aliases can point at the same fqdn; one alias only points
   * at one fqdn. **First-wins on collision** — consistent with design
   * §O6's namespace-level first-wins rule for `PrivateDnsNamespace`. A
   * collision (two services declaring the same `ClientAlias.DnsName`)
   * emits a `logger.warn` so users can debug "why does
   * `wget http://api/` reach service B instead of service A" without
   * silently shadowing the prior binding. Idempotent re-register of
   * the same `(alias, targetFqdn)` pair is a no-op and does NOT warn.
   */
  private readonly aliasIndex: Map<string, string> = new Map();

  /**
   * Register a replica's endpoint under `{namespace}/{discoveryName}`.
   *
   * @param namespace Cloud Map namespace name, e.g. `cdkd-local.local`.
   *                  An empty string is rejected — Cloud Map requires a
   *                  named namespace.
   * @param discoveryName Cloud Map service name, e.g. `orders`. Rejected
   *                      when empty.
   * @param endpoint Reachable endpoint + owner key for symmetric
   *                 unregister.
   * @returns A handle the caller stores for later `unregister(handle)`.
   */
  register(
    namespace: string,
    discoveryName: string,
    endpoint: RegisteredEndpoint
  ): RegistrationHandle {
    if (!namespace) {
      throw new Error('CloudMapRegistry.register: namespace must be a non-empty string.');
    }
    if (!discoveryName) {
      throw new Error('CloudMapRegistry.register: discoveryName must be a non-empty string.');
    }
    const fqdn = `${discoveryName}.${namespace}`;
    const entries = this.byFqdn.get(fqdn) ?? [];
    // Replace any prior entry with the same ownerKey (idempotent
    // re-register after a replica restart).
    const filtered = entries.filter((e) => e.endpoint.ownerKey !== endpoint.ownerKey);
    filtered.push({ namespace, discoveryName, endpoint });
    this.byFqdn.set(fqdn, filtered);
    return { fqdn, ownerKey: endpoint.ownerKey };
  }

  /**
   * Register a bare-name alias (`<discoveryName>` without the namespace
   * suffix). Cloud Map / Service Connect does NOT auto-create such
   * aliases — they're populated by `ClientAliases[].DnsName` entries in
   * the consumer service's `ServiceConnectConfiguration`. Aliases are
   * scoped per-CLI-invocation and **first-wins on collision** —
   * consistent with design §O6's namespace-level first-wins rule. The
   * first registration sticks; later attempts to bind the same alias
   * to a different fqdn are ignored and a `logger.warn` is emitted so
   * users can debug "why does `wget http://api/` reach service B
   * instead of service A". Re-registering the same `(alias,
   * targetFqdn)` pair is idempotent and does NOT warn.
   *
   * @param alias The bare discovery name (e.g. `orders` for an alias to
   *              `orders.cdkd-local.local`).
   * @param targetFqdn The full `{discoveryName}.{namespace}` the alias
   *                   resolves to.
   */
  registerAlias(alias: string, targetFqdn: string): void {
    if (!alias) {
      throw new Error('CloudMapRegistry.registerAlias: alias must be a non-empty string.');
    }
    if (!targetFqdn) {
      throw new Error('CloudMapRegistry.registerAlias: targetFqdn must be a non-empty string.');
    }
    const existing = this.aliasIndex.get(alias);
    if (existing !== undefined) {
      // Idempotent re-register from the same source — no-op, no warn.
      if (existing === targetFqdn) return;
      // Cross-source collision: first-wins. Keep the existing binding
      // and surface a warn so users can debug surprising routing.
      getLogger()
        .child('cloud-map-registry')
        .warn(
          `ClientAlias DnsName collision: '${alias}' was already mapped to '${existing}'; ` +
            `keeping first-wins binding and ignoring new mapping to '${targetFqdn}'. ` +
            'Likely cause: two Service Connect services declared the same ClientAlias.DnsName.'
        );
      return;
    }
    this.aliasIndex.set(alias, targetFqdn);
  }

  /**
   * Remove a single endpoint registered under the supplied handle.
   * Idempotent — unknown handles return false without throwing.
   */
  unregister(handle: RegistrationHandle): boolean {
    const entries = this.byFqdn.get(handle.fqdn);
    if (!entries) return false;
    const filtered = entries.filter((e) => e.endpoint.ownerKey !== handle.ownerKey);
    if (filtered.length === entries.length) return false;
    if (filtered.length === 0) this.byFqdn.delete(handle.fqdn);
    else this.byFqdn.set(handle.fqdn, filtered);
    return true;
  }

  /**
   * Drop every registration with the supplied owner key (e.g. teardown
   * of every replica of a service). Used by the service controller's
   * shutdown path; complementary to per-replica `unregister`.
   */
  unregisterByOwner(ownerKeyPrefix: string): number {
    let removed = 0;
    for (const [fqdn, entries] of [...this.byFqdn.entries()]) {
      const filtered = entries.filter((e) => !e.endpoint.ownerKey.startsWith(ownerKeyPrefix));
      removed += entries.length - filtered.length;
      if (filtered.length === 0) this.byFqdn.delete(fqdn);
      else this.byFqdn.set(fqdn, filtered);
    }
    return removed;
  }

  /**
   * Look up every endpoint registered under `{discoveryName}.{namespace}`.
   * Returns `undefined` when no endpoint exists (which is the consumer
   * runner's signal to log a warn — the user likely forgot to start the
   * producer). Returns the underlying array verbatim so callers cannot
   * accidentally mutate registry state — call `.slice()` if you need a
   * detachable copy.
   */
  lookup(namespace: string, discoveryName: string): ReadonlyArray<RegisteredEndpoint> | undefined {
    const fqdn = `${discoveryName}.${namespace}`;
    const entries = this.byFqdn.get(fqdn);
    if (!entries || entries.length === 0) return undefined;
    return entries.map((e) => e.endpoint);
  }

  /**
   * Resolve a bare alias to its target endpoints. Returns the same
   * shape as `lookup` for the alias's target fqdn, or `undefined` when
   * no such alias exists (which is distinct from "alias known but
   * target has no live replica" — caller may want different warns).
   */
  lookupAlias(alias: string): ReadonlyArray<RegisteredEndpoint> | undefined {
    const fqdn = this.aliasIndex.get(alias);
    if (!fqdn) return undefined;
    const entries = this.byFqdn.get(fqdn);
    if (!entries || entries.length === 0) return undefined;
    return entries.map((e) => e.endpoint);
  }

  /**
   * Build the `--add-host` flag list for a consumer container's
   * `docker run`. Returns each unique `(hostname, ip)` pair as a flat
   * `['--add-host', 'name:ip', ...]` array consumable verbatim by the
   * docker-runner. Includes both the fqdn AND every alias mapped to it.
   *
   * Multiple replicas per fqdn cannot be expressed as multiple
   * `--add-host` entries with the same name (docker's resolver takes
   * the *last* entry on duplicate keys per `getent hosts` semantics),
   * so this returns the **first** registered endpoint per fqdn /
   * alias. Multi-instance round-robin via the static `--add-host`
   * shape is structurally impossible; a true rotation requires the
   * DNS-sidecar option (deferred). Documented as a v1 limitation.
   */
  buildAddHostFlags(excludeOwnerKeyPrefix?: string): string[] {
    const flags: string[] = [];
    const seen = new Set<string>();
    // fqdn entries first so an alias collision (same name) doesn't
    // shadow a fully-qualified one — docker uses the first matching
    // entry by default and the fqdn variant should be the canonical.
    for (const [fqdn, entries] of this.byFqdn.entries()) {
      const candidate = entries.find(
        (e) => !excludeOwnerKeyPrefix || !e.endpoint.ownerKey.startsWith(excludeOwnerKeyPrefix)
      );
      if (!candidate) continue;
      if (seen.has(fqdn)) continue;
      flags.push('--add-host', `${fqdn}:${candidate.endpoint.ip}`);
      seen.add(fqdn);
    }
    for (const [alias, targetFqdn] of this.aliasIndex.entries()) {
      if (seen.has(alias)) continue;
      const entries = this.byFqdn.get(targetFqdn);
      if (!entries || entries.length === 0) continue;
      const candidate = entries.find(
        (e) => !excludeOwnerKeyPrefix || !e.endpoint.ownerKey.startsWith(excludeOwnerKeyPrefix)
      );
      if (!candidate) continue;
      flags.push('--add-host', `${alias}:${candidate.endpoint.ip}`);
      seen.add(alias);
    }
    return flags;
  }

  /**
   * Diagnostic snapshot used by the boot banner / test assertions.
   * Stable iteration order (insertion-order is preserved by JS Maps).
   */
  list(): ReadonlyArray<RegistryListing> {
    const out: RegistryListing[] = [];
    for (const [, entries] of this.byFqdn.entries()) {
      if (entries.length === 0) continue;
      const first = entries[0]!;
      out.push({
        namespace: first.namespace,
        discoveryName: first.discoveryName,
        endpoints: entries.map((e) => e.endpoint),
        isAlias: false,
      });
    }
    for (const [alias, fqdn] of this.aliasIndex.entries()) {
      const entries = this.byFqdn.get(fqdn);
      if (!entries || entries.length === 0) continue;
      out.push({
        namespace: '', // aliases are namespace-less by definition
        discoveryName: alias,
        endpoints: entries.map((e) => e.endpoint),
        isAlias: true,
      });
    }
    return out;
  }

  /** True when no endpoint is registered. Used by the runner to short-circuit. */
  isEmpty(): boolean {
    return this.byFqdn.size === 0;
  }
}
