/**
 * Issue #3097: `AWS::EC2::SecurityGroup`'s `VpcId` attribute is read back
 * from `DescribeSecurityGroups` on the group id and recorded through
 * `definedAttributes` at BOTH result maps (create and update) -- the two sites
 * issue #3077 had left on the `(properties['VpcId'] as string) ?? ''` shape.
 *
 * What discriminates: the mocked describe answers a VpcId that DIFFERS from
 * the template's property, so the pre-fix mutant (copy the template's value)
 * and the fix (record the response's) cannot pass the same assertion; the
 * failed / empty read asserts the key is ABSENT with `toStrictEqual`, which a
 * `''` fails and a present-but-`undefined` key fails too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
    }),
  };
});

import {
  EC2Provider,
  SG_READBACK_NOT_FOUND_ATTEMPTS,
  SG_READBACK_RETRY_DELAY_MS,
  securityGroupReadbackDelays,
} from '../../../src/provisioning/providers/ec2-provider.js';

const commandsSent = (): unknown[] => mockSend.mock.calls.map((c) => c[0]);
/**
 * The failed-describe lines stay at DEBUG: the AWS message can quote the
 * caller's account, role and session, so a promotion to warn / info would
 * put it on the terminal at default verbosity (security review of PR
 * go-to-k/cdkd#3139).
 */
const expectNothingAboveDebug = (): void => {
  expect(warnSpy).not.toHaveBeenCalled();
  expect(infoSpy).not.toHaveBeenCalled();
  expect(errorSpy).not.toHaveBeenCalled();
};
const describeCommands = (): DescribeSecurityGroupsCommand[] =>
  commandsSent().filter(
    (c): c is DescribeSecurityGroupsCommand => c instanceof DescribeSecurityGroupsCommand
  );

/**
 * Route by command class rather than by call order: the create path's
 * wiring calls run under `Promise.allSettled`, so an ordered `*Once` chain
 * would pin an order the provider does not promise.
 */
function routeSend(handlers: {
  create?: () => unknown;
  describe?: () => unknown;
}): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof CreateSecurityGroupCommand) return handlers.create?.() ?? { GroupId: 'sg-0abc' };
    if (cmd instanceof DescribeSecurityGroupsCommand) {
      return handlers.describe ? handlers.describe() : { SecurityGroups: [] };
    }
    return {};
  });
}

