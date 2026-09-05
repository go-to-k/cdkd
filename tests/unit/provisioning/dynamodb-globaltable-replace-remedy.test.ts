/**
 * Issue [#2610] sites 5-7: `AWS::DynamoDB::GlobalTable`'s three immutable
 * property guards advised `deploy with --replace`, which is wrong twice — the
 * type is in `STATEFUL_TYPES` (so the engine's replace fallback refuses it
 * again with `STATEFUL_REPLACE_BLOCKED`), and no deploy-side flag can clear
 * `DeletionProtectionEnabled`.
 *
 * Its own file because the provider's client comes from `getAwsClients()`,
 * which has to be mocked at module scope. Every assertion below is reached
 * before the first `send`, which the mock enforces.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// `mockRegion` is a SPY, not the plain arrow every other DynamoDB suite uses.
// Two things depend on that, and the round-3 review of PR go-to-k/cdkd#2662
// found both missing: a plain arrow cannot be made to REJECT, so the
// `catch { guardRegion = '' }` arm was unreachable from any test; and it
// records no calls, so the ORDER of the region read against the guards -- the
// whole subject of the withdrawn hoist -- was unobservable. With the arrow, a
// probe that re-applied the hoist stayed GREEN across 8249 tests.
const { mockSend, mockRegion } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockRegion: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: mockRegion } },
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

import {
  DynamoDBGlobalTableProvider,
  localReplicaEntry,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { STATEFUL_TYPES } from '../../../src/provisioning/stateful-types.js';

const TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'MyGlobalTable';

const KEY_SCHEMA = [{ AttributeName: 'pk', KeyType: 'HASH' }];

async function refusal(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): Promise<string> {
  const provider = new DynamoDBGlobalTableProvider();
  try {
    await provider.update('Table', TABLE, TYPE, properties, previousProperties);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected update() to refuse, but it resolved');
}

/** The three guards, each driven by the property it is about. */
const SITES: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['TableName', { TableName: 'renamed' }, { TableName: TABLE }],
  [
    'KeySchema',
    { KeySchema: [{ AttributeName: 'other', KeyType: 'HASH' }] },
    { KeySchema: KEY_SCHEMA },
  ],
  [
    'LocalSecondaryIndexes',
    { KeySchema: KEY_SCHEMA, LocalSecondaryIndexes: [{ IndexName: 'lsi2' }] },
    { KeySchema: KEY_SCHEMA, LocalSecondaryIndexes: [{ IndexName: 'lsi1' }] },
  ],
];

describe('DynamoDB GlobalTable immutable-property refusals (sites 5-7)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockRegion.mockReset();
    mockRegion.mockResolvedValue('us-east-1');
    mockSend.mockRejectedValue(
      new Error('the refusal must fire before any AWS call on this path')
    );
  });

  it('is a stateful type, so every refusal must name --force-stateful-recreation', () => {
    expect(STATEFUL_TYPES.has(TYPE)).toBe(true);
  });

  for (const [label, next, prev] of SITES) {
    it(`${label}: names the deletion-protection dead end when the LOCAL replica records it`, async () => {
      const message = await refusal(next, {
        ...prev,
        Replicas: [
          { Region: 'us-east-1', DeletionProtectionEnabled: true },
          { Region: 'eu-west-1', DeletionProtectionEnabled: false },
        ],
      });
      expect(message).toContain('DeletionProtectionEnabled: true for the deploy region');
      expect(message).toContain('cdkd deploy --replace --force-stateful-recreation');
      expect(message).toContain(`--table-name ${TABLE} --no-deletion-protection-enabled`);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it(`${label}: keeps the short advice when the local replica is unprotected`, async () => {
      const message = await refusal(next, {
        ...prev,
        Replicas: [
          { Region: 'us-east-1', DeletionProtectionEnabled: false },
          // A NON-local replica carrying protection must not trip the advice:
          // the resolution is per-replica and scoped to the deploy region.
          { Region: 'eu-west-1', DeletionProtectionEnabled: true },
        ],
      });
      expect(message).toContain(
        'replacement required (deploy with cdkd deploy --replace --force-stateful-recreation'
      );
      expect(message).not.toContain('--remove-protection');
      expect(message).not.toContain('update-table');
    });
  }

  it('falls back to the TOP-LEVEL flag when the local replica declares none', async () => {
    const [, next, prev] = SITES[0]!;
    const message = await refusal(next, { ...prev, DeletionProtectionEnabled: true });
    expect(message).toContain('DeletionProtectionEnabled: true for the deploy region');
  });

  it('keeps the short advice when nothing records protection at all', async () => {
    const [, next, prev] = SITES[0]!;
    const message = await refusal(next, prev);
    expect(message).not.toContain('--remove-protection');
  });

  it('reads the RECORDED bag, not the desired one', async () => {
    const [, next, prev] = SITES[0]!;
    const message = await refusal(
      { ...next, Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }] },
      { ...prev, Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: false }] }
    );
    expect(message).not.toContain('--remove-protection');
  });
});

