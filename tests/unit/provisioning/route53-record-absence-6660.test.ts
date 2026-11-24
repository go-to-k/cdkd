import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6660: a record deleted out of band read as "cannot tell"
// (`undefined`), which `cdkd drift` reports as `unsupported` and exits 0 on.
// A scan of the record's whole name + type run now proves it gone.
// go-to-k/cdkd#6661: a revert of a record switched to an alias out of band
// re-sent the alias.

const mockSend = vi.fn();

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
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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
  ListResourceRecordSetsCommand,
  type ListResourceRecordSetsCommandInput,
} from '@aws-sdk/client-route-53';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { revertedRecordMode } from '../../../src/provisioning/providers/route53/shared.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const ZONE = 'Z1234567890';
const TYPE = 'AWS::Route53::RecordSet';

function recorded(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    HostedZoneId: ZONE,
    Name: 'app.example.com.',
    Type: 'A',
    TTL: '300',
    ResourceRecords: ['192.0.2.1'],
    ...overrides,
  };
}

/** Answer each listing call with the next page; record what was asked. */
function pages(...answers: Array<Record<string, unknown>>): ListResourceRecordSetsCommandInput[] {
  const asked: ListResourceRecordSetsCommandInput[] = [];
  let i = 0;
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof ListResourceRecordSetsCommand) {
      asked.push(command.input);
      const answer = answers[i++];
      if (!answer) throw new Error('unexpected extra listing call');
      return answer;
    }
    return {};
  });
  return asked;
}

const read = (props: Record<string, unknown>, id = `${ZONE}|${String(props['Name'])}|A`) =>
  new Route53Provider().readCurrentState(id, 'Rec', TYPE, props);

describe('Route 53 record absence (#6660)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('reports a record whose run holds only a LATER name as gone', async () => {
    const later = { ResourceRecordSets: [{ Name: 'zzz.example.com.', Type: 'A' }], IsTruncated: true };
    const asked = pages(later, later);
    expect(await read(recorded())).toBe(RESOURCE_NOT_FOUND);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ StartRecordName: 'app.example.com.', StartRecordType: 'A' });
  });

  it('reports a record as gone when the listing ends before it', async () => {
    const empty = { ResourceRecordSets: [], IsTruncated: false };
    pages(empty, empty);
    expect(await read(recorded())).toBe(RESOURCE_NOT_FOUND);
  });

  it('positions a wildcard name at its stored escape and still proves it gone', async () => {
    const empty = { ResourceRecordSets: [], IsTruncated: false };
    const asked = pages(empty, empty);
    expect(await read(recorded({ Name: '*.example.com' }))).toBe(RESOURCE_NOT_FOUND);
    expect(asked[1]!.StartRecordName).toBe('\\052.example.com.');
  });

  it('keeps "cannot tell" for a name the query cannot position', async () => {
    const empty = { ResourceRecordSets: [], IsTruncated: false };
    pages(empty);
    expect(await read(recorded({ Name: 'a@b.example.com.' }))).toBeUndefined();
  });

  it('keeps "cannot tell" when a truncated page gives no continuation', async () => {
    pages(
      { ResourceRecordSets: [], IsTruncated: false },
      { ResourceRecordSets: [], IsTruncated: true }
    );
    expect(await read(recorded())).toBeUndefined();
  });

  it('keeps "cannot tell" when the read has no recorded bag to match a SetIdentifier on', async () => {
    pages({ ResourceRecordSets: [], IsTruncated: false });
    expect(
      await new Route53Provider().readCurrentState(`${ZONE}|app.example.com.|A`, 'Rec', TYPE)
    ).toBeUndefined();
  });

  it('keeps "cannot tell" for a scalar id whose zone resolved from HostedZoneName (split horizon)', async () => {
    // Two zones share the name; the lookup picks one, which may not be the
    // record's, so a miss there proves nothing.
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof ListResourceRecordSetsCommand) {
        return { ResourceRecordSets: [], IsTruncated: false };
      }
      return {
        HostedZones: [
          { Id: '/hostedzone/ZPRIVATE', Name: 'example.com.', Config: { PrivateZone: true } },
          { Id: '/hostedzone/ZPUBLIC', Name: 'example.com.', Config: { PrivateZone: false } },
        ],
        IsTruncated: false,
      };
    });
    const { HostedZoneId: _zone, ...props } = recorded();
    expect(
      await read({ ...props, HostedZoneName: 'example.com.' }, 'app.example.com.')
    ).toBeUndefined();
  });

  it('proves absence for a scalar id whose template names the zone by HostedZoneId', async () => {
    const empty = { ResourceRecordSets: [], IsTruncated: false };
    pages(empty, empty);
    expect(await read(recorded(), 'app.example.com.')).toBe(RESOURCE_NOT_FOUND);
  });

  describe('a record with a SetIdentifier', () => {
    const weighted = (id: string) => ({ Name: 'app.example.com.', Type: 'A', SetIdentifier: id });

    it('scans the whole sibling run, without a start identifier, before calling it gone', async () => {
      const asked = pages(
        { ResourceRecordSets: [weighted('b')], IsTruncated: false },
        {
          ResourceRecordSets: [weighted('a'), weighted('b')],
          IsTruncated: true,
          NextRecordName: 'app.example.com.',
          NextRecordType: 'A',
          NextRecordIdentifier: 'c',
        },
        { ResourceRecordSets: [weighted('c'), { Name: 'b.example.com.', Type: 'A' }], IsTruncated: true }
      );
      expect(await read(recorded({ SetIdentifier: 'x', Weight: 10 }))).toBe(RESOURCE_NOT_FOUND);
      expect(asked[1]).not.toHaveProperty('StartRecordIdentifier');
      expect(asked[2]).toMatchObject({ StartRecordIdentifier: 'c' });
    });

    it('keeps "cannot tell" when the scan meets the record the first window missed', async () => {
      pages(
        { ResourceRecordSets: [], IsTruncated: false },
        { ResourceRecordSets: [weighted('a'), weighted('x')], IsTruncated: false }
      );
      expect(await read(recorded({ SetIdentifier: 'x', Weight: 10 }))).toBeUndefined();
    });

    it('keeps "cannot tell" when the run outlasts the scan cap', async () => {
      const sameRun = {
        ResourceRecordSets: [weighted('a')],
        IsTruncated: true,
        NextRecordName: 'app.example.com.',
        NextRecordType: 'A',
        NextRecordIdentifier: 'b',
      };
      pages({ ResourceRecordSets: [], IsTruncated: false }, ...Array(10).fill(sameRun));
      expect(await read(recorded({ SetIdentifier: 'x', Weight: 10 }))).toBeUndefined();
    });
  });
});

