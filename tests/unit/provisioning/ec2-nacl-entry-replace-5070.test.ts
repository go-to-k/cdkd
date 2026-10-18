import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateNetworkAclEntryCommand,
  DeleteNetworkAclEntryCommand,
  ReplaceNetworkAclEntryCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../src/utils/error-handler.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';

/**
 * Issue #5070: an `AWS::EC2::NetworkAclEntry` rule change (action, protocol,
 * CIDR, port range, ICMP) is one atomic `ReplaceNetworkAclEntry`, as
 * CloudFormation does it ("Update requires: No interruption"). It used to be
 * refused as not updatable, and the suggested `--replace` deleted the entry
 * and created it again, leaving the rule number absent between the two calls.
 */
describe('EC2Provider AWS::EC2::NetworkAclEntry rule change uses ReplaceNetworkAclEntry (#5070)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new EC2Provider();
  });

  const TYPE = 'AWS::EC2::NetworkAclEntry';
  const ID = 'acl-1|100|false';
  const ENTRY: Record<string, unknown> = {
    NetworkAclId: 'acl-1',
    RuleNumber: 100,
    Protocol: 6,
    RuleAction: 'allow',
    Egress: false,
    CidrBlock: '0.0.0.0/0',
    PortRange: { From: 80, To: 80 },
  };

  const sentOf = <T>(ctor: new (...args: never[]) => T): T[] =>
    mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);
  const replaceInputs = (): Array<Record<string, unknown>> =>
    sentOf(ReplaceNetworkAclEntryCommand).map((c) => c.input as unknown as Record<string, unknown>);
  const deleteOrCreateSent = (): boolean =>
    sentOf(DeleteNetworkAclEntryCommand).length > 0 ||
    sentOf(CreateNetworkAclEntryCommand).length > 0;
  const defined = (input: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

  // Derived, not hand-listed: every handled property that is not createOnly is
  // a rule field. A field cdkd learns to handle later joins this population on
  // its own, and fails below until NEW_VALUE (and the ReplaceNetworkAclEntry
  // arm) carries it too.
  const createOnly = new Set(
    (CREATE_ONLY_PATHS_SNAPSHOT.get(TYPE) ?? []).map((path) => path.join('.'))
  );
  const ruleKeys = [...(PROPERTY_COVERAGE_BY_TYPE.get(TYPE)?.handled ?? [])]
    .filter((key) => !createOnly.has(key))
    .sort();

  /** The new template value per rule key, and the SDK field + value it must send. */
  const NEW_VALUE: Record<string, { value: unknown; sent: Record<string, unknown> }> = {
    CidrBlock: { value: '10.0.0.0/8', sent: { CidrBlock: '10.0.0.0/8' } },
    Icmp: {
      value: { Type: 8, Code: 0 },
      sent: { IcmpTypeCode: { Type: 8, Code: 0 } },
    },
    Ipv6CidrBlock: { value: '::/0', sent: { Ipv6CidrBlock: '::/0' } },
    PortRange: { value: { From: 443, To: 443 }, sent: { PortRange: { From: 443, To: 443 } } },
    Protocol: { value: 17, sent: { Protocol: '17' } },
    RuleAction: { value: 'deny', sent: { RuleAction: 'deny' } },
  };

  it('derives the createOnly identity and the six CloudFormation rule fields', () => {
    expect(createOnly).toEqual(new Set(['Egress', 'NetworkAclId', 'RuleNumber']));
    expect(ruleKeys).toEqual([
      'CidrBlock',
      'Icmp',
      'Ipv6CidrBlock',
      'PortRange',
      'Protocol',
      'RuleAction',
    ]);
  });

  describe('the in-place arm', () => {
    it.each(ruleKeys)(
      'a change to %s is one ReplaceNetworkAclEntry carrying it, and nothing is deleted',
      async (key) => {
        const change = NEW_VALUE[key];
        expect(change, `no NEW_VALUE for ${key}`).toBeDefined();
        const result = await provider.update(
          'Entry',
          ID,
          TYPE,
          { ...ENTRY, [key]: change!.value },
          ENTRY
        );

        expect(deleteOrCreateSent()).toBe(false);
        const inputs = replaceInputs();
        expect(inputs).toHaveLength(1);
        expect(defined(inputs[0]!)).toEqual({
          NetworkAclId: 'acl-1',
          RuleNumber: 100,
          Egress: false,
          Protocol: '6',
          RuleAction: 'allow',
          CidrBlock: '0.0.0.0/0',
          PortRange: { From: 80, To: 80 },
          ...change!.sent,
        });
        expect(result).toEqual({ physicalId: ID, wasReplaced: false });
      }
    );

    it('an egress entry is replaced as an egress entry', async () => {
      const egressEntry = { ...ENTRY, Egress: true };
      await provider.update(
        'Entry',
        'acl-1|100|true',
        TYPE,
        { ...egressEntry, RuleAction: 'deny' },
        egressEntry
      );

      expect(replaceInputs()[0]?.['Egress']).toBe(true);
      expect(replaceInputs()[0]?.['RuleNumber']).toBe(100);
    });

    it('an omitted Egress is the ingress entry, as on create', async () => {
      const { Egress: _omitted, ...ingress } = ENTRY;
      await provider.update('Entry', ID, TYPE, { ...ingress, RuleAction: 'deny' }, ingress);

      expect(replaceInputs()[0]?.['Egress']).toBe(false);
    });

    it('a field the template drops is not sent (the whole rule is replaced)', async () => {
      const { PortRange: _dropped, ...rest } = ENTRY;
      await provider.update('Entry', ID, TYPE, { ...rest, Protocol: -1 }, ENTRY);

      const input = replaceInputs()[0]!;
      expect(input['Protocol']).toBe('-1');
      expect(input['PortRange']).toBeUndefined();
    });

    it('accepts the legacy IcmpTypeCode key from a pre-#613 state record', async () => {
      const icmp = { ...ENTRY, Protocol: 1, PortRange: undefined, IcmpTypeCode: { Type: 0, Code: -1 } };
      await provider.update(
        'Entry',
        ID,
        TYPE,
        { ...icmp, IcmpTypeCode: { Type: 8, Code: -1 } },
        icmp,
        { replayingState: true }
      );

      expect(replaceInputs()[0]?.['IcmpTypeCode']).toEqual({ Type: 8, Code: -1 });
    });

    it('a rollback revert of a rule change replaces the rule back in place', async () => {
      // The rollback executor reverts an in-place update by calling update()
      // with the recorded previous bag; `wasReplaced: false` journaled on the
      // forward op is what routes it here instead of a reverse replacement.
      const result = await provider.update(
        'Entry',
        ID,
        TYPE,
        ENTRY,
        { ...ENTRY, RuleAction: 'deny' },
        { replayingState: true }
      );

      expect(deleteOrCreateSent()).toBe(false);
      expect(replaceInputs()[0]?.['RuleAction']).toBe('allow');
      expect(result.wasReplaced).toBe(false);
    });

    it('drift --revert of a console-side rule edit replaces the rule back in place', async () => {
      // The revert's desired bag is the AWS readback overlaid with the
      // recorded values: readNetworkAclEntryCurrentState's shape, which
      // carries the identity from the physical id and ICMP under both names.
      const readback = {
        NetworkAclId: 'acl-1',
        RuleNumber: 100,
        Egress: false,
        Protocol: 1,
        RuleAction: 'deny',
        CidrBlock: '0.0.0.0/0',
        Icmp: { Type: 8, Code: -1 },
        IcmpTypeCode: { Type: 8, Code: -1 },
      };
      const result = await provider.update(
        'Entry',
        ID,
        TYPE,
        { ...readback, RuleAction: 'allow' },
        readback,
        { desiredFromAwsReadback: true }
      );

      expect(deleteOrCreateSent()).toBe(false);
      expect(defined(replaceInputs()[0]!)).toEqual({
        NetworkAclId: 'acl-1',
        RuleNumber: 100,
        Egress: false,
        Protocol: '1',
        RuleAction: 'allow',
        CidrBlock: '0.0.0.0/0',
        IcmpTypeCode: { Type: 8, Code: -1 },
      });
      expect(result).toEqual({ physicalId: ID, wasReplaced: false });
    });

    it('drift --revert of a legacy IcmpTypeCode record sends the recorded ICMP, not the drifted Icmp', async () => {
      // A pre-#613 state record holds only `IcmpTypeCode`, so the revert
      // overlays that key alone; `Icmp` keeps the drifted AWS value.
      const readback = {
        NetworkAclId: 'acl-1',
        RuleNumber: 100,
        Egress: false,
        Protocol: 1,
        RuleAction: 'allow',
        CidrBlock: '0.0.0.0/0',
        Icmp: { Type: 0, Code: -1 },
        IcmpTypeCode: { Type: 0, Code: -1 },
      };
      await provider.update(
        'Entry',
        ID,
        TYPE,
        { ...readback, IcmpTypeCode: { Type: 8, Code: -1 } },
        readback,
        { desiredFromAwsReadback: true }
      );

      expect(replaceInputs()[0]?.['IcmpTypeCode']).toEqual({ Type: 8, Code: -1 });
    });

    it('a template Icmp change wins when only Icmp changed', async () => {
      const both = {
        ...ENTRY,
        Protocol: 1,
        PortRange: undefined,
        Icmp: { Type: 0, Code: -1 },
        IcmpTypeCode: { Type: 0, Code: -1 },
      };
      await provider.update('Entry', ID, TYPE, { ...both, Icmp: { Type: 3, Code: 4 } }, both);

      expect(replaceInputs()[0]?.['IcmpTypeCode']).toEqual({ Type: 3, Code: 4 });
    });

    it('a refused ReplaceNetworkAclEntry fails the update with the entry untouched', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('The network ACL entry identified by 100 does not exist'), {
          name: 'InvalidNetworkAclEntry.NotFound',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        })
      );

      const error = await provider
        .update('Entry', ID, TYPE, { ...ENTRY, RuleAction: 'deny' }, ENTRY)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect(error).not.toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((error as ProvisioningError).message).toMatch(
        /^Failed to update NetworkAclEntry Entry: /
      );
      expect((error as ProvisioningError).physicalId).toBe(ID);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(deleteOrCreateSent()).toBe(false);
    });

    it('a bag missing RuleAction is refused before any AWS call', async () => {
      const { RuleAction: _missing, ...rest } = ENTRY;
      const error = await provider
        .update('Entry', ID, TYPE, { ...rest, CidrBlock: '10.0.0.0/8' }, ENTRY)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as ProvisioningError).message).toContain('Protocol and RuleAction are required');
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('a bag naming another entry than the physical id is refused, as before', () => {
    it.each([
      ['another NetworkAclId', { ...ENTRY, NetworkAclId: 'acl-2', RuleAction: 'deny' }, ID],
      ['another RuleNumber', { ...ENTRY, RuleNumber: 200, RuleAction: 'deny' }, ID],
      ['another Egress', { ...ENTRY, Egress: true, RuleAction: 'deny' }, ID],
    ])('%s', async (_label, props, physicalId) => {
      const error = await provider
        .update('Entry', physicalId, TYPE, props, ENTRY)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((error as Error).message).toContain('cdkd deploy --replace');
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  it('a malformed physical id is refused with the id format, before any AWS call', async () => {
    const error = await provider
      .update('Entry', 'acl-1|100', TYPE, { ...ENTRY, RuleAction: 'deny' }, ENTRY)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error).not.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((error as Error).message).toContain('Invalid physicalId format for NetworkAclEntry');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a null Protocol is refused before any AWS call', async () => {
    const error = await provider
      .update('Entry', ID, TYPE, { ...ENTRY, Protocol: null, RuleAction: 'deny' }, ENTRY)
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('Protocol and RuleAction are required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an unchanged bag still sends nothing', async () => {
    const result = await provider.update('Entry', ID, TYPE, ENTRY, { ...ENTRY });
    expect(mockSend).not.toHaveBeenCalled();
    expect(result).toEqual({ physicalId: ID, wasReplaced: false });
  });
});
