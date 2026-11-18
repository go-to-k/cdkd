import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// AWS::Route53::RecordSetGroup: one ChangeResourceRecordSets batch per write,
// composite physicalId `<zoneId>|<logicalId>`.

const mockSend = vi.fn();
const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual('@aws-sdk/client-route-53');
  return {
    ...actual,
    Route53Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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
  GetHostedZoneCommand,
} from '@aws-sdk/client-route-53';
import { isNameCollisionErrorFrom } from '../../../src/deployment/retryable-errors.js';
import { CNAME_CONFLICT_COLLISION_NOTE } from '../../../src/provisioning/providers/route53/shared.js';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::Route53::RecordSetGroup';
const ZONE = 'Z1234567890';
const ZONE_NAME = 'example.com';
const LOGICAL = 'Group';
const COMPOSITE = `${ZONE}|${LOGICAL}`;

function rec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { Name: 'a.example.com.', Type: 'A', TTL: '300', ResourceRecords: ['192.0.2.1'], ...overrides };
}

/** The live (SDK-shaped) record for a recorded bag. */
function live(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Name: 'a.example.com.',
    Type: 'A',
    TTL: 900,
    ResourceRecords: [{ Value: '198.51.100.9' }],
    ...overrides,
  };
}

interface Route {
  zones?: Array<Record<string, unknown>>;
  liveRecords?: Array<Record<string, unknown>>;
  /** Called for each ChangeResourceRecordSets; may throw. */
  change?: (input: Record<string, unknown>) => unknown;
  listError?: Error;
}

function route(r: Route = {}): void {
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof ListHostedZonesByNameCommand) {
      return {
        HostedZones: r.zones ?? [
          { Id: `/hostedzone/${ZONE}`, Name: `${ZONE_NAME}.`, Config: { PrivateZone: false } },
        ],
        IsTruncated: false,
      };
    }
    if (command instanceof ListResourceRecordSetsCommand) {
      if (r.listError) throw r.listError;
      return { ResourceRecordSets: r.liveRecords ?? [], IsTruncated: false };
    }
    if (command instanceof ChangeResourceRecordSetsCommand) {
      return r.change ? r.change(command.input as unknown as Record<string, unknown>) : {};
    }
    throw new Error(`unexpected command ${String((command as object).constructor.name)}`);
  });
}

function calls<T>(cls: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof cls);
}
const changeInputs = (): Array<{
  HostedZoneId: string;
  ChangeBatch: { Comment?: string; Changes: Array<{ Action: string; ResourceRecordSet: Record<string, unknown> }> };
}> => calls(ChangeResourceRecordSetsCommand).map((c) => c.input as never);

