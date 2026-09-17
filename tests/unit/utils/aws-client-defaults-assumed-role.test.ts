import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STSClient } from '@aws-sdk/client-sts';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import {
  awsClientDefaults,
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setPreAssumeEnvCredentials,
  getAssumedRoleCredentials,
  PROXY_ENV_VARS,
} from '../../../src/utils/aws-client-defaults.ts';
import { AwsClients } from '../../../src/utils/aws-clients.ts';

/**
 * `--role-arn` must beat `--profile`, proved against the REAL SDK
 * (issue [#3130](https://github.com/go-to-k/cdkd/issues/3130)).
 *
 * The defect was a claim about credential PRECEDENCE inside
 * `@aws-sdk/credential-provider-node`, and the fix rests on a second such
 * claim. A mocked provider can only agree with whatever precedence the author
 * believed in, so every case here drives the installed SDK against a private
 * AWS home and reads the identity it actually resolves.
 *
 * The three keys below are mutually distinct and none of them is a value the
 * ambient environment can produce, so "which key came back" is the
 * discriminator in every direction — a case cannot pass by resolving the same
 * credentials for a different reason.
 */
const PROFILE_KEY = 'AKIAPROFILEBASECREDS0';
const ROLE_KEY = 'ASIAASSUMEDROLECREDS0';
const SITE_KEY = 'ASIASITESUPPLIEDCREDS';
/**
 * A fourth distinct key: the identity the process was STARTED with — what
 * `--role-arn` overwrote and what `ignoreAssumedRole` has to give back. In
 * production `applyRoleArnIfSet` destroys it on the env channel while the
 * published bag keeps the role, so only a distinct value can tell "the caller
 * answered" from "the role answered under another name".
 */
// 21 characters, like its three siblings above: `git-secrets` matches an AWS
// access key id as EXACTLY 20, so a 20-character placeholder blocks the commit.
const CALLER_KEY = 'AKIACALLEROWNCREDS000';

const PROFILE_NAME = 'ci';

const AWS_ENV = [
  'HOME',
  'USERPROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  // The links a caller could otherwise answer THROUGH, which would make a case
  // pass for a reason it does not name — the refusal case below most of all.
  'AWS_EC2_METADATA_DISABLED',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  ...PROXY_ENV_VARS,
] as const;

const scratch: string[] = [];
let saved: Record<string, string | undefined>;

/** A private AWS home, so the developer's real profiles cannot decide anything. */
function awsHomeWithProfile(): void {
  const home = mkdtempSync(join(tmpdir(), 'cdkd-assumed-role-'));
  scratch.push(home);
  mkdirSync(join(home, '.aws'), { recursive: true });
  writeFileSync(join(home, '.aws', 'config'), `[profile ${PROFILE_NAME}]\nregion = eu-west-1\n`);
  writeFileSync(
    join(home, '.aws', 'credentials'),
    `[${PROFILE_NAME}]\naws_access_key_id = ${PROFILE_KEY}\naws_secret_access_key = profilesecret\n`
  );
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
}

/**
 * A private AWS home whose `[default]` profile carries {@link CALLER_KEY} and
 * which declares NO other profile.
 *
 * For the third opt-out shape: a caller resolving through SSO / IMDS / a
 * container role has no static triple for the snapshot to capture, but it DOES
 * have a real chain, and that chain is what must answer. A `[default]` ini
 * entry stands in for those offline — the discriminating property is the same
 * one they share, that the answer comes from a link the environment is not.
 */
function awsHomeWithDefaultProfileOnly(): void {
  const home = mkdtempSync(join(tmpdir(), 'cdkd-assumed-role-default-'));
  scratch.push(home);
  mkdirSync(join(home, '.aws'), { recursive: true });
  writeFileSync(join(home, '.aws', 'config'), '[default]\nregion = eu-west-1\n');
  writeFileSync(
    join(home, '.aws', 'credentials'),
    `[default]\naws_access_key_id = ${CALLER_KEY}\naws_secret_access_key = callersecret\n`
  );
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
}

/**
 * A private AWS home with NO `.aws` directory at all, for the caller that has
 * no identity of its own: no profile, no static triple, no ini file to fall
 * back to. Paired with `AWS_EC2_METADATA_DISABLED` at the case, so the chain
 * runs to its end WITHOUT reaching the network.
 */
