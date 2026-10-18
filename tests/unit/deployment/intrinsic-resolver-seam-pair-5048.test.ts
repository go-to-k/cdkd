/**
 * go-to-k/cdkd#5048: the resolver's two recording seams (a fresh lookup and a
 * cache hit) write a secret's entry and its pair in ONE call
 * (`recordSecretResolution`), the pair withheld for a value read at a pinned
 * generation (go-to-k/cdkd#4847). Through the REAL resolver, both seams, both
 * ways.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const CURRENT = 'b1b2c3d4-0000-1111-2222-333333333333';
const PREVIOUS = 'a1b2c3d4-0000-1111-2222-333333333333';
const calls = vi.hoisted(() => ({ sm: 0 }));
const smAnswer = vi.hoisted(
  () =>
    async (command: { input?: { VersionId?: string } }): Promise<unknown> => {
      calls.sm++;
      const version = command.input?.VersionId;
      return version === undefined || version === 'b1b2c3d4-0000-1111-2222-333333333333'
        ? { SecretString: 'current-password', VersionId: 'b1b2c3d4-0000-1111-2222-333333333333' }
        : { SecretString: 'previous-password', VersionId: version };
    }
);
const bagFor = vi.hoisted(() => {
  const make = (region: string): Record<string, unknown> => ({
    configuredRegion: region,
    credentialConfig: {},
    withRegion: (target: string) => make(target),
    sts: { send: async () => ({ Account: '123456789012' }) },
    secretsManager: {
      send: smAnswer,
      config: { region: () => Promise.resolve(region) },
    },
  });
  return make;
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => bagFor('us-east-1'),
}));

const { IntrinsicFunctionResolver } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const { resolvedPlaintextOf } = await import('../../../src/deployment/secret-redaction/pairs.js');
const { clearRecordedSecretExpressions } = await import(
  '../../../src/deployment/secret-redaction.js'
);

const SM = '{{resolve:secretsmanager:app:SecretString:::}}';

const contextFor = (bag: Map<string, string>, pin?: string) => ({
  template: { Resources: {} },
  resources: {},
  recordedSecretValues: bag,
  ...(pin !== undefined && { referencePins: new Map([[SM, pin]]) }),
});

beforeEach(() => {
  calls.sm = 0;
  clearRecordedSecretExpressions();
});

describe('the resolver seams record the entry and its pair together', () => {
  it('an unpinned lookup and its cache hit record both', async () => {
    const resolver = new IntrinsicFunctionResolver();
    for (const seam of ['fresh', 'cache'] as const) {
      const bag = new Map<string, string>();
      await resolver.resolve({ P: SM }, contextFor(bag));
      expect({ seam, entry: bag.get('current-password') }).toEqual({ seam, entry: SM });
      expect({ seam, pair: resolvedPlaintextOf(bag, SM) }).toEqual({
        seam,
        pair: 'current-password',
      });
    }
    // The second resolution was the cache seam.
    expect(calls.sm).toBe(1);
  });

  it('a value read at a pinned generation records the entry and no pair, on both seams', async () => {
    const resolver = new IntrinsicFunctionResolver();
    // The unpinned entry first, so the pin names ANOTHER generation.
    await resolver.resolve({ P: SM }, contextFor(new Map()));
    for (const seam of ['fresh', 'cache'] as const) {
      const bag = new Map<string, string>();
      await resolver.resolve({ P: SM }, contextFor(bag, PREVIOUS));
      expect({ seam, entry: bag.get('previous-password') }).toEqual({ seam, entry: SM });
      expect({ seam, pair: resolvedPlaintextOf(bag, SM) }).toEqual({ seam, pair: undefined });
    }
    expect(calls.sm).toBe(2);
  });

  it('a pin equal to the current generation records the pair', async () => {
    const resolver = new IntrinsicFunctionResolver();
    await resolver.resolve({ P: SM }, contextFor(new Map()));
    const bag = new Map<string, string>();
    await resolver.resolve({ P: SM }, contextFor(bag, CURRENT));
    expect(resolvedPlaintextOf(bag, SM)).toBe('current-password');
  });
});
