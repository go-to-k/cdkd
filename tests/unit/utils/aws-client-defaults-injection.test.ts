import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * The parameter is declared so the spy's recorded calls stay TYPED. With a
 * zero-arg `vi.fn(() => ...)` every `mock.calls[0][0]` is `undefined` at the
 * type level and the assertions below do not compile.
 */
interface DefaultProviderInit {
  profile?: string;
  clientConfig?: Record<string, unknown>;
}

const defaultProviderSpy = vi.hoisted(() =>
  vi.fn((_init: DefaultProviderInit = {}) => async () => ({
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
  }))
);

vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: defaultProviderSpy,
}));

const { awsClientDefaults, resetAwsClientDefaults, PROXY_ENV_VARS } = await import(
  '../../../src/utils/aws-client-defaults.ts'
);

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(PROXY_ENV_VARS.map((n) => [n, process.env[n]]));
  for (const n of PROXY_ENV_VARS) delete process.env[n];
  defaultProviderSpy.mockClear();
  resetAwsClientDefaults();
});

afterEach(() => {
  for (const n of PROXY_ENV_VARS) {
    const v = saved[n];
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  resetAwsClientDefaults();
});

/**
 * The SHAPE of the injected credential chain (issue #2388).
 *
 * The behavioural fences in `aws-client-defaults-sdk-contract.test.ts` prove
 * the SDK honours `clientConfig.requestHandler`. This file proves cdkd still
 * PASSES it — a distinct failure, and the one a refactor causes. Before this
 * existed the only assertion on the chain was `typeof credentials ===
 * 'function'`, which `defaultProvider({})` satisfies with both the profile and
 * the handler dropped.
 */
describe('the injected credential chain is built with the agreed arguments', () => {
  it('is not constructed at all on the unproxied path', () => {
    expect(awsClientDefaults({ profile: 'dev' })).toEqual({});
    expect(defaultProviderSpy).not.toHaveBeenCalled();
  });

  it('threads the SAME requestHandler the client gets, inside `clientConfig`', () => {
    // The SSO portal client and the SSO-OIDC refresh read `clientConfig` and
    // nothing else, so this argument is the whole reason an SSO profile works
    // behind a proxy.
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    const defaults = awsClientDefaults();
    expect(defaultProviderSpy).toHaveBeenCalledTimes(1);
    const init = defaultProviderSpy.mock.calls[0]![0]!;
    expect(init.clientConfig?.['requestHandler']).toBe(defaults.requestHandler);
  });

  it('puts NOTHING but requestHandler in `clientConfig`', () => {
    // A `region` here would override the SSO portal's own region.
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    awsClientDefaults({ profile: 'dev' });
    const init = defaultProviderSpy.mock.calls[0]![0]!;
    expect(Object.keys(init.clientConfig ?? {})).toEqual(['requestHandler']);
  });

  it('passes `profile` ALONGSIDE clientConfig, not inside it', () => {
    // The built-in chain sees a profile through the client config; an injected
    // chain does not, so dropping this silently resolves the wrong identity.
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    awsClientDefaults({ profile: 'sso-dev' });
    const init = defaultProviderSpy.mock.calls[0]![0]!;
    expect(init.profile).toBe('sso-dev');
    expect(init.clientConfig).not.toHaveProperty('profile');
  });

  it('omits `profile` entirely when the caller has none', () => {
    // Rather than passing `undefined`, which `exactOptionalPropertyTypes`
    // forbids and which the SDK would read as a profile named undefined.
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    awsClientDefaults();
    expect(defaultProviderSpy.mock.calls[0]![0]!).not.toHaveProperty('profile');
  });

  it('builds a NEW chain per call, because resolved credentials memoize inside it', () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    awsClientDefaults({ profile: 'a' });
    awsClientDefaults({ profile: 'b' });
    expect(defaultProviderSpy).toHaveBeenCalledTimes(2);
    const first = defaultProviderSpy.mock.calls[0]![0]!;
    const second = defaultProviderSpy.mock.calls[1]![0]!;
    expect(first.clientConfig).not.toBe(second.clientConfig);
  });
});