/**
 * The withdrawn region HOIST, fenced.
 *
 * Round 2 of PR go-to-k/cdkd#2662's review found a blocker inside round 1's own
 * fix: the region read had been hoisted above these guards and its rejection
 * wrapped in a method-scoped `try/catch`, which degraded `currentRegion` to
 * `''` for its ~40 other uses -- including the replica diff loops, where
 * `region === currentRegion` is the only thing keeping the LOCAL replica from
 * being issued a `Delete`. The hoist was withdrawn; the method's read is
 * fail-CLOSED and back where `main` had it, and only the remedy thunk resolves
 * a region, lazily and defensively.
 *
 * Round 3 then found the WITHDRAWAL unfenced: re-applying the hoist left 8249
 * tests passing. These cases are what makes that probe RED.
 */
describe('the region read is lazy, fail-closed for the method, and defensive in the thunk', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockRegion.mockReset();
    // A DEFAULT, so a case added here later gets a resolving region rather
    // than an unprimed `undefined` that silently becomes `guardRegion = ''` --
    // which is the degraded arm, and would make a new case pass for the wrong
    // reason. Cases that need a rejection override it explicitly.
    mockRegion.mockResolvedValue('us-east-1');
    mockSend.mockRejectedValue(
      new Error('the refusal must fire before any AWS call on this path')
    );
  });

  it('resolves NO region at all before a guard refuses', async () => {
    // The hoist's actual signature. A refusal reached without any region read
    // is what "the guards refuse before touching anything" means, and it is
    // the assertion the plain-arrow mock could not make.
    const provider = new DynamoDBGlobalTableProvider();
    await expect(
      provider.update('Table', TABLE, TYPE, { TableName: 'renamed' }, { TableName: TABLE })
    ).rejects.toThrow(/TableName is immutable/);
    // Exactly one: the remedy thunk's own lazy read. A hoisted read makes this
    // two (thunk + method) or moves it before the throw.
    expect(mockRegion).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('still refuses with its OWN message when the region resolver REJECTS', async () => {
    // The `catch { guardRegion = '' }` arm, previously unreachable. The
    // discriminator is WHICH error surfaces: hoisted + unwrapped, the region
    // rejection pre-empts the refusal and the user sees "no region" instead of
    // the immutable-property message.
    mockRegion.mockRejectedValue(new Error('no region configured'));
    const provider = new DynamoDBGlobalTableProvider();
    const error = await provider
      .update('Table', TABLE, TYPE, { TableName: 'renamed' }, { TableName: TABLE })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(error).not.toBeNull();
    expect(error!.message).toContain('TableName is immutable on AWS::DynamoDB::GlobalTable');
    expect(error!.message).not.toContain('no region configured');
  });

  it('degrades to the SHORT advice when the region cannot be resolved', async () => {
    // An unresolvable region means no local replica is identifiable, so the
    // per-replica flag cannot be read and the message must not claim it.
    mockRegion.mockRejectedValue(new Error('no region configured'));
    const message = await refusal(
      { TableName: 'renamed' },
      {
        TableName: TABLE,
        Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }],
      }
    );
    expect(message).toContain('replacement required (deploy with cdkd deploy --replace');
    expect(message).not.toContain('--remove-protection');
  });

  it('still reads the TOP-LEVEL flag when the region is unresolvable', async () => {
    // The degradation is bounded: losing the region loses the PER-REPLICA
    // read, not the top-level fallback. Without this the case above would also
    // pass on a thunk that gave up entirely.
    mockRegion.mockRejectedValue(new Error('no region configured'));
    const message = await refusal(
      { TableName: 'renamed' },
      { TableName: TABLE, DeletionProtectionEnabled: true }
    );
    expect(message).toContain('DeletionProtectionEnabled: true for the deploy region');
  });

  it('does not let a non-array Replicas turn the refusal into a TypeError', async () => {
    // `extractLocalDeletionProtection` did `(props['Replicas'] ?? []).find(...)`,
    // so an unresolved intrinsic or a hand-edited state record replaced three
    // informative ProvisioningErrors with a stack trace.
    for (const replicas of [{ Ref: 'SomeParam' }, 'us-east-1', 42, null]) {
      const message = await refusal(
        { TableName: 'renamed' },
        { TableName: TABLE, Replicas: replicas }
      );
      expect(message, String(replicas)).toContain('TableName is immutable');
      expect(message, String(replicas)).not.toContain('TypeError');
    }
  });
});

