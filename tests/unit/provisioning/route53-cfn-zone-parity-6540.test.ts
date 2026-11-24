import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6540: RecordSet / RecordSetGroup refuse the zone spellings and
// group shapes CloudFormation fails (measured), warn on a state-borne path, and
// resolve a split-horizon HostedZoneName as ambiguous. A new group's physical id
// is `<zoneId>|<generated name>`.

const mockSend = vi.fn();
const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn((): unknown => childLogger),
  },
}));

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual('@aws-sdk/client-route-53');
  return {
    ...actual,
    Route53Client: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
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

import {
  ChangeResourceRecordSetsCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { withStackScope } from '../../../src/provisioning/resource-name.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const ZONE = 'Z1234567890';
const GROUP_TYPE = 'AWS::Route53::RecordSetGroup';
const RECORD_TYPE = 'AWS::Route53::RecordSet';
const GROUP = 'RecordGroup';
const INSTANCE_ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const rec = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  Name: 'a.example.com.',
  Type: 'A',
  TTL: '300',
  ResourceRecords: ['192.0.2.1'],
  ...extra,
});
const liveRec = (): Record<string, unknown> => ({
  Name: 'a.example.com.',
  Type: 'A',
  TTL: 300,
  ResourceRecords: [{ Value: '192.0.2.1' }],
});

const PUBLIC_ZONE = { Id: `/hostedzone/${ZONE}`, Name: 'example.com.', Config: { PrivateZone: false } };
const PRIVATE_ZONE = { Id: '/hostedzone/ZPRIV', Name: 'example.com.', Config: { PrivateZone: true } };

function route(zones: Array<Record<string, unknown>> = [PUBLIC_ZONE]): void {
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof ListHostedZonesByNameCommand) return { HostedZones: zones, IsTruncated: false };
    if (command instanceof ListResourceRecordSetsCommand) {
      return { ResourceRecordSets: [liveRec()], IsTruncated: false };
    }
    if (command instanceof ChangeResourceRecordSetsCommand) return {};
    throw new Error(`unexpected command ${String((command as object).constructor.name)}`);
  });
}

function calls<T>(cls: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof cls);
}
const changes = () => calls(ChangeResourceRecordSetsCommand).map((c) => c.input as { HostedZoneId: string });
const warned = (re: RegExp) => childLogger.warn.mock.calls.some((c) => re.test(String(c[0])));

/** Rejects with a ProvisioningError whose message matches, before any AWS call. */
async function expectRefused(p: Promise<unknown>, re: RegExp): Promise<void> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ProvisioningError);
  expect((error as Error).message).toMatch(re);
  expect(mockSend).not.toHaveBeenCalled();
}

const ZONE_NAME_REFUSAL = /HostedZoneName .* is not the zone's exact name/;

