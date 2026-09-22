/**
 * `ContextProviderRegistry.resolve` renders no manifest-derived value raw
 * (issue go-to-k/cdkd#3479).
 *
 * `entry.provider` and `entry.key` are read straight out of the manifest's
 * `missing` list, so they are chosen by whoever wrote the assembly. They reach
 * the terminal at four sites, three of which need no error at all: the
 * unknown-provider `warn`, and two `debug` lines on the SUCCESS path.
 *
 * The error-arm case also covers the provider's own failure text, which is the
 * render site for every lookup argument the `*-provider.ts` modules interpolate
 * into a thrown message (`parameterName`, `domainName`, a VPC filter) — all of
 * them from the template's context queries.
 *
 * Both polarities per site; the hostile cases carry a DISTINCT marker per
 * interpolated value.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...loggerSpies, child: () => loggerSpies }),
}));

import { ContextProviderRegistry } from '../../../../src/synthesis/context-providers/index.js';
import type { MissingContext } from '../../../../src/types/assembly.js';
import { CSI, hasForgingCharacter, LINE_SEP, NEL, RLO, ST } from '../../_forging-characters.js';

/** One hostile marker per interpolated value, each with its own sanitized twin. */
const HOSTILE = {
  unknownProvider: { raw: `unknown${CSI}provider`, clean: 'unknown provider' },
  unknownKey: { raw: `unknown${NEL}key`, clean: 'unknown key' },
  knownKey: { raw: `probe${LINE_SEP}key`, clean: 'probe key' },
  failingKey: { raw: `failing${RLO}key`, clean: 'failing key' },
  failureText: { raw: `SSM lookup denied${ST}for /db/host`, clean: 'SSM lookup denied for /db/host' },
} as const;

const PROVIDER_ERROR_KEY = '$providerError';

function warnLines(): string[] {
  return loggerSpies.warn.mock.calls.map((call) => String(call[0]));
}
function debugLines(): string[] {
  return loggerSpies.debug.mock.calls.map((call) => String(call[0]));
}
function errorLines(): string[] {
  return loggerSpies.error.mock.calls.map((call) => String(call[0]));
}

function missing(provider: string, key: string): MissingContext[] {
  return [{ provider, key, props: {} }] as unknown as MissingContext[];
}

beforeEach(() => {
  for (const spy of Object.values(loggerSpies)) spy.mockReset();
});

describe('ContextProviderRegistry renders manifest-derived values display-safe (#3479)', () => {
  describe('the unknown-provider arm — a warn plus the context value it writes back', () => {
    it('sanitizes the provider name in both, with the key sanitized on the same run', async () => {
      const registry = new ContextProviderRegistry();
      const results = await registry.resolve(
        missing(HOSTILE.unknownProvider.raw, HOSTILE.unknownKey.raw)
      );
      expect(warnLines()).toEqual([
        `No context provider registered for: ${HOSTILE.unknownProvider.clean}`,
      ]);
      // The RESULT is still keyed by the RAW manifest key — sanitizing what is
      // USED rather than shown would hand the CDK app a key it never asked for.
      const entry = results[HOSTILE.unknownKey.raw] as Record<string, unknown>;
      expect(entry[PROVIDER_ERROR_KEY]).toBe(
        `Unknown context provider: ${HOSTILE.unknownProvider.clean}`
      );
      for (const line of warnLines()) expect(hasForgingCharacter(line)).toBe(false);
      expect(hasForgingCharacter(String(entry[PROVIDER_ERROR_KEY]))).toBe(false);
    });

    it('leaves an ordinary provider name byte-identical', async () => {
      const registry = new ContextProviderRegistry();
      const results = await registry.resolve(missing('not-a-provider', 'some:key'));
      expect(warnLines()).toEqual(['No context provider registered for: not-a-provider']);
      const entry = results['some:key'] as Record<string, unknown>;
      expect(entry[PROVIDER_ERROR_KEY]).toBe('Unknown context provider: not-a-provider');
    });
  });

  describe('the SUCCESS path — two debug lines, no error involved', () => {
    it('sanitizes the provider name and the key, distinct markers per value', async () => {
      const registry = new ContextProviderRegistry();
      registry.register(HOSTILE.unknownProvider.raw, {
        resolve: async () => ['us-east-1a'],
      });
      await registry.resolve(missing(HOSTILE.unknownProvider.raw, HOSTILE.knownKey.raw));
      expect(debugLines()).toEqual([
        `Resolving context: ${HOSTILE.unknownProvider.clean} (key: ${HOSTILE.knownKey.clean})`,
        `Resolved context: ${HOSTILE.knownKey.clean}`,
      ]);
      for (const line of debugLines()) expect(hasForgingCharacter(line)).toBe(false);
    });

    it('leaves an ordinary provider name and key byte-identical', async () => {
      const registry = new ContextProviderRegistry();
      registry.register('availability-zones', { resolve: async () => ['us-east-1a'] });
      await registry.resolve(
        missing('availability-zones', 'availability-zones:account=1:region=us-east-1')
      );
      expect(debugLines()).toEqual([
        'Resolving context: availability-zones (key: availability-zones:account=1:region=us-east-1)',
        'Resolved context: availability-zones:account=1:region=us-east-1',
      ]);
    });
  });

  describe('the provider-failure arm — the error line and the context value', () => {
    it('sanitizes the provider name AND the provider-supplied failure text', async () => {
      const registry = new ContextProviderRegistry();
      registry.register(HOSTILE.unknownProvider.raw, {
        resolve: async () => {
          throw new Error(HOSTILE.failureText.raw);
        },
      });
      const results = await registry.resolve(
        missing(HOSTILE.unknownProvider.raw, HOSTILE.failingKey.raw)
      );
      expect(errorLines()).toEqual([
        `Context provider '${HOSTILE.unknownProvider.clean}' failed: ${HOSTILE.failureText.clean}`,
      ]);
      const entry = results[HOSTILE.failingKey.raw] as Record<string, unknown>;
      expect(entry[PROVIDER_ERROR_KEY]).toBe(HOSTILE.failureText.clean);
      for (const line of errorLines()) expect(hasForgingCharacter(line)).toBe(false);
    });

    it('leaves an ordinary failure text byte-identical', async () => {
      const registry = new ContextProviderRegistry();
      registry.register('ssm', {
        resolve: async () => {
          throw new Error('AWS API call failed');
        },
      });
      const results = await registry.resolve(missing('ssm', 'ssm:parameterName=/db/host'));
      expect(errorLines()).toEqual(["Context provider 'ssm' failed: AWS API call failed"]);
      const entry = results['ssm:parameterName=/db/host'] as Record<string, unknown>;
      expect(entry[PROVIDER_ERROR_KEY]).toBe('AWS API call failed');
    });
  });
});
