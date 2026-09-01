---
description: HTTPS_PROXY / HTTP_PROXY / NO_PROXY support for cdkd's AWS SDK calls, and the critic that keeps it from decaying
paths:
  - 'src/utils/aws-client-defaults.ts'
  - 'src/utils/proxy-routing-agent.ts'
  - 'scripts/check-aws-client-defaults.ts'
---

# Proxy support for AWS SDK calls

Issue [#2388](https://github.com/go-to-k/cdkd/issues/2388). Split out of
[layout-utils.md](layout-utils.md) / [layout-scripts.md](layout-scripts.md)
under a narrow `paths:` glob, so a session touching any OTHER `src/utils/**` or
`scripts/**` file does not pay for this detail.

Index of every area: [code-layout.md](code-layout.md).

User-facing documentation, including the `NO_PROXY` matching table and the
`NODE_EXTRA_CA_CERTS` / Docker-daemon caveats: the "Proxy / Corporate Network"
section of [docs/troubleshooting.md](../../docs/troubleshooting.md).

## The two modules

- **src/utils/** - proxy-aware client defaults (`aws-client-defaults.ts` — `awsClientDefaults({ profile })`, the partial client config EVERY AWS SDK client in cdkd must be spread FIRST. Returns `{}` unless a proxy variable is set, so the unproxied path is byte-identical to what the SDK builds on its own; when one is set it returns a `requestHandler` backed by `proxy-routing-agent.ts` PLUS an injected `defaultProvider` credential chain carrying the same handler through `clientConfig`. The chain is not optional: the AWS SDK v3 does not read `HTTPS_PROXY` at all, and a client's own `requestHandler` reaches the STS hops (they read it off `parentClientConfig`) but NOT the SSO portal client or the SSO-OIDC refresh, which build from `clientConfig` alone — so an SSO profile fails at `resolveSSOCredentials`, BEFORE any service call. IMDS and ECS container credentials call `node:http` / build their own handler, so they need no casing. Built FRESH per call, never shared: `NodeHttpHandler.destroy()` forwards to `httpAgent` / `httpsAgent` unconditionally and Node's `Agent.destroy()` walks `[freeSockets, sockets]` — the second being the ACTIVE set — so one shared agent would let a client's teardown abort another client's in-flight request, and cdkd destroys clients mid-run. The chain is per call for a second reason: `defaultProvider` memoizes RESOLVED credentials inside the instance, so sharing one would hand a client configured for one profile the credentials of another. Spread order is load-bearing — defaults FIRST so a site's explicit `credentials` still wins, which is what keeps `config-loader.ts`'s default-bucket probe checking the bucket as the identity its name was derived from. `resetAwsClientDefaults()` is the test seam for the memoized environment read, mirroring `resetAwsClients()`. The whole invariant is fenced by `scripts/check-aws-client-defaults.ts`; issue [#2388](https://github.com/go-to-k/cdkd/issues/2388)), per-request proxy router (`proxy-routing-agent.ts` — an `agent-base` subclass whose `connect()` returns either an `https-proxy-agent` / `http-proxy-agent` or a plain agent, chosen by `proxy-from-env`'s `getProxyForUrl` on the REQUEST's URL. Per request because `NodeHttpHandler` picks its agent by PROTOCOL alone and `https-proxy-agent` does not read `NO_PROXY`, so a statically chosen proxy agent cannot express a host exemption at all. `agent-base` delegates via `socket.addRequest` when `connect()` returns an Agent, so sockets pool on the INNER agent — which is why the inner agents carry `keepAlive: true` / `maxSockets: 50` themselves and why `destroy()` is forwarded to them. The inner cache is scoped to the ROUTING AGENT INSTANCE, never module-global, for the `Agent.destroy()` reason above. `NO_PROXY` matching is `proxy-from-env`'s: EXACT hostname unless the entry starts with `.` or `*`, and CIDR silently never matches — documented for users in `docs/troubleshooting.md`)

## What fences the SDK claims

The design splits the credential chain on a claim about the SDK, so both halves
are pinned by tests rather than by the reading that produced them.
`tests/unit/utils/aws-client-defaults-sdk-contract.test.ts` drives the real
providers against a COUNTING `requestHandler` from a temp AWS home: the SSO
portal call must arrive through `clientConfig.requestHandler`, and the STS hop
must arrive through the SERVICE client's own handler with no chain injected.
An SDK bump that changes either coalescing reds there instead of silently
un-routing SSO. `tests/unit/utils/aws-client-defaults-injection.test.ts` pins
the other side -- that cdkd still PASSES `profile` alongside and nothing but
`requestHandler` inside `clientConfig`; before it, `defaultProvider({})` passed
every test in the change. The NEGATIVE half (that a client's own handler does
NOT reach the portal) is deliberately unfenced: every cheap way to observe it
short-circuits before the portal client is built, so the test would pass for the
wrong reason.

## The critic

- **scripts/check-aws-client-defaults.ts** + **tests/aws-client-defaults-allowlist.json** - AWS SDK client construction critic (issue [#2388](https://github.com/go-to-k/cdkd/issues/2388)), run by `vp run audit:aws-client-defaults:check` (`cache: false`) with an explicit `ci.yml` step, and unit-tested by `tests/unit/scripts/aws-client-defaults-fence.test.ts`. Every `new XClient(...)` under `src/**` whose identifier was imported from an `@aws-sdk/client-*` package must spread `awsClientDefaults(...)` as the FIRST property of its config. **It has to be mechanical** because the failure is invisible in review and to every test: the AWS SDK v3 does not read `HTTPS_PROXY`, so a client built without the defaults fails behind a corporate proxy at CREDENTIAL resolution — before any service call, with a certificate error naming neither the proxy nor the client — and passes everywhere else. There are 134 sites across 67 files and the repository gains providers steadily, so the next new provider is where it decays. **It binds to the IMPORT plus the `Client` suffix, not to either alone.** The import alone matches commands and paginators from the same package (`new HeadBucketCommand({...})` takes an input bag, not a transport config) and reported 1726 sites where there are 134; the suffix alone binds to a naming convention, matching cdkd's own `S3StateBackend`-shaped classes and missing a construction split across lines. The suffix is tested on the EXPORTED name and the LOCAL name recorded, so `import { S3Client as Bucket }` is still caught — a bug the unit suite's alias case found. **The order is the property, not the presence**: `awsClientDefaults()` supplies a `credentials` chain and a site with explicit `credentials` must keep them, so a spread-LAST would silently replace an identity a site deliberately chose (`config-loader.ts`'s default-bucket probe reuses the STS client's provider so the bucket is checked as the identity its name was derived from). Indirection is resolved one hop within the file, in the three shapes the tree uses — the literal, a shared `const bag = {...}` handed to two clients (`asset-storage.ts`), and a `...this.clientOptions` getter (all 22 `aws-clients.ts` sites) — with a `mentionsDefaults` fallback distinguishing `defaults-not-first` from `missing`, and a config it cannot read reported `opaque` rather than skipped. Resolution is by NAME within one file, which is a real bound whose direction is safe: it can credit a site whose same-named sibling is clean, never manufacture a gap. **A shared config BAG is its own verdict.** Two clients built from one
`const opts = { ...awsClientDefaults(), ... }` share the `requestHandler` it
carries, and therefore one routing agent -- the per-client rule broken through
the back door, invisible at both call sites because each reads as
`defaults-first`. `shared-defaults` blocks. The correct form spreads the shared
bag INSIDE each client's literal (`{ ...awsClientDefaults(), ...opts }`), which
calls the helper per client and is accepted. Found in `asset-storage.ts` by
inline review after the first cut shipped it, so the real-code probe is that
exact shape. **The allow-list may only SHRINK** — a STALE entry (a file that is now clean) and a DEAD one (a file with no client site) both fail, so finishing a file forces its entry out. PR 1 migrated `aws-clients.ts`, the bootstrap path and the state-write path and left 61 files listed; PR 2 empties it. Defences: FLOORS on total sites / files with sites / clean sites, so a collapsed parse fails loudly instead of reporting zero gaps; a `--src-dir=` seam (rejected outside `--check`) so the SHIPPED command's exit code is probed against a scratch COPY of the tree rather than by calling the exported helpers; and REAL-CODE regression probes for each verdict — a migrated file losing its defaults, the defaults moved out of first position, and an allow-listed file becoming clean. NO AWS integ (pure static analysis).
