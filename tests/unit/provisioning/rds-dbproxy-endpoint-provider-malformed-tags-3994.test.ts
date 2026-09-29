import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AddTagsToResourceCommand,
  CreateDBProxyEndpointCommand,
  DescribeDBProxyEndpointsCommand,
  RemoveTagsFromResourceCommand,
} from '@aws-sdk/client-rds';

// go-to-k/cdkd#3994: the RDS DBProxyEndpoint Tags diff read a malformed side as empty
// or short, so a malformed DESIRED Tags (a rollback / drift --revert desired
// bag) untagged every recorded key.

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-rds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-rds')>();
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
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

import { RDSDBProxyEndpointProvider } from '../../../src/provisioning/providers/rds-dbproxy-endpoint-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

// CFn declares this type's tag `Value` optional, so an omitted Value is
// well-formed here (read as ''); a null Value stands in as the malformed row.
const NULL_VALUE: [string, unknown] = ['an entry with a null Value', [{ Key: 'env', Value: null }]];
const MALFORMED_DESIRED = [
  ...PROVIDER_MALFORMED_DESIRED.filter(([label]) => label !== 'an entry with no Value'),
  NULL_VALUE,
];
const MALFORMED_RECORDED = [
  ...PROVIDER_MALFORMED_RECORDED.filter(([label]) => label !== 'an entry with no Value'),
  NULL_VALUE,
];
const TYPE = 'AWS::RDS::DBProxyEndpoint';
const EP_NAME = 'MyEndpoint';
const EP_ARN = 'arn:aws:rds:us-east-1:123456789012:db-proxy-endpoint:prx-EP-aaa';
const BASE = {
  DBProxyEndpointName: EP_NAME,
  DBProxyName: 'MyProxy',
  VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
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

describe('RDSDBProxyEndpointProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: RDSDBProxyEndpointProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof DescribeDBProxyEndpointsCommand
        ? {
            DBProxyEndpoints: [
              {
                DBProxyEndpointName: EP_NAME,
                DBProxyEndpointArn: EP_ARN,
                Status: 'available',
                Endpoint: 'myendpoint.endpoint.proxy-abc.us-east-1.rds.amazonaws.com',
                VpcId: 'vpc-1',
              },
            ],
          }
        : {}
    );
    provider = new RDSDBProxyEndpointProvider();
  });

  it.each(MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update(
          'P',
          EP_NAME,
          TYPE,
          { ...BASE, VpcSecurityGroupIds: ['sg-new'], Tags: tags },
          { ...BASE, Tags: RECORDED }
        )
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} P`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('P', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} P`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('P', EP_NAME, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(commands().some((c) => c instanceof RemoveTagsFromResourceCommand)).toBe(false);
      const tag = commands().filter(
        (c) => c instanceof AddTagsToResourceCommand
      ) as AddTagsToResourceCommand[];
      expect(tag.map((c) => c.input)).toEqual([{ ResourceName: EP_ARN, Tags: DESIRED }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} P is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('P', EP_NAME, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    const tagCalls = commands().filter(
      (c) => c instanceof AddTagsToResourceCommand || c instanceof RemoveTagsFromResourceCommand
    ) as Array<AddTagsToResourceCommand | RemoveTagsFromResourceCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['RemoveTagsFromResourceCommand', { ResourceName: EP_ARN, TagKeys: ['drop'] }],
      ['AddTagsToResourceCommand', { ResourceName: EP_ARN, Tags: [{ Key: 'add', Value: '' }] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'P',
      EP_NAME,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = commands().filter(
      (c) => c instanceof RemoveTagsFromResourceCommand
    ) as RemoveTagsFromResourceCommand[];
    expect(untag.map((c) => c.input.TagKeys)).toEqual([['keep', 'drop']]);
  });

  it('passes an omitted Value as the empty string on create and update', async () => {
    await provider.create('P', TYPE, { ...BASE, Tags: [{ Key: 'env' }] });
    const create = commands().find((c) => c instanceof CreateDBProxyEndpointCommand) as CreateDBProxyEndpointCommand;
    expect(create.input.Tags).toEqual([{ Key: 'env', Value: '' }]);
    mockSend.mockClear();
    await provider.update(
      'P',
      EP_NAME,
      TYPE,
      { ...BASE, Tags: [{ Key: 'env' }] },
      { ...BASE, Tags: [{ Key: 'env', Value: '' }] }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_RECORDED)(
    'warns about a recorded %s with an empty desired side, making no call',
    async (_label, recorded) => {
      await provider.update('P', EP_NAME, TYPE, { ...BASE, Tags: [] }, { ...BASE, Tags: recorded });
      expect(mockSend).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
    }
  );

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'P',
      EP_NAME,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    // Warned before the short-circuit: no ARN Describe, no write.
    expect(mockSend).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} P holds 1 key(s) derived from a dynamic reference`));
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('issue3994/tags');
  });

  it('makes no call when the tag set is unchanged', async () => {
    await provider.update('P', EP_NAME, TYPE, { ...BASE, Tags: RECORDED }, { ...BASE, Tags: RECORDED });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('creates with the desired tags', async () => {
    await provider.create('P', TYPE, { ...BASE, Tags: DESIRED });
    const create = commands().find((c) => c instanceof CreateDBProxyEndpointCommand) as CreateDBProxyEndpointCommand;
    expect(create.input.Tags).toEqual(DESIRED);
  });

  it('creates with no Tags field when Tags is absent', async () => {
    await provider.create('P', TYPE, { ...BASE });
    const create = commands().find((c) => c instanceof CreateDBProxyEndpointCommand) as CreateDBProxyEndpointCommand;
    expect(create.input.Tags).toBeUndefined();
  });
});
