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
 *
 * WHY THE ASSUMED ROLE IS PUBLISHED FROM HERE
 *
 * `--role-arn` / `CDKD_ROLE_ARN` used to reach the SDK through the `AWS_*`
 * environment variables ALONE (`src/utils/role-arn.ts`). That channel is dead
 * whenever a profile is selected: `@aws-sdk/credential-provider-node` skips the
 * env-var provider entirely once `AWS_PROFILE` is set OR a `profile` is passed
 * on the client config, so `cdkd deploy --profile ci --role-arn <r>` assumed the
 * role, logged it as assumed, and then issued every AWS call as the profile's
 * own principal — in the wrong account, silently (issue
 * [#3130](https://github.com/go-to-k/cdkd/issues/3130)).
 *
 * Clearing `AWS_PROFILE` would not have closed it: cdkd ALSO threads `profile`
 * as an explicit client-config key at every construction site, and an explicit
 * key outranks the environment. So the assumed credentials are published HERE
 * instead, as an explicit `credentials` value — which outranks BOTH, because
 * `resolveAwsSdkSigV4Config` uses `config.credentials` when present and never
 * builds the default chain, leaving `profile` to select non-credential settings
 * only (`role-arn.ts`'s header carries why the profile is left in place).
 *
 * This is the one place that reaches every client without a per-site edit:
 * `scripts/check-aws-client-defaults.ts` requires this helper to be spread
 * FIRST at EVERY `new XxxClient(...)` under `src/**`, with an EMPTY allow-list.
 * The same spread order keeps a site's OWN explicit `credentials` winning — the
 * cross-account `Fn::GetStackOutput` read stays scoped to the producer's role.
 *
 * Clients built OUTSIDE `src/**` (cdk-local's own, the CDK app subprocess) see
 * none of this; they read the `AWS_*` triple `applyRoleArnIfSet` also writes,
 * which the SDK honours for them unless a profile is selected.
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
  /**
   * Resolve the caller's OWN credential chain even when `--role-arn` has
   * published an assumed role — for the one site whose question is "what does
   * THIS profile resolve to", not "who is cdkd".
   *
   * `cdkd local *` forwards the `--profile` identity INTO the emulated Lambda /
   * ECS container (`resolveProfileCredentials`), including into a synthesized
   * shared-credentials file written under that profile's own name. Handing it
   * the assumed role would silently run the user's local function as cdkd's
   * deploy role — usually the MORE privileged of the two, and a different
   * identity than the flag they passed asked for. `--role-arn` governs the
   * calls CDKD issues; `--assume-role` is the flag that governs the emulated
   * function's identity.
   *
   * Do NOT reach for this to "keep a client on the profile": every other site
   * is cdkd calling AWS as itself, which is exactly what the role is for.
   *
   * It restores the identity the client would have resolved had no role been
   * published, which takes three different shapes and is NOT simply "let the
   * SDK's own chain answer":
   *
   * 1. A profile is selected (a `profile` on the config, or `AWS_PROFILE` —
   *    `applyRoleArnIfSet` leaves it in place). `credential-provider-node`
   *    skips its env link entirely once a profile is named, so its own chain
   *    already resolves the caller and nothing is injected here.
   * 2. No profile, and the caller's environment carried a static triple before
   *    the assume. {@link setPreAssumeEnvCredentials} snapshotted it; it is
   *    returned as an explicit `credentials` value.
   * 3. No profile and no static triple (SSO / IMDS / a container role). The
   *    caller's real chain is injected with its ENV LINK EXCLUDED.
   *
   * **Shape 3's exclusion is what makes the opt-out mean anything, and leaving
   * it out made every site below a no-op.** With no profile selected the
   * chain's FIRST link is `fromEnv()`, reading the very
   * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` triple
   * `applyRoleArnIfSet` overwrote with the role — so returning `{}` here
   * resolved the ROLE, under the name of opting out of it. Measured on PR
   * #3223: `keys of awsClientDefaults({ignoreAssumedRole:true}) = []` and the
   * client then resolved the role's key. The consequences were live, not
   * theoretical: `ecs-secrets-resolver.ts` read SecureString / Secret
   * PLAINTEXT as the deploy role and injected it into the user's container,
   * and the three `--assume-role` STS hops were taken as the deploy role, so a
   * container could receive a role its caller could not assume.
   */
  ignoreAssumedRole?: boolean | undefined;
}

/**
 * The temporary credentials an `sts:AssumeRole` produced for `--role-arn`.
 *
 * Structurally identical to `AwsCredentials` in `src/utils/role-arn.ts` (which
 * is where the value is produced) and to the SDK's `AwsCredentialIdentity`.
 * Spelled here rather than imported from either because this module sits in the
 * closure `scripts/audit-provider-coverage.ts` resolves LITERALLY (see the
 * `.ts` import note below) and must not grow a relative `.js` import, and
 * because naming the smithy type would cost a new direct dependency.
 */
export interface AssumedRoleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /**
   * When the STS session stops working. CARRIED, NOT ACTED ON — nothing in this
   * module or in `awsClientDefaults`'s consumers reads it, and there is no
   * refresh: the bag published here is STATIC, so a client built from it keeps
   * presenting the same credentials until the process ends.
   *
   * The consequence is a real bound, and it is stated in
   * `docs/cli-reference.md` ("When the `--role-arn` session expires") rather
   * than handled: a deploy that outlives the 1-hour session fails with
   * `ExpiredTokenException`, and the remedy is to re-run the command. Kept on
   * the interface anyway because `applyRoleArnIfSet` has the value in hand and
   * it is what the `Assumed role ... (session expires ...)` line reports;
   * dropping it would make that line the only record of a fact the state of
   * the process already depends on. `assumeRoleForCrossAccountStateRead`'s
   * structurally identical `AwsCredentials` is the one that DOES act on its
   * copy — it re-assumes on a cache hit past the safety buffer.
   */
  expiration?: Date;
}

/**
 * A partial AWS SDK client config. Empty when no proxy is configured and no
 * role has been assumed.
 *
 * `credentials` is derived from `defaultProvider` rather than imported from
 * `@smithy/types` so that naming the type costs no new dependency; the second
 * member is the STATIC bag published by {@link setAssumedRoleCredentials}.
 */
export interface AwsClientDefaults {
  requestHandler?: NodeHttpHandler;
  credentials?: ReturnType<typeof defaultProvider> | AssumedRoleCredentials | CallerEnvCredentials;
}

/**
 * The profile `@smithy/shared-ini-file-loader`'s `getProfileName` falls back to
 * when neither a client config nor `AWS_PROFILE` names one.
 *
 * Naming it EXPLICITLY is how {@link callerIdentityForOptOut} builds shape 3's
 * chain: `credential-provider-node`'s first link short-circuits whenever
 * `init.profile ?? process.env.AWS_PROFILE` is truthy, and every OTHER link it
 * feeds (`fromSSO` / `fromIni` / `fromProcess`) resolves the same profile name
 * it would have defaulted to, while `fromTokenFile` and the container / IMDS
 * providers do not read a profile at all. So passing this is EXACTLY "the
 * default chain minus its environment link" — the one thing that has to be
 * subtracted, expressed through the SDK's own documented precedence rather than
 * by re-spelling the chain (which would then go stale on an SDK bump).
 */
const SDK_DEFAULT_PROFILE = 'default';

/**
 * The one warning {@link CHAIN_LOGGER} drops, matched on its distinctive line
 * rather than on the whole text: the rest of the message is advisory prose an
 * SDK bump is free to reword, while this line is the warning's identity.
 */
const MULTIPLE_CREDENTIAL_SOURCES_WARNING = 'Multiple credential sources detected';

/**
 * Handed to shape 3's injected chain to drop exactly ONE message —
 * `credential-provider-node`'s `Multiple credential sources detected` warning —
 * while every other warning the chain emits still reaches the user.
 *
 * That warning fires on `profile set AND AWS_ACCESS_KEY_ID/SECRET set`, which
 * is exactly shape 3's inputs, because this module NAMES `default` as the
 * profile ({@link SDK_DEFAULT_PROFILE}) to subtract the env link. Its text
 * ("Both AWS_PROFILE and the pair ... are set. This SDK will proceed with the
 * AWS_PROFILE value.") is FALSE here: `AWS_PROFILE` is unset, the profile name
 * is one cdkd passed, and the triple is one cdkd itself wrote. Left alone it
 * goes to `console.warn`, outside cdkd's logger, on every shape-3 client.
 *
 * **Scoped to shape 3, deliberately.** Shape 1 (`AWS_PROFILE` or a `profile`
 * key selected) returns `{}`, so the client builds the chain itself with no
 * logger and the SDK still emits this warning to `console.warn`. That is left
 * alone: there the message is TRUE — a profile really is selected and really
 * does win — so only its closing advice is unhelpful, and silencing it would
 * mean injecting a logger into every client config in the tree.
 *
 * **Why not a wholesale `warn: () => {}`.** Shape 3's own population is who
 * loses real warnings: `@smithy/credential-provider-imds`'s
 * `staticStabilityProvider` warns on `Credential renew failed:` and on
 * extending an expiration, and `@aws-sdk/credential-provider-http`'s `fromHttp`
 * warns when both the relative and full container-credential URIs (or both
 * token spellings) are set. Both of those default to `console` when no logger
 * is passed, so forwarding `warn` to the console restores their baseline
 * exactly. `trace` / `debug` / `info` stay no-ops: `defaultProvider`
 * reaches those through `logger?.` and therefore emits NOTHING without a
 * logger, so forwarding them would newly print a per-link chain trace on every
 * shape-3 run.
 *
 * **`error` is DEFENSIVE, and restores no baseline** — the claim above is true
 * of `warn` alone. No link in the installed chain calls either spelling of it:
 * across `@aws-sdk/credential-provider-*`, `@aws-sdk/token-providers` and
 * `@smithy/credential-provider-imds` the logger methods invoked are
 * `logger?.debug`, `logger?.warn` and `logger.warn`, with zero `logger.error` /
 * `logger?.error` (measured 2026-09-17), and the imds `options?.logger ||
 * console` default is therefore warn-only in practice. The arm is kept so that
 * a link which starts raising one is not silenced by cdkd having supplied a
 * logger. If such a link arrives, re-decide this arm rather than assuming it is
 * still right: a new link will most likely reach the logger through
 * `logger?.error`, which is the same optional-call shape that makes `info`
 * silent without a logger — so forwarding it would print a line the SDK emits
 * for nobody today, and the `info` argument above applies to it unchanged.
 *
 * **A dropped emission is permanent, and that is a bound, not a claim of
 * harmlessness.** `multipleCredentialSourceWarningEmitted` is a module-global
 * one-shot inside `credential-provider-node`, and the SDK sets it whether or
 * not the logger printed anything — so a drop here silences any LATER
 * emission in the process, including one from a chain cdk-local builds. What
 * makes that acceptable is reachability rather than scope: a later legitimate
 * emission needs a profile selected, and a selected profile is shape 1, where
 * nothing is dropped. Only a caller that builds a shape-3 client and then
 * selects a profile in the SAME process could lose one, and no cdkd path does:
 * `buildProgram`'s `preAction` hook (`src/cli/program.ts`) mirrors `--profile`
 * into `process.env.AWS_PROFILE` BEFORE any command action runs, so a
 * `--profile` run is shape 1 at every site from its first client onward.
 *
 * **That hook is the whole argument, which is why it is named.** Only 2 of the
 * 19 opt-out sites pass `profile` to this helper, so "a `--profile` run passes
 * the key to every site" is NOT what makes the claim true — and moving the
 * mirror into the individual commands, or dropping it because the SDK reads the
 * flag anyway, would kill the reachability argument with nothing in THIS file's
 * tests failing. Removing the hook outright does red three cases that assert it
 * directly (`AWS_PROFILE` set before a nested command action runs, and two
 * siblings), so the tree is not silent about the hook itself — it is silent
 * about this argument depending on it.
 *
 * **A BOUND on both forwards** (go-to-k/cdkd#3003, recorded rather than fixed):
 * `console.warn` / `console.error` bypass `ConsoleLogger.formatMessage`, so the
 * extra arguments the chain passes — an SDK error object on
 * `logger.warn("Credential renew failed: ", e)` — skip the C0 / C1 / bidi
 * denylist every cdkd logger call inherits, and skip cdkd's level control too.
 * It is NOT a regression: without a logger those links write to `console`
 * themselves, so the baseline is the same unsanitized call. Routing through
 * `getLogger()` is what the fix would need, and it collides with the import
 * closure this file's own import block describes: this module is reachable from
 * `aws-clients.ts`, so every relative import in it must carry the `.ts`
 * spelling, and `src/utils/logger.ts` reaches `display-safe` /
 * `live-renderer` / `stack-context` through `.js` specifiers — pulling the
 * whole tree into the closure `vp run audit:coverage:check` resolves the way
 * `node` does. The same constraint is why the whitespace-proxy refusal below
 * throws a plain `Error` rather than a `CdkdError`.
 *
 * `constructor.name` must not be `NoOpLogger` or `credential-provider-node`
 * routes the warning to `console.warn` instead of here — a plain object literal
 * is what satisfies that.
 *
 * EXPORTED as a test seam only, like {@link resetAwsClientDefaults}. No
 * `src/**` module reads it THROUGH this export — the one reader is
 * `callerIdentityForOptOut` below, which hands it straight to `defaultProvider`.
 * `defaultProvider` closes over it, so `error` —
 * the arm no installed link calls — is reachable from a test by NO other route.
 * Do not mutate it: every shape-3 chain in the process shares this one object.
 */
export const CHAIN_LOGGER = {
  // The no-op arms take the same rest parameter the forwarding ones do. A bare
  // `() => {}` is assignable to the SDK's `(...content: any[]) => void` and so
  // works, but it types the seam as REFUSING arguments — which is false of the
  // thing being modelled (every link calls `logger?.debug(message)`), and makes
  // a test that swallows a real message a type error rather than a check.
  trace: (..._args: unknown[]): void => {},
  debug: (..._args: unknown[]): void => {},
  info: (..._args: unknown[]): void => {},
  warn: (...args: unknown[]): void => {
    if (
      args.some(
        (arg) => typeof arg === 'string' && arg.includes(MULTIPLE_CREDENTIAL_SOURCES_WARNING)
      )
    ) {
      return;
    }
    console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    console.error(...args);
  },
};

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

/**
 * The credentials `--role-arn` assumed for THIS process, or `undefined` when no
 * role was assumed. Set once, at the command's entry, by `applyRoleArnIfSet`.
 *
 * Process-global for the same reason the `AWS_*` env vars it replaces were:
 * `--role-arn` is a process-wide decision taken before any stack work starts,
 * so there is nothing per-stack or per-concurrent-task to key it on. It is
 * monotonic — set once and never unset in production — so a client built before
 * it is set and one built after cannot disagree about which identity the user
 * chose; only about whether the role had been assumed yet, and every command
 * assumes it before constructing any other client. That is ENFORCED, not
 * merely intended: {@link setAssumedRoleCredentials} refuses a second publish.
 */
let assumedRoleCredentials: AssumedRoleCredentials | undefined;

/**
 * The `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` triple
 * the process was started with, captured by `applyRoleArnIfSet` IMMEDIATELY
 * BEFORE it overwrites those variables with the assumed role's.
 *
 * `undefined` means one of two different things, and the caller must not
 * conflate them: no role has been assumed at all (ask
 * {@link getAssumedRoleCredentials}), or a role was assumed and the caller had
 * NO static credentials in its environment — the SSO / IMDS / container-role
 * chains, where the triple was absent before the assume and there is nothing to
 * restore. `src/utils/caller-credentials.ts` is the one place that reads the two
 * together and turns them into an answer.
 *
 * Process-global for the same reason {@link assumedRoleCredentials} is: this is
 * the state of the environment at a single process-wide decision point.
 */
let preAssumeEnvCredentials: CallerEnvCredentials | undefined;

/**
 * Static AWS credentials read out of (or destined for) the process environment.
 *
 * Distinct from {@link AssumedRoleCredentials} in exactly one field:
 * `sessionToken` is OPTIONAL here, because a long-lived IAM user key has none
 * while `sts:AssumeRole` always issues one.
 */
export interface CallerEnvCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * The message BOTH ends of the single-publish invariant refuse with — this
 * module's {@link setAssumedRoleCredentials} and `role-arn.ts`'s
 * `applyRoleArnIfSet`, which trips first so that nothing is corrupted before
 * the refusal (see that function's comment).
 *
 * Shared rather than spelled twice: the two were byte-identical copies, so
 * rewording one would silently leave a user facing two different explanations
 * of one invariant depending on which end caught them — and the test that
 * matches the text would keep passing against the stale copy.
 */
export const SECOND_ROLE_PUBLISH_REFUSAL =
  'An assumed role has already been published for this process. ' +
  '`--role-arn` is a single process-wide decision taken once at a command entry; ' +
  'publishing a second role would leave clients built before and after it running as ' +
  'different identities.';

/**
 * Publish the credentials `--role-arn` assumed, so every later SDK client
 * built through {@link awsClientDefaults} runs as the role.
 *
 * Called by `applyRoleArnIfSet` AFTER the `sts:AssumeRole` hop completes — the
 * base credentials (a profile, the env, an instance role) must still be the
 * ones answering that hop.
 *
 * **A SECOND publish is REFUSED.** {@link assumedRoleCredentials}'s doc calls
 * the value monotonic, and every consumer relies on it: a client built before a
 * second publish and one built after would run as DIFFERENT identities inside
 * one process, with nothing naming which. `applyRoleArnIfSet` is meant to run
 * once at a command's entry, so a second call is a wiring defect — and the
 * failure it produces without this refusal is silent and account-scoped, which
 * is the class issue [#3130](https://github.com/go-to-k/cdkd/issues/3130)
 * exists to close. `resetAwsClientDefaults()` is the only way back, and it is a
 * TEST seam. A plain `Error` rather than `CdkdError` for this module's usual
 * reason: importing the error module would add a relative `.js` import to the
 * closure `scripts/audit-provider-coverage.ts` resolves literally.
 *
 * The bag is COPIED rather than stored by reference. The same object is handed
 * to every client `awsClientDefaults` serves, so aliasing the caller's would
 * let whoever still holds it rewrite the identity of clients already built —
 * the reason `AwsClients.credentialConfig` clones for its own siblings.
 */
export function setAssumedRoleCredentials(credentials: AssumedRoleCredentials): void {
  if (assumedRoleCredentials !== undefined) {
    throw new Error(SECOND_ROLE_PUBLISH_REFUSAL);
  }
  assumedRoleCredentials = {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    ...(credentials.expiration && { expiration: credentials.expiration }),
  };
}

/**
 * Record the caller's own pre-assume environment credentials, or `undefined`
 * when the environment carried none.
 *
 * Called by `applyRoleArnIfSet` BEFORE it overwrites the `AWS_*` triple —
 * afterwards the value is unrecoverable, and it is the only identity the
 * `cdkd local` surface may hand to an emulated workload.
 *
 * COPIED rather than stored by reference, for {@link setAssumedRoleCredentials}'s
 * reason and with more reach than it had before: since shape 2 of the
 * `ignoreAssumedRole` opt-out reads this snapshot, it is the source of the
 * identity EVERY opted-out client runs as, and {@link getPreAssumeEnvCredentials}
 * hands it out. Aliasing the caller's object would let whoever still holds it
 * rewrite that identity after the fact.
 */
export function setPreAssumeEnvCredentials(credentials: CallerEnvCredentials | undefined): void {
  preAssumeEnvCredentials = credentials
    ? {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        ...(credentials.sessionToken !== undefined && { sessionToken: credentials.sessionToken }),
      }
    : undefined;
}

/**
 * The credentials recorded by {@link setPreAssumeEnvCredentials}, if any.
 *
 * Read by `src/utils/caller-credentials.ts` — the local surface's env channel —
 * and by tests. Read it THROUGH that module rather than directly: `undefined`
 * here is ambiguous on its own (see {@link preAssumeEnvCredentials}).
 *
 * The returned bag is this module's OWN copy, not the caller's — do not mutate
 * it; shape 2 of the opt-out resolves every opted-out client's identity from
 * the same object.
 */
export function getPreAssumeEnvCredentials(): CallerEnvCredentials | undefined {
  return preAssumeEnvCredentials;
}

/**
 * The credentials published by {@link setAssumedRoleCredentials}, if any.
 *
 * ONE production consumer, and it asks a yes/no question rather than using the
 * value: `applyRoleArnIfSet` reads it to refuse a second `--role-arn` BEFORE
 * its `AssumeRole` hop, so that nothing is corrupted first. No client ever
 * reads it — every one of those receives the credentials through
 * {@link awsClientDefaults} — so this is not a way to "get the role" and must
 * not become one; a site that wants the role's identity simply omits
 * `ignoreAssumedRole`.
 */
export function getAssumedRoleCredentials(): AssumedRoleCredentials | undefined {
  return assumedRoleCredentials;
}

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
 * The identity a client that passed `ignoreAssumedRole` must run as, or
 * `undefined` when the SDK's own chain already resolves the caller and nothing
 * needs injecting.
 *
 * Only called once a role HAS been published — see
 * {@link AwsClientDefaultsOptions.ignoreAssumedRole} for the three shapes and
 * why shape 3 cannot be left to the default chain.
 *
 * `process.env` is READ here and never written. Clearing the triple around the
 * client construction would be the obvious alternative and is wrong: cdkd
 * builds clients concurrently (`--concurrency`, parallel stacks), so a window
 * in which the triple is absent is a window another task resolves through.
 *
 * TWO BOUNDS, RECORDED RATHER THAN CLOSED
 *
 * 1. **A `[default]` profile that sources the environment defeats shape 3.**
 *    Subtracting the chain's own env link does not subtract `fromEnv` reached
 *    THROUGH another link, and `credential_source = Environment` in the
 *    `[default]` profile is exactly that — so the opt-out resolves the ROLE's
 *    triple again. Its sibling is `credential_process`: the ini format has no
 *    environment interpolation, so a templated `aws_access_key_id` is not a
 *    vector, but a helper process that reads `AWS_ACCESS_KEY_ID` out of the
 *    environment it inherits and echoes it back defeats the subtraction
 *    identically. It is a narrow case and it is not a regression: before this
 *    shape existed the same configuration simply resolved the role too. Closing
 *    it would mean neutering `process.env` around the resolution, which the
 *    paragraph above rules out on concurrency grounds.
 * 2. **Shapes 2 and 3 inject an explicit `credentials`, which outranks a
 *    `profile` key a site sets AFTER the spread.** Shape 1 exists to hand the
 *    profile back to the SDK, but it only sees a profile passed through
 *    {@link AwsClientDefaultsOptions.profile} or `AWS_PROFILE` — a site that
 *    passes neither and then writes `profile: x` into its own client literal
 *    gets shape 2/3's credentials instead, silently. No site does that today
 *    (all 19 opt-out sites audited at PR #3223), and no fence catches it: the
 *    local-surface fence asks whether a site DECLARED an identity, not which
 *    keys its literal carries. Pass the profile to this helper, not only to the
 *    client.
 */
function callerIdentityForOptOut(
  options: AwsClientDefaultsOptions,
  requestHandler: NodeHttpHandler | undefined
): AwsClientDefaults['credentials'] | undefined {
  // Shape 1. The client-config key outranks the environment, and either one
  // makes `credential-provider-node` skip its env link, so the chain the client
  // builds for itself already answers with the caller's profile.
  const profile =
    options.profile !== undefined && options.profile !== ''
      ? options.profile
      : process.env['AWS_PROFILE'];
  if (profile !== undefined && profile !== '') return undefined;

  // Shape 2. COPIED rather than aliased, for {@link setAssumedRoleCredentials}'s
  // reason: the value is handed to every client built through this helper.
  const caller = preAssumeEnvCredentials;
  if (caller) {
    return {
      accessKeyId: caller.accessKeyId,
      secretAccessKey: caller.secretAccessKey,
      ...(caller.sessionToken && { sessionToken: caller.sessionToken }),
    };
  }

  // Shape 3. The caller's real chain, minus the env link now holding the role.
  return defaultProvider({
    profile: SDK_DEFAULT_PROFILE,
    logger: CHAIN_LOGGER,
    ...(requestHandler && { clientConfig: { requestHandler } }),
  });
}

/**
 * Returns `{}` when no proxy is configured, no role has been assumed, and no
 * opt-out is in play — which keeps that path byte-identical to what the SDK
 * builds on its own and makes this a no-op for every existing user.
 */
export function awsClientDefaults(options: AwsClientDefaultsOptions = {}): AwsClientDefaults {
  // Read the proxy environment FIRST in both branches: its whitespace-only
  // guard is a refusal the assumed-role path must not skip past.
  const proxied = isProxyConfigured();
  // ONE reading of the flag, used by both decisions below. They were spelled
  // differently — a truthiness test and an `=== true` — which is equivalent
  // for a `boolean | undefined` but invites the two to drift into disagreeing
  // about the same input, and "did this client opt out?" must have exactly one
  // answer per call.
  const optedOut = options.ignoreAssumedRole === true;
  const assumed = optedOut ? undefined : assumedRoleCredentials;
  // The opt-out only raises a question once a role has actually been published.
  // Before that the default chain IS the caller's, so the common path keeps
  // returning `{}` and no chain is built for it.
  const optedOutOfPublishedRole = optedOut && assumedRoleCredentials !== undefined;

  if (!proxied) {
    if (assumed) return { credentials: assumed };
    const caller = optedOutOfPublishedRole
      ? callerIdentityForOptOut(options, undefined)
      : undefined;
    return caller ? { credentials: caller } : {};
  }

  // A FRESH agent per call. `NodeHttpHandler.destroy()` destroys `httpAgent`
  // and `httpsAgent` unconditionally, and Node's `Agent.destroy()` aborts
  // ACTIVE sockets, so a shared agent would let one client's teardown kill
  // another client's in-flight request. See `proxy-routing-agent.ts`.
  const agent = new ProxyRoutingAgent();
  const requestHandler = new NodeHttpHandler({ httpAgent: agent, httpsAgent: agent });

  if (assumed) {
    // No chain to inject: the assumed credentials are already resolved, so
    // nothing here has to reach STS or an SSO portal. The handler is still
    // returned — it is what routes the SERVICE calls through the proxy.
    return { requestHandler, credentials: assumed };
  }

  // The proxied arm needs the SAME three shapes: it is a separate return, and
  // its `credentials` is populated in both polarities (it carries the injected
  // chain), so a call-site fence that only looks at the returned KEYS is blind
  // here.
  const caller = optedOutOfPublishedRole
    ? callerIdentityForOptOut(options, requestHandler)
    : undefined;
  if (caller) return { requestHandler, credentials: caller };

  return {
    requestHandler,
    credentials: defaultProvider({
      ...(options.profile !== undefined && options.profile !== '' && { profile: options.profile }),
      clientConfig: { requestHandler },
    }),
  };
}

/**
 * Drop the memoized environment read, the published assumed-role credentials,
 * AND the pre-assume caller snapshot. Test seam; mirrors `resetAwsClients()`.
 *
 * All three are dropped together because all three are process-global state
 * this module owns, and a role leaking from one test into the next would
 * silently change which identity every client in the next test resolves — or,
 * for the snapshot, which identity the `cdkd local` surface hands the emulated
 * workload.
 */
export function resetAwsClientDefaults(): void {
  proxyConfigured = undefined;
  assumedRoleCredentials = undefined;
  preAssumeEnvCredentials = undefined;
}