/**
 * The SHARED `Replicas` predicate, tested directly.
 *
 * Its two readers had drifted: issue [#2610]'s review guarded
 * `extractLocalDeletionProtection` and left `update()`'s inline
 * `extractLocalTags` on the unguarded spelling -- and a probe removing that
 * guard came back GREEN, because reaching `extractLocalTags` needs the whole
 * apply path while the defect is a two-line predicate. Testing the predicate
 * itself is what makes BOTH readers fenced by one case.
 */
describe('localReplicaEntry', () => {
  it('returns undefined rather than throwing for a non-array Replicas', () => {
    // The shapes a state record can really carry: an unresolved intrinsic, a
    // hand-edited scalar, an absent key.
    for (const raw of [{ Ref: 'SomeParam' }, 'us-east-1', 42, null, undefined, true]) {
      expect(() => localReplicaEntry({ Replicas: raw }, 'us-east-1')).not.toThrow();
      expect(localReplicaEntry({ Replicas: raw }, 'us-east-1')).toBeUndefined();
    }
    expect(localReplicaEntry({}, 'us-east-1')).toBeUndefined();
  });

  it('tolerates a null ENTRY inside an otherwise valid array', () => {
    const entry = { Region: 'us-east-1', DeletionProtectionEnabled: true };
    expect(localReplicaEntry({ Replicas: [null, entry] }, 'us-east-1')).toBe(entry);
  });

  it('still FINDS the local replica, and only the local one (negative control)', () => {
    // Without this, a predicate that always returned `undefined` would satisfy
    // every assertion above.
    const local = { Region: 'us-east-1', Tags: [{ Key: 'a', Value: 'b' }] };
    const remote = { Region: 'eu-west-1' };
    expect(localReplicaEntry({ Replicas: [remote, local] }, 'us-east-1')).toBe(local);
    expect(localReplicaEntry({ Replicas: [remote] }, 'us-east-1')).toBeUndefined();
    expect(localReplicaEntry({ Replicas: [remote, local] }, '')).toBeUndefined();
  });
});

/**
 * G2: the ROUTING, not just the predicate.
 *
 * Sharing `localReplicaEntry` is only worth anything while the readers actually
 * CALL it, and nothing checked that: reverting `update()`'s inline
 * `extractLocalTags` to its pre-fix `(props['Replicas'] ?? []).find((r) =>
 * r['Region'] === ...)` was GREEN across all 906 files. This drives a malformed
 * `Replicas` down the TAG path -- the apply-path reader, which runs ~400 lines
 * before the refusal-path one -- so the revert throws a bare `TypeError` and
 * the case goes red.
 */
describe('the tag path routes through the shared predicate (routing fence)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockRegion.mockReset();
    mockRegion.mockResolvedValue('us-east-1');
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      switch (cmd.constructor.name) {
        case 'DescribeTableCommand':
          return Promise.resolve({
            Table: {
              TableStatus: 'ACTIVE',
              TableArn: `arn:aws:dynamodb:us-east-1:123456789012:table/${TABLE}`,
              KeySchema: KEY_SCHEMA,
            },
          });
        default:
          return Promise.resolve({});
      }
    });
  });

  /** Run an update that reaches the tag diff, and report what it threw. */
  const updateWith = async (replicas: unknown): Promise<Error | null> => {
    const provider = new DynamoDBGlobalTableProvider();
    return provider
      .update(
        'Table',
        TABLE,
        TYPE,
        { KeySchema: KEY_SCHEMA, Replicas: replicas },
        { KeySchema: KEY_SCHEMA, Replicas: replicas }
      )
      .then(() => null)
      .catch((e: unknown) => e as Error);
  };

  it('does not throw a TypeError on a malformed Replicas', async () => {
    for (const replicas of [{ Ref: 'SomeParam' }, 'us-east-1', 42, true]) {
      const error = await updateWith(replicas);
      // It may still fail for unrelated reasons on this stubbed client; what it
      // must never do is die inside a `.find` over a non-array.
      expect(error?.name, String(replicas)).not.toBe('TypeError');
      expect(error?.message ?? '', String(replicas)).not.toMatch(/is not a function/);
    }
  });

  it('premise: the tag path really was reached (a DescribeTable was issued)', async () => {
    // Without this, a case that failed BEFORE the tag diff would satisfy the
    // assertion above while exercising nothing.
    await updateWith({ Ref: 'SomeParam' });
    const sent = mockSend.mock.calls.map(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name
    );
    expect(sent).toContain('DescribeTableCommand');
  });

  it('and a well-formed Replicas still reaches the tag diff (negative control)', async () => {
    const error = await updateWith([{ Region: 'us-east-1', Tags: [{ Key: 'a', Value: 'b' }] }]);
    expect(error?.name).not.toBe('TypeError');
  });
});