describe('RecordSet zone-name spelling (#6540)', () => {
  let provider: Route53Provider;
  const recordProps = (zoneName: string) => ({
    HostedZoneName: zoneName,
    Name: 'a.example.com.',
    Type: 'A',
    TTL: '300',
    ResourceRecords: ['192.0.2.1'],
  });
  const PID = `${ZONE}|a.example.com.|A`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    childLogger.child.mockReturnValue(childLogger);
    provider = new Route53Provider();
  });

  it.each([
    ['no trailing dot', 'example.com'],
    ['upper case', 'Example.com.'],
    ['both', 'EXAMPLE.COM'],
  ])('create refuses a HostedZoneName with %s, without printing a corrected spelling, before any AWS call', async (_n, name) => {
    route();
    const error = await provider.create('Rec', RECORD_TYPE, recordProps(name)).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ProvisioningError);
    const message = (error as Error).message;
    expect(message).toMatch(ZONE_NAME_REFUSAL);
    expect(message).toMatch(/resolves only the zone's lower-case name with its trailing dot/);
    // The refusal does not hand back the lower-cased, dotted name.
    expect(message).not.toContain('"example.com."');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('update refuses it the same way on a template path, before any AWS call', async () => {
    route();
    await expectRefused(
      provider.update('Rec', PID, RECORD_TYPE, recordProps('example.com'), recordProps('example.com.')),
      ZONE_NAME_REFUSAL
    );
  });

  it('create accepts the exact spelling and writes to the zone', async () => {
    route();
    await provider.create('Rec', RECORD_TYPE, recordProps('example.com.'));
    expect(changes()).toHaveLength(1);
    expect(changes()[0]!.HostedZoneId).toBe(ZONE);
  });

  it('create with replayingState warns and proceeds (normalized lookup)', async () => {
    route();
    await provider.create('Rec', RECORD_TYPE, recordProps('Example.com'), { replayingState: true });
    expect(warned(ZONE_NAME_REFUSAL)).toBe(true);
    expect(changes()).toHaveLength(1);
    expect(changes()[0]!.HostedZoneId).toBe(ZONE);
  });

  it.each([
    ['replayingState', { replayingState: true }],
    ['desiredFromAwsReadback', { desiredFromAwsReadback: true }],
  ])('update with %s warns and proceeds', async (_n, context) => {
    route();
    await provider.update('Rec', PID, RECORD_TYPE, recordProps('Example.com'), recordProps('example.com.'), context);
    expect(warned(ZONE_NAME_REFUSAL)).toBe(true);
    expect(changes()).toHaveLength(1);
  });

  it('create refuses a name matching two zones (split horizon) without a change call', async () => {
    route([PUBLIC_ZONE, PRIVATE_ZONE]);
    await expect(provider.create('Rec', RECORD_TYPE, recordProps('example.com.'))).rejects.toThrow(
      ProvisioningError
    );
    expect(changes()).toHaveLength(0);
  });

  it('update refuses a name matching two zones without a change call', async () => {
    route([PUBLIC_ZONE, PRIVATE_ZONE]);
    await expect(
      provider.update('Rec', PID, RECORD_TYPE, recordProps('example.com.'), { ...recordProps('example.com.'), TTL: '60' })
    ).rejects.toThrow(ProvisioningError);
    expect(changes()).toHaveLength(0);
  });
});