describe('drift --revert restores the recorded record mode (#6661)', () => {
  const ALIAS = { HostedZoneId: ZONE, DNSName: 'other.example.com.', EvaluateTargetHealth: false };
  const simpleLive = recorded({ TTL: 900, ResourceRecords: ['192.0.2.9'] });
  const aliasLive = { HostedZoneId: ZONE, Name: 'app.example.com.', Type: 'A', AliasTarget: ALIAS };

  it('keeps the simple record a revert overlaid onto an alias readback', () => {
    const desired = { ...aliasLive, TTL: '300', ResourceRecords: ['192.0.2.1'] };
    expect(revertedRecordMode(desired, aliasLive)).not.toHaveProperty('AliasTarget');
    expect(revertedRecordMode(desired, aliasLive)).toMatchObject({ TTL: '300' });
  });

  it('keeps the alias a revert overlaid onto a simple readback', () => {
    const desired = { ...simpleLive, AliasTarget: ALIAS };
    const out = revertedRecordMode(desired, simpleLive);
    expect(out).toHaveProperty('AliasTarget');
    expect(out).not.toHaveProperty('TTL');
    expect(out).not.toHaveProperty('ResourceRecords');
  });

  it('leaves a single-mode bag alone', () => {
    const desired = recorded();
    expect(revertedRecordMode(desired, aliasLive)).toBe(desired);
  });

  it('a revert UPSERTs the simple record, not the alias the record was switched to', async () => {
    mockSend.mockResolvedValue({});
    const desired = { ...aliasLive, TTL: '300', ResourceRecords: ['192.0.2.1'] };
    await new Route53Provider().update('Rec', `${ZONE}|app.example.com.|A`, TYPE, desired, aliasLive, {
      desiredFromAwsReadback: true,
    });
    const sent = mockSend.mock.calls
      .map((c) => c[0])
      .find((c): c is ChangeResourceRecordSetsCommand => c instanceof ChangeResourceRecordSetsCommand);
    const rrset = sent!.input.ChangeBatch!.Changes![0]!.ResourceRecordSet!;
    expect(rrset.AliasTarget).toBeUndefined();
    expect(rrset).toMatchObject({ TTL: 300, ResourceRecords: [{ Value: '192.0.2.1' }] });
  });

  it('a deploy keeps its own mode handling (the template path is untouched)', async () => {
    mockSend.mockResolvedValue({});
    await new Route53Provider().update(
      'Rec',
      `${ZONE}|app.example.com.|A`,
      TYPE,
      { ...aliasLive },
      simpleLive
    );
    const sent = mockSend.mock.calls
      .map((c) => c[0])
      .find((c): c is ChangeResourceRecordSetsCommand => c instanceof ChangeResourceRecordSetsCommand);
    expect(sent!.input.ChangeBatch!.Changes![0]!.ResourceRecordSet!.AliasTarget).toBeDefined();
  });
});
