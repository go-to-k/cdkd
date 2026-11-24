import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6544: an alias record declaring TTL / ResourceRecords is sent
// to Route 53 as declared on a create or a template-path update, so Route 53
// refuses it as it does for CloudFormation (measured). A DELETE and a
// state-borne update keep dropping them: a DELETE carrying the conflict is
// refused with InvalidChangeBatch, which the delete path reads as gone.

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
  ListResourceRecordSetsCommand,
  type ResourceRecordSet,
} from '@aws-sdk/client-route-53';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';

const ZONE = 'Z1234567890';
const RECORD_TYPE = 'AWS::Route53::RecordSet';
const GROUP_TYPE = 'AWS::Route53::RecordSetGroup';
const ALIAS = { HostedZoneId: ZONE, DNSName: 'target.example.com.' };

const aliasRecord = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  Name: 'a.example.com.',
  Type: 'A',
  AliasTarget: ALIAS,
  ...extra,
});
const conflicting = { TTL: '300', ResourceRecords: ['198.51.100.9'] };

function route(): void {
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof ListResourceRecordSetsCommand) {
      return { ResourceRecordSets: [], IsTruncated: false };
    }
    return {};
  });
}

/** Every ResourceRecordSet sent in a ChangeResourceRecordSets call, in order. */
function sentSets(): ResourceRecordSet[] {
  return mockSend.mock.calls
    .map(([command]) => command as unknown)
    .filter((c): c is ChangeResourceRecordSetsCommand => c instanceof ChangeResourceRecordSetsCommand)
    .flatMap((c) => (c.input.ChangeBatch?.Changes ?? []).map((ch) => ch.ResourceRecordSet!));
}

describe('alias record with TTL / ResourceRecords (go-to-k/cdkd#6544)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    childLogger.child.mockReturnValue(childLogger);
    provider = new Route53Provider();
    route();
  });

  describe('AWS::Route53::RecordSet', () => {
    it('create sends the declared TTL and ResourceRecords beside AliasTarget', async () => {
      await provider.create('Rec', RECORD_TYPE, { HostedZoneId: ZONE, ...aliasRecord(conflicting) });
      const [set] = sentSets();
      expect(set!.AliasTarget).toMatchObject({ DNSName: 'target.example.com.' });
      expect(set!.TTL).toBe(300);
      expect(set!.ResourceRecords).toEqual([{ Value: '198.51.100.9' }]);
    });

    it('an explicit null TTL or an empty ResourceRecords is not a declared value', async () => {
      await provider.create('Rec', RECORD_TYPE, {
        HostedZoneId: ZONE,
        ...aliasRecord({ TTL: null, ResourceRecords: [] }),
      });
      const [set] = sentSets();
      expect(set).not.toHaveProperty('TTL');
      expect(set).not.toHaveProperty('ResourceRecords');
    });

    it('create of a plain alias sends neither', async () => {
      await provider.create('Rec', RECORD_TYPE, { HostedZoneId: ZONE, ...aliasRecord() });
      const [set] = sentSets();
      expect(set).not.toHaveProperty('TTL');
      expect(set).not.toHaveProperty('ResourceRecords');
    });

    it('a replayed create keeps dropping them', async () => {
      await provider.create(
        'Rec',
        RECORD_TYPE,
        { HostedZoneId: ZONE, ...aliasRecord(conflicting) },
        { replayingState: true }
      );
      const [set] = sentSets();
      expect(set).not.toHaveProperty('TTL');
      expect(set).not.toHaveProperty('ResourceRecords');
    });

    it('a template-path update sends them; a state-borne one does not', async () => {
      const props = { HostedZoneId: ZONE, ...aliasRecord(conflicting) };
      const physicalId = `${ZONE}|a.example.com.|A`;
      await provider.update('Rec', physicalId, RECORD_TYPE, props, props);
      expect(sentSets()[0]!.TTL).toBe(300);

      mockSend.mockClear();
      await provider.update('Rec', physicalId, RECORD_TYPE, props, props, { replayingState: true });
      expect(sentSets()[0]).not.toHaveProperty('TTL');

      mockSend.mockClear();
      await provider.update('Rec', physicalId, RECORD_TYPE, props, props, {
        desiredFromAwsReadback: true,
      });
      expect(sentSets()[0]).not.toHaveProperty('TTL');
    });

    it('a delete never sends them', async () => {
      const props = { HostedZoneId: ZONE, ...aliasRecord(conflicting) };
      await provider.delete('Rec', `${ZONE}|a.example.com.|A`, RECORD_TYPE, props);
      const [set] = sentSets();
      expect(set!.AliasTarget).toBeDefined();
      expect(set).not.toHaveProperty('TTL');
      expect(set).not.toHaveProperty('ResourceRecords');
    });
  });

  describe('AWS::Route53::RecordSetGroup', () => {
    it('create sends them for the alias record', async () => {
      await provider.create('Grp', GROUP_TYPE, {
        HostedZoneId: ZONE,
        RecordSets: [aliasRecord(conflicting)],
      });
      const [set] = sentSets();
      expect(set!.TTL).toBe(300);
      expect(set!.ResourceRecords).toEqual([{ Value: '198.51.100.9' }]);
    });

    it('a replayed create keeps dropping them', async () => {
      await provider.create(
        'Grp',
        GROUP_TYPE,
        { HostedZoneId: ZONE, RecordSets: [aliasRecord(conflicting)] },
        { replayingState: true }
      );
      expect(sentSets()[0]).not.toHaveProperty('TTL');
    });

    it('a template-path update adding the record sends them; a state-borne one does not', async () => {
      const plain = { Name: 'b.example.com.', Type: 'A', TTL: '60', ResourceRecords: ['192.0.2.1'] };
      const previous = { HostedZoneId: ZONE, RecordSets: [plain] };
      const desired = { HostedZoneId: ZONE, RecordSets: [plain, aliasRecord(conflicting)] };
      await provider.update('Grp', `${ZONE}|Grp`, GROUP_TYPE, desired, previous);
      const added = sentSets().find((s) => s.Name === 'a.example.com.');
      expect(added!.TTL).toBe(300);

      mockSend.mockClear();
      await provider.update('Grp', `${ZONE}|Grp`, GROUP_TYPE, desired, previous, {
        replayingState: true,
      });
      const replayed = sentSets().find((s) => s.Name === 'a.example.com.');
      expect(replayed).not.toHaveProperty('TTL');
    });
  });
});
