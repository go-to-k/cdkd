import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #3741: renaming an AWS::Route53::RecordSet (Name / Type / SetIdentifier)
// must delete the old record, not UPSERT the new one beside it.

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
  ListResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import {
  Route53Provider,
  recordIdentityChanged,
} from '../../../src/provisioning/providers/route53-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { isNameCollisionErrorFrom } from '../../../src/deployment/retryable-errors.js';

const ZONE = 'Z1234567890';
const TYPE = 'AWS::Route53::RecordSet';

function record(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    HostedZoneId: ZONE,
    Name: 'old.example.com.',
    Type: 'A',
    TTL: '300',
    ResourceRecords: ['192.0.2.1'],
    ...overrides,
  };
}

/** Route the mock by command class: `list` answers ListResourceRecordSets. */
function routeSend(list: unknown[] | Error, change: unknown = {}): void {
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof ListResourceRecordSetsCommand) {
      if (list instanceof Error) throw list;
      return { ResourceRecordSets: list };
    }
    if (command instanceof ChangeResourceRecordSetsCommand) {
      if (change instanceof Error) throw change;
      return change;
    }
    throw new Error(`unexpected command ${String((command as object).constructor.name)}`);
  });
}

function calls<T>(cls: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof cls);
}

describe('Route53Provider RecordSet rename (issue #3741)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new Route53Provider();
  });

  it('a Name change deletes the LIVE old record and creates the new one in one batch', async () => {
    // The live record's TTL differs from the recorded one: Route 53 refuses a
    // DELETE whose values do not match, so the DELETE must carry the live copy.
    const liveOld = {
      Name: 'old.example.com.',
      Type: 'A',
      TTL: 900,
      ResourceRecords: [{ Value: '192.0.2.1' }],
    };
    routeSend([liveOld, { Name: 'zzz.example.com.', Type: 'A', TTL: 60 }]);

    const result = await provider.update(
      'Rec',
      `${ZONE}|old.example.com.|A`,
      TYPE,
      record({ Name: 'new.example.com.' }),
      record({})
    );

    const [list] = calls(ListResourceRecordSetsCommand);
    expect(list?.input).toEqual({
      HostedZoneId: ZONE,
      StartRecordName: 'old.example.com.',
      StartRecordType: 'A',
      MaxItems: 5,
    });
    const changes = calls(ChangeResourceRecordSetsCommand);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.input.HostedZoneId).toBe(ZONE);
    expect(changes[0]?.input.ChangeBatch?.Changes).toEqual([
      { Action: 'DELETE', ResourceRecordSet: liveOld },
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
    expect(result.physicalId).toBe(`${ZONE}|new.example.com.|A`);
    expect(result.wasReplaced).toBe(true);
  });

  it('a Type change on the same name (A -> CNAME) is one DELETE + CREATE batch', async () => {
    const liveOld = { Name: 'c.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '192.0.2.4' }] };
    routeSend([liveOld]);

    const result = await provider.update(
      'Rec',
      `${ZONE}|c.example.com.|A`,
      TYPE,
      record({ Name: 'c.example.com.', Type: 'CNAME', ResourceRecords: ['target.example.com'] }),
      record({ Name: 'c.example.com.', ResourceRecords: ['192.0.2.4'] })
    );

    const actions = calls(ChangeResourceRecordSetsCommand)[0]?.input.ChangeBatch?.Changes?.map(
      (c) => [c.Action, c.ResourceRecordSet?.Type]
    );
    expect(actions).toEqual([
      ['DELETE', 'A'],
      ['CREATE', 'CNAME'],
    ]);
    expect(result.physicalId).toBe(`${ZONE}|c.example.com.|CNAME`);
    expect(result.wasReplaced).toBe(true);
  });

  it('a SetIdentifier change positions the lookup on the old identifier and replaces that record', async () => {
    const liveOld = {
      Name: 'w.example.com.',
      Type: 'A',
      SetIdentifier: 'id1',
      Weight: 10,
      TTL: 300,
      ResourceRecords: [{ Value: '192.0.2.3' }],
    };
    // A sibling weighted record of the same name/type must not be the one deleted.
    routeSend([
      liveOld,
      { ...liveOld, SetIdentifier: 'id9' },
    ]);

    const result = await provider.update(
      'Rec',
      `${ZONE}|w.example.com.|A`,
      TYPE,
      record({ Name: 'w.example.com.', SetIdentifier: 'id2', Weight: 10 }),
      record({ Name: 'w.example.com.', SetIdentifier: 'id1', Weight: 10 })
    );

    expect(calls(ListResourceRecordSetsCommand)[0]?.input.StartRecordIdentifier).toBe('id1');
    const changes = calls(ChangeResourceRecordSetsCommand)[0]?.input.ChangeBatch?.Changes;
    expect(changes?.[0]).toEqual({ Action: 'DELETE', ResourceRecordSet: liveOld });
    expect(changes?.[1]?.Action).toBe('CREATE');
    expect(changes?.[1]?.ResourceRecordSet?.SetIdentifier).toBe('id2');
    // The composite id omits SetIdentifier, so it is unchanged -- the record is not.
    expect(result.physicalId).toBe(`${ZONE}|w.example.com.|A`);
    expect(result.wasReplaced).toBe(true);
  });

  it('a simple record becoming weighted deletes the record WITHOUT a SetIdentifier', async () => {
    const liveOld = { Name: 's.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '192.0.2.5' }] };
    routeSend([{ ...liveOld, SetIdentifier: 'other', Weight: 1 }, liveOld]);

    await provider.update(
      'Rec',
      `${ZONE}|s.example.com.|A`,
      TYPE,
      record({ Name: 's.example.com.', SetIdentifier: 'w1', Weight: 5 }),
      record({ Name: 's.example.com.' })
    );

    expect(calls(ListResourceRecordSetsCommand)[0]?.input).not.toHaveProperty(
      'StartRecordIdentifier'
    );
    const changes = calls(ChangeResourceRecordSetsCommand)[0]?.input.ChangeBatch?.Changes;
    expect(changes?.[0]).toEqual({ Action: 'DELETE', ResourceRecordSet: liveOld });
    expect(changes?.[1]?.Action).toBe('CREATE');
  });

  it('no live old record (already gone, or a committed batch retried) writes the new record by UPSERT', async () => {
    // The page holds only a neighbour: a lookup match must be exact.
    routeSend([{ Name: 'old2.example.com.', Type: 'A', TTL: 60, ResourceRecords: [{ Value: '192.0.2.9' }] }]);

    const result = await provider.update(
      'Rec',
      `${ZONE}|old.example.com.|A`,
      TYPE,
      record({ Name: 'new.example.com.' }),
      record({})
    );

    const changes = calls(ChangeResourceRecordSetsCommand)[0]?.input.ChangeBatch?.Changes;
    expect(changes?.map((c) => c.Action)).toEqual(['UPSERT']);
    expect(changes?.[0]?.ResourceRecordSet?.Name).toBe('new.example.com.');
    expect(result.wasReplaced).toBe(true);
  });

  it('a refused batch surfaces as a failed update and is not retried as an UPSERT', async () => {
    const liveOld = { Name: 'c.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '192.0.2.4' }] };
    const refusal = Object.assign(new Error('Tried to create resource record set but it already exists'), {
      name: 'InvalidChangeBatch',
    });
    routeSend([liveOld], refusal);

    await expect(
      provider.update(
        'Rec',
        `${ZONE}|c.example.com.|A`,
        TYPE,
        record({ Name: 'd.example.com.' }),
        record({ Name: 'c.example.com.', ResourceRecords: ['192.0.2.4'] })
      )
    ).rejects.toThrow(
      new ProvisioningError(
        'Failed to update record set Rec: Tried to create resource record set but it already exists',
        TYPE,
        'Rec'
      ).message
    );
    expect(calls(ChangeResourceRecordSetsCommand)).toHaveLength(1);
  });

  it('a rollback replay renaming BACK also deletes the record it leaves (no leak on revert)', async () => {
    const liveNew = { Name: 'new.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '192.0.2.1' }] };
    routeSend([liveNew]);

    const result = await provider.update(
      'Rec',
      `${ZONE}|new.example.com.|A`,
      TYPE,
      record({}),
      record({ Name: 'new.example.com.' }),
      { replayingState: true }
    );

    const changes = calls(ChangeResourceRecordSetsCommand)[0]?.input.ChangeBatch?.Changes;
    expect(changes?.[0]).toEqual({ Action: 'DELETE', ResourceRecordSet: liveNew });
    expect(changes?.[1]?.ResourceRecordSet?.Name).toBe('old.example.com.');
    expect(result.physicalId).toBe(`${ZONE}|old.example.com.|A`);
  });

  it('a wildcard rename positions the lookup on the ENCODED name Route 53 stores', async () => {
    const liveOld = { Name: '\\052.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '192.0.2.1' }] };
    routeSend([liveOld]);

    await provider.update(
      'Rec',
      `${ZONE}|*.example.com|A`,
      TYPE,
      record({ Name: '*.new.example.com' }),
      record({ Name: '*.example.com' })
    );

    expect(calls(ListResourceRecordSetsCommand)[0]?.input.StartRecordName).toBe('\\052.example.com.');
    expect(calls(ChangeResourceRecordSetsCommand)[0]?.input.ChangeBatch?.Changes?.[0]).toEqual({
      Action: 'DELETE',
      ResourceRecordSet: liveOld,
    });
  });

  it('cdkd drift --revert never renames, even when its readback names a sibling record', async () => {
    // A readback that matched the wrong weighted sibling (id1) must not become
    // a DELETE of that sibling while restoring id9.
    routeSend([{ Name: 'w.example.com.', Type: 'A', SetIdentifier: 'id1', Weight: 1, TTL: 300 }]);

    const result = await provider.update(
      'Rec',
      `${ZONE}|w.example.com.|A`,
      TYPE,
      record({ Name: 'w.example.com.', SetIdentifier: 'id9', Weight: 1 }),
      record({ Name: 'w.example.com.', SetIdentifier: 'id1', Weight: 1 }),
      { desiredFromAwsReadback: true }
    );

    expect(calls(ListResourceRecordSetsCommand)).toHaveLength(0);
    const changes = calls(ChangeResourceRecordSetsCommand)[0]?.input.ChangeBatch?.Changes;
    expect(changes?.map((c) => [c.Action, c.ResourceRecordSet?.SetIdentifier])).toEqual([
      ['UPSERT', 'id9'],
    ]);
    expect(result.wasReplaced).toBe(false);
  });

  it('an ordinary update (same identity, trailing dot and case only) is one UPSERT with no lookup', async () => {
    routeSend([]);

    const result = await provider.update(
      'Rec',
      `${ZONE}|old.example.com.|A`,
      TYPE,
      record({ Name: 'OLD.example.com', TTL: '600' }),
      record({})
    );

    expect(calls(ListResourceRecordSetsCommand)).toHaveLength(0);
    expect(
      calls(ChangeResourceRecordSetsCommand)[0]?.input.ChangeBatch?.Changes?.map((c) => c.Action)
    ).toEqual(['UPSERT']);
    expect(result.wasReplaced).toBe(false);
  });

  it('an uncomparable recorded identity keeps the UPSERT and never guesses a DELETE', async () => {
    routeSend([]);

    await provider.update(
      'Rec',
      `${ZONE}|new.example.com.|A`,
      TYPE,
      record({ Name: 'new.example.com.' }),
      record({ Name: '{{resolve:ssm:/name}}' })
    );

    expect(calls(ListResourceRecordSetsCommand)).toHaveLength(0);
    expect(
      calls(ChangeResourceRecordSetsCommand)[0]?.input.ChangeBatch?.Changes?.map((c) => c.Action)
    ).toEqual(['UPSERT']);
  });

  it('the #3728 separator refusal still fires before any AWS call on a template rename', async () => {
    routeSend([]);

    await expect(
      provider.update(
        'Rec',
        `${ZONE}|old.example.com.|A`,
        TYPE,
        record({ Name: 'a|b.example.com.' }),
        record({})
      )
    ).rejects.toThrow(/\|/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('recordIdentityChanged (issue #3741)', () => {
  const base = { Name: 'a.example.com.', Type: 'A' };
  it.each([
    ['same record', base, base, false],
    ['trailing dot only', base, { ...base, Name: 'a.example.com' }, false],
    ['letter case only', base, { ...base, Name: 'A.Example.com.' }, false],
    ['octal escape only', { ...base, Name: '\\052.example.com.' }, { ...base, Name: '*.example.com' }, false],
    ['Name', base, { ...base, Name: 'b.example.com.' }, true],
    ['Type', base, { ...base, Type: 'AAAA' }, true],
    ['SetIdentifier', { ...base, SetIdentifier: 'x' }, { ...base, SetIdentifier: 'y' }, true],
    ['SetIdentifier added', base, { ...base, SetIdentifier: 'y' }, true],
    ['SetIdentifier removed', { ...base, SetIdentifier: 'x' }, base, true],
    ['SetIdentifier unchanged', { ...base, SetIdentifier: 'x' }, { ...base, SetIdentifier: 'x' }, false],
    ['redacted recorded Name', { ...base, Name: '{{resolve:ssm:/n}}' }, base, false],
    ['recorded Type missing', { Name: 'a.example.com.' }, { ...base, Name: 'b.example.com.' }, false],
    ['non-string recorded Name', { ...base, Name: 7 }, base, false],
    ['desired Name missing', base, { Type: 'A' }, false],
    ['unreadable recorded SetIdentifier', { ...base, SetIdentifier: 3 }, { ...base, SetIdentifier: 'y' }, false],
    ['redacted SetIdentifier added', base, { ...base, SetIdentifier: '{{resolve:ssm:/s}}' }, false],
    ['unreadable SetIdentifier removed', { ...base, SetIdentifier: 3 }, base, false],
    ['redacted SetIdentifier removed', { ...base, SetIdentifier: '{{resolve:ssm:/s}}' }, base, false],
  ])('%s', (_label, previous, desired, expected) => {
    expect(recordIdentityChanged(previous, desired)).toBe(expected);
  });
});

describe('Route53Provider readCurrentState matches the recorded SetIdentifier (issue #3741 review)', () => {
  let provider: Route53Provider;
  const sibling = { Name: 'w.example.com.', Type: 'A', SetIdentifier: 'id1', Weight: 1, TTL: 60, ResourceRecords: [{ Value: '192.0.2.1' }] };
  const target = { ...sibling, SetIdentifier: 'id9', Weight: 9, ResourceRecords: [{ Value: '192.0.2.9' }] };
  const simple = { Name: 'w.example.com.', Type: 'A', TTL: 60, ResourceRecords: [{ Value: '192.0.2.5' }] };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new Route53Provider();
  });

  it('reads the record with the recorded SetIdentifier, not the sibling that sorts first', async () => {
    routeSend([sibling, target]);
    const observed = await provider.readCurrentState(
      `${ZONE}|w.example.com.|A`,
      'Rec',
      TYPE,
      record({ Name: 'w.example.com.', SetIdentifier: 'id9', Weight: 9 })
    );
    expect(calls(ListResourceRecordSetsCommand)[0]?.input.StartRecordIdentifier).toBe('id9');
    expect(observed?.['SetIdentifier']).toBe('id9');
    expect(observed?.['Weight']).toBe(9);
  });

  it('a recorded bag with no SetIdentifier reads the record without one', async () => {
    routeSend([sibling, simple]);
    const observed = await provider.readCurrentState(
      `${ZONE}|w.example.com.|A`,
      'Rec',
      TYPE,
      record({ Name: 'w.example.com.' })
    );
    expect(calls(ListResourceRecordSetsCommand)[0]?.input).not.toHaveProperty('StartRecordIdentifier');
    expect(observed).not.toHaveProperty('SetIdentifier');
    expect(observed?.['ResourceRecords']).toEqual(['192.0.2.5']);
  });

  it('a recorded SetIdentifier that is not live reads as absent', async () => {
    routeSend([sibling]);
    const observed = await provider.readCurrentState(
      `${ZONE}|w.example.com.|A`,
      'Rec',
      TYPE,
      record({ Name: 'w.example.com.', SetIdentifier: 'id9' })
    );
    expect(observed).toBeUndefined();
  });

  it('with no recorded bag (the import verification) the name + type match stands', async () => {
    routeSend([sibling, target]);
    const observed = await provider.readCurrentState(`${ZONE}|w.example.com.|A`, 'Rec', TYPE);
    expect(calls(ListResourceRecordSetsCommand)[0]?.input).not.toHaveProperty('StartRecordIdentifier');
    expect(observed?.['SetIdentifier']).toBe('id1');
  });

  it('a redacted recorded SetIdentifier keeps the name + type match', async () => {
    routeSend([sibling, target]);
    const observed = await provider.readCurrentState(
      `${ZONE}|w.example.com.|A`,
      'Rec',
      TYPE,
      record({ Name: 'w.example.com.', SetIdentifier: '{{resolve:ssm:/sid}}' })
    );
    expect(calls(ListResourceRecordSetsCommand)[0]?.input).not.toHaveProperty('StartRecordIdentifier');
    expect(observed?.['SetIdentifier']).toBe('id1');
  });

  it('a malformed recorded SetIdentifier keeps the name + type match', async () => {
    routeSend([sibling, target]);
    const observed = await provider.readCurrentState(
      `${ZONE}|w.example.com.|A`,
      'Rec',
      TYPE,
      record({ Name: 'w.example.com.', SetIdentifier: 7 })
    );
    expect(observed?.['SetIdentifier']).toBe('id1');
  });
});

// Measured against real AWS (us-east-1, 2026-09-26; transcript on issue #3741).
const ZONE_NAME = 'cdkd-3741-conf-1790385669.internal.';
const CNAME_BESIDE_A = `[RRSet of type CNAME with DNS name y.${ZONE_NAME} is not permitted as it conflicts with other records with the same DNS name in zone ${ZONE_NAME}]`;
const A_BESIDE_CNAME = `[RRSet of type A with DNS name x.${ZONE_NAME} is not permitted because a conflicting RRSet of type CNAME with the same DNS name already exists in zone ${ZONE_NAME}]`;
const DUPLICATE = `[Tried to create resource record set [name='x.${ZONE_NAME}', type='CNAME'] but it already exists]`;

function batchRefusal(message: string): Error {
  return Object.assign(new Error(message), { name: 'InvalidChangeBatch' });
}

describe('Route53Provider create classifies Route 53 name conflicts as collisions (issue #3741)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new Route53Provider();
  });

  async function createError(refusal: Error): Promise<unknown> {
    routeSend([], refusal);
    return provider
      .create('Rec', TYPE, record({ Name: `y.${ZONE_NAME}`, Type: 'CNAME', ResourceRecords: ['t.example.com'] }))
      .catch((e: unknown) => e);
  }

  it.each([
    // The one Route 53 spelling without "already exists": a rollback reversing
    // a CNAME -> A rename collides with the live A and must delete it first.
    ['a CNAME beside a live record of the same name', CNAME_BESIDE_A],
    ['a record beside a live CNAME', A_BESIDE_CNAME],
    ['a duplicate record', DUPLICATE],
  ])('%s is a name collision', async (_label, message) => {
    const error = await createError(batchRefusal(message));
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).toContain(message);
    expect(isNameCollisionErrorFrom(error, 'Rec')).toBe(true);
    // Anchored on the logical id, like every other collision.
    expect(isNameCollisionErrorFrom(error, 'OtherRecord')).toBe(false);
  });

  it.each([
    ['another batch refusal', batchRefusal('[Invalid Resource Record: FATAL problem: ARRDATAIllegalIPv4Address]')],
    // The CNAME text under a different error name is not the batch refusal.
    ['the CNAME text under another error name', Object.assign(new Error(CNAME_BESIDE_A), { name: 'Throttling' })],
  ])('%s is not a name collision', async (_label, refusal) => {
    const error = await createError(refusal);
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(isNameCollisionErrorFrom(error, 'Rec')).toBe(false);
  });
});
