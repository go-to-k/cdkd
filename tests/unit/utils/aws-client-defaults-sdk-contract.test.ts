import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

/**
 * The two SDK behaviours the proxy design rests on (issue #2388).
 *
 * The design splits the credential chain in half on a claim about the SDK:
 * the STS hops used by `role_arn` profiles INHERIT a service client's
 * `requestHandler` through `parentClientConfig`, while the SSO portal client
 * does NOT -- it is built from `clientConfig` alone. That is why cdkd injects a
 * chain instead of relying on the client's own handler, and why nothing is
 * added to the STS path.
 *
 * Both halves were established by reading the installed SDK. Neither was
 * fenced, so an SDK bump that changed the `clientConfig` coalescing would
 * regress the SSO path silently -- with the only evidence that it ever worked
 * being a one-off run on a corporate network.
 *
 * These run offline: a counting `requestHandler` answers every request, so no
 * socket is opened and the assertion is about WHICH handler the SDK reached
 * for.
 *
 * NOT fenced here, and stated rather than left implicit: the NEGATIVE half --
 * that a client's own `requestHandler` does not reach the SSO portal. Making
 * that hermetic needs the portal call to be observable without being made, and
 * every cheap way of arranging it (an expired token, an unroutable endpoint)
 * short-circuits before the portal client is built, so the test would pass for
 * the wrong reason. The shape below covers the direction that decides the
 * design; `aws-client-defaults-injection.test.ts` covers cdkd's side of it.
 */

const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';
const FAKE_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

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
  // Endpoint-SHAPING vars. The assertions below pin exact hostnames, and these
  // move them -- `sts-fips.us-east-1.amazonaws.com` would also miss the
  // `startsWith('sts.')` body switch. The risk is a false RED on a machine that
  // sets them, never a vacuous green, but a test whose verdict depends on the
  // developer's shell is answering a different question per machine.
  'AWS_USE_FIPS_ENDPOINT',
  'AWS_USE_DUALSTACK_ENDPOINT',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_STS',
  'AWS_ENDPOINT_URL_S3',
] as const;

const scratch: string[] = [];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(AWS_ENV.map((n) => [n, process.env[n]]));
  for (const n of AWS_ENV) delete process.env[n];
});