function awsHomeWithNoCredentialsAnywhere(): void {
  const home = mkdtempSync(join(tmpdir(), 'cdkd-assumed-role-empty-'));
  scratch.push(home);
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
}

/**
 * Exactly what `applyRoleArnIfSet` leaves behind: the caller's own triple
 * snapshotted, then the `AWS_*` triple overwritten with the role's, then the
 * role published. Spelled once so no case can accidentally test a state the
 * production helper never produces.
 */
function publishRoleOverCaller(
  caller: { accessKeyId: string; withoutSessionToken?: boolean } | undefined
): void {
  setPreAssumeEnvCredentials(
    caller
      ? {
          accessKeyId: caller.accessKeyId,
          secretAccessKey: 'callersecret',
          // A caller with NO session token is the long-lived IAM-user case, and
          // it is the only way to exercise shape 2's conditional spread. The
          // default keeps every other case on the STS-session shape.
          ...(caller.withoutSessionToken !== true && { sessionToken: 'callertoken' }),
        }
      : undefined
  );
  process.env['AWS_ACCESS_KEY_ID'] = ROLE_KEY;
  process.env['AWS_SECRET_ACCESS_KEY'] = 'assumedsecret';
  process.env['AWS_SESSION_TOKEN'] = 'assumedtoken';
  setAssumedRoleCredentials({
    accessKeyId: ROLE_KEY,
    secretAccessKey: 'assumedsecret',
    sessionToken: 'assumedtoken',
  });
}

/** Resolve the identity a client built with the opt-out actually runs as. */
async function resolveOptedOutIdentity(
  options: { profile?: string } = {}
): Promise<string | undefined> {
  const client = new STSClient({
    ...awsClientDefaults({ ...options, ignoreAssumedRole: true }),
    region: 'us-east-1',
    ...(options.profile !== undefined && { profile: options.profile }),
  });
  try {
    return (await client.config.credentials()).accessKeyId;
  } finally {
    client.destroy();
  }
}

/**
 * The shape cdkd builds clients with: `awsClientDefaults(...)` spread FIRST
 * (mechanically required of every client under `src/**` by
 * `scripts/check-aws-client-defaults.ts`), then the site's own config —
 * including the `profile` key that `AwsClients.clientOptions` and ~20 direct
 * construction sites pass.
 */
async function resolveIdentityForClientWithProfile(): Promise<string | undefined> {
  const client = new STSClient({
    ...awsClientDefaults({ profile: PROFILE_NAME }),
    region: 'us-east-1',
    profile: PROFILE_NAME,
  });
  try {
    const resolved = await client.config.credentials();
    return resolved.accessKeyId;
  } finally {
    client.destroy();
  }
}

beforeEach(() => {
  saved = Object.fromEntries(AWS_ENV.map((n) => [n, process.env[n]]));
  for (const n of AWS_ENV) delete process.env[n];
  resetAwsClientDefaults();
  awsHomeWithProfile();
});

