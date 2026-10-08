/**
 * Issue #2080 (Plan B, EC2): `CreateVpc`, `CreateSubnet`,
 * `CreateInternetGateway`, `AllocateAddress` and `CreateSecurityGroup` mint
 * their id and carry no idempotency token. A 5xx whose request EC2 completed
 * used to be replayed -- inside one `send` by the SDK, invisibly, or by the
 * engine's retry. The creates now go through a client that refuses the SDK's
 * 5xx retry. A replayed VPC, internet gateway or Elastic IP is a second
 * resource, which the next attempt REPORTS before creating again; a replayed
 * subnet or security group collides instead, so exactly one survives.
 * Detection only: nothing is adopted and nothing is deleted.
 *
 * The fakes count RESOURCES, not calls (acceptance item 2), and every retry
 * advances the clock (acceptance item 3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

interface FakeClientConfig {
  region: () => Promise<unknown>;
  retryStrategy?: () => Promise<unknown>;
}

const { mockSend, warnSpy, debugSpy, sentVia, ctorOptions, baseStrategy, shared } = vi.hoisted(
  () => ({
    mockSend: vi.fn(),
    warnSpy: vi.fn(),
    debugSpy: vi.fn(),
    /** `[command name, which client, that client's config]` per send. */
    sentVia: [] as Array<[string, 'shared' | 'create', FakeClientConfig]>,
    /** The options of every `EC2Client` the code under test constructed. */
    ctorOptions: [] as Array<Record<string, unknown>>,
    /** A stand-in for the SDK's resolved V2 retry strategy. */
    baseStrategy: {
      acquireInitialRetryToken: async (_scope: string) => 'token',
      refreshRetryTokenForRetry: async (_token: unknown, _info: { error?: unknown }) =>
        'retry-token',
      recordSuccess: (_token: unknown) => undefined,
    },
    /** The shared client `getAwsClients().ec2` returns; built in `beforeEach`. */
    shared: { client: undefined as unknown, region: vi.fn() },
  })
);

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ec2')>();
  /**
   * A REAL class, so the provider's `instanceof EC2Client` sees the shared
   * client as production-shaped and builds its dedicated create client.
   */
  class FakeEC2Client {
    readonly config: FakeClientConfig;
    kind: 'shared' | 'create' = 'create';
    constructor(options: Record<string, unknown>) {
      ctorOptions.push(options);
      this.config = {
        region: () => Promise.resolve(options['region']),
        retryStrategy: async (): Promise<unknown> => baseStrategy,
      };
    }
    send(command: { constructor: { name: string } }): Promise<unknown> {
      sentVia.push([command.constructor.name, this.kind, this.config]);
      return mockSend(command) as Promise<unknown>;
    }
    destroy(): void {}
  }
  return { ...actual, EC2Client: FakeEC2Client };
});