describe('EC2Provider AWS::EC2::SecurityGroup VpcId read-back (issue #3097)', () => {
  let provider: EC2Provider;

  const sleeps: number[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    sleeps.length = 0;
    securityGroupReadbackDelays.sleep = async (ms) => {
      sleeps.push(ms);
    };
    provider = new EC2Provider();
  });
  afterEach(() => {
    delete securityGroupReadbackDelays.sleep;
  });

  describe('create', () => {
    it('records VpcId from the DescribeSecurityGroups RESPONSE, not from the template property (explicit-VpcId shape)', async () => {
      routeSend({
        create: () => ({ GroupId: 'sg-0abc' }),
        describe: () => ({ SecurityGroups: [{ GroupId: 'sg-0abc', VpcId: 'vpc-0fromdescribe' }] }),
      });

      const result = await provider.create('Sg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'explicit VPC',
        VpcId: 'vpc-0fromtemplate',
      });

      expect(result.physicalId).toBe('sg-0abc');
      // The DISCRIMINATOR: the template said one id, AWS reported another.
      // The pre-fix `(properties['VpcId'] as string) ?? ''` records
      // `vpc-0fromtemplate` and fails here.
      expect(result.attributes).toStrictEqual({ GroupId: 'sg-0abc', VpcId: 'vpc-0fromdescribe' });

      const describes = describeCommands();
      expect(describes).toHaveLength(1);
      // By GroupIds, never a filter: a filter value reads `*` / `?` as
      // wildcards, and this id is AWS-minted anyway.
      expect(describes[0]!.input).toEqual({ GroupIds: ['sg-0abc'] });
    });

    it('records the default VPC id for a group declared WITHOUT VpcId (the default-VPC shape the issue is about)', async () => {
      routeSend({
        create: () => ({ GroupId: 'sg-0default' }),
        describe: () => ({
          SecurityGroups: [{ GroupId: 'sg-0default', VpcId: 'vpc-0accountdefault' }],
        }),
      });

      const result = await provider.create('DefaultVpcSg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'lands in the default VPC',
      });

      // The pre-fix shape recorded `''` here (no template property to copy).
      expect(result.attributes).toStrictEqual({
        GroupId: 'sg-0default',
        VpcId: 'vpc-0accountdefault',
      });
      // The create request itself still omits VpcId (AWS picks the default).
      const create = commandsSent().find((c) => c instanceof CreateSecurityGroupCommand) as
        | CreateSecurityGroupCommand
        | undefined;
      expect(create?.input.VpcId).toBeUndefined();
    });

    it('OMITS the key -- never \'\' -- when the describe fails, and still returns the created group', async () => {
      routeSend({
        create: () => ({ GroupId: 'sg-0abc' }),
        describe: () => {
          throw Object.assign(
            new Error('User: arn:aws:sts::123456789012:assumed-role/x/y is not authorized'),
            { name: 'UnauthorizedOperation', $metadata: { httpStatusCode: 403 } }
          );
        },
      });

      const result = await provider.create('Sg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'describe denied',
        VpcId: 'vpc-0fromtemplate',
      });

      expect(result.physicalId).toBe('sg-0abc');
      // `toStrictEqual`: `toEqual` ignores a present-but-undefined key, and a
      // `''` (the pre-fix record) is a different value outright.
      expect(result.attributes).toStrictEqual({ GroupId: 'sg-0abc' });
      expect(Object.hasOwn(result.attributes!, 'VpcId')).toBe(false);
      // A failed read-back is not a failed create: no cleanup delete.
      expect(commandsSent().some((c) => c instanceof DeleteSecurityGroupCommand)).toBe(false);
      // The debug line names the error CLASS and status at its head.
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('DescribeSecurityGroups for SecurityGroup sg-0abc failed (UnauthorizedOperation, HTTP 403)')
      );
      expectNothingAboveDebug();
    });

    it('OMITS the key when the describe answers no group / no VpcId', async () => {
      routeSend({ create: () => ({ GroupId: 'sg-0abc' }), describe: () => ({ SecurityGroups: [] }) });
      const empty = await provider.create('Sg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'empty describe',
        VpcId: 'vpc-0fromtemplate',
      });
      expect(empty.attributes).toStrictEqual({ GroupId: 'sg-0abc' });
      // An EMPTY answer is not a not-found: no retry, no sleep (delta review
      // of PR go-to-k/cdkd#3139 -- a mutant retrying on `vpcId === undefined`
      // passed the attributes assertion alone).
      expect(describeCommands()).toHaveLength(1);
      expect(sleeps).toEqual([]);

      mockSend.mockReset();
      routeSend({
        create: () => ({ GroupId: 'sg-0abc' }),
        describe: () => ({ SecurityGroups: [{ GroupId: 'sg-0abc' }] }),
      });
      const noVpc = await provider.create('Sg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'describe without VpcId',
        VpcId: 'vpc-0fromtemplate',
      });
      expect(noVpc.attributes).toStrictEqual({ GroupId: 'sg-0abc' });
      expect(describeCommands()).toHaveLength(1);
      expect(sleeps).toEqual([]);
    });

    it('retries a not-found describe (EC2 read-after-write lag) and records the VpcId once the group is visible', async () => {
      // EC2's describe is eventually consistent: the group the write path just
      // tagged and wired can still answer InvalidGroup.NotFound for a moment.
      let describes = 0;
      routeSend({
        create: () => ({ GroupId: 'sg-0abc' }),
        describe: () => {
          describes += 1;
          if (describes < 3) {
            throw Object.assign(new Error("The security group 'sg-0abc' does not exist"), {
              name: 'InvalidGroup.NotFound',
              $metadata: { httpStatusCode: 400 },
            });
          }
          return { SecurityGroups: [{ GroupId: 'sg-0abc', VpcId: 'vpc-0eventually' }] };
        },
      });

      const result = await provider.create('Sg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'lagging describe',
      });

      expect(result.attributes).toStrictEqual({ GroupId: 'sg-0abc', VpcId: 'vpc-0eventually' });
      expect(describeCommands()).toHaveLength(3);
      // One sleep per retried attempt, at the declared delay.
      expect(sleeps).toEqual([SG_READBACK_RETRY_DELAY_MS, SG_READBACK_RETRY_DELAY_MS]);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `answered not-found (InvalidGroup.NotFound, HTTP 400) on attempt 1/${SG_READBACK_NOT_FOUND_ATTEMPTS}`
        )
      );
    });

    it('gives up on a persistent not-found after the bounded attempts and OMITS the key', async () => {
      routeSend({
        create: () => ({ GroupId: 'sg-0abc' }),
        describe: () => {
          throw Object.assign(new Error("The security group 'sg-0abc' does not exist"), {
            name: 'InvalidGroup.NotFound',
          });
        },
      });

      const result = await provider.create('Sg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'never visible',
      });

      expect(result.attributes).toStrictEqual({ GroupId: 'sg-0abc' });
      expect(describeCommands()).toHaveLength(SG_READBACK_NOT_FOUND_ATTEMPTS);
      expect(sleeps).toHaveLength(SG_READBACK_NOT_FOUND_ATTEMPTS - 1);
      // The give-up line is the plain failure line, not another retry line.
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'DescribeSecurityGroups for SecurityGroup sg-0abc failed (InvalidGroup.NotFound); omitting the VpcId attribute'
        )
      );
      expectNothingAboveDebug();
    });

    it('waits the REAL delay between attempts when no seam is installed (fake timers; the production sleep is what runs)', async () => {
      // Every other case installs the seam, so the production fallback
      // (`this.sleep`) was never executed and a mutant resolving it at once
      // stayed green (delta review of PR go-to-k/cdkd#3139). Timers are faked
      // and advanced by hand: the second describe must not happen before
      // SG_READBACK_RETRY_DELAY_MS has elapsed.
      delete securityGroupReadbackDelays.sleep;
      vi.useFakeTimers();
      try {
        let describes = 0;
        routeSend({
          create: () => ({ GroupId: 'sg-0abc' }),
          describe: () => {
            describes += 1;
            if (describes < 2) {
              throw Object.assign(new Error("The security group 'sg-0abc' does not exist"), {
                name: 'InvalidGroup.NotFound',
              });
            }
            return { SecurityGroups: [{ GroupId: 'sg-0abc', VpcId: 'vpc-0afterwait' }] };
          },
        });
        const pending = provider.create('Sg', 'AWS::EC2::SecurityGroup', {
          GroupDescription: 'real delay',
        });
        // Let the create + first describe settle without advancing the clock.
        await vi.advanceTimersByTimeAsync(0);
        expect(describes).toBe(1);
        // Just short of the delay: still one describe.
        await vi.advanceTimersByTimeAsync(SG_READBACK_RETRY_DELAY_MS - 1);
        expect(describes).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        const result = await pending;
        expect(describes).toBe(2);
        expect(result.attributes).toStrictEqual({ GroupId: 'sg-0abc', VpcId: 'vpc-0afterwait' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('a rejecting retry sleep omits the key like a failed read (the best-effort boundary covers the wait too)', async () => {
      // Only a test seam can reject (the production sleep cannot); pinned so
      // the boundary stays where the docstring says it is.
      securityGroupReadbackDelays.sleep = async () => {
        throw new Error('seam rejected');
      };
      routeSend({
        create: () => ({ GroupId: 'sg-0abc' }),
        describe: () => {
          throw Object.assign(new Error("The security group 'sg-0abc' does not exist"), {
            name: 'InvalidGroup.NotFound',
          });
        },
      });
      const result = await provider.create('Sg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'seam rejects',
      });
      expect(result.physicalId).toBe('sg-0abc');
      expect(result.attributes).toStrictEqual({ GroupId: 'sg-0abc' });
      expect(describeCommands()).toHaveLength(1);
      expect(commandsSent().some((c) => c instanceof DeleteSecurityGroupCommand)).toBe(false);
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('retry sleep for SecurityGroup sg-0abc rejected'));
    });

    it('does NOT retry a failure that is not a not-found (a denial omits at once, no sleep)', async () => {
      routeSend({
        create: () => ({ GroupId: 'sg-0abc' }),
        describe: () => {
          throw Object.assign(new Error('not authorized'), { name: 'UnauthorizedOperation' });
        },
      });
      const result = await provider.create('Sg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'denied',
      });
      expect(result.attributes).toStrictEqual({ GroupId: 'sg-0abc' });
      expect(describeCommands()).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expectNothingAboveDebug();
    });

    it('describes AFTER the wiring settled, and never when the wiring failed (the cleanup delete runs instead)', async () => {
      // Wiring failure: the inline ingress authorize rejects. The provider
      // must delete the half-wired group and re-throw -- and must NOT have
      // issued the read-back (a describe racing the cleanup delete would be a
      // second call against a group being torn down).
      mockSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-0abc' };
        if (cmd instanceof AuthorizeSecurityGroupIngressCommand) {
          throw new Error('InvalidPermission.Malformed');
        }
        if (cmd instanceof DescribeSecurityGroupsCommand) {
          return { SecurityGroups: [{ GroupId: 'sg-0abc', VpcId: 'vpc-0x' }] };
        }
        return {};
      });

      await expect(
        provider.create('Sg', 'AWS::EC2::SecurityGroup', {
          GroupDescription: 'wiring fails',
          VpcId: 'vpc-0x',
          SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' }],
        })
      ).rejects.toThrow(/Failed to create SecurityGroup Sg/);

      expect(describeCommands()).toHaveLength(0);
      expect(commandsSent().some((c) => c instanceof DeleteSecurityGroupCommand)).toBe(true);

      // Happy path: the describe is the LAST call, after the wiring.
      mockSend.mockReset();
      mockSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-0abc' };
        if (cmd instanceof DescribeSecurityGroupsCommand) {
          return { SecurityGroups: [{ GroupId: 'sg-0abc', VpcId: 'vpc-0x' }] };
        }
        return {};
      });
      await provider.create('Sg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'wiring ok',
        VpcId: 'vpc-0x',
        SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' }],
      });
      const sent = commandsSent();
      expect(sent[sent.length - 1]).toBeInstanceOf(DescribeSecurityGroupsCommand);
      expect(sent.findIndex((c) => c instanceof AuthorizeSecurityGroupIngressCommand)).toBeLessThan(
        sent.length - 1
      );
      expectNothingAboveDebug();
    });
  });

  describe('update', () => {
    const unchanged = { GroupDescription: 'same', VpcId: 'vpc-0fromtemplate' };

    it('records VpcId from the describe RESPONSE on an update', async () => {
      routeSend({
        describe: () => ({ SecurityGroups: [{ GroupId: 'sg-0abc', VpcId: 'vpc-0fromdescribe' }] }),
      });

      const result = await provider.update('Sg', 'sg-0abc', 'AWS::EC2::SecurityGroup', unchanged, {
        ...unchanged,
      });

      expect(result.attributes).toStrictEqual({ GroupId: 'sg-0abc', VpcId: 'vpc-0fromdescribe' });
      const describes = describeCommands();
      expect(describes).toHaveLength(1);
      expect(describes[0]!.input).toEqual({ GroupIds: ['sg-0abc'] });
    });

    it('OMITS the key -- never \'\' -- when the describe fails on an update, and the update still succeeds', async () => {
      routeSend({
        describe: () => {
          throw Object.assign(new Error('throttled'), { name: 'RequestLimitExceeded' });
        },
      });

      const result = await provider.update('Sg', 'sg-0abc', 'AWS::EC2::SecurityGroup', unchanged, {
        ...unchanged,
      });

      expect(result.physicalId).toBe('sg-0abc');
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toStrictEqual({ GroupId: 'sg-0abc' });
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('DescribeSecurityGroups for SecurityGroup sg-0abc failed (RequestLimitExceeded)')
      );
      expectNothingAboveDebug();
    });
  });

  describe('import', () => {
    it('records GroupId and VpcId off the verifying describe, and omits VpcId when the response lacks it', async () => {
      routeSend({
        describe: () => ({ SecurityGroups: [{ GroupId: 'sg-0abc', VpcId: 'vpc-0adopted' }] }),
      });
      const adopted = await provider.import({
        logicalId: 'Sg',
        resourceType: 'AWS::EC2::SecurityGroup',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: 'sg-0abc',
        stackName: 'Stack',
      });
      expect(adopted).toStrictEqual({
        physicalId: 'sg-0abc',
        attributes: { GroupId: 'sg-0abc', VpcId: 'vpc-0adopted' },
      });

      mockSend.mockReset();
      routeSend({ describe: () => ({ SecurityGroups: [{ GroupId: 'sg-0abc' }] }) });
      const unreported = await provider.import({
        logicalId: 'Sg',
        resourceType: 'AWS::EC2::SecurityGroup',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: 'sg-0abc',
        stackName: 'Stack',
      });
      expect(unreported).toStrictEqual({ physicalId: 'sg-0abc', attributes: { GroupId: 'sg-0abc' } });

      mockSend.mockReset();
      routeSend({ describe: () => ({ SecurityGroups: [] }) });
      expect(
        await provider.import({
          logicalId: 'Sg',
          resourceType: 'AWS::EC2::SecurityGroup',
          region: 'us-east-1',
          properties: {},
          knownPhysicalId: 'sg-0missing',
          stackName: 'Stack',
        })
      ).toBeNull();
    });
  });

  describe('getAttribute', () => {
    it('answers VpcId through the same read-back, and GroupId without a call', async () => {
      routeSend({
        describe: () => ({ SecurityGroups: [{ GroupId: 'sg-0abc', VpcId: 'vpc-0live' }] }),
      });
      expect(await provider.getAttribute('sg-0abc', 'AWS::EC2::SecurityGroup', 'GroupId')).toBe(
        'sg-0abc'
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(await provider.getAttribute('sg-0abc', 'AWS::EC2::SecurityGroup', 'VpcId')).toBe(
        'vpc-0live'
      );
      expect(describeCommands()).toHaveLength(1);
      expect(
        await provider.getAttribute('sg-0abc', 'AWS::EC2::SecurityGroup', 'GroupName')
      ).toBeUndefined();
    });
  });
});
