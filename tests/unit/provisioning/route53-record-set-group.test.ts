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
  GetHostedZoneCommand,
} from '@aws-sdk/client-route-53';
import {
  isRefusedBeforeApplying,
  priorAttemptLookup,
  priorAttemptsInJournal,
  withPriorAttempts,
  type PriorAttemptLookup,
} from '../../../src/deployment/prior-attempt-scope.js';
import { isNameCollisionErrorFrom } from '../../../src/deployment/retryable-errors.js';
import { CNAME_CONFLICT_COLLISION_NOTE } from '../../../src/provisioning/providers/route53/shared.js';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { buildRevertNewProperties } from '../../../src/cli/commands/drift/revert-payload.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { markReplayMayCollide } from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::Route53::RecordSetGroup';
const ZONE = 'Z1234567890';
// The exact spelling CloudFormation resolves: lower case with the trailing dot (#6540).
const ZONE_NAME = 'example.com.';
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
          { Id: `/hostedzone/${ZONE}`, Name: ZONE_NAME, Config: { PrivateZone: false } },
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
    it('sends one batch of one CREATE per record, zone from HostedZoneId, comment forwarded', async () => {
      route();
      const result = await provider.create(LOGICAL, TYPE, {
        HostedZoneId: ZONE,
        Comment: 'grp comment',
        RecordSets: [
          rec(),
          rec({ Name: 'b.example.com.', Type: 'CNAME', ResourceRecords: ['a.example.com'] }),
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

    // CloudFormation: "Property RecordSets cannot be empty." (#6540), so an empty or
    // absent list is refused, not a no-op.
    it.each([
      ['empty list', { HostedZoneId: ZONE, RecordSets: [] }],
      ['absent list', { HostedZoneId: ZONE }],
    ])('refuses %s before any AWS call', async (_n, props) => {
      route();
      await expect(provider.create(LOGICAL, TYPE, props)).rejects.toThrow(/RecordSets cannot be empty/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      // CloudFormation's refusals run first (#6540) and read an unusable list as no
      // records, so these two report "cannot be empty" rather than cdkd's own wording.
      ['RecordSets not a list', { HostedZoneId: ZONE, RecordSets: 'nope' }, /RecordSets is not a list/],
      ['entry not an object', { HostedZoneId: ZONE, RecordSets: ['x'] }, /RecordSets\[0\] is not an object/],
      ['record without Name', { HostedZoneId: ZONE, RecordSets: [{ Type: 'A' }] }, /needs a plain string Name and Type/],
      ['record without Type', { HostedZoneId: ZONE, RecordSets: [{ Name: 'a.example.com.' }] }, /needs a plain string Name and Type/],
      ['record with non-string Name', { HostedZoneId: ZONE, RecordSets: [{ Name: { Ref: 'X' }, Type: 'A' }] }, /needs a plain string Name and Type/],
      [
        'record in a different zone',
        { HostedZoneId: ZONE, RecordSets: [rec({ HostedZoneId: 'Z999' })] },
        /RecordSets\[0\] declares a hosted zone.*unsupported property/,
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

    it('throws a non-"not found" per-record error after the batch not-found, naming the group', async () => {
      route({
        liveRecords: [live()],
        change: (input) => {
          const count = (input as { ChangeBatch: { Changes: unknown[] } }).ChangeBatch.Changes.length;
          if (count > 1) {
            throw awsError(
              'InvalidChangeBatch',
              "Tried to delete resource record set [name='x', type='A'] but it was not found"
            );
          }
          throw awsError('AccessDenied', 'denied');
        },
      });
      await expect(
        provider.delete(LOGICAL, COMPOSITE, TYPE, props([rec(), rec({ Name: 'b.example.com.' })]))
      ).rejects.toThrow(/^Failed to delete record set group Group: denied/);
      // batch (2 changes) + the first per-record delete, which stops the loop
      expect(changeInputs().map((c) => c.ChangeBatch.Changes.length)).toEqual([2, 1]);
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

    it('returns undefined when a recorded record cannot be placed by the lookup', async () => {
      // A truncated page of OTHER names with no continuation proves nothing.
      mockSend.mockImplementation(async (command: unknown) =>
        command instanceof ListResourceRecordSetsCommand
          ? { ResourceRecordSets: [], IsTruncated: true }
          : {}
      );
      const out = await provider.readCurrentState(COMPOSITE, LOGICAL, TYPE, {
        HostedZoneId: ZONE,
        RecordSets: [rec()],
      });
      expect(out).toBeUndefined();
      expect(out).not.toBe(RESOURCE_NOT_FOUND);
    });

    // go-to-k/cdkd#6660: a member deleted out of band is left out, so drift
    // reports the change (and still compares the other members).
    it('leaves out a member proven gone and reads the rest', async () => {
      route({ liveRecords: [live({ Name: 'b.example.com.' })] });
      const out = (await provider.readCurrentState(COMPOSITE, LOGICAL, TYPE, {
        HostedZoneId: ZONE,
        RecordSets: [rec(), rec({ Name: 'b.example.com.' })],
      })) as { RecordSets: Array<Record<string, unknown>> };
      expect(out.RecordSets.map((r) => r['Name'])).toEqual(['b.example.com.']);
      expect(out.RecordSets[0]!['TTL']).toBe(900);
    });

    // go-to-k/cdkd#6681: the group's own zone key is echoed, so a drift
    // baseline and `drift --revert`'s desired bag name the zone.
    it('echoes the zone key the group declares, and only that one', async () => {
      route({ liveRecords: [live()] });
      const byId = (await provider.readCurrentState(COMPOSITE, LOGICAL, TYPE, {
        HostedZoneId: ZONE,
        RecordSets: [rec()],
      })) as Record<string, unknown>;
      expect(byId['HostedZoneId']).toBe(ZONE);
      expect(byId).not.toHaveProperty('HostedZoneName');

      const byName = (await provider.readCurrentState(COMPOSITE, LOGICAL, TYPE, {
        HostedZoneName: ZONE_NAME,
        RecordSets: [rec()],
      })) as Record<string, unknown>;
      expect(byName['HostedZoneName']).toBe(ZONE_NAME);
      expect(byName).not.toHaveProperty('HostedZoneId');
    });

    it('lets drift --revert update from the readback without the names-no-zone warning', async () => {
      route({ liveRecords: [live()] });
      const recorded = { HostedZoneId: ZONE, RecordSets: [rec()] };
      const readback = (await provider.readCurrentState(COMPOSITE, LOGICAL, TYPE, recorded)) as Record<
        string,
        unknown
      >;
      const warn = vi.spyOn(provider.logger, 'warn');
      // The revert's desired bag: the readback with the recorded member overlaid.
      await provider.update(LOGICAL, COMPOSITE, TYPE, { ...readback, RecordSets: [rec()] }, readback, {
        desiredFromAwsReadback: true,
      });
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(
        /HostedZoneId and HostedZoneName/
      );
      expect(changeInputs()).toHaveLength(1);
      expect(changeInputs()[0]!.HostedZoneId).toBe(ZONE);
    });

    it('names the zone in the real revert payload over a baseline captured without the key', async () => {
      route({ liveRecords: [live()] });
      const recorded = { HostedZoneId: ZONE, RecordSets: [rec()] };
      const readback = (await provider.readCurrentState(COMPOSITE, LOGICAL, TYPE, recorded)) as Record<
        string,
        unknown
      >;
      const oldBaseline = { RecordSets: [rec()] };
      const desired = buildRevertNewProperties(
        [{ path: 'RecordSets', stateValue: oldBaseline.RecordSets, awsValue: readback['RecordSets'] }],
        oldBaseline,
        readback
      );
      expect(desired['HostedZoneId']).toBe(ZONE);
      const warn = vi.spyOn(provider.logger, 'warn');
      await provider.update(LOGICAL, COMPOSITE, TYPE, desired, readback, { desiredFromAwsReadback: true });
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(
        /HostedZoneId and HostedZoneName/
      );
    });

    it('returns RESOURCE_NOT_FOUND when every member is proven gone', async () => {
      route({ liveRecords: [] });
      const out = await provider.readCurrentState(COMPOSITE, LOGICAL, TYPE, {
        HostedZoneId: ZONE,
        RecordSets: [rec(), rec({ Name: 'b.example.com.' })],
      });
      expect(out).toBe(RESOURCE_NOT_FOUND);
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

    // go-to-k/cdkd#6662: with no id, the template's zone + records identify it.
    it('auto mode adopts the group under its generated name when every record is live', async () => {
      route({ liveRecords: [live()] });
      const result = await provider.import(input(undefined));
      expect(result).toEqual({ physicalId: `${ZONE}|${LOGICAL}`, attributes: {} });
    });

    it('auto mode declines when a record is missing', async () => {
      route({ liveRecords: [] });
      expect(await provider.import(input(undefined))).toBeNull();
    });

    it('auto mode declines a zone it cannot resolve without any record read', async () => {
      route();
      const result = await provider.import({
        ...input(undefined),
        properties: { HostedZoneId: { Ref: 'Zone' }, RecordSets: [rec()] },
      });
      expect(result).toBeNull();
      expect(
        mockSend.mock.calls.some((c) => c[0] instanceof ListResourceRecordSetsCommand)
      ).toBe(false);
    });

    it('auto mode declines a member whose SetIdentifier is unresolved', async () => {
      route({ liveRecords: [live()] });
      const result = await provider.import({
        ...input(undefined),
        properties: {
          HostedZoneName: 'example.com.',
          RecordSets: [rec({ SetIdentifier: { Ref: 'Param' }, Weight: 10 })],
        },
      });
      expect(result).toBeNull();
      // A dynamic reference is a string the read cannot match on either.
      const dynamic = await provider.import({
        ...input(undefined),
        properties: {
          HostedZoneName: 'example.com.',
          RecordSets: [rec({ SetIdentifier: '{{resolve:ssm:/id}}', Weight: 10 })],
        },
      });
      expect(dynamic).toBeNull();
    });

    it('records <zone>|<CFn group name> when the CFn group name is given and every record is live', async () => {
      route({ liveRecords: [live()] });
      const result = await provider.import(input('MyStack-Group-ABC'));
      // The adopted CloudFormation name is kept, not replaced by the logical id.
      expect(result).toEqual({ physicalId: `${ZONE}|MyStack-Group-ABC`, attributes: {} });
    });

    it('adopts the known id verbatim when a record is missing', async () => {
      route({ liveRecords: [] });
      const result = await provider.import(input('MyStack-Group-ABC'));
      expect(result).toEqual({ physicalId: 'MyStack-Group-ABC', attributes: {} });
    });
  });
});

/** Run `fn` with prior-attempt evidence bound for LOGICAL: journaled bags, 'landed', or an unreadable journal. */
function withEvidence<T>(
  evidence: Array<Record<string, unknown>> | 'landed' | 'unreadable' | 'none',
  fn: () => T,
  out?: { lookup?: PriorAttemptLookup }
): T {
  const lookup = priorAttemptLookup(LOGICAL, async () => {
    if (evidence === 'unreadable') throw new Error('journal unreadable');
    return Array.isArray(evidence) ? evidence : [];
  });
  if (evidence === 'landed') lookup.notePossiblyLanded();
  if (out) out.lookup = lookup;
  return withPriorAttempts(lookup, fn);
}

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
      await withEvidence('landed', () =>
        provider.update(LOGICAL, COMPOSITE, TYPE, props([rec(), added]), props([rec()]))
      );
      expect(calls(ListResourceRecordSetsCommand)).toHaveLength(1);
      expect(changeInputs()).toHaveLength(0);
    });

    it('CREATEs an added record that is live with DIFFERENT values', async () => {
      route({
        liveRecords: [
          { Name: 'new.example.com.', Type: 'A', TTL: 900, ResourceRecords: [{ Value: '198.51.100.9' }] },
        ],
      });
      await withEvidence('landed', () =>
        provider.update(LOGICAL, COMPOSITE, TYPE, props([rec(), added]), props([rec()]))
      );
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
    // CloudFormation: a record's HostedZoneId is "unsupported property" and a group with
    // no zone of its own is refused (#6540).
    it('refuses a zone taken from the records, before any AWS call', async () => {
      route();
      await expect(
        provider.create(LOGICAL, TYPE, {
          RecordSets: [rec({ HostedZoneId: 'Z9' }), rec({ Name: 'b.example.com.', HostedZoneId: 'Z9' })],
        })
      ).rejects.toThrow(/RecordSets\[0\] declares a hosted zone/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses records declaring a zone (CloudFormation message, not the disagreement one) before any AWS call', async () => {
      route();
      await expect(
        provider.create(LOGICAL, TYPE, {
          RecordSets: [rec({ HostedZoneId: 'Z9' }), rec({ Name: 'b.example.com.', HostedZoneId: 'Z8' })],
        })
      ).rejects.toThrow(/RecordSets\[0\] declares a hosted zone/);
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

describe('Route53Provider RecordSetGroup (round 2)', () => {
  let provider: Route53Provider;
  const props = (records: Record<string, unknown>[], zone: unknown = ZONE) => ({
    HostedZoneId: zone,
    RecordSets: records,
  });
  const added = { Name: 'new.example.com', Type: 'A', TTL: 300, ResourceRecords: ['192.0.2.1'] };
  const liveSame = {
    Name: 'new.example.com.',
    Type: 'A',
    TTL: 300,
    ResourceRecords: [{ Value: '192.0.2.1' }],
  };
  const liveAddedCount = () =>
    calls(ListResourceRecordSetsCommand).length;
  const createChange = () => ({
    Action: 'CREATE',
    ResourceRecordSet: {
      Name: 'new.example.com',
      Type: 'A',
      TTL: 300,
      ResourceRecords: [{ Value: '192.0.2.1' }],
    },
  });
  const upd = () =>
    provider.update(LOGICAL, COMPOSITE, TYPE, props([rec(), added]), props([rec()]));

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    childLogger.child.mockReturnValue(childLogger);
    provider = new Route53Provider();
  });

  describe('update: added-record skip needs this stack evidence', () => {
    it('CREATEs with no lookup bound, even when an identical record is live, without reading live records', async () => {
      route({ liveRecords: [liveSame] });
      await upd();
      expect(liveAddedCount()).toBe(0);
      expect(changeInputs()[0]!.ChangeBatch.Changes).toEqual([createChange()]);
    });

    it('CREATEs with a lookup bound that has no journaled bag and did not land', async () => {
      route({ liveRecords: [liveSame] });
      await withEvidence([], upd);
      expect(liveAddedCount()).toBe(0);
      expect(changeInputs()[0]!.ChangeBatch.Changes).toEqual([createChange()]);
    });

    it('skips when a journaled bag holds the same key with the same values', async () => {
      route({ liveRecords: [liveSame] });
      await withEvidence([props([rec(), added])], upd);
      expect(liveAddedCount()).toBe(1);
      expect(changeInputs()).toHaveLength(0);
    });

    it('CREATEs when the journaled bag holds the key with DIFFERENT values', async () => {
      route({ liveRecords: [liveSame] });
      await withEvidence([props([rec(), { ...added, TTL: 60 }])], upd);
      expect(liveAddedCount()).toBe(0);
      expect(changeInputs()[0]!.ChangeBatch.Changes).toEqual([createChange()]);
    });

    it('skips when possiblyLanded() is already set', async () => {
      route({ liveRecords: [liveSame] });
      await withEvidence('landed', upd);
      expect(changeInputs()).toHaveLength(0);
    });

    it('CREATEs when the journal is unreadable', async () => {
      route({ liveRecords: [liveSame] });
      await withEvidence('unreadable', upd);
      expect(liveAddedCount()).toBe(0);
      expect(changeInputs()[0]!.ChangeBatch.Changes).toEqual([createChange()]);
    });

    it('ignores a journaled bag whose RecordSets is not a list', async () => {
      route({ liveRecords: [liveSame] });
      await withEvidence([{ RecordSets: 'junk' }], upd);
      expect(changeInputs()[0]!.ChangeBatch.Changes).toEqual([createChange()]);
    });
  });

  describe('update: possiblyLanded on a failed change', () => {
    const failing = (error: Error) =>
      route({ change: () => { throw error; } });
    const run = async () => {
      const out: { lookup?: PriorAttemptLookup } = {};
      await withEvidence(
        'none',
        () => provider.update(LOGICAL, COMPOSITE, TYPE, props([rec({ TTL: '60' })]), props([rec()])),
        out
      ).catch(() => undefined);
      return out.lookup!;
    };

    it('notes possibly-landed for a non-client failure', async () => {
      failing(new Error('socket hang up'));
      expect((await run()).possiblyLanded()).toBe(true);
    });

    it('does not note it for a $fault client refusal', async () => {
      const e = awsError('InvalidChangeBatch', 'refused');
      (e as unknown as { $fault: string }).$fault = 'client';
      failing(e);
      const lookup = await run();
      expect(lookup.possiblyLanded()).toBe(false);
      expect(changeInputs()).toHaveLength(1);
    });

    it('notes it for a $fault server failure', async () => {
      const e = awsError('InternalFailure', 'boom');
      (e as unknown as { $fault: string }).$fault = 'server';
      failing(e);
      expect((await run()).possiblyLanded()).toBe(true);
    });
  });

  describe('update: alias target and key order', () => {
    const aliasDesired = {
      Name: 'alias.example.com',
      Type: 'A',
      AliasTarget: {
        HostedZoneId: 'Z35SXDOTRQ7X7K',
        DNSName: 'Dualstack.My-ALB.us-east-1.elb.amazonaws.com',
        EvaluateTargetHealth: false,
      },
    };
    const aliasLive = (dns: string) => ({
      Type: 'A',
      AliasTarget: { EvaluateTargetHealth: false, DNSName: dns, HostedZoneId: 'Z35SXDOTRQ7X7K' },
      Name: 'alias.example.com.',
    });
    const upd2 = () =>
      provider.update(LOGICAL, COMPOSITE, TYPE, props([rec(), aliasDesired]), props([rec()]));

    it('skips when the live alias differs only by trailing dot, case and key order', async () => {
      route({ liveRecords: [aliasLive('dualstack.my-alb.us-east-1.elb.amazonaws.com.')] });
      await withEvidence('landed', upd2);
      expect(changeInputs()).toHaveLength(0);
    });

    it('CREATEs when the live alias points at another target', async () => {
      route({ liveRecords: [aliasLive('other-alb.us-east-1.elb.amazonaws.com.')] });
      await withEvidence('landed', upd2);
      expect(changeInputs()[0]!.ChangeBatch.Changes.map((c) => c.Action)).toEqual(['CREATE']);
    });
  });

  describe('update: zone refusal strips /hostedzone/ on both sides', () => {
    it.each([['Z1'], ['/hostedzone/Z1']])(
      'physicalId /hostedzone/Z1|Grp with desired %s proceeds',
      async (desired) => {
        route();
        await provider.update(
          'Grp',
          '/hostedzone/Z1|Grp',
          TYPE,
          props([rec({ TTL: '60' })], desired),
          props([rec()])
        );
        const sent = changeInputs();
        expect(sent).toHaveLength(1);
        expect(sent[0]!.ChangeBatch.Changes[0]!.Action).toBe('UPSERT');
      }
    );
  });

  describe('foreign-group composite (Z1|OtherGroup) resolves the zone from properties', () => {
    const byName = { HostedZoneName: 'example.com.', RecordSets: [rec()] };

    it('update', async () => {
      route();
      const result = await provider.update(
        LOGICAL,
        'Z1|OtherGroup',
        TYPE,
        { HostedZoneName: 'example.com.', RecordSets: [rec({ TTL: '60' })] },
        byName
      );
      expect(calls(ListHostedZonesByNameCommand)).toHaveLength(1);
      expect(changeInputs()[0]!.HostedZoneId).toBe(ZONE);
      // `Z1|OtherGroup` is not this group's id (its name is neither the logical id nor
      // carries it as a segment), so the zone came from the properties, not from `Z1`.
      // The rewritten id keeps two segments: the resolved zone and the name segment.
      expect(result.physicalId).toBe(`${ZONE}|OtherGroup`);
    });

    it('readCurrentState', async () => {
      route({ liveRecords: [live()] });
      const out = await provider.readCurrentState('Z1|OtherGroup', LOGICAL, TYPE, byName);
      expect(out).toMatchObject({ RecordSets: expect.any(Array) });
      expect(calls(ListHostedZonesByNameCommand)).toHaveLength(1);
      expect(
        (calls(ListResourceRecordSetsCommand)[0]!.input as { HostedZoneId: string }).HostedZoneId
      ).toBe(ZONE);
    });

    it('import records the composite for the resolved zone', async () => {
      route({ liveRecords: [live()] });
      const result = await provider.import({
        logicalId: LOGICAL,
        resourceType: TYPE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: byName,
        knownPhysicalId: 'Z1|OtherGroup',
      });
      expect((result as { physicalId: string }).physicalId).toBe(`${ZONE}|OtherGroup`);
      // The foreign id is not a cdkd composite, so the zone is looked up by name.
      expect(calls(ListHostedZonesByNameCommand).length).toBeGreaterThan(0);
    });
  });

  describe('import: unverifiable inputs', () => {
    const input = (known: string, properties: Record<string, unknown>) => ({
      logicalId: 'Grp',
      resourceType: TYPE,
      stackName: 'MyStack',
      region: 'us-east-1',
      properties,
      knownPhysicalId: known,
    });
    const cases: Array<[string, Record<string, unknown>]> = [
      ['RecordSets not a list', { HostedZoneName: 'example.com.', RecordSets: 'nope' }],
      [
        'records disagreeing on the zone',
        { RecordSets: [rec({ HostedZoneId: 'Z9' }), rec({ Name: 'b.example.com.', HostedZoneId: 'Z8' })] },
      ],
    ];

    it.each(cases)('a known composite with %s declines', async (_n, properties) => {
      route();
      expect(await provider.import(input(`${ZONE}|Grp`, properties))).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each(cases)('a non-composite with %s adopts verbatim', async (_n, properties) => {
      route();
      expect(await provider.import(input('MyStack-Grp-ABC', properties))).toEqual({
        physicalId: 'MyStack-Grp-ABC',
        attributes: {},
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a known composite whose verification throws declines', async () => {
      route({ listError: awsError('AccessDenied', 'denied') });
      expect(
        await provider.import(
          input(`${ZONE}|Grp`, { HostedZoneName: 'example.com.', RecordSets: [rec()] })
        )
      ).toBeNull();
    });
  });

  describe('delete: zone gone by name', () => {
    it('throws a region refusal when expectedRegion mismatches', async () => {
      route({ zones: [] });
      await expect(
        provider.delete(
          LOGICAL,
          'MyStack-Group-ABC',
          TYPE,
          { HostedZoneName: 'example.com.', RecordSets: [rec()] },
          { expectedRegion: 'eu-west-1' }
        )
      ).rejects.toThrow(/eu-west-1/);
      expect(changeInputs()).toHaveLength(0);
    });
  });
});

describe('Route53Provider RecordSetGroup (round 3: refused before applying)', () => {
  let provider: Route53Provider;
  const props = (records: Record<string, unknown>[]) => ({ HostedZoneId: ZONE, RecordSets: records });
  const added = { Name: 'new.example.com', Type: 'A', TTL: 300, ResourceRecords: ['192.0.2.1'] };
  const liveSame = {
    Name: 'new.example.com.',
    Type: 'A',
    TTL: 300,
    ResourceRecords: [{ Value: '192.0.2.1' }],
  };
  const withFault = (e: Error, fault: string): Error => {
    (e as unknown as { $fault: string }).$fault = fault;
    return e;
  };
  const exists = () =>
    withFault(awsError('InvalidChangeBatch', 'Tried to create resource record set but it already exists'), 'client');

  /** Run an UPDATE adding `added` (a send) under `evidence`; resolves the thrown error and the bound lookup. */
  async function runAdd(evidence: Parameters<typeof withEvidence>[0]) {
    const out: { lookup?: PriorAttemptLookup } = {};
    const error = await withEvidence(
      evidence,
      () => provider.update(LOGICAL, COMPOSITE, TYPE, props([rec(), added]), props([rec()])),
      out
    ).catch((e: unknown) => e);
    return { error, lookup: out.lookup! };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    childLogger.child.mockReturnValue(childLogger);
    provider = new Route53Provider();
  });

  it('marks a client-refused send and leaves possiblyLanded false', async () => {
    route({ change: () => { throw exists(); } });
    const { error, lookup } = await runAdd('none');
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(isRefusedBeforeApplying(error, LOGICAL)).toBe(true);
    expect(isRefusedBeforeApplying(error, 'Other')).toBe(false);
    expect(lookup.possiblyLanded()).toBe(false);
    expect(changeInputs()).toHaveLength(1);
  });

  // An "already exists" the batch client stamps as following an AMBIGUOUS
  // attempt may answer the batch that attempt committed: neither marked nor
  // read as a refusal. After a throttle (no stamp) it is still a refusal.
  it('does not mark a client refusal following an ambiguous attempt and sets possiblyLanded', async () => {
    route({ change: () => { throw markReplayMayCollide(exists()); } });
    const { error, lookup } = await runAdd('none');
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(isRefusedBeforeApplying(error, LOGICAL)).toBe(false);
    expect(lookup.possiblyLanded()).toBe(true);
  });

  it('marks a client refusal returned after a throttle retry (no ambiguous attempt)', async () => {
    route({
      change: () => {
        const e = exists();
        (e as unknown as { $metadata: { attempts: number } }).$metadata = { attempts: 2 };
        throw e;
      },
    });
    const { error, lookup } = await runAdd('none');
    expect(isRefusedBeforeApplying(error, LOGICAL)).toBe(true);
    expect(lookup.possiblyLanded()).toBe(false);
  });

  it.each([
    ['$fault server', () => withFault(awsError('InternalFailure', 'boom'), 'server')],
    ['a plain Error', () => new Error('socket hang up')],
  ])('does not mark a send failing with %s and sets possiblyLanded', async (_n, make) => {
    route({ change: () => { throw make(); } });
    const { error, lookup } = await runAdd('none');
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(isRefusedBeforeApplying(error, LOGICAL)).toBe(false);
    expect(lookup.possiblyLanded()).toBe(true);
  });

  it('marks a pre-send refusal (unreadable recorded identity) without possiblyLanded', async () => {
    route();
    const out: { lookup?: PriorAttemptLookup } = {};
    const error = await withEvidence(
      'none',
      () => provider.update(LOGICAL, COMPOSITE, TYPE, props([rec()]), props([rec({ Name: '***' })])),
      out
    ).catch((e: unknown) => e);
    expect(String((error as Error).message)).toMatch(/no readable Name/);
    expect(isRefusedBeforeApplying(error, LOGICAL)).toBe(true);
    expect(out.lookup!.possiblyLanded()).toBe(false);
    expect(changeInputs()).toHaveLength(0);
  });

  it('marks a pre-send ListResourceRecordSets failure without $fault', async () => {
    route({ listError: new Error('connect ETIMEDOUT') });
    const out: { lookup?: PriorAttemptLookup } = {};
    // the removed record is looked up live before any send
    const error = await withEvidence(
      'none',
      () =>
        provider.update(
          LOGICAL,
          COMPOSITE,
          TYPE,
          props([rec()]),
          props([rec(), rec({ Name: 'gone.example.com.' })])
        ),
      out
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(isRefusedBeforeApplying(error, LOGICAL)).toBe(true);
    expect(out.lookup!.possiblyLanded()).toBe(false);
    expect(changeInputs()).toHaveLength(0);
  });

  it('does not mark a client refusal when possiblyLanded was already true', async () => {
    route({ change: () => { throw exists(); } });
    const { error, lookup } = await runAdd('landed');
    expect(isRefusedBeforeApplying(error, LOGICAL)).toBe(false);
    expect(lookup.possiblyLanded()).toBe(true);
  });

  describe('two-deploy scenario', () => {
    /** The journal the engine writes for a failed UPDATE: the bag only when the error is not refused-before-applying. */
    const journalOf = (error: unknown, attempted: Record<string, unknown>) =>
      ({
        version: 1,
        segments: [
          {
            timestamp: 1,
            reason: 'no-rollback-failure',
            operations: [],
            failedOperations: [
              {
                logicalId: LOGICAL,
                resourceType: TYPE,
                changeType: 'UPDATE',
                ...(isRefusedBeforeApplying(error, LOGICAL) ? {} : { attemptedProperties: attempted }),
              },
            ],
          },
        ],
      }) as never;

    it('a refused "already exists" deploy leaves no evidence, so deploy 2 sends CREATE over the identical live record', async () => {
      route({ change: () => { throw exists(); } });
      const deploy1 = await runAdd('none');
      expect(isRefusedBeforeApplying(deploy1.error, LOGICAL)).toBe(true);
      const bags = priorAttemptsInJournal(
        journalOf(deploy1.error, props([rec(), added])),
        LOGICAL,
        TYPE
      );
      expect(bags).toEqual([]);

      mockSend.mockReset();
      route({ liveRecords: [liveSame] });
      await withEvidence(bags, () =>
        provider.update(LOGICAL, COMPOSITE, TYPE, props([rec(), added]), props([rec()]))
      );
      expect(calls(ListResourceRecordSetsCommand)).toHaveLength(0);
      expect(changeInputs()).toHaveLength(1);
      expect(changeInputs()[0]!.ChangeBatch.Changes.map((c) => c.Action)).toEqual(['CREATE']);
    });

    it('control: an ambiguous (server) failure keeps its bag, so deploy 2 skips the identical live record', async () => {
      route({ change: () => { throw withFault(awsError('InternalFailure', 'boom'), 'server'); } });
      const deploy1 = await runAdd('none');
      expect(isRefusedBeforeApplying(deploy1.error, LOGICAL)).toBe(false);
      const bags = priorAttemptsInJournal(
        journalOf(deploy1.error, props([rec(), added])),
        LOGICAL,
        TYPE
      );
      expect(bags).toHaveLength(1);

      mockSend.mockReset();
      route({ liveRecords: [liveSame] });
      await withEvidence(bags, () =>
        provider.update(LOGICAL, COMPOSITE, TYPE, props([rec(), added]), props([rec()]))
      );
      expect(changeInputs()).toHaveLength(0);
    });
  });
});

// go-to-k/cdkd#6537: a HostedZoneName <-> HostedZoneId switch is not a
// replacement, so a desired HostedZoneName is resolved when the reference changed.
describe('Route53Provider RecordSetGroup zone-key switch (go-to-k/cdkd#6537)', () => {
  let provider: Route53Provider;
  const byId = (extra: Record<string, unknown> = {}) => ({
    HostedZoneId: ZONE,
    RecordSets: [rec(extra)],
  });
  const byName = (extra: Record<string, unknown> = {}) => ({
    HostedZoneName: ZONE_NAME,
    RecordSets: [rec(extra)],
  });
  const otherZone = [
    { Id: '/hostedzone/Z9999999999', Name: ZONE_NAME, Config: { PrivateZone: false } },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    childLogger.child.mockReturnValue(childLogger);
    provider = new Route53Provider();
  });

  it('id -> name resolving to the composite zone proceeds', async () => {
    route();
    await provider.update(LOGICAL, COMPOSITE, TYPE, byName({ TTL: '60' }), byId());
    expect(calls(ListHostedZonesByNameCommand)).toHaveLength(1);
    const sent = changeInputs();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.HostedZoneId).toBe(ZONE);
    expect(sent[0]!.ChangeBatch.Changes[0]!.Action).toBe('UPSERT');
  });

  it('id -> name resolving to ANOTHER zone throws, marked refused-before-applying, no change call', async () => {
    route({ zones: otherZone });
    const error = await provider
      .update(LOGICAL, COMPOSITE, TYPE, byName({ TTL: '60' }), byId())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      new RegExp(`Record set group ${LOGICAL}: the template's hosted zone differs from the one its records are in \\(${ZONE}\\)`)
    );
    expect(isRefusedBeforeApplying(error, LOGICAL)).toBe(true);
    expect(changeInputs()).toHaveLength(0);
  });

  it('name -> id of the composite zone proceeds without a name lookup', async () => {
    route();
    await provider.update(LOGICAL, COMPOSITE, TYPE, byId({ TTL: '60' }), byName());
    expect(calls(ListHostedZonesByNameCommand)).toHaveLength(0);
    expect(changeInputs()).toHaveLength(1);
  });

  it('name -> id of ANOTHER zone throws, marked refused-before-applying, no change call', async () => {
    route();
    const error = await provider
      .update(LOGICAL, COMPOSITE, TYPE, { HostedZoneId: 'Z9999999999', RecordSets: [rec()] }, byName())
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/the template's hosted zone differs from the one its records are in/);
    expect(isRefusedBeforeApplying(error, LOGICAL)).toBe(true);
    expect(changeInputs()).toHaveLength(0);
  });

  it('an unchanged HostedZoneName makes no ListHostedZonesByName call (composite names the zone)', async () => {
    route({ zones: otherZone });
    await provider.update(LOGICAL, COMPOSITE, TYPE, byName({ TTL: '60' }), byName());
    expect(calls(ListHostedZonesByNameCommand)).toHaveLength(0);
    expect(changeInputs()).toHaveLength(1);
    expect(changeInputs()[0]!.HostedZoneId).toBe(ZONE);
  });

  describe('a non-composite (imported) physicalId resolves the RECORDED zone', () => {
    const imported = 'MyStack-Group-ABC';
    const prev = (name: unknown) => ({ HostedZoneName: name, RecordSets: [rec()] });
    const zoneNamed = (id: string) => ({
      Id: `/hostedzone/${id}`,
      Name: 'a.com.',
      Config: { PrivateZone: false },
    });
    const run = (desired: Record<string, unknown>, previous: Record<string, unknown>) =>
      provider.update(LOGICAL, imported, TYPE, desired, previous).then(
        () => undefined,
        (e: unknown) => e
      );

    it('recorded name -> Z_A, desired id Z_B: throws refused-before-applying, no change call', async () => {
      route({ zones: [zoneNamed('Z_A')] });
      const error = await run({ HostedZoneId: 'Z_B', RecordSets: [rec()] }, prev('a.com.'));
      expect((error as Error).message).toMatch(/hosted zone differs/);
      expect(isRefusedBeforeApplying(error, LOGICAL)).toBe(true);
      expect(changeInputs()).toHaveLength(0);
    });

    it('recorded name -> Z_A, desired id Z_A: proceeds in Z_A', async () => {
      route({ zones: [zoneNamed('Z_A')] });
      expect(await run({ HostedZoneId: 'Z_A', RecordSets: [rec({ TTL: '60' })] }, prev('a.com.'))).toBeUndefined();
      expect(changeInputs()).toHaveLength(1);
      expect(changeInputs()[0]!.HostedZoneId).toBe('Z_A');
    });

    it('recorded name matching two zones: throws refused-before-applying, no change call', async () => {
      route({ zones: [zoneNamed('Z_A'), zoneNamed('Z_A2')] });
      const error = await run({ HostedZoneId: 'Z_A', RecordSets: [rec()] }, prev('a.com.'));
      expect((error as Error).message).toMatch(/cannot confirm/);
      expect(isRefusedBeforeApplying(error, LOGICAL)).toBe(true);
      expect(changeInputs()).toHaveLength(0);
    });

    it.each([['***'], ['{{resolve:ssm:/x}}']])(
      'recorded HostedZoneName %s: throws "redacted", no lookup, no change call',
      async (name) => {
        route({ zones: [zoneNamed('Z_A')] });
        const error = await run({ HostedZoneId: 'Z_A', RecordSets: [rec()] }, prev(name));
        expect((error as Error).message).toMatch(/redacted/);
        expect(isRefusedBeforeApplying(error, LOGICAL)).toBe(true);
        expect(calls(ListHostedZonesByNameCommand)).toHaveLength(0);
        expect(changeInputs()).toHaveLength(0);
      }
    );
  });
});
