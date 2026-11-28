import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState, ResourceState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

vi.mock('../../../../src/utils/logger.js', () => {
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

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: { send: vi.fn() },
  }),
}));

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const STACK = 'Stk7189Scrub';

/**
 * go-to-k/cdkd#7189 in `cdkd scrub`: a leaf that EMBEDS a declared `NoEcho`
 * attribute (an `Fn::Join` around `Fn::GetAtt`), which an older binary masked
 * whole by containment and named in no `noEchoLeaves`, is positioned from
 * today's template, live record and orphan alike.
 */
const template = {
  Resources: {
    Cr: { Type: 'Custom::Secret7189', Properties: { ServiceToken: 'arn' } },
    Reader: {
      Type: 'AWS::SSM::Parameter',
      Properties: {
        Type: 'String',
        Value: { 'Fn::Join': ['', ['postgres://u:', { 'Fn::GetAtt': ['Cr', 'Secret'] }, '@db']] },
      },
    },
  },
} as unknown as CloudFormationTemplate;

const reader = (): ResourceState => ({
  physicalId: 'reader',
  resourceType: 'AWS::SSM::Parameter',
  properties: { Type: 'String', Value: '***' },
});

function state(extra: Partial<StackState> = {}): StackState {
  return {
    version: 18 as never,
    region: 'us-east-1',
    stackName: STACK,
    resources: {
      Cr: {
        physicalId: 'cr',
        resourceType: 'Custom::Secret7189',
        properties: { ServiceToken: 'arn' },
        attributes: { Secret: '***' },
        noEchoAttributeNames: ['Secret'],
      },
      Reader: reader(),
    },
    outputs: {},
    lastModified: 0,
    ...extra,
  };
}

describe('cdkd scrub positions an embedded NoEcho attribute read already masked (go-to-k/cdkd#7189)', () => {
  const backend = {
    getState: vi.fn(),
    saveState: vi.fn(),
    purgeNoncurrentVersions: vi.fn(),
    listStacks: vi.fn(),
  };
  const lock = {
    acquireLockWithRetry: vi.fn(async () => undefined),
    releaseLock: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    backend.saveState.mockResolvedValue('etag-2');
    backend.purgeNoncurrentVersions.mockResolvedValue(undefined);
    backend.listStacks.mockResolvedValue([]);
  });

  async function scrub(input: StackState): Promise<StackState | undefined> {
    backend.getState.mockResolvedValue({ state: input, etag: 'etag-1' });
    await scrubStack({ stackName: STACK, template } as never, 'us-east-1', backend as never, lock as never, {
      dryRun: false,
      logger: logger as never,
    });
    return backend.saveState.mock.calls.at(-1)?.[2] as StackState | undefined;
  }

  it('names the live record\'s masked embedding leaf in noEchoLeaves', async () => {
    const saved = await scrub(state());
    expect(saved?.resources['Reader']?.noEchoLeaves).toEqual([['Value']]);
    expect(saved?.resources['Reader']?.properties['Value']).toBe('***');
  });

  it('names an orphan\'s too', async () => {
    const saved = await scrub(
      state({ orphans: [{ logicalId: 'Reader', orphanedAt: 1, state: reader() }] })
    );
    expect(saved?.orphans?.[0]?.state.noEchoLeaves).toEqual([['Value']]);
  });
});