describe('RecordSetGroup CloudFormation shapes (#6540)', () => {
  let provider: Route53Provider;
  const PID = `${ZONE}|${GROUP}`;
  const byId = (records: unknown = [rec()]) => ({ HostedZoneId: ZONE, RecordSets: records });
  const byName = (name: string, records: unknown = [rec()]) => ({ HostedZoneName: name, RecordSets: records });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    childLogger.child.mockReturnValue(childLogger);
    provider = new Route53Provider();
  });

  describe('zone-name spelling', () => {
    it.each([
      ['no trailing dot', 'example.com'],
      ['upper case', 'Example.com.'],
    ])('create refuses a group HostedZoneName with %s before any AWS call', async (_n, name) => {
      route();
      await expectRefused(provider.create(GROUP, GROUP_TYPE, byName(name)), ZONE_NAME_REFUSAL);
    });

    it('update refuses it on a template path before any AWS call', async () => {
      route();
      await expectRefused(
        provider.update(GROUP, PID, GROUP_TYPE, byName('example.com'), byName('example.com.')),
        ZONE_NAME_REFUSAL
      );
    });

    it('create with replayingState warns and proceeds', async () => {
      route();
      const result = await provider.create(GROUP, GROUP_TYPE, byName('example.com'), { replayingState: true });
      expect(warned(ZONE_NAME_REFUSAL)).toBe(true);
      expect(result.physicalId).toBe(`${ZONE}|${GROUP}`);
    });

    it.each([
      ['replayingState', { replayingState: true }],
      ['desiredFromAwsReadback', { desiredFromAwsReadback: true }],
    ])('update with %s warns and proceeds', async (_n, context) => {
      route();
      await provider.update(
        GROUP,
        'MyStack-RecordGroup-abcdef012345',
        GROUP_TYPE,
        byName('example.com', [rec({ TTL: '60' })]),
        byName('example.com.'),
        context
      );
      expect(warned(ZONE_NAME_REFUSAL)).toBe(true);
      expect(changes()).toHaveLength(1);
    });

    it('create refuses a name matching two zones without a change call', async () => {
      route([PUBLIC_ZONE, PRIVATE_ZONE]);
      await expect(provider.create(GROUP, GROUP_TYPE, byName('example.com.'))).rejects.toThrow(ProvisioningError);
      expect(changes()).toHaveLength(0);
    });

    it('update (non-composite id) refuses a name matching two zones without a change call', async () => {
      route([PUBLIC_ZONE, PRIVATE_ZONE]);
      await expect(
        provider.update(GROUP, 'MyStack-RecordGroup-abcdef012345', GROUP_TYPE, byName('example.com.', [rec({ TTL: '60' })]), byName('example.com.'))
      ).rejects.toThrow(ProvisioningError);
      expect(changes()).toHaveLength(0);
    });
  });

  describe('refused shapes', () => {
    const cases: Array<[string, string, Record<string, unknown>, RegExp]> = [
      ['a record with HostedZoneId', 'RecordSets[0] declares', byId([rec({ HostedZoneId: ZONE })]), /RecordSets\[0\] declares a hosted zone/],
      ['a record with HostedZoneName', 'RecordSets[1] declares', byId([rec(), rec({ Name: 'b.example.com.', HostedZoneName: 'example.com.' })]), /RecordSets\[1\] declares a hosted zone/],
      ['neither zone key', 'neither', { RecordSets: [rec()] }, /exactly one of HostedZoneId and HostedZoneName must be specified \(the group names neither\)/],
      ['both zone keys', 'both', { HostedZoneId: ZONE, HostedZoneName: 'example.com.', RecordSets: [rec()] }, /exactly one of HostedZoneId and HostedZoneName must be specified \(the group names both\)/],
      ['an empty RecordSets', 'empty', byId([]), /RecordSets cannot be empty/],
      ['an absent RecordSets', 'absent', { HostedZoneId: ZONE }, /RecordSets cannot be empty/],
    ];

    it.each(cases)('create refuses %s before any AWS call', async (_n, _k, props, re) => {
      route();
      await expectRefused(provider.create(GROUP, GROUP_TYPE, props), re);
    });

    it.each(cases)('update refuses %s on a template path before any AWS call', async (_n, _k, props, re) => {
      route();
      await expectRefused(provider.update(GROUP, PID, GROUP_TYPE, props, byId()), re);
    });

    it.each(cases.filter(([, k]) => k !== 'empty' && k !== 'absent'))(
      'create with replayingState warns instead of refusing %s',
      async (_n, _k, props, re) => {
        route();
        // The refusal is downgraded to a warning; a later failure of its own (no zone
        // to resolve for "neither") is not the subject.
        await provider.create(GROUP, GROUP_TYPE, props, { replayingState: true }).catch(() => undefined);
        expect(warned(re)).toBe(true);
      }
    );

    it.each([
      ['an empty RecordSets', byId([]), /RecordSets cannot be empty/],
      ['a record with a zone key', byId([rec({ HostedZoneId: ZONE })]), /declares a hosted zone/],
    ])('update with replayingState warns instead of refusing %s', async (_n, props, re) => {
      route();
      await provider.update(GROUP, PID, GROUP_TYPE, props, byId(), { replayingState: true }).catch(() => undefined);
      expect(warned(re)).toBe(true);
    });

    it('update with desiredFromAwsReadback warns instead of refusing an empty RecordSets', async () => {
      route();
      await provider.update(GROUP, PID, GROUP_TYPE, byId([]), byId(), { desiredFromAwsReadback: true }).catch(() => undefined);
      expect(warned(/RecordSets cannot be empty/)).toBe(true);
    });
  });

  describe('generated group name', () => {
    const scope = (nameGenerations: ReadonlyMap<string, number> = new Map()) => ({
      stackName: 'Route53Stack',
      stackInstanceId: INSTANCE_ID,
      nameGenerations,
    });

    it('outside a stack scope the name is the bare logical id', async () => {
      route();
      const result = await provider.create(GROUP, GROUP_TYPE, byId());
      expect(result.physicalId).toBe(`${ZONE}|${GROUP}`);
    });

    it('inside a stack scope the name is <Stack>-<LogicalId>-<12 hex>', async () => {
      route();
      const result = await withStackScope(scope(), () => provider.create(GROUP, GROUP_TYPE, byId()));
      expect(result.physicalId).toMatch(new RegExp(`^${ZONE}\\|Route53Stack-${GROUP}-[0-9a-f]{12}$`));
    });

    it('update keeps the existing generated name, whatever the scope would now generate', async () => {
      route();
      const existing = `${ZONE}|Route53Stack-${GROUP}-abcdef012345`;
      const result = await withStackScope(scope(new Map([[GROUP, 1]])), () =>
        provider.update(GROUP, existing, GROUP_TYPE, byId([rec({ TTL: '60' })]), byId())
      );
      expect(result.physicalId).toBe(existing);
      expect(changes()[0]!.HostedZoneId).toBe(ZONE);
    });

    it('update keeps a bare logical-id name', async () => {
      route();
      const result = await provider.update(GROUP, PID, GROUP_TYPE, byId([rec({ TTL: '60' })]), byId());
      expect(result.physicalId).toBe(PID);
    });

    it('update of an adopted CloudFormation name (no zone segment) keeps the name under the resolved zone', async () => {
      route();
      const cfn = 'MyStack-RecordGroup-1A2B3C4D5E6F';
      const result = await provider.update(GROUP, cfn, GROUP_TYPE, byName('example.com.', [rec({ TTL: '60' })]), byName('example.com.'));
      expect(result.physicalId).toBe(`${ZONE}|${cfn}`);
    });

    it('import keeps a generated <Stack>-<LogicalId>-<suffix> composite', async () => {
      route();
      const known = `${ZONE}|Route53Stack-${GROUP}-abcdef012345`;
      const result = await provider.import({
        logicalId: GROUP,
        resourceType: GROUP_TYPE,
        stackName: 'Route53Stack',
        region: 'us-east-1',
        properties: byId(),
        knownPhysicalId: known,
      });
      expect(result).toEqual({ physicalId: known, attributes: {} });
      expect(calls(ListHostedZonesByNameCommand)).toHaveLength(0);
    });

    it('import keeps a CloudFormation group name, under the zone the template resolves', async () => {
      route();
      const cfn = 'Route53Stack-RecordGroup-1A2B3C4D5E6F';
      const result = await provider.import({
        logicalId: GROUP,
        resourceType: GROUP_TYPE,
        stackName: 'Route53Stack',
        region: 'us-east-1',
        properties: byName('example.com.'),
        knownPhysicalId: cfn,
      });
      expect(result).toEqual({ physicalId: `${ZONE}|${cfn}`, attributes: {} });
    });

    it('a foreign name `Z1|Other-Name` is not parsed as this group\'s: the zone comes from the template', async () => {
      route();
      await provider.update(GROUP, 'Z1|Other-Name', GROUP_TYPE, byName('example.com.', [rec({ TTL: '60' })]), byName('example.com.'));
      expect(calls(ListHostedZonesByNameCommand).length).toBeGreaterThan(0);
      expect(changes()[0]!.HostedZoneId).toBe(ZONE);
    });

    it('a composite carrying the logical id as a hyphen segment names the zone with no lookup', async () => {
      route();
      await provider.update(GROUP, 'ZABC|Stack-RecordGroup-abcdef012345', GROUP_TYPE, byName('example.com.', [rec({ TTL: '60' })]), byName('example.com.'));
      expect(calls(ListHostedZonesByNameCommand)).toHaveLength(0);
      expect(changes()[0]!.HostedZoneId).toBe('ZABC');
    });

    it('a name merely containing the logical id inside a segment is not this group\'s', async () => {
      route();
      await provider.update(GROUP, 'ZABC|Stack-MyRecordGroupX-abc', GROUP_TYPE, byName('example.com.', [rec({ TTL: '60' })]), byName('example.com.'));
      expect(changes()[0]!.HostedZoneId).toBe(ZONE);
    });
  });
});

