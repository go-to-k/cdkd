---
description: Proxy support for cdkd's AWS SDK calls and the checker guarding it
paths:
  - 'src/utils/aws-client-defaults.ts'
  - 'src/utils/proxy-routing-agent.ts'
  - 'scripts/check-aws-client-defaults.ts'
---

# Proxy support

Issue [#2388](https://github.com/go-to-k/cdkd/issues/2388); user docs in
[troubleshooting](../../docs/troubleshooting-proxy.md).

## `aws-client-defaults.ts`

`awsClientDefaults(...)` is the partial config EVERY AWS SDK client under
`src/**` must spread FIRST, so a site's explicit `credentials` wins — through
`ambientClientDefaults()` outside `AwsClients` ([#3588](https://github.com/go-to-k/cdkd/issues/3588)).

- No proxy and no role assumed: it returns `{}`. Otherwise a `requestHandler`
  from `proxy-routing-agent.ts` PLUS an injected `defaultProvider` chain
  carrying that handler; the SDK never reads `HTTPS_PROXY`, and a client's own
  handler never reaches the SSO portal.
- An endpoint override (`setAwsEndpointOverrideSource`, `--aws-emulator`;
  escape: `realAws`, `runWithRealAws`) outranks both.
- **Built FRESH per call, never shared**: one client's `destroy()` would abort
  another's request, and `defaultProvider` memoizes per instance.
- **`ignoreAssumedRole` INJECTS the caller's identity**; `{}` would be a no-op,
  the chain re-reading the `AWS_*` triple the helper overwrote.
- `resetAwsClientDefaults()` also drops the published role and pre-assume caller
  snapshot ([local-caller-identity.md](local-caller-identity.md)).
- `ambientClientDefaults()` adds the ACTIVE clients' explicit `credentials`,
  which bare `awsClientDefaults()` drops; caches key on `credentialFingerprint`.

## `proxy-routing-agent.ts`

An `agent-base` subclass choosing per REQUEST between a proxy agent and a plain
one via `proxy-from-env`'s `getProxyForUrl`: `NodeHttpHandler` picks by
PROTOCOL, `https-proxy-agent` ignores `NO_PROXY`. The inner-agent cache is scoped to the agent INSTANCE, never
module-global. `NO_PROXY` matching is `proxy-from-env`'s: exact hostname unless
the entry starts with `.` or `*`; CIDR never matches.

## `scripts/check-aws-client-defaults.ts`

Every `new XClient(...)` under `src/**` whose identifier came from an
`@aws-sdk/client-*` import must spread `awsClientDefaults(...)` FIRST; a missing
spread fails only behind a proxy.

- **Binds to the IMPORT plus the `Client` suffix, not either alone**: the import
  alone matches commands and paginators.
- **A shared config bag is its own verdict (`shared-defaults`, blocks)**: two
  clients from one `const opts = { ...awsClientDefaults() }` share one routing
  agent; spread the bag INSIDE each client literal.
- **`tests/aws-client-defaults-allowlist.json` may only SHRINK**; it is EMPTY,
  and a stale or dead entry fails.