afterEach(() => {
  for (const n of AWS_ENV) {
    const v = saved[n];
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  resetAwsClientDefaults();
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('the defect: credential env vars are inert while a profile is selected', () => {
  it('resolves the PROFILE key even with the full AWS_* credential triple exported', async () => {
    // Exactly what `applyRoleArnIfSet` used to do as its ONLY channel.
    process.env['AWS_ACCESS_KEY_ID'] = ROLE_KEY;
    process.env['AWS_SECRET_ACCESS_KEY'] = 'assumedsecret';
    process.env['AWS_SESSION_TOKEN'] = 'assumedtoken';
    process.env['AWS_PROFILE'] = PROFILE_NAME;

    const resolved = await defaultProvider()();

    expect(resolved.accessKeyId).toBe(PROFILE_KEY);
    expect(resolved.accessKeyId).not.toBe(ROLE_KEY);
  });

  it('resolves the PROFILE key when the profile arrives as a client-config key instead', async () => {
    // The second channel, and the reason clearing AWS_PROFILE alone is not a
    // fix: cdkd passes `profile` explicitly at every client construction site,
    // and an explicit key outranks the environment.
    process.env['AWS_ACCESS_KEY_ID'] = ROLE_KEY;
    process.env['AWS_SECRET_ACCESS_KEY'] = 'assumedsecret';
    process.env['AWS_SESSION_TOKEN'] = 'assumedtoken';

    expect(await resolveIdentityForClientWithProfile()).toBe(PROFILE_KEY);
  });
});

describe('the fix: published assumed-role credentials beat a profile on the same client', () => {
  it('resolves the ROLE key for a client that also carries `profile`', async () => {
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
    });

    expect(await resolveIdentityForClientWithProfile()).toBe(ROLE_KEY);
  });

  it('resolves the ROLE key with no profile anywhere — the credentials channel alone suffices', async () => {
    // No AWS_PROFILE, no `profile` key, and deliberately NO credential env
    // vars: what answers here is the published bag and nothing else.
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
    });

    const client = new STSClient({ ...awsClientDefaults(), region: 'us-east-1' });
    try {
      expect((await client.config.credentials()).accessKeyId).toBe(ROLE_KEY);
    } finally {
      client.destroy();
    }
  });

  it('leaves `--profile` alone unaffected — no role, and the PROFILE key still wins', async () => {
    // The other polarity. Without this, a fix that hijacked every client
    // unconditionally would look identical to a correct one.
    expect(getAssumedRoleCredentials()).toBeUndefined();

    expect(await resolveIdentityForClientWithProfile()).toBe(PROFILE_KEY);
  });

  it('reaches a client built through AwsClients, which is how most of cdkd builds one', async () => {
    // `clientOptions` is the claimed reach for ~20 services at once. The
    // spread ORDER there is fenced structurally by
    // `scripts/check-aws-client-defaults.ts`; that the getter still spreads
    // the helper AT ALL is what this resolves end to end.
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
    });
    const clients = new AwsClients({ region: 'us-east-1', profile: PROFILE_NAME });
    try {
      expect((await clients.sts.config.credentials()).accessKeyId).toBe(ROLE_KEY);
      // A sibling derived for another region inherits the identity too.
      const derived = clients.withRegion('eu-west-1');
      try {
        expect((await derived.sts.config.credentials()).accessKeyId).toBe(ROLE_KEY);
      } finally {
        derived.destroy();
      }
    } finally {
      clients.destroy();
    }
  });

  it('resolves the ROLE key behind a proxy too, with `profile` on the same client', async () => {
    // The proxied arm returns the same bag, so precedence transfers — but the
    // arms are separate returns and one could be "simplified" away.
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
    });

    expect(await resolveIdentityForClientWithProfile()).toBe(ROLE_KEY);
  });

  it('YIELDS to the profile when the caller asks with `ignoreAssumedRole`', async () => {
    // `cdkd local *` forwards the --profile identity INTO the user's container,
    // so the one site asking "what does THIS profile resolve to" must not be
    // captured by the role. Both polarities of the flag are pinned: the case
    // above resolves the ROLE for the same inputs without it.
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
    });

    const client = new STSClient({
      ...awsClientDefaults({ profile: PROFILE_NAME, ignoreAssumedRole: true }),
      region: 'us-east-1',
      profile: PROFILE_NAME,
    });
    try {
      expect((await client.config.credentials()).accessKeyId).toBe(PROFILE_KEY);
    } finally {
      client.destroy();
    }
  });

  it('YIELDS to the profile behind a proxy too — both arms honour the opt-out', async () => {
    // The proxied arm is a SEPARATE return, and its `credentials` is present in
    // both polarities (it carries the injected chain), so the "no credentials
    // key" observable the call-site fences use is blind there. Resolve the
    // identity instead. Without this, making the proxied arm read the published
    // bag directly passes every other case in the tree.
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
    });

    const client = new STSClient({
      ...awsClientDefaults({ profile: PROFILE_NAME, ignoreAssumedRole: true }),
      region: 'us-east-1',
      profile: PROFILE_NAME,
    });
    try {
      expect((await client.config.credentials()).accessKeyId).toBe(PROFILE_KEY);
    } finally {
      client.destroy();
    }
  });

  it("keeps a SITE's own explicit credentials winning, because defaults are spread FIRST", async () => {
    // The cross-account `Fn::GetStackOutput` read scopes a producer role to one
    // S3 client this way; a role assumed for the CLI must not capture it.
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
    });

    const client = new STSClient({
      ...awsClientDefaults({ profile: PROFILE_NAME }),
      region: 'us-east-1',
      credentials: {
        accessKeyId: SITE_KEY,
        secretAccessKey: 'sitesecret',
        sessionToken: 'sitetoken',
      },
    });
    try {
      expect((await client.config.credentials()).accessKeyId).toBe(SITE_KEY);
    } finally {
      client.destroy();
    }
  });
});

