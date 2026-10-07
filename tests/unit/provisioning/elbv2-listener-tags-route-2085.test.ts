import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#2085: a listener carrying Tags (any CDK app with stack tags)
// was routed via Cloud Control because the SDK provider did not declare Tags,
// and that route leaves a removed ListenerAttributes key live in AWS. The SDK
// provider now owns the tagged listener: it resets the removed key and diffs
// the tags itself.

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-elastic-load-balancing-v2')>(
    '@aws-sdk/client-elastic-load-balancing-v2'
  );
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

import {
  AddTagsCommand,
  CreateListenerCommand,
  ModifyListenerAttributesCommand,
  ModifyListenerCommand,
  RemoveTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { findActionableSilentDrops } from '../../../src/provisioning/property-coverage.js';

const LISTENER = 'AWS::ElasticLoadBalancingV2::Listener';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/0123456789abcdef';
const LISTENER_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/0123456789abcdef/fedcba9876543210';

/** The listener the alb fixture synthesizes, with the stack's tags. */
const taggedListener = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  LoadBalancerArn: LB_ARN,
  Port: 80,
  Protocol: 'HTTP',
  DefaultActions: [{ Type: 'forward', TargetGroupArn: 'arn:tg' }],
  Tags: [
    { Key: 'Example', Value: 'alb' },
    { Key: 'Project', Value: 'cdkd' },
  ],
  ...extra,
});

const SERVER_HEADER_OFF = {
  ListenerAttributes: [{ Key: 'routing.http.response.server.enabled', Value: 'false' }],
};

const sentOf = <T>(cls: new (...args: never[]) => T): T[] =>
  mockSend.mock.calls.map(([c]) => c as unknown).filter((c): c is T => c instanceof cls);

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

describe('a tagged ALB listener stays on the SDK provider (go-to-k/cdkd#2085)', () => {
  it('Tags is no Cloud Control-routing silent drop for a listener', () => {
    expect(new ELBv2Provider().handledProperties.get(LISTENER)?.has('Tags')).toBe(true);
    expect(findActionableSilentDrops(LISTENER, taggedListener(SERVER_HEADER_OFF), new Set())).toEqual(
      []
    );
  });

  it('create sends the tags with CreateListener', async () => {
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof CreateListenerCommand ? { Listeners: [{ ListenerArn: LISTENER_ARN }] } : {}
    );
    await new ELBv2Provider().create('Listener', LISTENER, taggedListener());
    expect(sentOf(CreateListenerCommand)[0]!.input.Tags).toEqual([
      { Key: 'Example', Value: 'alb' },
      { Key: 'Project', Value: 'cdkd' },
    ]);
  });

  it('dropping ListenerAttributes from a tagged listener resets the server header to its default', async () => {
    await new ELBv2Provider().update(
      'Listener',
      LISTENER_ARN,
      LISTENER,
      taggedListener(),
      taggedListener(SERVER_HEADER_OFF)
    );
    expect(sentOf(ModifyListenerCommand)).toHaveLength(1);
    expect(sentOf(ModifyListenerAttributesCommand).map((c) => c.input.Attributes)).toEqual([
      [{ Key: 'routing.http.response.server.enabled', Value: 'true' }],
    ]);
    // Unchanged tags send no tag call.
    expect(sentOf(AddTagsCommand)).toHaveLength(0);
    expect(sentOf(RemoveTagsCommand)).toHaveLength(0);
  });

  it("the update diffs the listener's tags: a removed key is removed, a changed one re-added", async () => {
    await new ELBv2Provider().update(
      'Listener',
      LISTENER_ARN,
      LISTENER,
      taggedListener({ Tags: [{ Key: 'Project', Value: 'cdkd2' }] }),
      taggedListener()
    );
    expect(sentOf(RemoveTagsCommand).map((c) => c.input)).toEqual([
      { ResourceArns: [LISTENER_ARN], TagKeys: ['Example'] },
    ]);
    expect(sentOf(AddTagsCommand).map((c) => c.input)).toEqual([
      { ResourceArns: [LISTENER_ARN], Tags: [{ Key: 'Project', Value: 'cdkd2' }] },
    ]);
    expect(sentOf(ModifyListenerAttributesCommand)).toHaveLength(0);
  });
});
