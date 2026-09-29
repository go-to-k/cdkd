import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3994: the Cloud Map namespace Tags diff read a malformed side
// as empty or short (`(newTags ?? []).map(t => t.Key).filter(k => !!k)`), so
// a malformed DESIRED Tags (a rollback / drift --revert desired bag) untagged
// every recorded key.

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-servicediscovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-servicediscovery')>();
  return {
    ...actual,
    ServiceDiscoveryClient: vi.fn().mockImplementation(() => ({
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
  return { getLogger: () => ({ child: () => childLogger }) };
});

import {
  CreateHttpNamespaceCommand,
  CreatePrivateDnsNamespaceCommand,
  CreatePublicDnsNamespaceCommand,
  CreateServiceCommand,
  GetNamespaceCommand,
  GetServiceCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-servicediscovery';
import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const NS_ID = 'ns-abc123';
const NS_ARN = `arn:aws:servicediscovery:us-east-1:123456789012:namespace/${NS_ID}`;

interface Case {
  type: string;
  base: Record<string, unknown>;
  createCommand:
    | typeof CreatePrivateDnsNamespaceCommand
    | typeof CreateHttpNamespaceCommand
    | typeof CreatePublicDnsNamespaceCommand;
}

const CASES: Array<[string, Case]> = [
  [
    'PrivateDnsNamespace',
    {
      type: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
      base: { Name: 'svc.local', Vpc: 'vpc-123' },
      createCommand: CreatePrivateDnsNamespaceCommand,
    },
  ],
  [
    'HttpNamespace',
    {
      type: 'AWS::ServiceDiscovery::HttpNamespace',
      base: { Name: 'svc-http' },
      createCommand: CreateHttpNamespaceCommand,
    },
  ],
  [
    'PublicDnsNamespace',
    {
      type: 'AWS::ServiceDiscovery::PublicDnsNamespace',
      base: { Name: 'example.com' },
      createCommand: CreatePublicDnsNamespaceCommand,
    },
  ],
];

const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

function tagCalls(): Array<TagResourceCommand | UntagResourceCommand> {
  return mockSend.mock.calls
    .map((c) => c[0] as unknown)
    .filter(
      (c): c is TagResourceCommand | UntagResourceCommand =>
        c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    );
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

describe.each(CASES)('ServiceDiscoveryProvider %s Tags (go-to-k/cdkd#3994)', (_name, c) => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetNamespaceCommand) return { Namespace: { Arn: NS_ARN } };
      // Create*Namespace: capture the input, then fail the create so the
      // test needs no operation poll.
      if (cmd instanceof c.createCommand) throw new Error('create stopped by the test');
      return {};
    });
    provider = new ServiceDiscoveryProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('N', NS_ID, c.type, { ...c.base, Description: 'new', Tags: tags }, {
          ...c.base,
          Tags: RECORDED,
        })
      );
      expect(err.message).toContain(`desired Tags of ${c.type} N`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('N', c.type, { ...c.base, Tags: tags }));
      expect(err.message).toContain(`Tags of ${c.type} N`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('N', NS_ID, c.type, { ...c.base, Tags: DESIRED }, {
        ...c.base,
        Tags: recorded,
      });
      expect(tagCalls().map((x) => [x.constructor.name, x.input])).toEqual([
        [
          'TagResourceCommand',
          {
            ResourceARN: NS_ARN,
            Tags: [
              { Key: 'keep', Value: 'same' },
              { Key: 'add', Value: '' },
            ],
          },
        ],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${c.type} N is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('N', NS_ID, c.type, { ...c.base, Tags: DESIRED }, {
      ...c.base,
      Tags: RECORDED,
    });
    expect(tagCalls().map((x) => [x.constructor.name, x.input])).toEqual([
      ['UntagResourceCommand', { ResourceARN: NS_ARN, TagKeys: ['drop'] }],
      ['TagResourceCommand', { ResourceARN: NS_ARN, Tags: [{ Key: 'add', Value: '' }] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update('N', NS_ID, c.type, { ...c.base, Tags: [] }, {
      ...c.base,
      Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED],
    });
    const untag = tagCalls().filter((x) => x instanceof UntagResourceCommand);
    expect(untag.map((x) => x.input.TagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'N',
      NS_ID,
      c.type,
      { ...c.base, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...c.base, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    expect(tagCalls()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`${c.type} N holds 1 key(s) derived from a dynamic reference`)
    );
  });

  it('creates with the desired tags', async () => {
    await expect(provider.create('N', c.type, { ...c.base, Tags: DESIRED })).rejects.toThrow(
      'create stopped by the test'
    );
    const create = mockSend.mock.calls
      .map((x) => x[0] as unknown)
      .find((x) => x instanceof c.createCommand) as
      | CreatePrivateDnsNamespaceCommand
      | CreateHttpNamespaceCommand
      | CreatePublicDnsNamespaceCommand
      | undefined;
    expect(create?.input.Tags).toEqual(DESIRED);
  });
});

// AWS::ServiceDiscovery::Service declared `Tags` handled, sent it on create,
// and ignored it on update: a Tags-only change was silently dropped.
describe('ServiceDiscoveryProvider Service Tags update (go-to-k/cdkd#3994)', () => {
  const TYPE = 'AWS::ServiceDiscovery::Service';
  const SVC_ID = 'srv-abc123';
  const SVC_ARN = `arn:aws:servicediscovery:us-east-1:123456789012:service/${SVC_ID}`;
  const BASE = { Name: 'svc', NamespaceId: NS_ID };
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof GetServiceCommand ? { Service: { Id: SVC_ID, Arn: SVC_ARN } } : {}
    );
    provider = new ServiceDiscoveryProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('S', SVC_ID, TYPE, { ...BASE, Tags: tags }, { ...BASE, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} S`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('applies a Tags-only change with exact Untag / Tag calls', async () => {
    await provider.update('S', SVC_ID, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    expect(tagCalls().map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagResourceCommand', { ResourceARN: SVC_ARN, TagKeys: ['drop'] }],
      ['TagResourceCommand', { ResourceARN: SVC_ARN, Tags: [{ Key: 'add', Value: '' }] }],
    ]);
  });

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only',
    async (_label, recorded) => {
      await provider.update('S', SVC_ID, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(tagCalls().map((c) => [c.constructor.name, c.input])).toEqual([
        ['TagResourceCommand', { ResourceARN: SVC_ARN, Tags: DESIRED }],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} S is not`));
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('S', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} S`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('creates with the desired tags', async () => {
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof CreateServiceCommand ? { Service: { Id: SVC_ID, Arn: SVC_ARN } } : {}
    );
    await provider.create('S', TYPE, { ...BASE, Tags: DESIRED });
    const create = mockSend.mock.calls
      .map((c) => c[0] as unknown)
      .find((c): c is CreateServiceCommand => c instanceof CreateServiceCommand);
    expect(create?.input.Tags).toEqual(DESIRED);
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'S',
      SVC_ID,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    expect(tagCalls().map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagResourceCommand', { ResourceARN: SVC_ARN, TagKeys: ['keep', 'drop'] }],
    ]);
  });

  it('throws when GetService returns no ARN, sending no tag call', async () => {
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof GetServiceCommand ? { Service: { Id: SVC_ID } } : {}
    );
    await expect(
      provider.update('S\nX', SVC_ID, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED })
    ).rejects.toThrow(/^Could not resolve the ARN of service discovery service S X; its Tags were not updated$/);
    expect(tagCalls()).toEqual([]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'S',
      SVC_ID,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    expect(tagCalls()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`${TYPE} S holds 1 key(s) derived from a dynamic reference`)
    );
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('issue3994/tags');
  });

  it('warns about an unreadable record even when the desired side is empty', async () => {
    await provider.update('S', SVC_ID, TYPE, { ...BASE, Tags: [] }, { ...BASE, Tags: TAG_FIXTURE.NEEDLE });
    expect(tagCalls()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
  });

  it('makes no call when the tag set is unchanged', async () => {
    await provider.update('S', SVC_ID, TYPE, { ...BASE, Tags: RECORDED }, { ...BASE, Tags: [...RECORDED].reverse() });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