/**
 * PR #3223 round 5, BLOCKER. `ignoreAssumedRole` was INERT without a profile:
 * the helper returned `{}`, so the client fell through to the SDK's own chain
 * whose FIRST link is `fromEnv()` — reading the very triple `applyRoleArnIfSet`
 * had just overwritten with the role. Every site below the opt-out (the ECS
 * secret reads, the three `--assume-role` hops, the placeholder-account probe)
 * therefore ran as the deploy role while its annotation claimed otherwise.
 *
 * Each case drives the REAL SDK: a mocked provider would agree with whatever
 * precedence the author believed in, which is exactly how the defect survived
 * the first four rounds. Every case sets up the state
 * `applyRoleArnIfSet` actually leaves behind (`publishRoleOverCaller`), because
 * the flipped case below used to pass by testing a state production never
 * produces — an env triple holding something OTHER than the role.
 */
describe('`ignoreAssumedRole` resolves the CALLER, in all three shapes', () => {
  it('shape 1 — a profile is selected: the profile answers, over a role-bearing env', async () => {
    // The only shape that was already correct, and only incidentally:
    // `credential-provider-node` skips its env link once a profile is named, so
    // the role cdkd wrote into the environment is never read. Pinned with the
    // env triple PRESENT, which the pre-existing profile cases did not do — all
    // of them stayed green while the no-profile shapes were broken.
    awsHomeWithProfile();
    publishRoleOverCaller(undefined);
    process.env['AWS_PROFILE'] = PROFILE_NAME;

    expect(await resolveOptedOutIdentity()).toBe(PROFILE_KEY);
  });

  it('shape 1 — the profile arriving as a client-config key only', async () => {
    awsHomeWithProfile();
    publishRoleOverCaller(undefined);

    expect(await resolveOptedOutIdentity({ profile: PROFILE_NAME })).toBe(PROFILE_KEY);
  });

  it('shape 2 — no profile, caller HAD a static triple: the pre-assume snapshot answers', async () => {
    // `process.env` still holds ROLE_KEY here, exactly as in production. The
    // snapshot is the only place CALLER_KEY exists, so resolving it proves the
    // env link did not answer.
    publishRoleOverCaller({ accessKeyId: CALLER_KEY });

    // The WHOLE bag, because the identity alone does not watch the session
    // token: the common `--role-arn` caller holds STS session credentials, and
    // a shape-2 copy that dropped `sessionToken` would sign every opted-out
    // client with no `X-Amz-Security-Token` — `InvalidClientTokenId` from AWS,
    // with the access key id still resolving as asserted below. The
    // long-lived-IAM-user case further down pins the ABSENT polarity; without
    // this one, deleting the conditional spread outright reds neither.
    expect(awsClientDefaults({ ignoreAssumedRole: true }).credentials).toEqual({
      accessKeyId: CALLER_KEY,
      secretAccessKey: 'callersecret',
      sessionToken: 'callertoken',
    });
    expect(await resolveOptedOutIdentity()).toBe(CALLER_KEY);
  });

  it('shape 3 — no profile, no static triple: the caller chain answers with its env link EXCLUDED', async () => {
    // The SSO / IMDS / container-role caller. Nothing to restore, and the env
    // now holds the role — so the chain has to run with `fromEnv` subtracted.
    // Before the fix this resolved ROLE_KEY.
    awsHomeWithDefaultProfileOnly();
    publishRoleOverCaller(undefined);

    expect(await resolveOptedOutIdentity()).toBe(CALLER_KEY);
  });

  it('shape 3 behind a proxy — the proxied arm subtracts the env link too', async () => {
    // A SEPARATE return whose `credentials` is populated in both polarities, so
    // nothing about the returned shape distinguishes it. Resolve the identity.
    awsHomeWithDefaultProfileOnly();
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    publishRoleOverCaller(undefined);

    // ...and it must ALSO keep the `requestHandler`, for the reason the shape-1
    // proxy case below states: a client that resolves the right identity but
    // dials out directly fails behind the proxy. This is the return that
    // carries it for shapes 2 and 3 alike, and identity assertions are blind
    // to it.
    expect(awsClientDefaults({ ignoreAssumedRole: true }).requestHandler).toBeDefined();
    expect(await resolveOptedOutIdentity()).toBe(CALLER_KEY);
  });

  it('shape 2 behind a proxy — the snapshot answers there as well', async () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    publishRoleOverCaller({ accessKeyId: CALLER_KEY });

    // The handler again — same return, the other shape reaching it.
    expect(awsClientDefaults({ ignoreAssumedRole: true }).requestHandler).toBeDefined();
    expect(await resolveOptedOutIdentity()).toBe(CALLER_KEY);
  });

  it('shape 2 for a LONG-LIVED IAM user — no `sessionToken` key is invented', async () => {
    // Every other shape-2 case carries an STS session token, so the
    // conditional spread that omits the key had never run. Passing an EMPTY
    // `sessionToken` through to the SDK is not the same as omitting it: the
    // signer sends `X-Amz-Security-Token` for a present-but-empty value, which
    // AWS rejects for a long-lived key.
    publishRoleOverCaller({ accessKeyId: CALLER_KEY, withoutSessionToken: true });

    const defaults = awsClientDefaults({ ignoreAssumedRole: true });
    expect(defaults.credentials).toEqual({
      accessKeyId: CALLER_KEY,
      secretAccessKey: 'callersecret',
    });
    expect(defaults.credentials).not.toHaveProperty('sessionToken');
    expect(await resolveOptedOutIdentity()).toBe(CALLER_KEY);
  });

  it("treats an EMPTY `profile` as no profile, not as shape 1", async () => {
    // `''` selects nothing as far as the SDK is concerned, so treating it as a
    // selected profile would take the opt-out down shape 1 and inject nothing
    // — landing the client back on the env triple that holds the role.
    //
    // What this covers is the `options.profile !== ''` / `profile !== ''` PAIR
    // jointly, not either guard alone: with one neutered the other still routes
    // an empty profile past shape 1, so only the combined regression reds here.
    // The invariant to hold is that an empty profile — from the option or from
    // `AWS_PROFILE` — is NOT a selected profile at any point in the chain.
    publishRoleOverCaller({ accessKeyId: CALLER_KEY });

    expect(await resolveOptedOutIdentity({ profile: '' })).toBe(CALLER_KEY);
  });

  it('shape 1 behind a proxy, with the role-bearing env triple present', async () => {
    // The pre-existing proxy case sets no triple at all, so the proxied arm's
    // shape-1 branch had never been asked the question that matters: with the
    // role in the environment, does it still hand the profile back? It must
    // ALSO keep the `requestHandler` — a client that resolves the right
    // identity but dials out directly fails behind the proxy.
    awsHomeWithProfile();
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    publishRoleOverCaller(undefined);
    process.env['AWS_PROFILE'] = PROFILE_NAME;

    const defaults = awsClientDefaults({ ignoreAssumedRole: true });
    expect(defaults.requestHandler).toBeDefined();
    expect(await resolveOptedOutIdentity()).toBe(PROFILE_KEY);
  });

  it('shape 3 with NO caller identity at all — REFUSES rather than inheriting the role', async () => {
    // The most dangerous arm, and the one the design is for: a container or
    // IMDS caller whose own chain resolves nothing must FAIL, never silently
    // run as the deploy role. Before the fix this resolved ROLE_KEY — a
    // privilege escalation with a green exit code.
    //
    // It is assertable without the network, which is what this case had to
    // establish before it could be written: an AWS home with no `.aws` leaves
    // no ini link to answer, `AWS_EC2_METADATA_DISABLED` makes the IMDS link
    // refuse LOCALLY, and `beforeEach` has already cleared the container and
    // web-identity variables. So the chain runs to its end and raises its own
    // aggregate error, and the assertion names THAT message rather than being
    // a bare `rejects.toThrow()` any refusal would satisfy — including the
    // suite's network fence, which is why the case was left out of round 5.
    awsHomeWithNoCredentialsAnywhere();
    process.env['AWS_EC2_METADATA_DISABLED'] = 'true';
    publishRoleOverCaller(undefined);

    await expect(resolveOptedOutIdentity()).rejects.toThrow(
      /Could not load credentials from any providers/
    );
  });

  it('leaves the NO-ROLE path alone: the opt-out injects nothing before a role is published', () => {
    // The other polarity, and what keeps the overwhelmingly common path
    // byte-identical: with no role published the SDK's own chain IS the
    // caller's, so the helper must still return `{}`.
    expect(getAssumedRoleCredentials()).toBeUndefined();

    expect(awsClientDefaults({ ignoreAssumedRole: true })).toEqual({});
  });

  it('does not disturb a client that did NOT opt out — it still runs as the role', () => {
    publishRoleOverCaller({ accessKeyId: CALLER_KEY });

    expect(awsClientDefaults()).toMatchObject({ credentials: { accessKeyId: ROLE_KEY } });
  });
});

