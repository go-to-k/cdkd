import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// AWS::Route53::RecordSetGroup: one ChangeResourceRecordSets batch per write,
// composite physicalId `<zoneId>|<logicalId>`.

const mockSend = vi.fn();

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

import {
  ChangeResourceRecordSetsCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
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