vi.mock('../../../src/utils/ambient-client-defaults.js', () => ({
  /** A sentinel, so the create client is shown to carry the ambient identity. */
  ambientClientDefaults: () => ({ credentials: { accessKeyId: 'AKIDAMBIENT' } }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ ec2: shared.client }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { EC2Client } from '@aws-sdk/client-ec2';
import {
  EC2Provider,
  resetEc2CreateRetryStateForTests,
} from '../../../src/provisioning/providers/ec2-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  hasReplayMayCollide,
  isNameCollisionErrorFrom,
} from '../../../src/deployment/retryable-errors.js';

/** EC2's 500 shape (`isTransientServerError` / `isAmbiguousOutcomeError`, issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('We encountered an internal error. Please try again.'), {
    name: 'InternalError',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

/**
 * EC2's throttle, identified BY NAME on a 503: only the name exemption keeps
 * it from arming the latch (the status alone reads as ambiguous).
 */
const throttled = (): Error =>
  Object.assign(new Error('Request limit exceeded.'), {
    name: 'RequestLimitExceeded',
    $fault: 'client',
    $metadata: { httpStatusCode: 503 },
  });

/** A definite refusal: EC2 did nothing. */
const definite4xx = (): Error =>
  Object.assign(new Error('Value (10.0.0.0/33) for parameter cidrBlock is invalid.'), {
    name: 'InvalidParameterValue',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });

/** Advance the fake clock on every backoff (issue #2080 acceptance item 3). */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

interface Tag {
  Key: string;
  Value: string;
}
interface FakeVpc {
  VpcId: string;
  CidrBlock: string;
  IsDefault: boolean;
  Tags: Tag[];
}
interface FakeSubnet {
  SubnetId: string;
  VpcId: string;
  CidrBlock: string;
  AvailabilityZone: string;
  Tags: Tag[];
}
interface FakeIgw {
  InternetGatewayId: string;
  Attachments: Array<{ VpcId: string }>;
  Tags: Tag[];
}
interface FakeAddress {
  AllocationId: string;
  PublicIp: string;
  Domain: string;
  AssociationId?: string;
  NetworkBorderGroup?: string;
  PublicIpv4Pool?: string;
  Tags: Tag[];
}
interface FakeSg {
  GroupId: string;
  GroupName: string;
  VpcId: string;
}

/** Host-bit-cleared, as EC2 stores a CIDR (enough of it for these cases). */
const canonical = (cidr: string): string => {
  const [ip, len] = cidr.split('/');
  const bits = Number(len);
  const n = ip!.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const masked = bits === 0 ? 0 : (n & (~0 << (32 - bits))) >>> 0;
  return `${[24, 16, 8, 0].map((s) => (masked >>> s) & 255).join('.')}/${bits}`;
};

/** A fake EC2. The arrays count RESOURCES, not calls (issue #2080 acceptance item 2). */
class FakeEc2 {
  readonly vpcs: FakeVpc[] = [];
  readonly subnets: FakeSubnet[] = [];
  readonly igws: FakeIgw[] = [];
  readonly addresses: FakeAddress[] = [];
  readonly sgs: FakeSg[] = [];
  readonly calls: string[] = [];
  /** The orphan-lookup `Describe*` calls only: a create's own read-back names its ids. */
  readonly lookups: string[] = [];
  readonly failNext = new Map<string, Error[]>();
  /** The next create makes its resource, THEN throws this (a lost response). */
  loseNextCreateResponse: Error | undefined;
  /** Items per `Describe*` page. */
  pageSize = 1000;
  /** Runs on every `Describe*` lookup call, to stage what the NEXT create does. */
  onList: (() => void) | undefined;
  private nextId = 1;

  private id(prefix: string): string {
    return `${prefix}-${String(this.nextId++).padStart(3, '0')}`;
  }

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const input = command.input;
    if (
      name.startsWith('Describe') &&
      input['VpcIds'] === undefined &&
      input['SubnetIds'] === undefined &&
      name !== 'DescribeSecurityGroupsCommand'
    ) {
      this.lookups.push(name);
    }
    const queued = this.failNext.get(name);
    if (queued && queued.length > 0) throw queued.shift();
    switch (name) {
      case 'CreateVpcCommand': {
        const vpc: FakeVpc = {
          VpcId: this.id('vpc'),
          CidrBlock: canonical(input['CidrBlock'] as string),
          IsDefault: false,
          Tags: [],
        };
        this.vpcs.push(vpc);
        return this.answer({ Vpc: { VpcId: vpc.VpcId } });
      }
      case 'CreateSubnetCommand': {
        const cidr = canonical(input['CidrBlock'] as string);
        const vpcId = input['VpcId'] as string;
        if (this.subnets.some((s) => s.VpcId === vpcId && s.CidrBlock === cidr)) {
          throw Object.assign(
            new Error(`The CIDR '${cidr}' conflicts with another subnet`),
            { name: 'InvalidSubnet.Conflict', $fault: 'client', $metadata: { httpStatusCode: 400 } }
          );
        }
        const subnet: FakeSubnet = {
          SubnetId: this.id('subnet'),
          VpcId: vpcId,
          CidrBlock: cidr,
          AvailabilityZone: 'ap-southeast-2a',
          Tags: [],
        };
        this.subnets.push(subnet);
        return this.answer({
          Subnet: { SubnetId: subnet.SubnetId, AvailabilityZone: subnet.AvailabilityZone },
        });
      }
      case 'CreateInternetGatewayCommand': {
        const igw: FakeIgw = { InternetGatewayId: this.id('igw'), Attachments: [], Tags: [] };
        this.igws.push(igw);
        return this.answer({ InternetGateway: { InternetGatewayId: igw.InternetGatewayId } });
      }
      case 'AllocateAddressCommand': {
        const address: FakeAddress = {
          AllocationId: this.id('eipalloc'),
          PublicIp: `203.0.113.${this.nextId}`,
          Domain: (input['Domain'] as string | undefined) ?? 'vpc',
          // Real EC2 reports a border group for every address, the region's
          // own when the request named none.
          NetworkBorderGroup:
            (input['NetworkBorderGroup'] as string | undefined) ?? 'ap-southeast-2',
          // ...and a pool: `amazon` for an Amazon-provided address.
          PublicIpv4Pool: (input['PublicIpv4Pool'] as string | undefined) ?? 'amazon',
          Tags: [],
        };
        this.addresses.push(address);
        return this.answer({ AllocationId: address.AllocationId, PublicIp: address.PublicIp });
      }
      case 'CreateSecurityGroupCommand': {
        const groupName = input['GroupName'] as string;
        const vpcId = input['VpcId'] as string;
        if (this.sgs.some((g) => g.VpcId === vpcId && g.GroupName === groupName)) {
          throw Object.assign(
            new Error(`The security group '${groupName}' already exists for VPC '${vpcId}'`),
            { name: 'InvalidGroup.Duplicate', $fault: 'client', $metadata: { httpStatusCode: 400 } }
          );
        }
        const sg: FakeSg = { GroupId: this.id('sg'), GroupName: groupName, VpcId: vpcId };
        this.sgs.push(sg);
        return this.answer({ GroupId: sg.GroupId });
      }
      case 'CreateTagsCommand': {
        const tags = input['Tags'] as Tag[];
        for (const id of input['Resources'] as string[]) {
          const target =
            this.vpcs.find((v) => v.VpcId === id) ??
            this.subnets.find((s) => s.SubnetId === id) ??
            this.igws.find((g) => g.InternetGatewayId === id) ??
            this.addresses.find((a) => a.AllocationId === id);
          target?.Tags.push(...tags);
        }
        return {};
      }
      case 'DescribeVpcsCommand':
        this.onList?.();
        return this.page(this.vpcs, 'Vpcs', input['NextToken']);
      case 'DescribeSubnetsCommand': {
        this.onList?.();
        const filter = (input['Filters'] as Array<{ Name: string; Values: string[] }>)[0]!;
        expect(filter.Name).toBe('vpc-id');
        return this.page(
          this.subnets.filter((s) => filter.Values.includes(s.VpcId)),
          'Subnets',
          input['NextToken']
        );
      }
      case 'DescribeInternetGatewaysCommand':
        this.onList?.();
        return this.page(this.igws, 'InternetGateways', input['NextToken']);
      case 'DescribeAddressesCommand':
        this.onList?.();
        return { Addresses: this.addresses.map((a) => ({ ...a, Tags: [...a.Tags] })) };
      case 'DescribeSecurityGroupsCommand':
        return { SecurityGroups: [{ GroupId: 'sg-default' }] };
      default:
        return {};
    }
  };

  private answer<T>(response: T): T {
    if (this.loseNextCreateResponse) {
      const error = this.loseNextCreateResponse;
      this.loseNextCreateResponse = undefined;
      throw error;
    }
    return response;
  }

  private page<T>(all: T[], key: string, token: unknown): Record<string, unknown> {
    const start = token === undefined ? 0 : Number(token);
    const end = start + this.pageSize;
    return {
      [key]: all.slice(start, end).map((item) => structuredClone(item)),
      ...(end < all.length && { NextToken: String(end) }),
    };
  }

  lookupCount(name: string): number {
    return this.lookups.filter((c) => c === name).length;
  }
}

const VPC_PROPS = { CidrBlock: '10.0.0.0/16', Tags: [{ Key: 'Name', Value: 'app' }] };
const SUBNET_PROPS = {
  VpcId: 'vpc-shared',
  CidrBlock: '10.0.1.0/24',
  Tags: [{ Key: 'Name', Value: 'app-a' }],
};
const IGW_PROPS = { Tags: [{ Key: 'Name', Value: 'app' }] };
const EIP_PROPS = { Domain: 'vpc', Tags: [{ Key: 'Name', Value: 'app' }] };
const SG_PROPS = { GroupDescription: 'app', VpcId: 'vpc-shared' };

describe('EC2Provider tokenless create retry safety (issue #2080 Plan B)', () => {
  let provider: EC2Provider;
  let aws: FakeEc2;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T00:00:00Z'));
    resetEc2CreateRetryStateForTests();
    aws = new FakeEc2();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    warnSpy.mockReset();
    debugSpy.mockReset();
    sentVia.length = 0;
    ctorOptions.length = 0;
    shared.region.mockReset();
    // Not the ambient default, so a create client built from the ambient
    // region instead of the shared client's is told apart.
    shared.region.mockResolvedValue('ap-southeast-2');
    const client = new EC2Client({}) as unknown as { kind: string; config: FakeClientConfig };
    client.kind = 'shared';
    client.config.region = () => shared.region() as Promise<unknown>;
    shared.client = client;
    ctorOptions.length = 0;
    provider = new EC2Provider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createWithRetry = (
    type: string,
    props: Record<string, unknown>,
    logicalId = 'Res',
    maskSecrets?: (text: string) => string
  ) =>
    withRetry(
      () => provider.create(logicalId, type, props, maskSecrets ? { maskSecrets } : undefined),
      logicalId,
      { sleep: advancingSleep }
    );

  const warnLines = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));
  const reportsFor = (action: string): string[] =>
    warnLines().filter((l) => l.includes(`earlier ${action} attempt`));
  const reportFor = (action: string): string | undefined => reportsFor(action)[0];

  describe('CreateVpc (a replay is a second VPC: reported, not prevented)', () => {
    it('names the VPC a lost response created, and neither adopts nor deletes it', async () => {
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry('AWS::EC2::VPC', VPC_PROPS);

      expect(aws.vpcs.map((v) => v.VpcId)).toEqual(['vpc-001', 'vpc-002']);
      expect(result.physicalId).toBe('vpc-002');
      expect(aws.calls).not.toContain('DeleteVpcCommand');
      const line = reportFor('CreateVpc');
      expect(line).toContain('vpc-001');
      expect(line).not.toContain('vpc-002');
      expect(line).toContain('aws ec2 describe-vpcs --vpc-ids vpc-001 --region ap-southeast-2');
      expect(line).not.toContain('delete-vpc');
      expect(line).toContain('EC2 may have created a VPC with CIDR 10.0.0.0/16');
      expect(line).toContain('EC2 reports no creation time');
      expect(line).toContain('does not adopt or delete');
      // The shared report's default next step, on every type but the subnet.
      expect(line).toContain('Creating a new one now.');
    });

    it('does not report a VPC this process recorded, a tagged one, another CIDR or a default VPC', async () => {
      const earlier = await provider.create('Other', 'AWS::EC2::VPC', { CidrBlock: '10.0.0.0/16' });
      aws.vpcs.push(
        { VpcId: 'vpc-tagged', CidrBlock: '10.0.0.0/16', IsDefault: false, Tags: [{ Key: 'a', Value: 'b' }] },
        { VpcId: 'vpc-othercidr', CidrBlock: '10.1.0.0/16', IsDefault: false, Tags: [] },
        { VpcId: 'vpc-default', CidrBlock: '10.0.0.0/16', IsDefault: true, Tags: [] }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::EC2::VPC', VPC_PROPS);

      const line = reportFor('CreateVpc')!;
      expect(line).toContain('1 untagged VPC(s) match');
      expect(line).not.toContain(earlier.physicalId);
      for (const id of ['vpc-tagged', 'vpc-othercidr', 'vpc-default']) {
        expect(line).not.toContain(id);
      }
    });

    it('matches a CIDR EC2 stored host-bit-cleared against the template spelling', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::EC2::VPC', { CidrBlock: '10.0.5.0/16' });

      expect(aws.vpcs[0]!.CidrBlock).toBe('10.0.0.0/16');
      expect(reportFor('CreateVpc')).toContain('vpc-001');
    });

    it('follows DescribeVpcs pagination to a candidate on a later page', async () => {
      aws.pageSize = 1;
      aws.vpcs.push(
        { VpcId: 'vpc-a', CidrBlock: '10.9.0.0/16', IsDefault: false, Tags: [] },
        { VpcId: 'vpc-b', CidrBlock: '10.8.0.0/16', IsDefault: false, Tags: [] }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::EC2::VPC', VPC_PROPS);

      // The orphan is third in the listing: one VPC per page.
      expect(aws.lookupCount('DescribeVpcsCommand')).toBe(3);
      expect(reportFor('CreateVpc')).toContain('vpc-001');
    });

    it('two ambiguous attempts in a row: the second report names BOTH orphans', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.loseNextCreateResponse = transient500();
        aws.onList = undefined;
      };

      const result = await createWithRetry('AWS::EC2::VPC', VPC_PROPS);

      expect(result.physicalId).toBe('vpc-003');
      const lines = reportsFor('CreateVpc');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('vpc-001');
      expect(lines[1]).toContain('vpc-002');
      expect(lines[1]).toContain('at 2026-10-04T23:59:55.000Z');
    });

    it('a throttled CreateVpc triggers no lookup', async () => {
      aws.failNext.set('CreateVpcCommand', [throttled()]);

      await createWithRetry('AWS::EC2::VPC', VPC_PROPS);

      expect(aws.lookupCount('DescribeVpcsCommand')).toBe(0);
      expect(aws.vpcs).toHaveLength(1);
    });

    it('a DEFINITE CreateVpc failure (a 4xx) triggers no lookup', async () => {
      aws.failNext.set('CreateVpcCommand', [definite4xx()]);

      await expect(createWithRetry('AWS::EC2::VPC', VPC_PROPS)).rejects.toThrow();
      await createWithRetry('AWS::EC2::VPC', VPC_PROPS);

      expect(aws.lookupCount('DescribeVpcsCommand')).toBe(0);
    });

    it('a failed DescribeVpcs warns that it could not look and lets the create proceed', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.failNext.set('DescribeVpcsCommand', [definite4xx()]);

      const result = await createWithRetry('AWS::EC2::VPC', VPC_PROPS);

      expect(result.physicalId).toBe('vpc-002');
      expect(reportFor('CreateVpc')).toContain('cdkd could not look for it (DescribeVpcs');
    });

    it('masks a secret-derived CIDR as a WHOLE value', async () => {
      aws.loseNextCreateResponse = transient500();
      const mask = (text: string): string => text.split('10.0.0.0/16').join('***');

      await createWithRetry('AWS::EC2::VPC', VPC_PROPS, 'Res', mask);

      const line = reportFor('CreateVpc')!;
      expect(line).toContain('a VPC with CIDR ***');
      expect(line).not.toContain('10.0.0.0/16');
    });
  });

  describe('CreateSubnet (a replay collides: exactly one subnet survives)', () => {
    it('names the subnet a lost response created, then the replay fails with the conflict', async () => {
      aws.loseNextCreateResponse = transient500();

      await expect(createWithRetry('AWS::EC2::Subnet', SUBNET_PROPS)).rejects.toThrow(
        /conflicts with another subnet/
      );

      expect(aws.subnets.map((s) => s.SubnetId)).toEqual(['subnet-001']);
      expect(aws.calls).not.toContain('DeleteSubnetCommand');
      const line = reportFor('CreateSubnet')!;
      expect(line).toContain('subnet-001');
      expect(line).toContain(
        'aws ec2 describe-subnets --subnet-ids subnet-001 --region ap-southeast-2'
      );
      expect(line).toContain('a subnet with CIDR 10.0.1.0/24 in VPC vpc-shared');
      expect(line).not.toContain('delete-subnet');
      // The undated report's default "Creating a new one now." would be false.
      expect(line).toContain('which fails with InvalidSubnet.Conflict while that subnet exists');
      expect(line).not.toContain('Creating a new one now');
    });

    it('follows DescribeSubnets pagination to a candidate on a later page', async () => {
      aws.pageSize = 1;
      aws.subnets.push(
        { SubnetId: 'subnet-a', VpcId: 'vpc-shared', CidrBlock: '10.0.8.0/24', AvailabilityZone: 'a', Tags: [] },
        { SubnetId: 'subnet-b', VpcId: 'vpc-shared', CidrBlock: '10.0.9.0/24', AvailabilityZone: 'a', Tags: [] }
      );
      aws.loseNextCreateResponse = transient500();

      await expect(createWithRetry('AWS::EC2::Subnet', SUBNET_PROPS)).rejects.toThrow(
        /conflicts with another subnet/
      );

      expect(aws.lookupCount('DescribeSubnetsCommand')).toBe(3);
      expect(reportFor('CreateSubnet')).toContain('subnet-001');
    });

    it('masks a short secret-derived CIDR and VPC id as WHOLE values', async () => {
      aws.loseNextCreateResponse = transient500();
      // Whole-value arm only, like the real masker for a value under its
      // substring floor: only `log.value` can hide these.
      const mask = (text: string): string =>
        text === '10.0.1.0/24' || text === 'vpc-shared' ? '***' : text;

      await expect(
        createWithRetry('AWS::EC2::Subnet', SUBNET_PROPS, 'Res', mask)
      ).rejects.toThrow();

      const line = reportFor('CreateSubnet')!;
      expect(line).toContain('a subnet with CIDR *** in VPC ***');
      expect(line).not.toContain('10.0.1.0/24');
    });

    it('does not report a tagged subnet, another CIDR or another VPC', async () => {
      aws.subnets.push(
        { SubnetId: 'subnet-tagged', VpcId: 'vpc-shared', CidrBlock: '10.0.1.0/24', AvailabilityZone: 'a', Tags: [{ Key: 'a', Value: 'b' }] },
        { SubnetId: 'subnet-othercidr', VpcId: 'vpc-shared', CidrBlock: '10.0.2.0/24', AvailabilityZone: 'a', Tags: [] },
        { SubnetId: 'subnet-othervpc', VpcId: 'vpc-other', CidrBlock: '10.0.3.0/24', AvailabilityZone: 'a', Tags: [] }
      );
      aws.loseNextCreateResponse = transient500();

      await expect(
        createWithRetry('AWS::EC2::Subnet', { ...SUBNET_PROPS, CidrBlock: '10.0.3.0/24' })
      ).rejects.toThrow(/conflicts with another subnet/);

      const line = reportFor('CreateSubnet')!;
      expect(line).toContain('1 untagged subnet(s) match');
      for (const id of ['subnet-tagged', 'subnet-othercidr', 'subnet-othervpc']) {
        expect(line).not.toContain(id);
      }
    });

    // The two controls below differ from a real orphan in ONE field only (a
    // tag; this process's own record). A 5xx that created nothing arms the
    // latch, so the lookup reaches them before the replay hits their CIDR.
    const createNothingThen = async (): Promise<void> => {
      aws.failNext.set('CreateSubnetCommand', [transient500()]);
      await expect(createWithRetry('AWS::EC2::Subnet', SUBNET_PROPS)).rejects.toThrow(
        /conflicts with another subnet/
      );
    };
    const debugLines = (): string[] => debugSpy.mock.calls.map((c) => String(c[0]));

    it('does not report a TAGGED subnet of the same CIDR in the same VPC', async () => {
      aws.subnets.push({
        SubnetId: 'subnet-tagged',
        VpcId: 'vpc-shared',
        CidrBlock: '10.0.1.0/24',
        AvailabilityZone: 'a',
        Tags: [{ Key: 'a', Value: 'b' }],
      });

      await createNothingThen();

      expect(aws.lookupCount('DescribeSubnetsCommand')).toBe(1);
      expect(reportFor('CreateSubnet')).toBeUndefined();
      expect(debugLines().some((l) => l.startsWith('No listed untagged subnet(s)'))).toBe(true);
    });

    it('does not report a subnet this process created, of the same CIDR in the same VPC', async () => {
      const earlier = await provider.create('Other', 'AWS::EC2::Subnet', {
        VpcId: 'vpc-shared',
        CidrBlock: '10.0.1.0/24',
      });
      expect(aws.subnets.find((x) => x.SubnetId === earlier.physicalId)!.Tags).toEqual([]);

      await createNothingThen();

      expect(aws.lookupCount('DescribeSubnetsCommand')).toBe(1);
      expect(reportFor('CreateSubnet')).toBeUndefined();
    });

    it('matches a CIDR EC2 stored host-bit-cleared against the template spelling', async () => {
      aws.loseNextCreateResponse = transient500();

      await expect(
        createWithRetry('AWS::EC2::Subnet', { ...SUBNET_PROPS, CidrBlock: '10.0.1.7/24' })
      ).rejects.toThrow(/conflicts with another subnet/);

      expect(aws.subnets[0]!.CidrBlock).toBe('10.0.1.0/24');
      expect(reportFor('CreateSubnet')).toContain('subnet-001');
    });
  });

  describe('CreateInternetGateway (a replay is a second gateway: reported)', () => {
    it('names the detached, untagged gateway a lost response created', async () => {
      const earlier = await provider.create('Other', 'AWS::EC2::InternetGateway', {});
      aws.igws.push(
        { InternetGatewayId: 'igw-attached', Attachments: [{ VpcId: 'vpc-x' }], Tags: [] },
        { InternetGatewayId: 'igw-tagged', Attachments: [], Tags: [{ Key: 'a', Value: 'b' }] }
      );
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry('AWS::EC2::InternetGateway', IGW_PROPS);

      expect(aws.igws).toHaveLength(5);
      expect(result.physicalId).toBe('igw-003');
      expect(aws.calls).not.toContain('DeleteInternetGatewayCommand');
      const line = reportFor('CreateInternetGateway')!;
      expect(line).toContain('1 detached, untagged internet gateway(s) match');
      expect(line).toContain(
        'aws ec2 describe-internet-gateways --internet-gateway-ids igw-002 --region ap-southeast-2'
      );
      for (const id of [earlier.physicalId, 'igw-attached', 'igw-tagged']) {
        expect(line).not.toContain(id);
      }
    });

    it('follows DescribeInternetGateways pagination to a candidate on a later page', async () => {
      aws.pageSize = 1;
      aws.igws.push(
        { InternetGatewayId: 'igw-a', Attachments: [{ VpcId: 'vpc-x' }], Tags: [] },
        { InternetGatewayId: 'igw-b', Attachments: [{ VpcId: 'vpc-y' }], Tags: [] }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::EC2::InternetGateway', IGW_PROPS);

      expect(aws.lookupCount('DescribeInternetGatewaysCommand')).toBe(3);
      expect(reportFor('CreateInternetGateway')).toContain('igw-001');
    });

    it('two ambiguous attempts in a row: the second report names BOTH orphans', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.loseNextCreateResponse = transient500();
        aws.onList = undefined;
      };

      const result = await createWithRetry('AWS::EC2::InternetGateway', IGW_PROPS);

      expect(result.physicalId).toBe('igw-003');
      const lines = reportsFor('CreateInternetGateway');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('igw-001');
      expect(lines[1]).toContain('igw-002');
      expect(lines[1]).toContain('at 2026-10-04T23:59:55.000Z');
    });
  });

  describe('AllocateAddress (a replay is a second address: reported)', () => {
    it('names the unassociated, untagged address a lost response allocated', async () => {
      const earlier = await provider.create('Other', 'AWS::EC2::EIP', {
        Domain: 'vpc',
        NetworkBorderGroup: 'ap-southeast-2',
        PublicIpv4Pool: 'amazon',
      });
      aws.addresses.push(
        // Each differs from the orphan in ONE field only.
        { AllocationId: 'eipalloc-assoc', PublicIp: '1', Domain: 'vpc', NetworkBorderGroup: 'ap-southeast-2', PublicIpv4Pool: 'amazon', AssociationId: 'eipassoc-1', Tags: [] },
        { AllocationId: 'eipalloc-tagged', PublicIp: '2', Domain: 'vpc', NetworkBorderGroup: 'ap-southeast-2', PublicIpv4Pool: 'amazon', Tags: [{ Key: 'a', Value: 'b' }] },
        { AllocationId: 'eipalloc-std', PublicIp: '3', Domain: 'standard', NetworkBorderGroup: 'ap-southeast-2', PublicIpv4Pool: 'amazon', Tags: [] },
        { AllocationId: 'eipalloc-nbg', PublicIp: '4', Domain: 'vpc', NetworkBorderGroup: 'other-nbg', PublicIpv4Pool: 'amazon', Tags: [] },
        { AllocationId: 'eipalloc-pool', PublicIp: '5', Domain: 'vpc', NetworkBorderGroup: 'ap-southeast-2', PublicIpv4Pool: 'ipv4pool-ec2-0abc', Tags: [] }
      );
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry('AWS::EC2::EIP', {
        ...EIP_PROPS,
        NetworkBorderGroup: 'ap-southeast-2',
        PublicIpv4Pool: 'amazon',
      });

      // Two of this create's addresses: the orphan is reported, not prevented.
      expect(aws.addresses.filter((a) => /^eipalloc-00[23]$/.test(a.AllocationId))).toHaveLength(2);
      expect(aws.addresses.map((a) => a.AllocationId)).toContain('eipalloc-002');
      expect(result.physicalId).not.toContain('eipalloc-002');
      expect(result.physicalId).toContain('eipalloc-003');
      expect(aws.calls).not.toContain('ReleaseAddressCommand');
      const line = reportFor('AllocateAddress')!;
      expect(line).toContain('1 unassociated, untagged Elastic IP address(es) match');
      expect(line).toContain(
        'aws ec2 describe-addresses --allocation-ids eipalloc-002 --region ap-southeast-2'
      );
      for (const id of [earlier.physicalId, 'eipalloc-assoc', 'eipalloc-tagged', 'eipalloc-std', 'eipalloc-nbg', 'eipalloc-pool']) {
        expect(line).not.toContain(id);
      }
    });

    it('a template naming no border group or pool still finds the orphan EC2 gave the region default', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::EC2::EIP', EIP_PROPS);

      expect(aws.addresses[0]!.NetworkBorderGroup).toBe('ap-southeast-2');
      expect(reportFor('AllocateAddress')).toContain('eipalloc-001');
    });

    it('two ambiguous attempts in a row: the second report names BOTH orphans', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.loseNextCreateResponse = transient500();
        aws.onList = undefined;
      };

      await createWithRetry('AWS::EC2::EIP', EIP_PROPS);

      const lines = reportsFor('AllocateAddress');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('eipalloc-001');
      expect(lines[1]).toContain('eipalloc-002');
      expect(lines[1]).toContain('at 2026-10-04T23:59:55.000Z');
    });

    it('masks a short secret-derived domain as a WHOLE value', async () => {
      aws.loseNextCreateResponse = transient500();
      const mask = (text: string): string => (text === 'vpc' ? '***' : text);

      await createWithRetry('AWS::EC2::EIP', EIP_PROPS, 'Res', mask);

      expect(reportFor('AllocateAddress')).toContain('(domain ***)');
    });
  });

  describe('CreateSecurityGroup (a replay collides on the name: exactly one group survives)', () => {
    // The engine-side outcome only: this fake sits below the SDK's retry, so
    // the 5xx reaches `withRetry` with or without the fix. What the fix
    // changes -- which client sends the create -- is pinned by the
    // create-client cases below.
    it('a replayed collision is marked as possibly this create\'s own, never credited', async () => {
      aws.loseNextCreateResponse = transient500();

      const error = await createWithRetry('AWS::EC2::SecurityGroup', SG_PROPS, 'AppSg').then(
        () => undefined,
        (e: unknown) => e
      );

      expect(String(error)).toContain('already exists');
      expect(aws.sgs).toHaveLength(1);
      expect(hasReplayMayCollide(error)).toBe(true);
      expect(isNameCollisionErrorFrom(error, 'AppSg')).toBe(false);
      expect(aws.calls).not.toContain('DeleteSecurityGroupCommand');
    });
  });

  describe('a create the SDK replayed inside its send (issue #4687)', () => {
    /** Stamp every create's output with `$metadata`, as the SDK's retry middleware does. */
    const stampCreates = (metadata: Record<string, unknown> | undefined): void => {
      mockSend.mockImplementation(async (command: Parameters<FakeEc2['send']>[0]) => {
        const output = await aws.send(command);
        return metadata !== undefined && REPLAY_SITES.some((s) => s.command === command.constructor.name)
          ? { ...(output as object), $metadata: metadata }
          : output;
      });
    };
    const replayLines = (action: string): string[] =>
      warnLines().filter((l) => l.includes(`The ${action} call for Res succeeded only after`));

    interface ReplaySite {
      readonly action: string;
      readonly command: string;
      readonly type: string;
      readonly props: Record<string, unknown>;
      readonly lookup: string;
      readonly returned: string;
      readonly orphan: string;
      /** Puts an unrecorded, matching candidate where the lookup will list it. */
      readonly stage: (aws: FakeEc2) => void;
    }
    const REPLAY_SITES: readonly ReplaySite[] = [
      {
        action: 'CreateVpc',
        command: 'CreateVpcCommand',
        type: 'AWS::EC2::VPC',
        props: VPC_PROPS,
        lookup: 'DescribeVpcsCommand',
        returned: 'vpc-001',
        orphan: 'vpc-orphan',
        stage: (fake) =>
          fake.vpcs.push({ VpcId: 'vpc-orphan', CidrBlock: '10.0.0.0/16', IsDefault: false, Tags: [] }),
      },
      {
        action: 'CreateSubnet',
        command: 'CreateSubnetCommand',
        type: 'AWS::EC2::Subnet',
        props: SUBNET_PROPS,
        lookup: 'DescribeSubnetsCommand',
        returned: 'subnet-001',
        orphan: 'subnet-orphan',
        // Staged at list time: present before the create, it would collide.
        stage: (fake) => {
          fake.onList = () => {
            fake.subnets.push({
              SubnetId: 'subnet-orphan',
              VpcId: 'vpc-shared',
              CidrBlock: '10.0.1.0/24',
              AvailabilityZone: 'ap-southeast-2a',
              Tags: [],
            });
            fake.onList = undefined;
          };
        },
      },
      {
        action: 'CreateInternetGateway',
        command: 'CreateInternetGatewayCommand',
        type: 'AWS::EC2::InternetGateway',
        props: IGW_PROPS,
        lookup: 'DescribeInternetGatewaysCommand',
        returned: 'igw-001',
        orphan: 'igw-orphan',
        stage: (fake) =>
          fake.igws.push({ InternetGatewayId: 'igw-orphan', Attachments: [], Tags: [] }),
      },
      {
        action: 'AllocateAddress',
        command: 'AllocateAddressCommand',
        type: 'AWS::EC2::EIP',
        props: EIP_PROPS,
        lookup: 'DescribeAddressesCommand',
        returned: 'eipalloc-001',
        orphan: 'eipalloc-orphan',
        stage: (fake) =>
          fake.addresses.push({
            AllocationId: 'eipalloc-orphan',
            PublicIp: '198.51.100.9',
            Domain: 'vpc',
            NetworkBorderGroup: 'ap-southeast-2',
            PublicIpv4Pool: 'amazon',
            Tags: [],
          }),
      },
    ];

    /** The calls a single-attempt create sends, with no lookup. */
    const baselineCalls = async (site: ReplaySite): Promise<string[]> => {
      const probe = new FakeEc2();
      mockSend.mockImplementation(probe.send);
      resetEc2CreateRetryStateForTests();
      await new EC2Provider().create('Res', site.type, site.props);
      resetEc2CreateRetryStateForTests();
      return probe.calls;
    };

    it.each(REPLAY_SITES.map((s) => [s.action, s] as const))(
      '%s: a replayed success looks once, names the unrecorded candidate and not the returned id',
      async (_action, site) => {
        const baseline = await baselineCalls(site);
        site.stage(aws);
        stampCreates({ attempts: 2 });

        const result = await provider.create('Res', site.type, site.props);

        expect(result.physicalId).toContain(site.returned);
        // The baseline plus exactly one lookup, sent right after the create.
        const at = baseline.indexOf(site.command) + 1;
        expect(aws.calls).toEqual([...baseline.slice(0, at), site.lookup, ...baseline.slice(at)]);
        expect(aws.lookups).toEqual([site.lookup]);
        expect(aws.calls.filter((c) => /^(Delete|Release)/.test(c))).toEqual([]);
        expect(reportFor(site.action)).toBeUndefined();
        const lines = replayLines(site.action);
        expect(lines).toHaveLength(1);
        const line = lines[0]!;
        expect(line).toContain(
          `The ${site.action} call for Res succeeded only after the AWS SDK sent it again, following an attempt that failed without a definite answer`
        );
        expect(line).toContain(site.orphan);
        expect(line).not.toContain(site.returned);
        expect(line).toContain('cdkd recorded the one the create returned.');
        expect(line).not.toContain('Creating a new one now');
        expect(line).not.toContain('Creating it again');
        expect(line).not.toContain('InvalidSubnet.Conflict');
      }
    );

    it.each(
      REPLAY_SITES.flatMap((s) => [
        [s.action, 'attempts: 1', s, { attempts: 1 }] as const,
        [s.action, 'no $metadata', s, undefined] as const,
      ])
    )('%s with %s sends no lookup', async (_action, _label, site, metadata) => {
      const baseline = await baselineCalls(site);
      site.stage(aws);
      stampCreates(metadata);

      await provider.create('Res', site.type, site.props);

      expect(aws.calls).toEqual(baseline);
      expect(aws.lookups).toEqual([]);
      expect(warnLines()).toEqual([]);
    });
  });

  describe('the create client', () => {
    it.each([
      ['CreateVpcCommand', 'AWS::EC2::VPC', VPC_PROPS],
      ['CreateSubnetCommand', 'AWS::EC2::Subnet', SUBNET_PROPS],
      ['CreateInternetGatewayCommand', 'AWS::EC2::InternetGateway', IGW_PROPS],
      ['AllocateAddressCommand', 'AWS::EC2::EIP', EIP_PROPS],
      ['CreateSecurityGroupCommand', 'AWS::EC2::SecurityGroup', SG_PROPS],
    ] as const)(
      'sends %s through a client that refuses the SDK retry of a 5xx, in the shared client region',
      async (command, type, props) => {
        await provider.create('Res', type, props);

        const [, via, createConfig] = sentVia.find(([name]) => name === command)!;
        expect(via).toBe('create');
        const strategy = (await createConfig.retryStrategy!()) as typeof baseStrategy;
        await expect(
          strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
        ).rejects.toThrow();
        await expect(
          strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
        ).resolves.toBe('retry-token');
        // Every other call keeps the shared client and its full SDK retry.
        expect(
          sentVia.filter(([name]) => name !== command).every(([, v]) => v === 'shared')
        ).toBe(true);
        expect(ctorOptions).toHaveLength(1);
        expect(ctorOptions[0]).toMatchObject({
          region: 'ap-southeast-2',
          credentials: { accessKeyId: 'AKIDAMBIENT' },
        });
      }
    );

    it('a lookup lists through the shared client', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::EC2::VPC', VPC_PROPS);

      expect(aws.lookupCount('DescribeVpcsCommand')).toBe(1);
      const describes = sentVia.filter(([name]) => name === 'DescribeVpcsCommand');
      expect(describes.length).toBeGreaterThan(0);
      expect(describes.every(([, v]) => v === 'shared')).toBe(true);
    });

    it('two creates on a cold provider build ONE create client', async () => {
      await Promise.all([
        provider.create('A', 'AWS::EC2::VPC', VPC_PROPS),
        provider.create('B', 'AWS::EC2::InternetGateway', IGW_PROPS),
      ]);

      expect(ctorOptions).toHaveLength(1);
    });

    it('a rejected region read is not cached: the next create builds the client', async () => {
      shared.region.mockRejectedValueOnce(new Error('Region is missing'));

      await expect(provider.create('Res', 'AWS::EC2::VPC', VPC_PROPS)).rejects.toThrow(
        'Region is missing'
      );
      const result = await provider.create('Res', 'AWS::EC2::VPC', VPC_PROPS);

      expect(result.physicalId).toBe('vpc-001');
      expect(aws.vpcs).toHaveLength(1);
      expect(shared.region).toHaveBeenCalledTimes(2);
    });
  });
});
