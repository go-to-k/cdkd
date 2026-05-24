# cdkd local ECS Service Connect + Cloud Map emulation (Phase 3 of #262)

> Design doc — no implementation. Tracks [#460](https://github.com/go-to-k/cdkd/issues/460).
>
> Phase 1 (`cdkd local run-task` single task) shipped via #262.
> Phase 2 (`cdkd local start-service` long-running ECS service emulation)
> is tracked separately as [#466](https://github.com/go-to-k/cdkd/issues/466).
> **This doc covers Phase 3 only** (Service Connect L7 + Cloud Map DNS) and
> calls out the Phase-2 dependencies it inherits.

## 1. Goal

Two services declared in the same CDK app with Service Connect enabled
(Envoy sidecar) OR Cloud Map service discovery enabled are routable from
each other by short name (`http://orders:80` / `orders.cdkd-local.local`)
without any code change on either side.

Concretely:

- Parse `AWS::ECS::Service.ServiceConnectConfiguration` + `AWS::ECS::Service.ServiceRegistries`.
- Parse `AWS::ServiceDiscovery::PrivateDnsNamespace` + `AWS::ServiceDiscovery::Service`.
- For each running task, stand up an Envoy sidecar that resolves peer
  services via the local Cloud Map DNS sidecar and forwards traffic to
  whichever peer task instances are currently up.
- Honor port mappings declared as `name` + `appProtocol` (the Service
  Connect contract).

## 2. Non-goals

Hard-rejected at boot with an actionable error (mirrors PR 8a's class-4
"hard error" treatment):

- **`AWS::ServiceDiscovery::PublicDnsNamespace`** — defeats the "local" point.
- **`AWS::ServiceDiscovery::HttpNamespace`** — no DNS, uses the AWS Cloud Map
  DiscoverInstances API directly. Local emulation would require shimming
  the AWS SDK inside every container; out of scope.
- **`taskDefinition.proxyConfiguration` with custom App Mesh / Envoy config** —
  v1 emulates the AWS-managed Service Connect config only. The user-supplied
  Envoy `bootstrap.yaml` shape varies enough that auto-translating it is a
  separate concern.

  *Carve-out from the "hard-rejected" intro above*: this bullet is
  implemented as a resolver `warnings.push(...)` (warn-and-continue), not
  a throw — unlike the sibling `PublicDnsNamespace` / `HttpNamespace`
  non-goals which DO throw `EcsTaskResolutionError` at boot. The asymmetry
  is intentional: CDK ECS L2 constructs (e.g. `appmesh.VirtualNode`'s
  `addToTaskDefinition`) auto-inject `ProxyConfiguration` at synth time, so
  a hard reject would refuse to run common app shapes locally even when the
  proxy is not load-bearing for the dev's test. Warning surfaces the
  divergence to the user while letting the business container run.
  Honoring `proxyConfiguration` end-to-end is deferred to Layer B (Envoy
  sidecar). See [PR #577](https://github.com/go-to-k/cdkd/pull/577) +
  [issue #578](https://github.com/go-to-k/cdkd/issues/578) for the
  divergence history.
- **mTLS / TLS termination** between services. Service Connect supports TLS
  termination at the Envoy sidecar (when the user attaches a `tlsConfiguration`);
  v1 routes plaintext only.
- **HTTP/2 / gRPC** — Service Connect detects both via `appProtocol`. v1
  routes HTTP/1.1 only. gRPC's HTTP/2-required clients will fail with the
  same shape AWS-side Envoy returns when misconfigured.
- **AWS App Mesh** (separate service from Service Connect; uses its own
  Virtuoso CRDs). Different surface, separate issue.
- **Service Connect → non-ECS targets** (Lambda, ALB, etc.). The AWS-side
  Envoy sidecar can target only ECS task IPs.
- **Health-check-driven routing**. AWS-side Envoy drops unhealthy tasks
  from the rotation. v1 routes to every registered task regardless of
  health (the local container pool is small enough that health-aware
  routing adds complexity without measurable upside; users debugging a
  bad task can `docker stop` it explicitly).
- **Per-task ENI emulation**. The Phase-1 `awsvpc` → `bridge` mapping
  (with the existing warn) carries forward unchanged.

## 3. Dependency on Phase 2 (`cdkd local start-service`, #466)

Service Connect is meaningful only when **multiple tasks of multiple
services** are running at the same time. `cdkd local run-task` exits when
its essential container exits — calling it twice in two terminals does
NOT share a docker network, and the second call sees zero peers.

This doc therefore assumes Phase 2 has shipped and `cdkd local start-service`:

- Maintains a long-running per-service supervisor that keeps `desiredCount`
  tasks up.
- Shares ONE docker network per CDK app (or per `--cluster` flag) across
  every service so peer-to-peer routing is possible.
- Exposes a "service registry" data structure the Service Connect / Cloud
  Map layer can read at runtime: `(serviceLogicalId, taskIpsAndPorts[])`.

**What Phase 3 ships against `cdkd local run-task` alone**: limited
single-task value — the task can call `<self-svc>:<port>` and reach
itself via Envoy, and `nslookup self-svc.cdkd-local.local` returns its
own IP. That's it. No peer discovery. The Phase-3 PR should therefore
land AFTER Phase 2 OR ship behind a `--cdkd-experimental-multi-task` flag
that internally runs `start-service` machinery from inside `run-task` (the
issue's "Wait for W3-5" note is the cleaner path; this doc plans for it).

## 4. Two-layer emulation: Cloud Map DNS + Service Connect Envoy

Service Connect and Cloud Map are independent features that the same
CDK constructs often enable together. The local emulation mirrors that
independence — each layer is opt-in based on what the synth template
declares.

### Layer A — Cloud Map DNS (`AWS::ServiceDiscovery::*`)

- **Trigger**: template contains an `AWS::ServiceDiscovery::PrivateDnsNamespace`
  AND at least one `AWS::ServiceDiscovery::Service` that references it.
- **Behavior**: containers can resolve `<service>.<namespace>` (A records)
  and `_<service>._tcp.<namespace>` (SRV records) to one or more task IPs.
- **AWS-side mapping**: `ecs.Service({ cloudMapOptions: { name, cloudMapNamespace } })`
  emits an `AWS::ECS::Service.ServiceRegistries[]` entry plus an
  `AWS::ServiceDiscovery::Service` with a `DnsConfig.DnsRecords` array.
  At runtime the ECS agent calls `ListInstances` to populate Cloud Map.

### Layer B — Service Connect Envoy (`AWS::ECS::Service.ServiceConnectConfiguration`)

- **Trigger**: template's `AWS::ECS::Service` has `ServiceConnectConfiguration`
  with `Enabled: true` AND at least one entry in `Services[]`.
- **Behavior**: each task gets an extra Envoy sidecar (in the same docker
  network namespace as the main container, so traffic to `127.0.0.1:<port>`
  inside the task reaches Envoy). Envoy listens locally for every peer
  service the user declared, and forwards each request to one of the peer
  task IPs (round-robin / random — same default AWS-side Envoy uses).
- **AWS-side mapping**: CDK's
  `serviceConnectConfiguration: { namespace, services: [{ portMappingName, dnsName, port }] }`
  emits an `AWS::ECS::Service.ServiceConnectConfiguration.Services[]` array
  where each entry pins one upstream by `PortMappingName` (which itself
  references a `Name` on the producer task's `ContainerDefinitions[].PortMappings[]`).

### Combining layers

A CDK app can:

| Cloud Map | Service Connect | Discovery shape |
|-----------|-----------------|-----------------|
| No        | No              | Phase 1 — siblings reach each other by `--network-alias` only |
| Yes       | No              | DNS-only — peers do `nslookup` and connect directly |
| No        | Yes             | Envoy-only — peers connect to `127.0.0.1:<port>` |
| Yes       | Yes             | Both — DNS works AND `127.0.0.1:<port>` works |

Cdkd handles each row independently — there is no required pairing.

## 5. Local docker network shape

**Option A** (recommended): one docker network per CDK app (or per
`--cluster <name>` flag), subnet `169.254.171.0/24` (one octet up from
Phase 1's metadata sidecar subnet `169.254.170.0/24` to avoid collision
when both `cdkd local run-task` and `cdkd local start-service` run on
the same host).

- Every service's tasks join this network.
- The Cloud Map DNS sidecar gets a well-known IP (e.g. `169.254.171.2`).
- The metadata sidecar from Phase 1 still lives at `169.254.170.2` on a
  separate network OR is hoisted to the shared network with a 2nd
  well-known IP — TBD per open question O1.

**Option B** (rejected): one docker network per task (Phase 1 shape).
Inter-service routing would require a docker `network connect` per peer
service, and a peer scaling from 1 → 3 tasks would need to attach 2 more
network bridges to every existing task — unwieldy and racy.

**Option C** (rejected): one docker network per `AWS::ServiceDiscovery::PrivateDnsNamespace`.
This is closest to AWS's actual scoping (Cloud Map namespaces ARE the
isolation boundary), but a single app using two namespaces would force
inter-namespace traffic to go through the host (or `network connect`
explicitly), which AWS doesn't require — AWS-side Envoy resolves any
Cloud Map name regardless of namespace.

Option A wins because:
- Mirrors the `cdkd local start-api` "one server per API" pattern (PR #260
  follow-up) — one isolation boundary per CLI invocation, not per template
  primitive.
- Cleanup is one `docker network rm` at shutdown.
- Cross-namespace traffic Just Works.

## 6. DNS resolution strategy

**Option A** (recommended): bundle a minimal local DNS sidecar
(`dnsmasq` ~1MB OR a hand-rolled 200-LOC Node UDP server using the
`dns2` npm package OR no dependency by using node's built-in `dgram` +
RFC1035 parser). Every container gets `--dns 169.254.171.2` so its
`/etc/resolv.conf` points at the local resolver. Non-matching domains
fall through to the host's resolver via the sidecar's own forwarder
config.

- **dnsmasq**: lowest LOC, but adds an Alpine-based image dependency and
  reconfiguring it on task-list change requires re-writing `/etc/dnsmasq.d`
  + SIGHUP. Not great for hot updates.
- **dns2 npm**: ~50KB dep, full programmatic A / SRV record control,
  trivial to reload on task-list change. Same approach as
  [moby/libnetwork's built-in DNS](https://github.com/moby/moby/blob/master/libnetwork/resolver.go).
  Recommended.
- **Hand-rolled `dgram`**: zero new deps but ~200 LOC of RFC1035 parsing
  and we'd be debugging DNS bugs forever. Rejected.

**Option B** (rejected): rely on docker's built-in `--network-alias`
mechanism. Phase 1 already uses this for sibling resolution
(`docker run --network <net> --network-alias <ContainerName>`). Docker's
internal DNS server can resolve `<alias>` (no namespace suffix) to every
container with that alias on the network — which gives multi-task
service discovery for free.

But: it doesn't support **namespace-qualified** names (`<svc>.<namespace>.local`)
or **SRV records** (which `ListInstances` consumers and Envoy itself
need). It also can't distinguish multiple services with the same short
name across different namespaces. Plus the alias has to match the CFn
`Service.Name`, not the docker container name — adds a translation layer.

Option A wins. The Cloud Map DNS sidecar is the only local primitive
flexible enough to mirror AWS's DNS behavior.

**Record types served**:
- `A` records for `<svc>.<namespace>` returning all live task IPs
  (round-robin via answer-set rotation per query, matching AWS's
  `MULTIVALUE` behavior).
- `SRV` records for `_<svc>._<protocol>.<namespace>` returning
  `(priority=1, weight=1, port, target=<task-hostname>)`. The target
  is a synthetic hostname that resolves to the task IP via an additional
  `A` record in the same response (the canonical "additional section"
  pattern Envoy expects).
- `AAAA` records: defer to v2.
- Everything else: forward to the host's resolver (so `aws.amazon.com`
  still works from inside containers).

**Source of truth** for the resolver: the Phase 2 service-registry data
structure described in §3. The DNS server reads it on every query (no
caching — the data is already in-memory, and tasks scale up/down often
enough that even 1s TTL would cause stale routing). DNS responses set
`TTL=0` so client-side DNS caches don't pin stale answers either.

## 7. Service Connect envoy emulation

**Option A** (recommended): bundle the official AWS-published Envoy image
`public.ecr.aws/ecs/ecs-service-connect-agent:latest` (the same image
AWS injects into Service-Connect-enabled tasks). It's a standard Envoy
build with AWS's bootstrap config baked in.

- **Pros**: byte-identical to production. Users debugging local Envoy
  behavior can use the same `curl localhost:9901/clusters` admin
  endpoint AWS docs reference. HTTP/2 / gRPC routing comes for free
  even though v1 only routes HTTP/1.1 (the routing engine is the same).
- **Cons**: ~120MB image, extra container per task, adds an Envoy
  bootstrap-config-generation step (the file shape is documented but
  non-trivial — see open question O2). Visible in `docker ps`.

**Option B** (rejected): node-based L7 proxy. ~500 LOC of
`http.createServer` + `http.request` forwarding, supports HTTP/1.1 only.
Faster cold-start, smaller image, but loses HTTP/2 and any future
Service Connect feature (retries / circuit-breaking / outlier-ejection).
Loses fidelity in exactly the area developers debug locally — wrong
trade-off.

**Option C** (rejected): nginx / haproxy stub. Both can L7-proxy
HTTP/1.1 fine but reloading on a peer's task-list change requires
config rewrite + SIGHUP. Loses fidelity vs Envoy's runtime xDS reload.

Option A wins for the same reason Phase 1 chose the AWS-published
metadata-endpoints sidecar over a hand-rolled stub: stay in lock-step
with whatever fidelity AWS provides.

### Envoy lifecycle per task

1. When a Service Connect-enabled task starts, the runner generates an
   Envoy `bootstrap.yaml` from the template's
   `ServiceConnectConfiguration.Services[]` (one listener per upstream
   service, target cluster pointing at the Cloud Map DNS name so Envoy
   re-resolves on every connection).
2. The runner mounts the bootstrap config at
   `/etc/aws-appmesh-envoy/bootstrap.yaml` (the path the AWS image
   expects).
3. The runner starts the Envoy sidecar via
   `docker run -d --network container:<main> ...` so Envoy shares the
   main container's network namespace (matches AWS-side Service Connect —
   the sidecar is in the same ENI as the app).
4. The main container reaches peer services via `127.0.0.1:<port>`;
   Envoy forwards to a Cloud Map name; Cloud Map DNS returns a peer task
   IP; Envoy connects directly to the peer task (which is NOT going
   through that peer's Envoy on the response path — Envoy is one-way per
   AWS-side behavior).
5. On task shutdown: `docker rm -f` the Envoy sidecar BEFORE removing
   the main container (so in-flight connections fail-fast instead of
   timing out).

### Bootstrap config generation

The minimal Envoy config per task is roughly:

```yaml
admin: { address: { socket_address: { address: 127.0.0.1, port_value: 9901 } } }
static_resources:
  listeners:
    - name: orders-listener
      address: { socket_address: { address: 127.0.0.1, port_value: 80 } }
      filter_chains: [{ filters: [{ name: envoy.http_connection_manager, typed_config:
        { route_config: { virtual_hosts: [{ name: orders, domains: ["*"],
          routes: [{ match: { prefix: "/" }, route: { cluster: orders_cluster } }] }] } } }] }]
  clusters:
    - name: orders_cluster
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      load_assignment:
        cluster_name: orders_cluster
        endpoints: [{ lb_endpoints: [{ endpoint: { address:
          { socket_address: { address: "orders.cdkd-local.local", port_value: 80 } } } }] }]
```

The generator walks `ServiceConnectConfiguration.Services[]` and emits
one `(listener, cluster)` pair per entry. `STRICT_DNS` (NOT `LOGICAL_DNS`)
makes Envoy re-resolve on TTL expiry, which combined with the DNS
sidecar's `TTL=0` means tasks scaling up appear in the rotation within
seconds (matches AWS-side behavior).

## 8. CFn shape mapping

The resolver layer (analogous to `ecs-task-resolver.ts` for Phase 1)
walks the synthesized template once and produces three new data
structures:

```typescript
// src/local/cloud-map-resolver.ts (new)
interface ResolvedCloudMapNamespace {
  logicalId: string;      // AWS::ServiceDiscovery::PrivateDnsNamespace logical id
  name: string;           // e.g. "cdkd-local.local"
  // (Vpc / Properties intentionally ignored — local emulation is single-host)
}

interface ResolvedCloudMapService {
  logicalId: string;            // AWS::ServiceDiscovery::Service logical id
  namespaceLogicalId: string;   // back-ref via Properties.NamespaceId
  name: string;                 // e.g. "orders"
  dnsRecords: Array<{ Type: 'A' | 'SRV'; TTL: number }>; // TTL parsed but ignored (we emit 0)
}

// src/local/service-connect-resolver.ts (new)
interface ResolvedServiceConnectConfig {
  serviceLogicalId: string;        // AWS::ECS::Service logical id
  namespaceLogicalId: string;      // resolved from ServiceConnectConfiguration.Namespace (Ref or arn)
  services: Array<{
    portMappingName: string;       // matches a Name in producer TaskDef's ContainerDefinitions[].PortMappings[]
    dnsName?: string;              // optional alias (defaults to portMappingName)
    port?: number;                 // optional override (defaults to the producer's port)
    clientAliases?: Array<{ port: number; dnsName?: string }>;
  }>;
}
```

These are passed to the Phase-2 service supervisor, which uses them to:
1. Decide whether to start an Envoy sidecar per task.
2. Generate the bootstrap config from the resolved `services[]` plus the
   service-registry runtime data.
3. Decide which DNS records to publish per `cloudMapOptions` declaration.

The resolver hard-fails (boot-time) when:
- A `ServiceConnectConfiguration.Services[i].PortMappingName` doesn't match
  any port mapping name on the same service's TaskDef.
- A `ServiceConnectConfiguration.Namespace` resolves to a non-private
  namespace (HttpNamespace / PublicDnsNamespace).
- An `AWS::ServiceDiscovery::Service` has `DnsConfig.NamespaceId` pointing
  to a non-existent or non-private namespace.

Intrinsic shapes accepted (per the resolver patterns established in #286 /
#293 / #297): `Ref` to a same-stack namespace / service, `Fn::GetAtt`
returning an ARN, `Fn::Sub` with same-stack refs. Cross-stack / cross-
account namespaces are rejected with the "deferred follow-up" pointer
similar to PR 5 of #224's cross-account ECR pull.

## 9. Lifecycle / cleanup

Phase 1's `cleanupEcsRun` shape extends naturally:

```typescript
interface CleanupState {
  network: TaskNetwork | undefined;                    // Phase 1
  startedContainers: { name: string; id: string }[];   // Phase 1
  dockerVolumeNames: string[];                         // Phase 1
  logStoppers: (() => void)[];                         // Phase 1
  // NEW for Phase 3:
  envoySidecarIds: string[];                           // one per task with Service Connect
  cloudMapDnsSidecarId?: string;                       // single shared sidecar
  cloudMapDnsServerHandle?: () => void;                // OR an embedded server (option A.2 above)
}
```

Teardown order (reverse of startup): user containers → Envoy sidecars →
Cloud Map DNS sidecar → docker network → docker volumes. Idempotent at
each step (Phase 1's `removeContainer` already swallows "not found").

SIGINT path: shared with Phase 1's hoisted `cleanup()` helper per the
existing single-flight memoization pattern (`feedback_sigint_finally_cleanup_singleflight.md`).

## 10. Test strategy

Two real-Docker (no AWS deploy) integ fixtures, mirroring the
Phase 1 fixtures' shape:

### `tests/integration/local-run-task-cloud-map/` (Layer A only)

- CDK fixture: 1 PrivateDnsNamespace + 2 Services + 2 ECS Services
  each with `cloudMapOptions`. Each ECS Service runs a tiny HTTP server
  on a known port.
- `verify.sh`:
  1. `cdkd local start-service --watch` (or `cdkd local run-task` × 2
     if Phase 2 isn't ready and we're using the experimental flag).
  2. `docker exec <task-A> nslookup orders.cdkd-local.local` → asserts
     an A record returns task B's IP.
  3. `docker exec <task-A> curl http://orders.cdkd-local.local:8080/health` →
     asserts 200.
  4. Scale orders to 2 instances, assert nslookup returns 2 IPs.
  5. Teardown asserts no leaked containers / network / docker volumes.

### `tests/integration/local-run-task-service-connect/` (Layer B + A)

- CDK fixture: 1 PrivateDnsNamespace + 2 ECS Services with
  `serviceConnectConfiguration` + `cloudMapOptions`. The `orders`
  service exposes a port named `api` via `portMappings`; the `frontend`
  service references it via `services: [{ portMappingName: 'api', dnsName: 'orders', port: 80 }]`.
- `verify.sh`:
  1. Start the multi-service runtime.
  2. `docker exec <frontend-task> curl http://orders:80/items` —
     asserts the response was sourced from the orders task (echo
     handler returns its container hostname).
  3. `docker exec <frontend-task> curl http://localhost:9901/clusters` —
     asserts the Envoy admin endpoint reports the orders cluster has
     1 endpoint.
  4. Scale orders to 3 instances; assert the Envoy cluster reports 3
     endpoints within the DNS-resolve TTL window.
  5. Teardown asserts no leaked Envoy sidecars / containers / network.

Both fixtures register integ-local-gate scope so `/run-integ` flips
the `integ-local` marker on success.

Unit tests cover the resolver layer (CFn shape parsing, error
messages, intrinsic resolution) and the Envoy bootstrap generator
(snapshot-test the generated YAML). Cloud Map DNS resolver gets a
table-driven test against handcrafted A / SRV queries.

## 11. Implementation phasing

Within Phase 3 itself, suggested PR split:

1. **PR 3a — Cloud Map resolver + DNS sidecar** (Layer A only).
   - `src/local/cloud-map-resolver.ts` (new): parses
     `AWS::ServiceDiscovery::*` from synth template.
   - `src/local/cloud-map-dns.ts` (new): `dns2`-based UDP server.
   - Wire into `cdkd local run-task` via `--cdkd-experimental-multi-task`
     for early adopters; Phase 2 integration deferred to PR 3c.
   - Integ test: `tests/integration/local-run-task-cloud-map/`.
   - Estimated: 600-900 LOC + tests.

2. **PR 3b — Service Connect resolver + Envoy sidecar** (Layer B only).
   - `src/local/service-connect-resolver.ts` (new).
   - `src/local/envoy-bootstrap.ts` (new): YAML generation.
   - `src/local/envoy-sidecar.ts` (new): per-task sidecar lifecycle.
   - Wire into the same experimental path.
   - Integ test: `tests/integration/local-run-task-service-connect/`.
   - Estimated: 800-1100 LOC + tests.

3. **PR 3c — Phase 2 integration** (after #466 ships).
   - Replace the experimental flag with first-class integration into
     `cdkd local start-service`'s service supervisor.
   - Update CLAUDE.md to remove the "Phase 3 deferred" note.
   - Estimated: 200-400 LOC.

## 12. Open design questions

These need answering before PR 3a opens. Some need real-Envoy / real-AWS
probing.

### O1. Shared docker network with Phase 1's metadata sidecar?

Phase 1 puts the metadata sidecar at `169.254.170.2` on a per-task
network. Phase 2 + Phase 3 want a per-app network. Options:
- Two networks per task (Phase 1's `169.254.170.0/24` + the shared
  `169.254.171.0/24`). Docker supports multi-network attach but it's
  more failure modes.
- Hoist the metadata sidecar onto the shared network, give it
  `169.254.170.2` there too. Simpler — only one network — but
  requires the sidecar to handle credentials for many concurrent tasks
  (which it already does on AWS-side ECS, so the image should cope).

Recommended: hoist. Validate that the AWS-published sidecar image is
designed for multi-task use (almost certainly yes, since that's what
ECS Agent does).

### O2. Envoy bootstrap config shape

The AWS-published Envoy image expects a specific bootstrap-config shape.
We need to either:
- Reverse-engineer the shape AWS-side ECS Agent injects (read the
  agent's open-source code) and replicate it exactly, OR
- Build a minimal bootstrap from scratch using Envoy's documented
  schema (works but loses any AWS-image-specific extensions).

Recommended: start with the minimal hand-written config (§7 example);
upgrade to the AWS-shaped config in a follow-up if users hit fidelity
issues.

### O3. Cloud Map DNS record TTL behavior

AWS Cloud Map returns DNS records with the TTL declared in
`AWS::ServiceDiscovery::Service.DnsConfig.DnsRecords[i].TTL`. Local
emulation always returns `TTL=0` so tasks scaling up appear in the
rotation immediately (§6). Is that a fidelity bug we care about? An
app that depends on DNS-caching behavior locally wouldn't notice
because the cache horizon is below the test run's window anyway.

Recommended: emit `TTL=0` and document the divergence. If a user reports
a real bug, parse the template's TTL and honor it.

### O4. SRV record port semantics

AWS Cloud Map SRV records list the **container port** in the SRV
target, even though traffic from a different host reaches the task
via its assigned ENI on the **task port** (which is the same in
`awsvpc` mode but differs in `bridge` mode with dynamic port mapping).
Local emulation uses `bridge`, so do we publish the container port
(matching AWS-side `awsvpc`) or the host-published port (matching
local network reality)?

Recommended: publish the container port AND make the per-task network
addressable via `<containerName>:<containerPort>` directly (which
Phase 1's `--network-alias` already does). Containers calling each
other through the docker network reach the container port natively;
the local DNS sidecar's SRV records match the AWS-side shape; no
divergence from the consumer's perspective.

### O5. Envoy sidecar resource cost on dev machines

Each Envoy sidecar is ~50-100MB RSS. A 5-service app with 2 tasks
each is 10 Envoy containers ≈ 500-1000MB extra. On a 16GB dev laptop
this is fine; on a 8GB laptop it's painful. Should we offer a
`--no-envoy` flag that falls back to Cloud Map DNS only (`<svc>.<ns>:<port>`
direct routing, no L7 features)?

Recommended: ship `--no-envoy` from day one. The DNS-only mode covers
80% of debugging use cases; the missing 20% (testing retries / circuit
breaking) is the explicit reason to opt INTO Envoy.

### O6. Multi-namespace name collision

Two services named `orders` in two different namespaces are valid on
AWS. Phase 1's `--network-alias <ContainerName>` mechanism breaks for
this case because docker doesn't scope aliases by namespace. The DNS
sidecar handles it correctly (`orders.ns-a.local` and `orders.ns-b.local`
are distinct lookups), but the docker-alias short name (`http://orders/`)
would resolve to whichever container won the alias race.

Recommended: in multi-namespace apps, document that short-name lookups
are undefined and require the namespace suffix. Optionally emit a
WARN at boot when two services share a short name across namespaces.

---

**Status**: ready for human review. Implementation deferred until #466
(`cdkd local start-service`) ships or until a clear use case for the
experimental single-task path emerges.
