import { STSClient } from '@aws-sdk/client-sts';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  awsClientDefaults,
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setAwsEndpointOverrideSource,
  type AwsEndpointOverrideDefaults,
} from '../../../src/utils/aws-client-defaults.ts';

/**
 * `cdkd local --aws-emulator` (go-to-k/cdkd#6132): every client cdkd builds
 * through `awsClientDefaults` follows the endpoint the registered source
 * reports, signed with the endpoint's own keys only. Driven through a real
 * `STSClient` so the CREDENTIAL the SDK resolves is what is asserted.
 */
const EMULATOR = {
  endpoint: 'https://127.0.0.1:9297',
  caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
  credentials: { accessKeyId: 'EMULATORKEY000000000', secretAccessKey: 'emulator-secret' },
} satisfies AwsEndpointOverrideDefaults;

afterEach(() => {
  setAwsEndpointOverrideSource(undefined);
  resetAwsClientDefaults();
});

describe('awsClientDefaults under an endpoint override', () => {
  it('is untouched while no source is registered, or the source reports none', () => {
    expect(awsClientDefaults()).toEqual({});
    setAwsEndpointOverrideSource(() => undefined);
    expect(awsClientDefaults()).toEqual({});
  });

  it('returns the endpoint, a fresh handler per call, and the endpoint keys', async () => {
    setAwsEndpointOverrideSource(() => EMULATOR);
    const a = awsClientDefaults();
    const b = awsClientDefaults();
    expect(a.endpoint).toBe(EMULATOR.endpoint);
    expect(a.requestHandler).toBeDefined();
    expect(a.requestHandler).not.toBe(b.requestHandler);
    // The handler's agent trusts the endpoint's CA on top of the public roots.
    const handlerConfig = await (
      a.requestHandler as unknown as {
        configProvider: Promise<{ httpsAgent: { options: { ca?: string[] } } }>;
      }
    ).configProvider;
    expect(handlerConfig.httpsAgent.options.ca).toContain(EMULATOR.caPem);
    expect(handlerConfig.httpsAgent.options.ca!.length).toBeGreaterThan(1);
    const sts = new STSClient({ ...awsClientDefaults(), region: 'us-east-1' });
    try {
      const creds = await sts.config.credentials();
      expect(creds.accessKeyId).toBe(EMULATOR.credentials.accessKeyId);
      const ep = await sts.config.endpoint?.();
      expect(ep?.hostname).toBe('127.0.0.1');
      expect(ep?.port).toBe(9297);
    } finally {
      sts.destroy();
    }
  });

  it('outranks a published --role-arn role and the caller opt-out: no real key is signed in', async () => {
    setAssumedRoleCredentials({
      accessKeyId: 'ROLEKEYID00000000000',
      secretAccessKey: 'role-secret',
      sessionToken: 'role-token',
    });
    setAwsEndpointOverrideSource(() => EMULATOR);
    for (const opts of [{}, { ignoreAssumedRole: true }, { profile: 'prod' }]) {
      const sts = new STSClient({ ...awsClientDefaults(opts), region: 'us-east-1' });
      try {
        const creds = await sts.config.credentials();
        expect(creds.accessKeyId).toBe(EMULATOR.credentials.accessKeyId);
        expect(creds.sessionToken).toBeUndefined();
      } finally {
        sts.destroy();
      }
    }
  });

  it('is asked per client, so an override activated after registration is honoured', () => {
    let active: AwsEndpointOverrideDefaults | undefined;
    setAwsEndpointOverrideSource(() => active);
    expect(awsClientDefaults().endpoint).toBeUndefined();
    active = EMULATOR;
    expect(awsClientDefaults().endpoint).toBe(EMULATOR.endpoint);
  });

  it('carries no credentials key when the endpoint has no keys of its own', () => {
    setAwsEndpointOverrideSource(() => ({ endpoint: 'http://127.0.0.1:4566' }));
    const d = awsClientDefaults();
    expect(d.endpoint).toBe('http://127.0.0.1:4566');
    expect('credentials' in d).toBe(false);
  });
});