afterEach(() => {
  for (const n of AWS_ENV) {
    const v = saved[n];
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A private AWS home, so the developer's real profiles cannot decide anything. */
function awsHome(config: string, credentials?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'cdkd-sdk-contract-'));
  scratch.push(home);
  mkdirSync(join(home, '.aws', 'sso', 'cache'), { recursive: true });
  writeFileSync(join(home, '.aws', 'config'), config);
  if (credentials !== undefined) writeFileSync(join(home, '.aws', 'credentials'), credentials);
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  // A UNIQUE path per test, which is also what keeps the SDK's path-keyed
  // shared-config cache from serving one test's profiles to another.
  process.env['AWS_CONFIG_FILE'] = join(home, '.aws', 'config');
  process.env['AWS_SHARED_CREDENTIALS_FILE'] = join(home, '.aws', 'credentials');
  return home;
}

interface CountingHandler {
  readonly seen: string[];
  metadata: { handlerProtocol: string };
  destroy(): void;
  updateHttpClientConfig(): void;
  httpHandlerConfigs(): Record<string, never>;
  handle(request: { hostname: string; path: string }): Promise<unknown>;
}

/** Answers every request from a canned body and records the host it was for. */
function countingHandler(bodyFor: (hostname: string) => string): CountingHandler {
  const seen: string[] = [];
  return {
    seen,
    metadata: { handlerProtocol: 'http/1.1' },
    destroy() {},
    updateHttpClientConfig() {},
    httpHandlerConfigs: () => ({}),
    async handle(request) {
      seen.push(request.hostname);
      return {
        response: {
          statusCode: 200,
          reason: 'OK',
          headers: { 'content-type': 'application/json' },
          body: Readable.from([Buffer.from(bodyFor(request.hostname))]),
        },
      };
    },
  };
}

describe('the SDK honours `clientConfig.requestHandler` for the SSO portal', () => {
  it('resolves an SSO profile through the injected handler, opening no socket', async () => {
    const startUrl = 'https://example.awsapps.com/start';
    const home = awsHome(
      [
        '[profile ssotest]',
        `sso_start_url = ${startUrl}`,
        'sso_region = us-east-1',
        'sso_account_id = 111122223333',
        'sso_role_name = TestRole',
        'region = us-east-1',
        '',
      ].join('\n')
    );
    // The portal is only reached with a live cached token; the filename is the
    // sha1 of the start URL, which is the SDK's own scheme.
    writeFileSync(
      join(home, '.aws', 'sso', 'cache', `${createHash('sha1').update(startUrl).digest('hex')}.json`),
      JSON.stringify({
        startUrl,
        region: 'us-east-1',
        accessToken: 'token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
    );

    const handler = countingHandler(() =>
      JSON.stringify({
        roleCredentials: {
          accessKeyId: 'ASIASSO',
          secretAccessKey: 'secret',
          sessionToken: 'token',
          expiration: Date.now() + 3_600_000,
        },
      })
    );

    const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
    const credentials = await defaultProvider({
      profile: 'ssotest',
      clientConfig: { requestHandler: handler as never },
    })();

    expect(credentials.accessKeyId).toBe('ASIASSO');
    expect(
      handler.seen,
      'the SSO portal call did not go through `clientConfig.requestHandler` — if this ' +
        'is an SDK bump, the injected-chain half of the proxy design no longer holds'
    ).toEqual(['portal.sso.us-east-1.amazonaws.com']);
  }, 30_000);
});

describe('the SDK propagates a service client handler to its STS hop', () => {
  it('assumes a role through the CLIENT\'s handler, with no chain injected', async () => {
    // No `credentials` argument at all: the point is `parentClientConfig`, and
    // injecting one would prove the other mechanism instead. This is the half
    // the design deliberately leaves alone.
    awsHome(
      [
        '[profile base]',
        'region = us-east-1',
        '',
        '[profile roled]',
        'role_arn = arn:aws:iam::111122223333:role/Test',
        'source_profile = base',
        'region = us-east-1',
        '',
      ].join('\n'),
      ['[base]', `aws_access_key_id = ${FAKE_KEY}`, `aws_secret_access_key = ${FAKE_SECRET}`, ''].join(
        '\n'
      )
    );

    const assumeRole =
      '<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">' +
      '<AssumeRoleResult><Credentials><AccessKeyId>ASIASTS</AccessKeyId>' +
      '<SecretAccessKey>s</SecretAccessKey><SessionToken>t</SessionToken>' +
      '<Expiration>2099-01-01T00:00:00Z</Expiration></Credentials>' +
      '<AssumedRoleUser><Arn>arn:aws:sts::111122223333:assumed-role/Test/x</Arn>' +
      '<AssumedRoleId>AROA:x</AssumedRoleId></AssumedRoleUser>' +
      '</AssumeRoleResult></AssumeRoleResponse>';
    const listBuckets =
      '<?xml version="1.0"?><ListAllMyBucketsResult ' +
      'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>o</ID></Owner>' +
      '<Buckets></Buckets></ListAllMyBucketsResult>';

    const handler = countingHandler((hostname) =>
      hostname.startsWith('sts.') ? assumeRole : listBuckets
    );

    const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      profile: 'roled',
      region: 'us-east-1',
      requestHandler: handler as never,
    });
    await client.send(new ListBucketsCommand({}));

    expect(
      handler.seen,
      'the STS hop did not inherit the service client\'s handler — if this is an SDK ' +
        'bump, the STS path now needs the same injection the SSO path gets'
    ).toEqual(['sts.us-east-1.amazonaws.com', 's3.us-east-1.amazonaws.com']);
    client.destroy();
  }, 30_000);
});
