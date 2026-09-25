import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  persistedTokenResolverContext,
  resolveRecordSecrets,
} from '../../../src/deployment/masked-baseline-recapture.js';
import { DynamicReferenceRegionAmbiguousError } from '../../../src/utils/error-handler.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const mockSecretsManagerSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: { send: vi.fn().mockResolvedValue({ AvailabilityZones: [] }) },
    secretsManager: { send: mockSecretsManagerSend },
    ssm: { send: vi.fn() },
  }),
}));

/**
 * Issue #3595: the re-capture's resolution through the REAL resolver, with the
 * exact context the deploy engine builds (`persistedTokenResolverContext`).
 * The engine-level test mocks the resolver, so it pins only what the engine
 * PASSES; this pins what the far side does with it: it records the pair into
 * the map it was handed, it THROWS on a failed lookup (the all-or-nothing arm
 * rests on that), and it refuses a region-less reference as ambiguous when
 * the stack's producer regions name another region.
 */
describe('masked-baseline re-capture through the real resolver (issue #3595)', () => {
  const A = '{{resolve:secretsmanager:app-secret:SecretString:alpha}}';
  const B = '{{resolve:secretsmanager:app-secret:SecretString:bravo}}';

  beforeEach(() => {
    resetAccountInfoCache();
    mockSecretsManagerSend.mockReset();
  });

  const resolveWith =
    (resolver: IntrinsicFunctionResolver, producerRegions: readonly string[]) =>
    (token: string, own: Map<string, string>) =>
      resolver.resolveDynamicReferences(token, persistedTokenResolverContext(own, producerRegions));

  it('records each reference into the pass map', async () => {
    mockSecretsManagerSend.mockResolvedValue({
      SecretString: JSON.stringify({ alpha: 'alpha-pt-1', bravo: 'bravo-pt-2' }),
    });
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const secrets = await resolveRecordSecrets({ E: ['-p', A, '-p', B] }, resolveWith(resolver, []));
    expect(secrets).toEqual(
      new Map([
        ['alpha-pt-1', A],
        ['bravo-pt-2', B],
      ])
    );
  });

  it('refuses the record when a lookup fails, instead of certifying the rest', async () => {
    mockSecretsManagerSend.mockRejectedValue(
      Object.assign(new Error('Secrets Manager can not find the specified secret.'), {
        name: 'ResourceNotFoundException',
      })
    );
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      resolveRecordSecrets({ E: ['-p', A, '-p', B] }, resolveWith(resolver, []))
    ).resolves.toBeUndefined();
  });

  it('refuses a region-less reference the producer regions make ambiguous', async () => {
    mockSecretsManagerSend.mockResolvedValue({
      SecretString: JSON.stringify({ alpha: 'alpha-pt-1', bravo: 'bravo-pt-2' }),
    });
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const own = new Map<string, string>();
    await expect(
      resolver.resolveDynamicReferences(A, persistedTokenResolverContext(own, ['eu-west-1']))
    ).rejects.toBeInstanceOf(DynamicReferenceRegionAmbiguousError);
    expect(own.size).toBe(0);
    expect(mockSecretsManagerSend).not.toHaveBeenCalled();
    await expect(
      resolveRecordSecrets({ E: [A] }, resolveWith(resolver, ['eu-west-1']))
    ).resolves.toBeUndefined();
  });
});