describe('the shape awsClientDefaults returns', () => {
  it('is still EMPTY when no role was assumed and no proxy is configured', () => {
    expect(awsClientDefaults({ profile: PROFILE_NAME })).toEqual({});
  });

  it('carries the static credential bag on the unproxied path once a role is assumed', () => {
    const expiration = new Date('2026-01-01T00:00:00Z');
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
      expiration,
    });

    expect(awsClientDefaults({ profile: PROFILE_NAME })).toEqual({
      credentials: {
        accessKeyId: ROLE_KEY,
        secretAccessKey: 'assumedsecret',
        sessionToken: 'assumedtoken',
        expiration,
      },
    });
  });

  it('keeps the proxy requestHandler and injects NO chain when a role is assumed', () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
    });

    const defaults = awsClientDefaults({ profile: PROFILE_NAME });

    expect(defaults.requestHandler).toBeDefined();
    // A `defaultProvider` chain is a FUNCTION; the resolved bag is not. The
    // distinction is the point: a chain would consult the profile again.
    expect(typeof defaults.credentials).toBe('object');
    expect(defaults.credentials).toMatchObject({ accessKeyId: ROLE_KEY });
  });

  it('still refuses a whitespace-only proxy variable after a role is assumed', () => {
    // The refusal must not be skipped by the assumed-role early return: a typo
    // there otherwise resurfaces per request as an unnamed URL-parse error.
    process.env['HTTPS_PROXY'] = '   ';
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
    });

    expect(() => awsClientDefaults()).toThrow(/HTTPS_PROXY is set to whitespace only/);
  });

  it('REFUSES a second publish, so "monotonic" is enforced rather than asserted', () => {
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
    });

    expect(() =>
      setAssumedRoleCredentials({
        accessKeyId: SITE_KEY,
        secretAccessKey: 'othersecret',
        sessionToken: 'othertoken',
      })
    ).toThrow(/already been published/);

    // And the FIRST publish is what survives — a refusal that half-applied
    // would be worse than no refusal, since the identity would then depend on
    // where the throw landed.
    expect(getAssumedRoleCredentials()?.accessKeyId).toBe(ROLE_KEY);
  });

  it('COPIES the bag on publish, so the caller cannot rewrite every client after the fact', () => {
    // The same object is handed to every client `awsClientDefaults` serves, so
    // aliasing the caller's would let whoever still holds it change the
    // identity of clients already built. `AwsClients.credentialConfig` clones
    // for its own siblings for exactly this reason.
    const mutable = {
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
    };
    setAssumedRoleCredentials(mutable);

    mutable.accessKeyId = SITE_KEY;

    expect(getAssumedRoleCredentials()?.accessKeyId).toBe(ROLE_KEY);
    expect(awsClientDefaults()).toMatchObject({ credentials: { accessKeyId: ROLE_KEY } });
  });

  it('is cleared by resetAwsClientDefaults, so a role cannot leak between tests', () => {
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: 'assumedsecret',
      sessionToken: 'assumedtoken',
    });
    resetAwsClientDefaults();

    expect(getAssumedRoleCredentials()).toBeUndefined();
    expect(awsClientDefaults()).toEqual({});
  });
});