function awsError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe('Route53Provider RecordSetGroup', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new Route53Provider();
  });

  describe('create', () => {
    it('sends one batch of one CREATE per record, zone from HostedZoneId, comment forwarded, per-record zone keys stripped', async () => {
      route();
      const result = await provider.create(LOGICAL, TYPE, {
        HostedZoneId: ZONE,
        Comment: 'grp comment',
        RecordSets: [
          rec({ HostedZoneId: ZONE }),
          rec({ Name: 'b.example.com.', Type: 'CNAME', ResourceRecords: ['a.example.com'], HostedZoneName: 'example.com.' , HostedZoneId: ZONE }),
        ],
      });
      expect(result.physicalId).toBe(COMPOSITE);
      expect(calls(ListHostedZonesByNameCommand)).toHaveLength(0);
      const sent = changeInputs();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.HostedZoneId).toBe(ZONE);
      expect(sent[0]!.ChangeBatch.Comment).toBe('grp comment');
      expect(sent[0]!.ChangeBatch.Changes).toEqual([
        {
          Action: 'CREATE',
          ResourceRecordSet: {
            Name: 'a.example.com.',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '192.0.2.1' }],
          },
        },
        {
          Action: 'CREATE',
          ResourceRecordSet: {
            Name: 'b.example.com.',
            Type: 'CNAME',
            TTL: 300,
            ResourceRecords: [{ Value: 'a.example.com' }],
          },
        },
      ]);
      for (const c of sent[0]!.ChangeBatch.Changes) {
        expect(c.ResourceRecordSet).not.toHaveProperty('HostedZoneId');
        expect(c.ResourceRecordSet).not.toHaveProperty('HostedZoneName');
      }
    });

    it('resolves HostedZoneName via ListHostedZonesByName and omits Comment when absent', async () => {
      route();
      const result = await provider.create(LOGICAL, TYPE, {
        HostedZoneName: 'example.com.',
        RecordSets: [rec()],
      });
      expect(result.physicalId).toBe(COMPOSITE);
      expect(calls(ListHostedZonesByNameCommand)).toHaveLength(1);
      const sent = changeInputs();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.HostedZoneId).toBe(ZONE);
      expect(sent[0]!.ChangeBatch).not.toHaveProperty('Comment');
    });

    it.each([
      ['empty list', { HostedZoneId: ZONE, RecordSets: [] }],
      ['absent list', { HostedZoneId: ZONE }],
    ])('makes no ChangeResourceRecordSets call for %s', async (_n, props) => {
      route();
      const result = await provider.create(LOGICAL, TYPE, props);
      expect(result.physicalId).toBe(COMPOSITE);
      expect(changeInputs()).toHaveLength(0);
    });

    it.each([
      ['RecordSets not a list', { HostedZoneId: ZONE, RecordSets: 'nope' }, /RecordSets is not a list/],
      ['entry not an object', { HostedZoneId: ZONE, RecordSets: ['x'] }, /RecordSets\[0\] is not an object/],
      ['record without Name', { HostedZoneId: ZONE, RecordSets: [{ Type: 'A' }] }, /needs a plain string Name and Type/],
      ['record without Type', { HostedZoneId: ZONE, RecordSets: [{ Name: 'a.example.com.' }] }, /needs a plain string Name and Type/],
      ['record with non-string Name', { HostedZoneId: ZONE, RecordSets: [{ Name: { Ref: 'X' }, Type: 'A' }] }, /needs a plain string Name and Type/],
      [
        'record in a different zone',
        { HostedZoneId: ZONE, RecordSets: [rec({ HostedZoneId: 'Z999' })] },
        /every record of a RecordSetGroup must be in one hosted zone/,
      ],
    ])('refuses %s before any AWS call', async (_n, props, needle) => {
      route();
      await expect(provider.create(LOGICAL, TYPE, props)).rejects.toThrow(needle);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('wraps a Route 53 refusal in a ProvisioningError', async () => {
      route({ change: () => { throw awsError('InvalidChangeBatch', 'already exists'); } });
      await expect(
        provider.create(LOGICAL, TYPE, { HostedZoneId: ZONE, RecordSets: [rec()] })
      ).rejects.toBeInstanceOf(ProvisioningError);
    });
  });

  describe('update', () => {
    const base = (records: Record<string, unknown>[]) => ({ HostedZoneId: ZONE, RecordSets: records });

    it('CREATEs an added key', async () => {
      route();
      const added = rec({ Name: 'new.example.com.' });
      const result = await provider.update(LOGICAL, COMPOSITE, TYPE, base([rec(), added]), base([rec()]));
      expect(result.physicalId).toBe(COMPOSITE);
      const sent = changeInputs();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.ChangeBatch.Changes).toEqual([
        {
          Action: 'CREATE',
          ResourceRecordSet: {
            Name: 'new.example.com.',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '192.0.2.1' }],
          },
        },
      ]);
    });

    it('UPSERTs a changed value on the same key, comparing the name without trailing dot or case', async () => {
      route();
      await provider.update(
        LOGICAL,
        COMPOSITE,
        TYPE,
        base([rec({ Name: 'A.Example.com', ResourceRecords: ['192.0.2.2'] })]),
        base([rec()])
      );
      const sent = changeInputs();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.ChangeBatch.Changes).toHaveLength(1);
      expect(sent[0]!.ChangeBatch.Changes[0]!.Action).toBe('UPSERT');
      expect(sent[0]!.ChangeBatch.Changes[0]!.ResourceRecordSet['ResourceRecords']).toEqual([
        { Value: '192.0.2.2' },
      ]);
      // key matched: no live lookup for a removal
      expect(calls(ListResourceRecordSetsCommand)).toHaveLength(0);
    });

    it('sends no change call when nothing changed', async () => {
      route();
      await provider.update(LOGICAL, COMPOSITE, TYPE, base([rec()]), base([rec()]));
      expect(changeInputs()).toHaveLength(0);
    });

    it('treats a different SetIdentifier as a different key (DELETE old + CREATE new)', async () => {
      route({ liveRecords: [live({ SetIdentifier: 'one', Weight: 1 })] });
      await provider.update(
        LOGICAL,
        COMPOSITE,
        TYPE,
        base([rec({ SetIdentifier: 'two', Weight: 1 })]),
        base([rec({ SetIdentifier: 'one', Weight: 1 })])
      );
      const changes = changeInputs()[0]!.ChangeBatch.Changes;
      expect(changes.map((c) => c.Action)).toEqual(['DELETE', 'CREATE']);
      expect(changes[0]!.ResourceRecordSet['SetIdentifier']).toBe('one');
      expect(changes[1]!.ResourceRecordSet['SetIdentifier']).toBe('two');
    });

    it('DELETEs a removed key with the LIVE record, ordered before the other changes in one batch', async () => {
      const liveOld = live({ Name: 'old.example.com.' });
      route({ liveRecords: [liveOld] });
      await provider.update(
        LOGICAL,
        COMPOSITE,
        TYPE,
        base([rec({ Name: 'new.example.com.' }), rec({ Name: 'kept.example.com.', TTL: '60' })]),
        base([rec({ Name: 'kept.example.com.' }), rec({ Name: 'old.example.com.' })])
      );
      const sent = changeInputs();
      expect(sent).toHaveLength(1);
      const changes = sent[0]!.ChangeBatch.Changes;
      expect(changes.map((c) => c.Action)).toEqual(['DELETE', 'CREATE', 'UPSERT']);
      // live values (TTL 900 / 198.51.100.9), not the recorded 300 / 192.0.2.1
      expect(changes[0]!.ResourceRecordSet).toEqual(liveOld);
    });

    it('skips the DELETE for a removed record that is not live', async () => {
      route({ liveRecords: [] });
      await provider.update(LOGICAL, COMPOSITE, TYPE, base([rec()]), base([rec(), rec({ Name: 'gone.example.com.' })]));
      expect(calls(ListResourceRecordSetsCommand)).toHaveLength(1);
      expect(changeInputs()).toHaveLength(0);
    });

    it('takes the zone from the physicalId composite without ListHostedZonesByName', async () => {
      route();
      await provider.update(
        LOGICAL,
        COMPOSITE,
        TYPE,
        { HostedZoneName: 'example.com.', RecordSets: [rec({ TTL: '60' })] },
        { HostedZoneName: 'example.com.', RecordSets: [rec()] }
      );
      expect(calls(ListHostedZonesByNameCommand)).toHaveLength(0);
      expect(changeInputs()[0]!.HostedZoneId).toBe(ZONE);
    });

    it('forwards the group Comment on the batch', async () => {
      route();
      await provider.update(
        LOGICAL,
        COMPOSITE,
        TYPE,
        { ...base([rec({ TTL: '60' })]), Comment: 'c2' },
        base([rec()])
      );
      expect(changeInputs()[0]!.ChangeBatch.Comment).toBe('c2');
    });

    it('throws before any change call when a recorded record has no readable Name', async () => {
      route();
      await expect(
        provider.update(LOGICAL, COMPOSITE, TYPE, base([rec()]), base([{ Type: 'A', TTL: '300' }]))
      ).rejects.toThrow(/recorded RecordSets\[0\] has no readable Name/);
      expect(changeInputs()).toHaveLength(0);
    });
  });

  describe('delete', () => {
    const props = (records: Record<string, unknown>[]) => ({ HostedZoneId: ZONE, RecordSets: records });

    it('deletes all live records in ONE batch with the live values', async () => {
      const liveA = live();
      const liveB = live({ Name: 'b.example.com.' });
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof ListResourceRecordSetsCommand) {
          const start = String((command.input as { StartRecordName?: string }).StartRecordName);
          return { ResourceRecordSets: start.startsWith('b') ? [liveB] : [liveA], IsTruncated: false };
        }
        return {};
      });
      const result = await provider.delete(
        LOGICAL,
        COMPOSITE,
        TYPE,
        props([rec(), rec({ Name: 'b.example.com.' })])
      );
      expect(result).toBeUndefined();
      const sent = changeInputs();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.HostedZoneId).toBe(ZONE);
      expect(sent[0]!.ChangeBatch.Changes).toEqual([
        { Action: 'DELETE', ResourceRecordSet: liveA },
        { Action: 'DELETE', ResourceRecordSet: liveB },
      ]);
    });

    it('deletes a record the lookup does not find with its recorded values', async () => {
      route({ liveRecords: [] });
      await provider.delete(LOGICAL, COMPOSITE, TYPE, props([rec()]));
      expect(changeInputs()[0]!.ChangeBatch.Changes).toEqual([
        {
          Action: 'DELETE',
          ResourceRecordSet: {
            Name: 'a.example.com.',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '192.0.2.1' }],
          },
        },
      ]);
    });

    it('falls back to per-record deletes on a batch "not found", swallowing per-record "not found"', async () => {
      let n = 0;
      route({
        liveRecords: [live()],
        change: (input) => {
          n++;
          const count = (input as { ChangeBatch: { Changes: unknown[] } }).ChangeBatch.Changes.length;
          if (count > 1) throw awsError('InvalidChangeBatch', 'Tried to delete resource record set but it was not found');
          if (n === 2) throw awsError('InvalidChangeBatch', 'but it was not found');
          return {};
        },
      });
      await provider.delete(
        LOGICAL,
        COMPOSITE,
        TYPE,
        props([rec(), rec({ Name: 'b.example.com.' })])
      );
      const sent = changeInputs();
      expect(sent.map((s) => s.ChangeBatch.Changes.length)).toEqual([2, 1, 1]);
    });

    it('throws a non-"not found" per-record error', async () => {
      route({
        liveRecords: [live()],
        change: (input) => {
          const count = (input as { ChangeBatch: { Changes: unknown[] } }).ChangeBatch.Changes.length;
          if (count > 1) throw awsError('InvalidChangeBatch', 'it was not found');
          throw awsError('AccessDenied', 'denied');
        },
      });
      await expect(
        provider.delete(LOGICAL, COMPOSITE, TYPE, props([rec(), rec({ Name: 'b.example.com.' })]))
      ).rejects.toThrow(/Failed to delete record set group/);
    });

    it('returns normally on NoSuchHostedZone', async () => {
      route({ change: () => { throw awsError('NoSuchHostedZone', 'no zone'); } });
      await expect(provider.delete(LOGICAL, COMPOSITE, TYPE, props([rec()]))).resolves.toBeUndefined();
    });

    it('resolves the zone from HostedZoneName for a non-composite physicalId', async () => {
      route({ liveRecords: [live()] });
      await provider.delete(LOGICAL, 'MyStack-Group-ABC', TYPE, {
        HostedZoneName: 'example.com.',
        RecordSets: [rec()],
      });
      expect(calls(ListHostedZonesByNameCommand)).toHaveLength(1);
      expect(changeInputs()[0]!.HostedZoneId).toBe(ZONE);
    });

    it('refuses a non-composite physicalId whose zone name matches two zones', async () => {
      route({
        zones: [
          { Id: '/hostedzone/ZPUB', Name: 'example.com.', Config: { PrivateZone: false } },
          { Id: '/hostedzone/ZPRIV', Name: 'example.com.', Config: { PrivateZone: true } },
        ],
      });
      await expect(
        provider.delete(LOGICAL, 'MyStack-Group-ABC', TYPE, {
          HostedZoneName: 'example.com.',
          RecordSets: [rec()],
        })
      ).rejects.toThrow(/matches 2 hosted zones/);
      expect(changeInputs()).toHaveLength(0);
    });

    it('returns normally when the zone name matches no zone (sound negative)', async () => {
      route({ zones: [] });
      await expect(
        provider.delete(LOGICAL, 'MyStack-Group-ABC', TYPE, {
          HostedZoneName: 'example.com.',
          RecordSets: [rec()],
        })
      ).resolves.toBeUndefined();
      expect(changeInputs()).toHaveLength(0);
    });

    it('skips (no change call) when the recorded identity holds a redacted dynamic reference', async () => {
      route();
      const result = await provider.delete(
        LOGICAL,
        COMPOSITE,
        TYPE,
        props([rec({ Name: '{{resolve:secretsmanager:x}}' })])
      );
      expect(result).toMatchObject({ outcome: 'skipped' });
      expect(changeInputs()).toHaveLength(0);
    });
  });

  describe('readCurrentState', () => {
    it('returns { RecordSets } in recorded order without per-record HostedZoneId unless declared', async () => {
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof ListResourceRecordSetsCommand) {
          const start = String((command.input as { StartRecordName?: string }).StartRecordName);
          return {
            ResourceRecordSets: [
              start.startsWith('b')
                ? live({ Name: 'b.example.com.', TTL: 60, ResourceRecords: [{ Value: '192.0.2.2' }] })
                : live({ TTL: 300, ResourceRecords: [{ Value: '192.0.2.1' }] }),
            ],
            IsTruncated: false,
          };
        }
        return {};
      });
      const out = (await provider.readCurrentState(COMPOSITE, LOGICAL, TYPE, {
        HostedZoneId: ZONE,
        RecordSets: [rec(), rec({ Name: 'b.example.com.', HostedZoneId: ZONE })],
      })) as { RecordSets: Array<Record<string, unknown>> };
      expect(out.RecordSets).toHaveLength(2);
      expect(out.RecordSets[0]!['Name']).toBe('a.example.com.');
      expect(out.RecordSets[0]).not.toHaveProperty('HostedZoneId');
      expect(out.RecordSets[1]!['Name']).toBe('b.example.com.');
      expect(out.RecordSets[1]!['HostedZoneId']).toBe(ZONE);
    });

    it('returns undefined when a recorded record is missing from the lookup', async () => {
      route({ liveRecords: [] });
      const out = await provider.readCurrentState(COMPOSITE, LOGICAL, TYPE, {
        HostedZoneId: ZONE,
        RecordSets: [rec()],
      });
      expect(out).toBeUndefined();
      expect(out).not.toBe(RESOURCE_NOT_FOUND);
    });
  });

  describe('import', () => {
    const input = (known: string | undefined) => ({
      logicalId: LOGICAL,
      resourceType: TYPE,
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { HostedZoneName: 'example.com.', RecordSets: [rec()] },
      knownPhysicalId: known,
    });

    it('returns null without a knownPhysicalId', async () => {
      route();
      expect(await provider.import(input(undefined))).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('records the composite id when the CFn group name is given and every record is live', async () => {
      route({ liveRecords: [live()] });
      const result = await provider.import(input('MyStack-Group-ABC'));
      expect(result).toEqual({ physicalId: COMPOSITE, attributes: {} });
    });

    it('adopts the known id verbatim when a record is missing', async () => {
      route({ liveRecords: [] });
      const result = await provider.import(input('MyStack-Group-ABC'));
      expect(result).toEqual({ physicalId: 'MyStack-Group-ABC', attributes: {} });
    });
  });
});

