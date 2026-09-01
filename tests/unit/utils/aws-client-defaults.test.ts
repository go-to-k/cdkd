import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import {
  awsClientDefaults,
  PROXY_ENV_VARS as PROXY_ENV_VARS_FOR_TEST,
  resetAwsClientDefaults,
} from '../../../src/utils/aws-client-defaults.ts';
import { ProxyRoutingAgent } from '../../../src/utils/proxy-routing-agent.ts';

const PROXY_VARS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(PROXY_VARS.map((name) => [name, process.env[name]]));
  for (const name of PROXY_VARS) delete process.env[name];
  resetAwsClientDefaults();
});

afterEach(() => {
  for (const name of PROXY_VARS) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetAwsClientDefaults();
});

/**
 * The agents a handler will actually use.
 *
 * `NodeHttpHandler` resolves its config lazily and exposes the plain-http agent
 * only through `httpAgentProvider()` — it is not materialised until the first
 * `http:` request — so reading `config.httpAgent` eagerly reports `undefined`
 * for a correctly wired handler.
 */
async function agentsOf(defaults: ReturnType<typeof awsClientDefaults>): Promise<unknown[]> {
  const handler = defaults.requestHandler as unknown as {
    configProvider: Promise<{
      httpsAgent?: unknown;
      httpAgentProvider?: () => Promise<unknown>;
    }>;
  };
  const config = await handler.configProvider;
  return [await config.httpAgentProvider?.(), config.httpsAgent];
}

/**
 * Issue [#2388](https://github.com/go-to-k/cdkd/issues/2388) — the AWS SDK for
 * JavaScript v3 does not read the proxy environment variables, so behind a
 * corporate proxy every cdkd command fails at credential resolution.
 */
describe('awsClientDefaults', () => {
  describe('the unproxied path', () => {
    it('returns {} so the SDK keeps its own agent defaults', () => {
      // This is what makes the change a no-op for every existing user: an empty
      // spread leaves the client config byte-identical to before.
      expect(awsClientDefaults()).toEqual({});
      expect(awsClientDefaults({ profile: 'dev' })).toEqual({});
    });

    it('is unaffected by NO_PROXY alone', () => {
      process.env['NO_PROXY'] = 'example.com';
      expect(awsClientDefaults()).toEqual({});
    });
  });

  describe('the proxied path', () => {
    it('supplies a request handler backed by a routing agent', async () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      const defaults = awsClientDefaults();
      expect(defaults.requestHandler).toBeDefined();
      for (const agent of await agentsOf(defaults)) {
        expect(agent).toBeInstanceOf(ProxyRoutingAgent);
      }
    });

    it('uses ONE routing agent for both schemes, so the routing decision is per request', async () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      const [http, https] = await agentsOf(awsClientDefaults());
      expect(http).toBe(https);
    });

    it('injects a credential chain, which is what an SSO profile needs', () => {
      // A client's own `requestHandler` does not reach the SSO portal client:
      // `@aws-sdk/credential-provider-sso` builds it from `clientConfig` alone.
      // So an SSO profile fails BEFORE any service call unless the chain is
      // constructed here.
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      expect(typeof awsClientDefaults({ profile: 'sso-dev' }).credentials).toBe('function');
    });

    it('is triggered by every spelling the source lists, `ALL_PROXY` included', () => {
      // Driven off the module's own list rather than a copy of it. A hand-typed
      // set covered four of the six, so deleting `ALL_PROXY` / `all_proxy` from
      // the source passed the suite.
      const spellings = PROXY_ENV_VARS_FOR_TEST;
      expect(spellings.length, 'the source list shrank — is that deliberate?').toBe(6);
      for (const name of spellings) {
        resetAwsClientDefaults();
        for (const other of PROXY_VARS) delete process.env[other];
        process.env[name] = 'http://proxy.example:8080';
        expect(awsClientDefaults().requestHandler, name).toBeDefined();
      }
    });

    it('still refuses a whitespace-only var when a VALID one precedes it', () => {
      // `.some()` short-circuited at the first valid variable, so the typo was
      // never reached and resurfaced per request as the unnamed URL-parse error
      // the guard exists to pre-empt. `HTTPS_PROXY` is checked before
      // `http_proxy` in the source order, so this is that exact ordering.
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      process.env['http_proxy'] = '   ';
      expect(() => awsClientDefaults()).toThrow(/http_proxy is set to whitespace only/);
    });

    it('refuses a whitespace-only value by NAME instead of failing later', () => {
      // Silently treating it as unset sends the run direct, which fails with
      // the certificate error this change exists to remove and names nothing.
      process.env['HTTPS_PROXY'] = '   ';
      expect(() => awsClientDefaults()).toThrow(/HTTPS_PROXY is set to whitespace only/);
    });

    it('treats an empty variable as unset', () => {
      process.env['HTTPS_PROXY'] = '';
      expect(awsClientDefaults()).toEqual({});
    });
  });

  describe('one agent per call', () => {
    it('never hands two callers the same agent', async () => {
      // `NodeHttpHandler.destroy()` destroys `httpAgent` / `httpsAgent`
      // unconditionally, and Node's `Agent.destroy()` aborts ACTIVE sockets. A
      // shared agent would let one client's teardown kill another client's
      // in-flight request, and cdkd destroys clients mid-deploy.
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      const [firstAgent] = await agentsOf(awsClientDefaults());
      const [secondAgent] = await agentsOf(awsClientDefaults());
      expect(firstAgent).not.toBe(secondAgent);
    });

    it('never hands two callers the same credential chain', () => {
      // `defaultProvider` memoizes RESOLVED credentials inside the chain
      // instance, so sharing one would hand a client configured for one profile
      // the credentials of another.
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      expect(awsClientDefaults({ profile: 'a' }).credentials).not.toBe(
        awsClientDefaults({ profile: 'b' }).credentials
      );
    });
  });

  describe('the memoized environment read', () => {
    it('is lazy — a variable set after import still takes effect', () => {
      // Reading at module scope would freeze the answer before the CLI has
      // finished setting up.
      expect(awsClientDefaults()).toEqual({});
      resetAwsClientDefaults();
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      expect(awsClientDefaults().requestHandler).toBeDefined();
    });

    it('is memoized, and the reset seam is what clears it', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      expect(awsClientDefaults().requestHandler).toBeDefined();
      delete process.env['HTTPS_PROXY'];
      // Still proxied: the parse result is cached, which is the documented
      // behaviour and why the seam exists.
      expect(awsClientDefaults().requestHandler).toBeDefined();
      resetAwsClientDefaults();
      expect(awsClientDefaults()).toEqual({});
    });
  });
});
