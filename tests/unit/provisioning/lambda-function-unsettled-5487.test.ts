/**
 * go-to-k/cdkd#5487: the Lambda function `update()` marks each key just
 * before the call that changes it (`UpdateContext.markUnsettled`), converges a
 * key an earlier failed update left unsettled against what the function holds
 * now, and reports a configuration / code key still changing while the
 * function reads `LastUpdateStatus: InProgress`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockLambdaSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2: { send: vi.fn() },
  }),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  child.child.mockReturnValue(child);
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';

const TYPE = 'AWS::Lambda::Function';
const ARN = 'arn:aws:lambda:us-east-1:123456789012:function:f';
const BASE = { Role: 'arn:aws:iam::123456789012:role/r', Handler: 'index.handler', Runtime: 'nodejs20.x' };

function serve(live: { timeout?: number; lastUpdateStatus?: string; state?: string; tags?: Record<string, string> }): void {
  mockLambdaSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'GetFunctionCommand':
      case 'GetFunctionConfigurationCommand': {
        const configuration = {
          FunctionName: 'f',
          FunctionArn: ARN,
          ...BASE,
          Timeout: live.timeout ?? 3,
          MemorySize: 128,
          State: live.state ?? 'Active',
          LastUpdateStatus: live.lastUpdateStatus ?? 'Successful',
        };
        return cmd.constructor.name === 'GetFunctionCommand'
          ? { Configuration: configuration, Tags: live.tags ?? {} }
          : configuration;
      }
      case 'ListTagsCommand':
        return { Tags: live.tags ?? {} };
      default:
        return {};
    }
  });
}

const sent = (name: string) =>
  mockLambdaSend.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === name);

describe('Lambda function unsettled properties (go-to-k/cdkd#5487)', () => {
  let provider: LambdaFunctionProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaFunctionProvider();
  });

  it('marks the changed configuration keys before UpdateFunctionConfiguration, and only those', async () => {
    serve({});
    const marks: string[] = [];
    let configSentAtMark: number | undefined;
    await provider.update(
      'F',
      'f',
      TYPE,
      { ...BASE, Timeout: 10, MemorySize: 256 },
      { ...BASE, Timeout: 3, MemorySize: 128 },
      {
        markUnsettled: (k: string) => {
          marks.push(k);
          configSentAtMark ??= sent('UpdateFunctionConfigurationCommand').length;
        },
      }
    );
    expect(marks).toEqual(['Timeout', 'MemorySize']);
    expect(configSentAtMark).toBe(0);
    expect(sent('UpdateFunctionConfigurationCommand')).toHaveLength(1);
  });

  it('marks ReservedConcurrentExecutions and Tags before their own calls', async () => {
    serve({});
    const marks: string[] = [];
    await provider.update(
      'F',
      'f',
      TYPE,
      { ...BASE, ReservedConcurrentExecutions: 5, Tags: [{ Key: 'a', Value: '1' }] },
      { ...BASE },
      { markUnsettled: (k: string) => marks.push(k) }
    );
    expect(marks).toEqual(['ReservedConcurrentExecutions', 'Tags']);
  });

  it('marks nothing for an update that changes nothing it sends', async () => {
    serve({});
    const marks: string[] = [];
    await provider.update('F', 'f', TYPE, { ...BASE, Timeout: 3 }, { ...BASE, Timeout: 3 }, {
      markUnsettled: (k: string) => marks.push(k),
    });
    expect(marks).toEqual([]);
    expect(sent('UpdateFunctionConfigurationCommand')).toHaveLength(0);
  });

  it('an unsettled Timeout equal in the bags is re-sent when the function holds another value', async () => {
    serve({ timeout: 10 });
    await provider.update('F', 'f', TYPE, { ...BASE, Timeout: 3 }, { ...BASE, Timeout: 3 }, {
      unsettledProperties: new Set(['Timeout']),
    });
    expect(sent('UpdateFunctionConfigurationCommand').map((c) => c.input.Timeout)).toEqual([3]);
  });

  it('an unsettled Timeout the function already holds sends nothing', async () => {
    serve({ timeout: 3 });
    await provider.update('F', 'f', TYPE, { ...BASE, Timeout: 3 }, { ...BASE, Timeout: 3 }, {
      unsettledProperties: new Set(['Timeout']),
    });
    expect(sent('UpdateFunctionConfigurationCommand')).toHaveLength(0);
  });

  it('without unsettled keys the recorded bag decides', async () => {
    serve({ timeout: 10 });
    await provider.update('F', 'f', TYPE, { ...BASE, Timeout: 3 }, { ...BASE, Timeout: 3 });
    expect(sent('UpdateFunctionConfigurationCommand')).toHaveLength(0);
  });

  it('unsettled Tags converge against the live tags', async () => {
    serve({ tags: { stale: 'x' } });
    await provider.update('F', 'f', TYPE, { ...BASE }, { ...BASE }, {
      unsettledProperties: new Set(['Tags']),
    });
    expect(sent('UntagResourceCommand').map((c) => c.input.TagKeys)).toEqual([['stale']]);
  });

  it('refuses before any write when the function cannot be read to converge', async () => {
    mockLambdaSend.mockImplementation(async () => {
      throw new Error('throttled');
    });
    await expect(
      provider.update('F', 'f', TYPE, { ...BASE, Timeout: 3 }, { ...BASE, Timeout: 3 }, {
        unsettledProperties: new Set(['Timeout']),
      })
    ).rejects.toThrow();
    expect(sent('UpdateFunctionConfigurationCommand')).toHaveLength(0);
  });

  it('unsettledInTransition: configuration keys while InProgress or Pending, none once settled', async () => {
    const names = new Set(['Timeout', 'Tags', 'ReservedConcurrentExecutions']);
    serve({ lastUpdateStatus: 'InProgress' });
    expect([...(await provider.unsettledInTransition('f', 'F', TYPE, names))]).toEqual(['Timeout']);
    serve({ state: 'Pending' });
    expect([...(await provider.unsettledInTransition('f', 'F', TYPE, names))]).toEqual(['Timeout']);
    serve({});
    expect([...(await provider.unsettledInTransition('f', 'F', TYPE, names))]).toEqual([]);
    mockLambdaSend.mockRejectedValue(new Error('throttled'));
    expect((await provider.unsettledInTransition('f', 'F', TYPE, names)).size).toBe(3);
  });
});
