/**
 * Client config every AWS SDK client in cdkd must be built with.
 *
 * WHY THIS EXISTS
 *
 * The AWS SDK for JavaScript v3 does NOT read `HTTPS_PROXY` / `HTTP_PROXY` the
 * way botocore (the AWS CLI) and Go's `net/http` do. Its own guide says a proxy
 * is supplied "through a third-party HTTP agent" by whoever constructs the
 * client — so on a machine whose only egress is a corporate proxy, an SDK call
 * dials out directly and fails, typically as
 * `CredentialsProviderError: self-signed certificate in certificate chain`
 * because the direct route is what the network intercepts (issue #2388).
 *
 * Node 24's `NODE_USE_ENV_PROXY=1` is not a way out: it rewires the GLOBAL
 * agent, and every SDK client builds its own.
 *
 * WHY THE CREDENTIAL CHAIN IS INJECTED TOO
 *
 * A client's `requestHandler` does not reach every credential hop:
 *
 * - STS (`role_arn` profiles, web identity) reads `requestHandler` off
 *   `parentClientConfig`, so it INHERITS ours. Nothing to do.
 * - `@aws-sdk/credential-provider-sso` builds its portal client from
 *   `clientConfig` alone, coalescing only `logger`, `region` and
 *   `userAgentAppId` from the caller. `@aws-sdk/token-providers` does the same
 *   for the SSO-OIDC refresh. So an SSO profile fails at
 *   `resolveSSOCredentials` — BEFORE any service call — unless the chain is
 *   constructed here with the handler threaded through `clientConfig`.
 * - IMDS (`@smithy/credential-provider-imds`) and ECS container credentials
 *   (`@aws-sdk/credential-provider-http`) call `node:http` / build their own
 *   handler, so they bypass a proxy on their own and need no special casing.
 *
 * The chain is therefore built per call. `defaultProvider` MEMOIZES resolved
 * credentials inside the chain instance, so one shared instance would hand a
 * client configured for profile A the credentials of profile B. Per call costs
 * nothing relative to today, since each client already builds its own chain.
 *
 * `clientConfig` carries `requestHandler` and NOTHING else — a `region` there
 * would override the SSO portal's own region — and `profile` is passed
 * ALONGSIDE it, because the built-in chain sees a profile through the client
 * config while an injected chain does not.
 *
 * SPREAD THIS FIRST, SITE-SPECIFIC CONFIG SECOND
 *
 * `new S3Client({ ...awsClientDefaults({ profile }), region, ...(creds && { credentials: creds }) })`
 *
 * A site that supplies its own `credentials` must keep them — `config-loader`'s
 * default-bucket probe reuses the STS client's resolved provider on purpose, so
 * that the bucket it probes is checked as the identity the name was derived
 * from. That provider already carries the handler, because the STS client it
 * came from was built through this helper.
 */

import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { NodeHttpHandler } from '@smithy/node-http-handler';
// The `.ts` spelling below is REQUIRED, not a slip.
//
// `scripts/audit-provider-coverage.ts` imports `src/utils/aws-clients.ts`
// directly and runs under `node`'s native type stripping, which resolves
// relative specifiers LITERALLY — it does not rewrite `.js` to `.ts` the way
// TypeScript does at emit time. The constraint is TRANSITIVE: it binds every
// module reachable from `aws-clients.ts`, this one included, so a `./foo.js`
// import ANYWHERE in that closure breaks `vp run audit:coverage:check` in CI.
// `tsconfig.json`'s `rewriteRelativeImportExtensions` is what emits the `.ts`
// spelling as `.js`, and `tests/unit/utils/aws-clients-region-fold.test.ts`
// fences the whole closure by resolving it the way `node` would.
import { ProxyRoutingAgent } from './proxy-routing-agent.ts';

export interface AwsClientDefaultsOptions {
  /** The profile the calling site was configured with, if any. */
  profile?: string | undefined;
}

/**
 * A partial AWS SDK client config. Empty when no proxy is configured.
 *
 * `credentials` is derived from `defaultProvider` rather than imported from
 * `@smithy/types` so that naming the type costs no new dependency.
 */
export interface AwsClientDefaults {
  requestHandler?: NodeHttpHandler;
  credentials?: ReturnType<typeof defaultProvider>;
}

/**
 * The proxy variables, in the order `proxy-from-env` itself reads them.
 *
 * Only their PRESENCE is decided here. Which one applies to a given request —
 * and whether `NO_PROXY` exempts it — is `getProxyForUrl`'s job, per request,
 * inside {@link ProxyRoutingAgent}. Deciding it here instead would collapse
 * `HTTP_PROXY` and `HTTPS_PROXY` into one answer and send `http://` traffic to
 * an HTTPS proxy.
 */
export const PROXY_ENV_VARS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

let proxyConfigured: boolean | undefined;

function isProxyConfigured(): boolean {
  // Read lazily and memoize only the PARSE RESULT, so module import order
  // cannot freeze an answer before the CLI has finished setting up, and so a
  // test can control the environment through `resetAwsClientDefaults()`.
  if (proxyConfigured === undefined) {
    // Every spelling is examined before the answer is decided. A `.some()` here
    // short-circuited at the first VALID variable, so `HTTPS_PROXY=http://ok`
    // beside a typo'd `http_proxy='   '` never reached the guard below -- and
    // the typo then resurfaced per request as exactly the unnamed URL-parse
    // error the guard exists to pre-empt.
    let configured = false;
    for (const name of PROXY_ENV_VARS) {
      const value = process.env[name];
      if (value === undefined || value === '') continue;
      if (value.trim() === '') {
        // Whitespace-only is a typo, not a configuration. Treating it as SET
        // fails later with a URL-parse error naming neither the variable nor
        // cdkd; treating it as UNSET is worse still, because the run then goes
        // direct and fails with the certificate error this whole change exists
        // to remove -- with no hint that the variable was the cause.
        //
        // A plain `Error` rather than `CdkdError`: importing the error module
        // would add a `.js` relative import to the closure reachable from
        // `aws-clients.ts`, which is the constraint the header above describes.
        throw new Error(
          `${name} is set to whitespace only. Set it to a proxy URL ` +
            `(e.g. http://proxy.example:8080) or unset it.`
        );
      }
      configured = true;
    }
    proxyConfigured = configured;
  }
  return proxyConfigured;
}

/**
 * Returns `{}` when no proxy is configured, which keeps the unproxied path
 * byte-identical to what the SDK builds on its own and makes this a no-op for
 * every existing user.
 */
export function awsClientDefaults(options: AwsClientDefaultsOptions = {}): AwsClientDefaults {
  if (!isProxyConfigured()) return {};

  // A FRESH agent per call. `NodeHttpHandler.destroy()` destroys `httpAgent`
  // and `httpsAgent` unconditionally, and Node's `Agent.destroy()` aborts
  // ACTIVE sockets, so a shared agent would let one client's teardown kill
  // another client's in-flight request. See `proxy-routing-agent.ts`.
  const agent = new ProxyRoutingAgent();
  const requestHandler = new NodeHttpHandler({ httpAgent: agent, httpsAgent: agent });

  return {
    requestHandler,
    credentials: defaultProvider({
      ...(options.profile !== undefined && options.profile !== '' && { profile: options.profile }),
      clientConfig: { requestHandler },
    }),
  };
}

/** Drop the memoized environment read. Test seam; mirrors `resetAwsClients()`. */
export function resetAwsClientDefaults(): void {
  proxyConfigured = undefined;
}
