import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateWebACLCommand,
  GetWebACLCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-wafv2';

// go-to-k/cdkd#3994: the WAFv2 WebACL Tags diff read a malformed side as
// empty, so a malformed DESIRED Tags (a rollback / drift --revert desired bag)
// untagged every recorded key.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-wafv2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-wafv2');
  return {
    ...actual,
    WAFV2Client: vi.fn().mockImplementation(() => ({
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

import { WAFv2WebACLProvider } from '../../../src/provisioning/providers/wafv2-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::WAFv2::WebACL';
const ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123-def';
const BASE = {
  Scope: 'REGIONAL',
  DefaultAction: { Allow: {} },
  VisibilityConfig: {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: 'm',
  },
};
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
      (c) => c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    ) as Array<TagResourceCommand | UntagResourceCommand>
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

describe('WAFv2WebACLProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: WAFv2WebACLProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof GetWebACLCommand
        ? { LockToken: 'lt', WebACL: { ARN } }
        : cmd instanceof CreateWebACLCommand
          ? { Summary: { ARN, Id: 'abc-123-def' } }
          : {}
    );
    provider = new WAFv2WebACLProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('W', ARN, TYPE, { ...BASE, Tags: tags }, { ...BASE, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} W`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('W', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} W`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update(
        'W',
        ARN,
        TYPE,
        { ...BASE, Tags: DESIRED },
        { ...BASE, Tags: recorded }
      );
      expect(tagCalls()).toEqual([['TagResourceCommand', { ResourceARN: ARN, Tags: DESIRED }]]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} W is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('W', ARN, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    expect(tagCalls()).toEqual([
      ['UntagResourceCommand', { ResourceARN: ARN, TagKeys: ['drop'] }],
      ['TagResourceCommand', { ResourceARN: ARN, Tags: [{ Key: 'add', Value: '' }] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'W',
      ARN,
      TYPE,
      { ...BASE, Tags: [] },
      {
        ...BASE,
        Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED],
      }
    );
    expect(tagCalls()).toEqual([
      ['UntagResourceCommand', { ResourceARN: ARN, TagKeys: ['keep', 'drop'] }],
    ]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'W',
      ARN,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      {
        ...BASE,
        Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }],
      }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} W holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('W', TYPE, {
      ...BASE,
      Name: 'my-acl',
      Tags: DESIRED,
    });
    const create = commands().find((c) => c instanceof CreateWebACLCommand) as CreateWebACLCommand;
    expect(create.input.Tags).toEqual(DESIRED);
  });
});