describe('Route53Provider RecordSetGroup (review additions)', () => {
  let provider: Route53Provider;
  const props = (records: Record<string, unknown>[]) => ({ HostedZoneId: ZONE, RecordSets: records });
  const TWO_ZONES = [
    { Id: '/hostedzone/ZPUB', Name: 'example.com.', Config: { PrivateZone: false } },
    { Id: '/hostedzone/ZPRIV', Name: 'example.com.', Config: { PrivateZone: true } },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    childLogger.child.mockReturnValue(childLogger);
    provider = new Route53Provider();
  });

  describe('redacted identity (cdkd *** mask)', () => {
    it.each([
      ['SetIdentifier', { SetIdentifier: '***', Weight: 1 }],
      ['Name', { Name: '***' }],
    ])('delete with a recorded %s of *** is skipped without any change call', async (_n, o) => {
      route();
      const result = await provider.delete(LOGICAL, COMPOSITE, TYPE, props([rec(o)]));
      expect(result).toMatchObject({ outcome: 'skipped' });
      expect(changeInputs()).toHaveLength(0);
    });

    it.each([
      ['SetIdentifier', { SetIdentifier: '***', Weight: 1 }],
      ['Name', { Name: '***' }],
    ])('update with a recorded %s of *** throws before any change call', async (_n, o) => {
      route();
      await expect(
        provider.update(LOGICAL, COMPOSITE, TYPE, props([rec()]), props([rec(o)]))
      ).rejects.toThrow(/recorded RecordSets\[0\] has no readable Name/);
      expect(changeInputs()).toHaveLength(0);
    });
  });

  describe('composite id must carry the group own logical id', () => {
    it('delete with Z1|OtherGroup resolves the zone from HostedZoneName', async () => {
      route({ liveRecords: [live()] });
      await provider.delete(LOGICAL, 'Z1|OtherGroup', TYPE, {
        HostedZoneName: 'example.com.',
        RecordSets: [rec()],
      });
      expect(calls(ListHostedZonesByNameCommand)).toHaveLength(1);
      const sent = changeInputs();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.HostedZoneId).toBe(ZONE);
    });
  });

  describe('import', () => {
    const input = (known: string, logicalId = 'Grp') => ({
      logicalId,
      resourceType: TYPE,
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { HostedZoneName: 'example.com.', RecordSets: [rec()] },
      knownPhysicalId: known,
    });

    it('declines (null, with a warning) a known composite whose records are not found', async () => {
      route({ liveRecords: [] });
      expect(await provider.import(input('Zwrong|Grp'))).toBeNull();
      expect(childLogger.warn).toHaveBeenCalledTimes(1);
      expect(String(childLogger.warn.mock.calls[0]![0])).toContain('Not importing it');
    });

    it('adopts a known composite that verifies', async () => {
      route({ liveRecords: [live()] });
      expect(await provider.import(input(`${ZONE}|Grp`))).toEqual({
        physicalId: `${ZONE}|Grp`,
        attributes: {},
      });
    });

    it('adopts a non-composite id verbatim when verification throws', async () => {
      route({ listError: awsError('AccessDenied', 'denied') });
      expect(await provider.import(input('MyStack-Grp-ABC'))).toEqual({
        physicalId: 'MyStack-Grp-ABC',
        attributes: {},
      });
      expect(childLogger.warn).toHaveBeenCalledTimes(1);
    });

    it('adopts a non-composite id verbatim when the zone name is ambiguous', async () => {
      route({ zones: TWO_ZONES });
      expect(await provider.import(input('MyStack-Grp-ABC'))).toEqual({
        physicalId: 'MyStack-Grp-ABC',
        attributes: {},
      });
      expect(calls(ListResourceRecordSetsCommand)).toHaveLength(0);
    });
  });

  describe('update', () => {
    const added = { Name: 'new.example.com', Type: 'A', TTL: 300, ResourceRecords: ['192.0.2.1'] };

    it('does not CREATE an added record already live with exactly the desired values', async () => {
      route({
        liveRecords: [
          { Name: 'new.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '192.0.2.1' }] },
        ],
      });
      await provider.update(LOGICAL, COMPOSITE, TYPE, props([rec(), added]), props([rec()]));
      expect(calls(ListResourceRecordSetsCommand)).toHaveLength(1);
      expect(changeInputs()).toHaveLength(0);
    });

    it('CREATEs an added record that is live with DIFFERENT values', async () => {
      route({
        liveRecords: [
          { Name: 'new.example.com.', Type: 'A', TTL: 900, ResourceRecords: [{ Value: '198.51.100.9' }] },
        ],
      });
      await provider.update(LOGICAL, COMPOSITE, TYPE, props([rec(), added]), props([rec()]));
      const sent = changeInputs();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.ChangeBatch.Changes).toEqual([
        {
          Action: 'CREATE',
          ResourceRecordSet: {
            Name: 'new.example.com',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '192.0.2.1' }],
          },
        },
      ]);
    });

    it('warns and sends no DELETE for a removed record not found live', async () => {
      route({ liveRecords: [] });
      await provider.update(
        LOGICAL,
        COMPOSITE,
        TYPE,
        props([rec()]),
        props([rec(), rec({ Name: 'gone.example.com.' })])
      );
      expect(childLogger.warn).toHaveBeenCalledTimes(1);
      expect(String(childLogger.warn.mock.calls[0]![0])).toContain('was not found in');
      expect(changeInputs()).toHaveLength(0);
    });

    it.each([['/hostedzone/Z2'], ['Z2']])(
      'throws before any change call when the desired HostedZoneId is %s but the composite names Z1',
      async (desiredZone) => {
        route();
        await expect(
          provider.update(
            LOGICAL,
            COMPOSITE,
            TYPE,
            { HostedZoneId: desiredZone, RecordSets: [rec({ TTL: '60' })] },
            props([rec()])
          )
        ).rejects.toThrow(
          new RegExp(`the template's hosted zone differs from the one its records are in \\(${ZONE}\\)`)
        );
        expect(changeInputs()).toHaveLength(0);
      }
    );

    it('proceeds when the desired HostedZoneId (/hostedzone/ spelling) equals the composite zone', async () => {
      route();
      await provider.update(
        LOGICAL,
        COMPOSITE,
        TYPE,
        { HostedZoneId: `/hostedzone/${ZONE}`, RecordSets: [rec({ TTL: '60' })] },
        props([rec()])
      );
      const sent = changeInputs();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.HostedZoneId).toBe(ZONE);
      expect(sent[0]!.ChangeBatch.Changes[0]!.Action).toBe('UPSERT');
    });

    it('wraps a failed ChangeResourceRecordSets and applies maskSecrets', async () => {
      route({ change: () => { throw new Error('rejected value hunter2-secret'); } });
      const err = await provider
        .update(LOGICAL, COMPOSITE, TYPE, props([rec({ TTL: '60' })]), props([rec()]), {
          maskSecrets: (t: string) => t.replace('hunter2-secret', '***'),
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProvisioningError);
      expect((err as Error).message).toBe(
        'Failed to update record set group Group: rejected value ***'
      );
      expect(changeInputs()).toHaveLength(1);
    });

    it('refuses a non-composite physicalId whose HostedZoneName matches 2 zones', async () => {
      route({ zones: TWO_ZONES });
      await expect(
        provider.update(
          LOGICAL,
          'MyStack-Group-ABC',
          TYPE,
          { HostedZoneName: 'example.com.', RecordSets: [rec({ TTL: '60' })] },
          { HostedZoneName: 'example.com.', RecordSets: [rec()] }
        )
      ).rejects.toThrow(/matches 2 hosted zones/);
      expect(changeInputs()).toHaveLength(0);
    });
  });

  describe('delete', () => {
    const notFound = (name = 'a.example.com.') =>
      awsError(
        'InvalidChangeBatch',
        `Tried to delete resource record set [name='${name}', type='A'] but it was not found`
      );
    const two = () => props([rec(), rec({ Name: 'b.example.com.' })]);

    it('throws on a batch refusal that is not "not found", after exactly one change call', async () => {
      route({
        liveRecords: [live()],
        change: () => {
          throw awsError(
            'InvalidChangeBatch',
            'Tried to delete resource record set but the values provided do not match the current values'
          );
        },
      });
      await expect(provider.delete(LOGICAL, COMPOSITE, TYPE, two())).rejects.toThrow(
        /^Failed to delete record set group Group: .*do not match the current values/
      );
      expect(changeInputs()).toHaveLength(1);
    });

    const fallbackRoute = () =>
      route({
        liveRecords: [live()],
        change: (input) => {
          const n = (input as { ChangeBatch: { Changes: unknown[] } }).ChangeBatch.Changes.length;
          throw n > 1 ? notFound() : notFound('b.example.com.');
        },
      });

    it('swallows a per-record "not found" when the region matches', async () => {
      fallbackRoute();
      await expect(
        provider.delete(LOGICAL, COMPOSITE, TYPE, two(), { expectedRegion: 'us-east-1' })
      ).resolves.toBeUndefined();
      expect(changeInputs().map((c) => c.ChangeBatch.Changes.length)).toEqual([2, 1, 1]);
    });

    it('throws a region refusal for a per-record "not found" when expectedRegion mismatches', async () => {
      fallbackRoute();
      await expect(
        provider.delete(LOGICAL, COMPOSITE, TYPE, two(), { expectedRegion: 'eu-west-1' })
      ).rejects.toThrow(/eu-west-1/);
      expect(changeInputs().map((c) => c.ChangeBatch.Changes.length)).toEqual([2, 1]);
    });

    it('throws a region refusal for NoSuchHostedZone when expectedRegion mismatches', async () => {
      route({ change: () => { throw awsError('NoSuchHostedZone', 'no zone'); } });
      await expect(
        provider.delete(LOGICAL, COMPOSITE, TYPE, props([rec()]), { expectedRegion: 'eu-west-1' })
      ).rejects.toThrow(/eu-west-1/);
    });

    it('waits out an AcceleratedRecovery mutation lock and retries the batch once', async () => {
      process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] = '1';
      process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] = '2000';
      try {
        let changes = 0;
        mockSend.mockImplementation(async (command: unknown) => {
          if (command instanceof ListResourceRecordSetsCommand) {
            return { ResourceRecordSets: [live()], IsTruncated: false };
          }
          if (command instanceof ChangeResourceRecordSetsCommand) {
            changes++;
            if (changes === 1) {
              throw new Error(`HostedZone ${ZONE} is marked disabled for mutation`);
            }
            return {};
          }
          if (command instanceof GetHostedZoneCommand) {
            return { HostedZone: { Features: { AcceleratedRecoveryStatus: 'ENABLED' } } };
          }
          throw new Error('unexpected');
        });
        await provider.delete(LOGICAL, COMPOSITE, TYPE, props([rec()]));
        expect(changeInputs()).toHaveLength(2);
        expect(calls(GetHostedZoneCommand)).toHaveLength(1);
        expect(changeInputs()[1]).toEqual(changeInputs()[0]);
      } finally {
        delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'];
        delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'];
      }
    });

    it('skips (no change call) a record not found live whose value field is ***', async () => {
      route({ liveRecords: [] });
      const result = await provider.delete(
        LOGICAL,
        COMPOSITE,
        TYPE,
        props([rec({ ResourceRecords: ['***'] })])
      );
      expect(result).toMatchObject({ outcome: 'skipped' });
      expect(changeInputs()).toHaveLength(0);
    });
  });

  describe('create failures', () => {
    it('marks a CNAME-conflict refusal as a name collision and adds the collision note', async () => {
      const cname = awsError(
        'InvalidChangeBatch',
        '[RRSet of type CNAME with DNS name www.example.com. is not permitted as it conflicts with other records with the same DNS name in zone example.com.]'
      );
      (cname as unknown as { $fault: string }).$fault = 'client';
      route({ change: () => { throw cname; } });
      const err = (await provider
        .create(LOGICAL, TYPE, props([rec({ Name: 'www.example.com.', Type: 'CNAME', ResourceRecords: ['t.example.com'] })]))
        .catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(ProvisioningError);
      expect(err.message).toContain(`Failed to create record set group Group${CNAME_CONFLICT_COLLISION_NOTE}`);
      expect(isNameCollisionErrorFrom(err, LOGICAL)).toBe(true);
    });

    it('passes a generic failure message through the mask', async () => {
      route({ change: () => { throw new Error('rejected value hunter2-secret'); } });
      await expect(
        provider.create(LOGICAL, TYPE, props([rec()]), {
          maskSecrets: (t: string) => t.replace('hunter2-secret', '***'),
        })
      ).rejects.toThrow('Failed to create record set group Group: rejected value ***');
    });
  });

  describe('zone from records only', () => {
    it('writes to the zone the records declare', async () => {
      route();
      const result = await provider.create(LOGICAL, TYPE, {
        RecordSets: [rec({ HostedZoneId: 'Z9' }), rec({ Name: 'b.example.com.', HostedZoneId: 'Z9' })],
      });
      expect(result.physicalId).toBe('Z9|Group');
      const sent = changeInputs();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.HostedZoneId).toBe('Z9');
      expect(calls(ListHostedZonesByNameCommand)).toHaveLength(0);
    });

    it('refuses records that disagree on the zone before any AWS call', async () => {
      route();
      await expect(
        provider.create(LOGICAL, TYPE, {
          RecordSets: [rec({ HostedZoneId: 'Z9' }), rec({ Name: 'b.example.com.', HostedZoneId: 'Z8' })],
        })
      ).rejects.toThrow(/RecordSets\[1\]\.HostedZoneId differs from the HostedZoneId/);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('readCurrentState', () => {
    it('answers RESOURCE_NOT_FOUND when the zone is gone', async () => {
      route({ listError: awsError('NoSuchHostedZone', 'no zone') });
      expect(
        await provider.readCurrentState(COMPOSITE, LOGICAL, TYPE, props([rec()]))
      ).toBe(RESOURCE_NOT_FOUND);
    });

    it('answers undefined when the zone cannot be resolved', async () => {
      route({ zones: TWO_ZONES });
      expect(
        await provider.readCurrentState('MyStack-Group-ABC', LOGICAL, TYPE, {
          HostedZoneName: 'example.com.',
          RecordSets: [rec()],
        })
      ).toBeUndefined();
      expect(calls(ListResourceRecordSetsCommand)).toHaveLength(0);
    });
  });
});
