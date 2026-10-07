import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #4029: `CloudControlProvider.delete` hands a Neptune cluster to a
 * `NeptuneProvider` built with its OWN client's region, the one its
 * recorded-region pre-flight vetted. The option must reach the SDK client,
 * over the ambient region.
 */

const clientRegions = vi.hoisted(() => [] as Array<string | undefined>);
const send = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-neptune', async () => {
  const actual = await vi.importActual('@aws-sdk/client-neptune');
  return {
    ...actual,
    NeptuneClient: vi.fn().mockImplementation((config: { region?: string }) => {
      clientRegions.push(config.region);
      return { send, config: { region: () => Promise.resolve(config.region ?? 'us-east-1') } };
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => child }) };
});

import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';

describe('NeptuneProvider region option (issue #4029)', () => {
  beforeEach(() => {
    clientRegions.length = 0;
    send.mockReset();
    // The delete's post-wait describe reads the cluster as gone at once.
    send.mockImplementation((cmd) =>
      cmd.constructor.name.startsWith('Describe')
        ? Promise.reject(Object.assign(new Error('gone'), { name: 'DBClusterNotFoundFault' }))
        : Promise.resolve({})
    );
  });

  it('pins the client to the given region, over AWS_REGION', async () => {
    const saved = process.env['AWS_REGION'];
    process.env['AWS_REGION'] = 'us-east-1';
    try {
      await new NeptuneProvider({ region: 'eu-west-1' }).delete(
        'Nep',
        'nep-1',
        'AWS::Neptune::DBCluster',
        {}
      );
    } finally {
      if (saved === undefined) delete process.env['AWS_REGION'];
      else process.env['AWS_REGION'] = saved;
    }
    // The shared client and the create client built with it (#4639).
    expect(clientRegions).toEqual(['eu-west-1', 'eu-west-1']);
    const del = send.mock.calls.find((c) => c[0].constructor.name === 'DeleteDBClusterCommand');
    expect(del?.[0].input).toEqual(expect.objectContaining({ SkipFinalSnapshot: true }));
  });
});