describe('RecordSet state-borne update of a cdkd composite id (#6540)', () => {
  let provider: Route53Provider;
  const PID = `${ZONE}|a.example.com.|A`;
  const props = (extra: Record<string, unknown> = {}) => ({
    HostedZoneName: 'example.com.',
    Name: 'a.example.com.',
    Type: 'A',
    TTL: '300',
    ResourceRecords: ['192.0.2.1'],
    ...extra,
  });
  const CONTEXTS: Array<[string, Record<string, unknown>]> = [
    ['replayingState', { replayingState: true }],
    ['desiredFromAwsReadback', { desiredFromAwsReadback: true }],
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    childLogger.child.mockReturnValue(childLogger);
    provider = new Route53Provider();
  });

  it.each(CONTEXTS)('with %s uses the composite zone without ListHostedZonesByName', async (_n, context) => {
    route();
    await provider.update('Rec', PID, RECORD_TYPE, props({ TTL: '60' }), props(), context);
    expect(calls(ListHostedZonesByNameCommand)).toHaveLength(0);
    expect(changes()).toHaveLength(1);
    expect(changes()[0]!.HostedZoneId).toBe(ZONE);
  });

  it.each(CONTEXTS)('with %s a split-horizon name does not refuse', async (_n, context) => {
    route([PUBLIC_ZONE, PRIVATE_ZONE]);
    await provider.update('Rec', PID, RECORD_TYPE, props({ TTL: '60' }), props(), context);
    expect(changes()).toHaveLength(1);
    expect(changes()[0]!.HostedZoneId).toBe(ZONE);
  });

  it('a template-path update still refuses a split-horizon name, with no change call', async () => {
    route([PUBLIC_ZONE, PRIVATE_ZONE]);
    await expect(
      provider.update('Rec', PID, RECORD_TYPE, props({ TTL: '60' }), props())
    ).rejects.toThrow(ProvisioningError);
    expect(changes()).toHaveLength(0);
  });

  it('replayingState with a composite whose Name/Type disagree with the previous bag resolves the template zone, not the composite zone', async () => {
    route();
    const www = props({ Name: 'www.example.com.', TTL: '60' });
    await provider.update('Rec', 'ZCOMP|other.example.com.|A', RECORD_TYPE, www, props({ Name: 'www.example.com.' }), {
      replayingState: true,
    });
    expect(calls(ListHostedZonesByNameCommand).length).toBeGreaterThan(0);
    const sent = changes();
    expect(sent.length).toBeGreaterThan(0);
    for (const c of sent) expect(c.HostedZoneId).toBe(ZONE);
    expect(sent.map((c) => c.HostedZoneId)).not.toContain('ZCOMP');
  });

  it('replayingState with a CloudFormation-form id (the record name) runs the zone lookup', async () => {
    route();
    await provider.update(
      'Rec',
      'www.example.com.',
      RECORD_TYPE,
      props({ Name: 'www.example.com.', TTL: '60' }),
      props({ Name: 'www.example.com.' }),
      { replayingState: true }
    );
    expect(calls(ListHostedZonesByNameCommand).length).toBeGreaterThan(0);
    expect(changes().length).toBeGreaterThan(0);
    expect(changes()[0]!.HostedZoneId).toBe(ZONE);
  });

  it('a state-borne update whose zone reference CHANGED still resolves the name', async () => {
    route();
    await provider.update(
      'Rec',
      PID,
      RECORD_TYPE,
      props({ TTL: '60' }),
      { ...props(), HostedZoneName: undefined, HostedZoneId: ZONE },
      { replayingState: true }
    );
    expect(calls(ListHostedZonesByNameCommand).length).toBeGreaterThan(0);
  });
});

