import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AddTagsCommand,
  CreateListenerCommand,
  CreateTargetGroupCommand,
  DescribeTargetGroupsCommand,
  RemoveTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';

// go-to-k/cdkd#3994: the ELBv2 Tags diff read a malformed side as empty, so a
// malformed DESIRED Tags (a rollback / drift --revert desired bag) untagged
// every recorded key. Every ELBv2 type shares one Tags helper; each type's
// create and update path carries its own refusal.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:resource/issue3994/abc';
const TYPES = [
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::ElasticLoadBalancingV2::TargetGroup',
  'AWS::ElasticLoadBalancingV2::Listener',
] as const;
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
}

function tagCalls(): Array<[string, unknown]> {
  return (
    commands().filter(
      (c) => c instanceof AddTagsCommand || c instanceof RemoveTagsCommand
    ) as Array<AddTagsCommand | RemoveTagsCommand>
  ).map((c) => [c.constructor.name, c.input]);
}

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(isMarkedNonRetryable(err)).toBe(true);
  const msg = (err as Error).message;
  expect(msg).not.toContain(TAG_FIXTURE.NEEDLE);
  expect(msg).not.toContain('issue3994/tags');
  return err as Error;
}

describe('ELBv2Provider Tags (go-to-k/cdkd#3994)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof DescribeTargetGroupsCommand
        ? { TargetGroups: [{ TargetGroupArn: ARN }] }
        : cmd instanceof CreateListenerCommand
          ? { Listeners: [{ ListenerArn: ARN }] }
          : cmd instanceof CreateTargetGroupCommand
            ? { TargetGroups: [{ TargetGroupArn: ARN }] }
            : {}
    );
    provider = new ELBv2Provider();
  });

  describe.each(TYPES)('%s', (type) => {
    it.each(PROVIDER_MALFORMED_DESIRED)(
      'refuses a desired %s on update before any call',
      async (_label, tags) => {
        const err = await refusal(() =>
          provider.update('R', ARN, type, { Tags: tags }, { Tags: RECORDED })
        );
        expect(err.message).toContain(`desired Tags of ${type} R`);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it.each(PROVIDER_MALFORMED_DESIRED)(
      'refuses a desired %s on create before any call',
      async (_label, tags) => {
        const err = await refusal(() => provider.create('R', type, { Tags: tags }));
        expect(err.message).toContain(`Tags of ${type} R`);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it.each(PROVIDER_MALFORMED_RECORDED)(
      'applies a recorded %s ADD-only: tags every desired key, untags nothing',
      async (_label, recorded) => {
        await provider.update('R', ARN, type, { Tags: DESIRED }, { Tags: recorded });
        expect(tagCalls()).toEqual([['AddTagsCommand', { ResourceArns: [ARN], Tags: DESIRED }]]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
        // Names the LOGICAL id, never an ARN / URL / physical name.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${type} R is not`));
        expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
      }
    );

    it('diffs a valid pair into exact Add / Remove calls', async () => {
      await provider.update('R', ARN, type, { Tags: DESIRED }, { Tags: RECORDED });
      expect(tagCalls()).toEqual([
        ['RemoveTagsCommand', { ResourceArns: [ARN], TagKeys: ['drop'] }],
        ['AddTagsCommand', { ResourceArns: [ARN], Tags: [{ Key: 'add', Value: '' }] }],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('never untags a recorded secret-derived key', async () => {
      await provider.update(
        'R',
        ARN,
        type,
        { Tags: [] },
        { Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
      );
      expect(tagCalls()).toEqual([
        ['RemoveTagsCommand', { ResourceArns: [ARN], TagKeys: ['keep', 'drop'] }],
      ]);
    });

    it('warns about a recorded secret-derived key it cannot remove', async () => {
      await provider.update(
        'R',
        ARN,
        type,
        { Tags: [{ Key: 'keep', Value: 'same' }] },
        { Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
      );
      const warned = warn.mock.calls.map((c) => String(c[0]));
      expect(warned).toContainEqual(
        expect.stringContaining(`${type} R holds 1 key(s) derived from a dynamic reference`)
      );
      expect(warned.join('\n')).not.toContain('issue3994/tags');
      const sent = [mockSend].flatMap((m) =>
        m.mock.calls.map((c) => (c[0] as object).constructor.name)
      );
      expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
    });
  });

  it('creates a Listener with the desired tags', async () => {
    await provider.create('L', 'AWS::ElasticLoadBalancingV2::Listener', {
      LoadBalancerArn: ARN,
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [{ Type: 'fixed-response' }],
      Tags: DESIRED,
    });
    const create = commands().find(
      (c) => c instanceof CreateListenerCommand
    ) as CreateListenerCommand;
    expect(create.input.Tags).toEqual(DESIRED);
  });

  it('creates a TargetGroup with the desired tags', async () => {
    await provider.create('T', 'AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 80,
      Protocol: 'HTTP',
      VpcId: 'vpc-1',
      Tags: DESIRED,
    });
    const create = commands().find(
      (c) => c instanceof CreateTargetGroupCommand
    ) as CreateTargetGroupCommand;
    expect(create.input.Tags).toEqual(DESIRED);
  });
});
