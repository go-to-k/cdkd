import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateInternetGatewayCommand,
  CreateTagsCommand,
  DeleteTagsCommand,
} from '@aws-sdk/client-ec2';

// go-to-k/cdkd#3994: the EC2 Tags diff read a malformed side as empty, so a
// malformed DESIRED Tags (a rollback / drift --revert desired bag) untagged
// every recorded key. Every tag-bearing EC2 type shares one create-time
// `applyTags` and one update-time `applyTagDiff`; each type's create and
// update path carries its own refusal.

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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
      warn,
      error: vi.fn(),
    }),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

/** Every type whose create applies the CFn `Tags` list. */
const CREATE_TYPES = [
  'AWS::EC2::VPC',
  'AWS::EC2::Subnet',
  'AWS::EC2::InternetGateway',
  'AWS::EC2::EIP',
  'AWS::EC2::NatGateway',
  'AWS::EC2::RouteTable',
  'AWS::EC2::SecurityGroup',
  'AWS::EC2::Instance',
  'AWS::EC2::NetworkAcl',
];

/** Every type whose update diffs Tags: [type, physicalId, the id the tag calls target]. */
const UPDATE_TYPES: Array<[string, string, string]> = [
  ['AWS::EC2::VPC', 'vpc-1', 'vpc-1'],
  ['AWS::EC2::Subnet', 'subnet-1', 'subnet-1'],
  ['AWS::EC2::EIP', '203.0.113.1|eipalloc-1', 'eipalloc-1'],
  ['AWS::EC2::SecurityGroup', 'sg-1', 'sg-1'],
  ['AWS::EC2::Instance', 'i-1', 'i-1'],
];

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
}

function tagCalls(): Array<[string, unknown]> {
  return (
    commands().filter(
      (c) => c instanceof CreateTagsCommand || c instanceof DeleteTagsCommand
    ) as Array<CreateTagsCommand | DeleteTagsCommand>
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

describe('EC2Provider Tags (go-to-k/cdkd#3994)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof CreateInternetGatewayCommand
        ? { InternetGateway: { InternetGatewayId: 'igw-1' } }
        : {}
    );
    provider = new EC2Provider();
  });

  describe.each(CREATE_TYPES)('%s create', (type) => {
    it.each(PROVIDER_MALFORMED_DESIRED)(
      'refuses a desired %s before any call',
      async (_label, tags) => {
        const err = await refusal(() => provider.create('R', type, { Tags: tags }));
        expect(err.message).toContain(`Tags of ${type} R`);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );
  });

  describe.each(UPDATE_TYPES)('%s update', (type, physicalId, target) => {
    it.each(PROVIDER_MALFORMED_DESIRED)(
      'refuses a desired %s before any call',
      async (_label, tags) => {
        const err = await refusal(() =>
          provider.update('R', physicalId, type, { Tags: tags }, { Tags: RECORDED })
        );
        expect(err.message).toContain(`desired Tags of ${type} R`);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it.each(PROVIDER_MALFORMED_RECORDED)(
      'applies a recorded %s ADD-only: tags every desired key, untags nothing',
      async (_label, recorded) => {
        await provider.update('R', physicalId, type, { Tags: DESIRED }, { Tags: recorded });
        expect(tagCalls()).toEqual([
          ['CreateTagsCommand', { Resources: [target], Tags: DESIRED }],
        ]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
        // Names the LOGICAL id, never an ARN / URL / physical name.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${type} R is not`));
        expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
      }
    );

    it('diffs a valid pair into exact Create / Delete calls', async () => {
      await provider.update('R', physicalId, type, { Tags: DESIRED }, { Tags: RECORDED });
      expect(tagCalls()).toEqual([
        ['DeleteTagsCommand', { Resources: [target], Tags: [{ Key: 'drop' }] }],
        ['CreateTagsCommand', { Resources: [target], Tags: [{ Key: 'add', Value: '' }] }],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('never untags a recorded secret-derived key', async () => {
      await provider.update(
        'R',
        physicalId,
        type,
        { Tags: [] },
        { Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
      );
      expect(tagCalls()).toEqual([
        ['DeleteTagsCommand', { Resources: [target], Tags: [{ Key: 'keep' }, { Key: 'drop' }] }],
      ]);
    });

    it('warns about a recorded secret-derived key it cannot remove', async () => {
      await provider.update(
        'R',
        physicalId,
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

  it('creates an InternetGateway with the desired tags', async () => {
    await provider.create('G', 'AWS::EC2::InternetGateway', { Tags: DESIRED });
    expect(tagCalls()).toEqual([['CreateTagsCommand', { Resources: ['igw-1'], Tags: DESIRED }]]);
  });
});

// Each wired create applies the checked list through `applyTags` (a create
// that dropped it would stay green on the refusal cases alone).
describe('EC2Provider create applies the desired tags (go-to-k/cdkd#3994)', () => {
  const ID: Record<string, string> = {
    'AWS::EC2::VPC': 'vpc-1',
    'AWS::EC2::RouteTable': 'rtb-1',
    'AWS::EC2::SecurityGroup': 'sg-1',
    'AWS::EC2::Instance': 'i-1',
    'AWS::EC2::NetworkAcl': 'acl-1',
  };
  const PROPS: Record<string, Record<string, unknown>> = {
    'AWS::EC2::VPC': { CidrBlock: '10.0.0.0/16' },
    'AWS::EC2::RouteTable': { VpcId: 'vpc-1' },
    'AWS::EC2::SecurityGroup': { GroupDescription: 'd', VpcId: 'vpc-1' },
    'AWS::EC2::Instance': { ImageId: 'ami-1', InstanceType: 't3.micro' },
    'AWS::EC2::NetworkAcl': { VpcId: 'vpc-1' },
  };
  // One response carrying every shape these creates and their waits read.
  const RESPONSE = {
    Vpc: { VpcId: 'vpc-1', State: 'available', CidrBlock: '10.0.0.0/16' },
    Vpcs: [{ VpcId: 'vpc-1', State: 'available', CidrBlock: '10.0.0.0/16' }],
    RouteTable: { RouteTableId: 'rtb-1' },
    GroupId: 'sg-1',
    SecurityGroups: [{ GroupId: 'sg-1', IpPermissionsEgress: [] }],
    Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }],
    Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }] }],
    NetworkAcl: { NetworkAclId: 'acl-1' },
  };
  let provider: EC2Provider;
  const savedNoWait = process.env['CDKD_NO_WAIT'];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env['CDKD_NO_WAIT'] = 'true';
    mockSend.mockImplementation(async () => RESPONSE);
    provider = new EC2Provider();
  });

  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  it.each(Object.keys(ID))('%s', async (type) => {
    await provider.create('R', type, { ...PROPS[type], Tags: DESIRED });
    const created = (
      mockSend.mock.calls.map((c) => c[0] as unknown).filter((c) => c instanceof CreateTagsCommand) as CreateTagsCommand[]
    ).map((c) => c.input);
    expect(created).toContainEqual({ Resources: [ID[type]], Tags: DESIRED });
  });
});
