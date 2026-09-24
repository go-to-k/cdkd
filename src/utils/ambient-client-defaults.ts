/**
 * Client config for an SDK client built OUTSIDE `AwsClients` (issue
 * [#3588](https://github.com/go-to-k/cdkd/issues/3588)).
 *
 * `awsClientDefaults()` alone carries the ambient ENVIRONMENT — `AWS_PROFILE`,
 * a published `--role-arn` role, the proxy handler, a stack scope's region — but
 * not an explicit `AwsClientConfig.credentials` object, which has no
 * environment path at all. A LIBRARY caller that installs
 * `new AwsClients({ credentials })` (`setAwsClients` / `runWithStackAwsClients`
 * are public exports) therefore had every client a provider, context provider,
 * asset publisher or the cross-account STS hop built for itself signing with
 * the default credential chain: a different identity from the one it
 * configured. {@link ambientClientDefaults} closes that for every site at once
 * by reading the ACTIVE clients' {@link AwsClients.credentialConfig}.
 *
 * SPREAD IT FIRST, exactly where `awsClientDefaults()` was spread:
 *
 * `new GlueClient({ ...ambientClientDefaults(), ...(region && { region }) })`
 *
 * The site's own keys still win, so a site that names its own `region` or its
 * own `credentials` keeps them. `scripts/check-aws-client-defaults.ts` accepts
 * this helper as the defaults spread (it calls `awsClientDefaults` afresh per
 * call, so each client still gets its own routing agent), and
 * `tests/unit/utils/ambient-client-defaults-fence.test.ts` refuses a new
 * `awsClientDefaults()`-only construction under `src/**`.
 *
 * Its own module rather than a member of `aws-clients.ts` so that a test which
 * `vi.mock`s `aws-clients.js` with a `getAwsClients` double still reaches this
 * code and degrades, instead of losing the export. It is deliberately OUTSIDE
 * the literal-`.ts` closure `scripts/audit-provider-coverage.ts` resolves
 * (nothing in that closure imports it), and neither module it imports imports
 * it back, so there is no cycle.
 */

import { awsClientDefaults, type AwsClientDefaults } from './aws-client-defaults.js';
import { getAwsClients, type AwsClientConfig } from './aws-clients.js';

/** The credential half of an `AwsClients` configuration: profile + explicit credentials. */
export type CredentialConfig = Omit<AwsClientConfig, 'region'>;

/** What {@link clientDefaultsFor} returns: the defaults plus the credential half. */
export type AmbientClientDefaults = Omit<AwsClientDefaults, 'credentials'> & {
  profile?: string;
  credentials?:
    | NonNullable<AwsClientDefaults['credentials']>
    | NonNullable<AwsClientConfig['credentials']>;
};

/**
 * The ACTIVE clients' credential configuration: the stack scope's
 * `AwsClients` inside `runWithStackAwsClients`, else the process-global one.
 *
 * `{}` when those clients carry none (every CLI run passes no explicit
 * `credentials`, and `--profile` alone yields `{ profile }`), and also for a
 * test double that has no `credentialConfig` getter — degrading to the plain
 * `awsClientDefaults()` answer rather than throwing.
 *
 * Read through `getAwsClients()`, which creates an unconfigured global on first
 * use when nothing installed one. That is side-effect free here: its service
 * clients are lazy, no production call passes `getAwsClients(config)` (so no
 * later configuration is shadowed), and `setAwsClients` replaces it.
 */
export function ambientCredentialConfig(): CredentialConfig {
  const active = getAwsClients() as { credentialConfig?: CredentialConfig } | undefined;
  return active?.credentialConfig ?? {};
}

/**
 * `awsClientDefaults(...)` plus `credentialConfig`, in `AwsClients.clientOptions`'
 * spread order: the defaults FIRST, so an explicit `credentials` outranks a
 * published `--role-arn` role, then `profile`, then `credentials`.
 *
 * Takes the configuration as an argument for the callers that must key a cache
 * on the SAME reading they build from ({@link credentialFingerprint}); every
 * other site calls {@link ambientClientDefaults}.
 */
export function clientDefaultsFor(credentialConfig: CredentialConfig): AmbientClientDefaults {
  return {
    ...awsClientDefaults({ profile: credentialConfig.profile }),
    ...(credentialConfig.profile && { profile: credentialConfig.profile }),
    ...(credentialConfig.credentials && { credentials: { ...credentialConfig.credentials } }),
  };
}

/**
 * The config every SDK client built outside `AwsClients` spreads first: the
 * proxy / role / scope-region defaults plus the ACTIVE clients' profile and
 * explicit credentials.
 */
export function ambientClientDefaults(): AmbientClientDefaults {
  return clientDefaultsFor(ambientCredentialConfig());
}

/**
 * A cache-key component naming WHICH identity a credential configuration
 * selects, for a cache that holds a client (or credentials) built from it.
 *
 * `profile` plus the explicit credentials' ACCESS KEY ID — never the secret
 * key or the session token. The access key id is an identifier rather than a
 * secret (`expected-bucket-owner.ts` already keys its account cache on it), and
 * STS issues a distinct one per session, so two different explicit bags are
 * told apart. The one collision is two bags sharing an access key id with
 * different secrets, at most one of which can be valid.
 *
 * What it does NOT carry, because it is PROCESS-WIDE rather than per
 * configuration: a published `--role-arn` role (set once, refused a second
 * time), the proxy, and `AWS_PROFILE` / the environment chain. Two readings
 * with equal fingerprints within one process therefore resolve to the same
 * identity. Do not log it.
 */
export function credentialFingerprint(credentialConfig: CredentialConfig): string {
  return JSON.stringify([
    credentialConfig.profile ?? null,
    credentialConfig.credentials?.accessKeyId ?? null,
  ]);
}
