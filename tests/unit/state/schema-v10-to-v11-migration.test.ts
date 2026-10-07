import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  type StackState,
} from '../../../src/types/state.js';
import { StateError } from '../../../src/utils/error-handler.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';

/**
 * Schema v11 — `ResourceState.noEchoLeaves` / `noEchoAttributeNames`
 * (go-to-k/cdkd#4043 Phase B, go-to-k/cdkd#2449).
 *
 * The integ test `tests/integration/schema-v10-to-v11-migration/` proves the
 * round trip against real AWS. This pins the in-memory contract through the
 * REAL `S3StateBackend` read path: v11 is current and readable, a v10 blob is
 * read unchanged with both fields absent (the "not known" reading every
 * pre-v11 record gets), and a version past 11 is refused with "Upgrade cdkd".
 * The writers and readers of the two fields are pinned where they live
 * (`deploy-engine-noecho-v11.test.ts`, `secret-redaction-noecho-leaves.test.ts`).
 */
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '999999999999' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/utils/aws-region-resolver.js')
  >('../../../src/utils/aws-region-resolver.js');
  return { ...actual, resolveBucketRegion: vi.fn() };
});

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...fns, child: () => fns }) };
});

function makeClient(): { send: ReturnType<typeof vi.fn> } & Record<string, unknown> {
  return {
    send: vi.fn(),
    destroy: vi.fn(),
    config: {
      region: () => Promise.resolve('us-east-1'),
      credentials: () =>
        Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' }),
    },
  };
}

describe('State schema v11 — noEchoLeaves / noEchoAttributeNames (#4043, #2449)', () => {
  let client: ReturnType<typeof makeClient>;
  let backend: S3StateBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
    client = makeClient();
    backend = new S3StateBackend(
      client as unknown as S3Client,
      { bucket: 'b', prefix: 'cdkd' },
      { region: 'us-east-1' }
    );
  });

  const serve = (blob: unknown): void => {
    client.send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(blob)) },
      ETag: '"e"',
    });
  };

  it('v11 is the current version, and every version 1..11 is readable', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBe(11);
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(v);
    }
    expect(STATE_SCHEMA_VERSIONS_READABLE).not.toContain(12);
  });

  it('reads a v10 blob unchanged, with both v11 fields absent, and writes nothing on read', async () => {
    const v10 = {
      version: 10,
      stackName: 'LegacyV10Stack',
      region: 'us-east-1',
      resources: {
        Param: {
          physicalId: '/app/p',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/app/p', Value: 'still-plaintext' },
          attributes: { Value: 'still-plaintext' },
        },
      },
      outputs: {},
      lastModified: 0,
    };
    serve(v10);
    const result = await backend.getState('LegacyV10Stack', 'us-east-1');
    const state = result?.state as StackState;
    expect(state.version).toBe(10);
    expect(state.resources['Param']!.noEchoLeaves).toBeUndefined();
    expect(state.resources['Param']!.noEchoAttributeNames).toBeUndefined();
    expect(state.resources['Param']!.properties['Value']).toBe('still-plaintext');
    // Reading never rewrites: the only S3 call was the GET.
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('reads a v11 blob carrying both fields as written', async () => {
    serve({
      version: 11,
      stackName: 'S',
      region: 'us-east-1',
      resources: {
        Param: {
          physicalId: '/app/p',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/app/p', Value: '***' },
          attributes: { Value: '***' },
          noEchoLeaves: [['Value']],
          noEchoAttributeNames: ['Value'],
        },
      },
      outputs: {},
      lastModified: 0,
    });
    const state = (await backend.getState('S', 'us-east-1'))?.state as StackState;
    expect(state.version).toBe(11);
    expect(state.resources['Param']!.noEchoLeaves).toEqual([['Value']]);
    expect(state.resources['Param']!.noEchoAttributeNames).toEqual(['Value']);
  });

  it('refuses version 12 with the "Upgrade cdkd" error, as an older binary refuses 11', async () => {
    serve({ version: 12, stackName: 'X', resources: {}, outputs: {}, lastModified: 0 });
    const caught = await backend.getState('X', 'us-east-1').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as Error).message).toMatch(/Unsupported state schema version 12/);
    expect((caught as Error).message).toMatch(/1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11/);
    expect((caught as Error).message).toMatch(/Upgrade cdkd/);
  });
});