describe('RecordSetGroup CloudFormation refusals come first, and replay downgrades (#6540 round 2)', () => {
  let provider: Route53Provider;
  const PID = `${ZONE}|${GROUP}`;
  const byId = (records: unknown = [rec()]) => ({ HostedZoneId: ZONE, RecordSets: records });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    childLogger.child.mockReturnValue(childLogger);
    provider = new Route53Provider();
  });

  // A record whose zone differs from the group's would be cdkd's "differs" refusal;
  // CloudFormation's own message comes first.
  const DIFFERING = byId([rec({ HostedZoneId: 'Z9999999999' })]);

  it('create: a record zone key differing from the group\'s gets the CloudFormation message', async () => {
    route();
    const error = await provider.create(GROUP, GROUP_TYPE, DIFFERING).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((error as Error).message).toMatch(/RecordSets\[0\] declares a hosted zone.*unsupported property/);
    expect((error as Error).message).not.toMatch(/differs/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('update: a record zone key differing from the group\'s gets the CloudFormation message', async () => {
    route();
    const error = await provider.update(GROUP, PID, GROUP_TYPE, DIFFERING, byId()).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((error as Error).message).toMatch(/RecordSets\[0\] declares a hosted zone.*unsupported property/);
    expect((error as Error).message).not.toMatch(/differs/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // G1
  it.each([
    ['empty', byId([])],
    ['absent', { HostedZoneId: ZONE }],
  ])('create with replayingState and %s RecordSets warns, writes nothing and returns an id', async (_n, props) => {
    route();
    const result = await provider.create(GROUP, GROUP_TYPE, props, { replayingState: true });
    expect(warned(/RecordSets cannot be empty/)).toBe(true);
    expect(changes()).toHaveLength(0);
    expect(result.physicalId).toBe(`${ZONE}|${GROUP}`);
  });

  // G2
  it('create with replayingState and record-level zone keys warns, writes to the group zone, sends no zone key', async () => {
    route();
    const result = await provider.create(
      GROUP,
      GROUP_TYPE,
      byId([rec({ HostedZoneId: ZONE }), rec({ Name: 'b.example.com.', HostedZoneName: 'example.com.' })]),
      { replayingState: true }
    );
    expect(warned(/RecordSets\[0\] declares a hosted zone/)).toBe(true);
    expect(result.physicalId).toBe(`${ZONE}|${GROUP}`);
    const sent = calls(ChangeResourceRecordSetsCommand).map((c) => c.input as never as {
      HostedZoneId: string;
      ChangeBatch: { Changes: Array<{ ResourceRecordSet: Record<string, unknown> }> };
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.HostedZoneId).toBe(ZONE);
    expect(sent[0]!.ChangeBatch.Changes).toHaveLength(2);
    for (const c of sent[0]!.ChangeBatch.Changes) {
      expect(c.ResourceRecordSet).not.toHaveProperty('HostedZoneId');
      expect(c.ResourceRecordSet).not.toHaveProperty('HostedZoneName');
    }
  });

  it('create with replayingState and records declaring the zone (no group zone) writes to the zone the records declare', async () => {
    route();
    const result = await provider.create(
      GROUP,
      GROUP_TYPE,
      { RecordSets: [rec({ HostedZoneId: 'Z9' }), rec({ Name: 'b.example.com.', HostedZoneId: 'Z9' })] },
      { replayingState: true }
    );
    expect(warned(/declares a hosted zone/)).toBe(true);
    expect(warned(/exactly one of HostedZoneId and HostedZoneName/)).toBe(true);
    expect(result.physicalId).toBe(`Z9|${GROUP}`);
    expect(changes()[0]!.HostedZoneId).toBe('Z9');
    for (const c of calls(ChangeResourceRecordSetsCommand)) {
      for (const ch of (c.input as never as { ChangeBatch: { Changes: Array<{ ResourceRecordSet: object }> } }).ChangeBatch.Changes) {
        expect(ch.ResourceRecordSet).not.toHaveProperty('HostedZoneId');
      }
    }
  });

  it('update with replayingState and a record-level zone key warns and writes to the group zone with no zone key on the wire', async () => {
    route();
    await provider.update(GROUP, PID, GROUP_TYPE, byId([rec({ TTL: '60', HostedZoneId: ZONE })]), byId(), {
      replayingState: true,
    });
    expect(warned(/declares a hosted zone/)).toBe(true);
    expect(changes()).toHaveLength(1);
    expect(changes()[0]!.HostedZoneId).toBe(ZONE);
    const batch = (calls(ChangeResourceRecordSetsCommand)[0]!.input as never as {
      ChangeBatch: { Changes: Array<{ ResourceRecordSet: object }> };
    }).ChangeBatch;
    for (const ch of batch.Changes) {
      expect(ch.ResourceRecordSet).not.toHaveProperty('HostedZoneId');
      expect(ch.ResourceRecordSet).not.toHaveProperty('HostedZoneName');
    }
  });

  // A2: proceed-vs-throw is explicit for neither / both.
  it('create with replayingState and NEITHER zone key warns, then throws for the unresolvable zone (no AWS write)', async () => {
    route();
    await expect(
      provider.create(GROUP, GROUP_TYPE, { RecordSets: [rec()] }, { replayingState: true })
    ).rejects.toThrow(ProvisioningError);
    expect(warned(/exactly one of HostedZoneId and HostedZoneName must be specified \(the group names neither\)/)).toBe(true);
    expect(changes()).toHaveLength(0);
  });

  it('create with replayingState and BOTH zone keys warns and proceeds', async () => {
    route();
    const result = await provider.create(
      GROUP,
      GROUP_TYPE,
      { HostedZoneId: ZONE, HostedZoneName: 'example.com.', RecordSets: [rec()] },
      { replayingState: true }
    );
    expect(warned(/exactly one of HostedZoneId and HostedZoneName must be specified \(the group names both\)/)).toBe(true);
    expect(result.physicalId).toBe(`${ZONE}|${GROUP}`);
    expect(changes()).toHaveLength(1);
  });

  // G3
  it.each([
    ['an empty name', `${ZONE}|`],
    ['three segments', 'a|b|c'],
  ])('update of a foreign id with %s falls back to the logical id as the group name', async (_n, existing) => {
    route();
    const result = await provider.update(
      GROUP,
      existing,
      GROUP_TYPE,
      { HostedZoneName: 'example.com.', RecordSets: [rec({ TTL: '60' })] },
      { HostedZoneName: 'example.com.', RecordSets: [rec()] }
    );
    expect(result.physicalId).toBe(`${ZONE}|${GROUP}`);
  });

  it('update of a foreign two-segment id keeps its plain name segment', async () => {
    route();
    const result = await provider.update(
      GROUP,
      'Z1|OtherGroup',
      GROUP_TYPE,
      { HostedZoneName: 'example.com.', RecordSets: [rec({ TTL: '60' })] },
      { HostedZoneName: 'example.com.', RecordSets: [rec()] }
    );
    expect(result.physicalId).toBe(`${ZONE}|OtherGroup`);
  });
});
