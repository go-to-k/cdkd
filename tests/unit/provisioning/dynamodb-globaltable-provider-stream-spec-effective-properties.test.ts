import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-test-table-xxx';

const baseProps = {
  TableName: TABLE_NAME,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
  Replicas: [{ Region: 'us-east-1' }],
};

/**
 * `effectiveProperties` for the `StreamSpecification` warn arms (issue #1653).
 *
 * Both arms make the deploy SUCCEED while the DECLARED block never reaches
 * AWS as written, so before this fix the engine recorded the malformed desired
 * value. `readCurrentState` can never match that, so every later `cdkd drift`
 * re-reported the same difference and `drift --revert` re-issued the same
 * call — the permanent phantom drift `.claude/rules/providers.md` records for
 * the EC2 Route warn arm (#1591), reached through a SKIP / a SUBSTITUTION
 * instead of a narrowing.
 *
 * The answer differs per path because what reached AWS differs, which is why
 * both are pinned here rather than one standing in for the other.
 */
describe('DynamoDBGlobalTableProvider StreamSpecification effectiveProperties (issue #1653)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableStatus: 'ACTIVE',
        TableArn: `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}`,
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
      },
    });
    provider = new DynamoDBGlobalTableProvider();
  });

  /** Every UpdateTable input this update issued. */
  const updateInputs = (): Array<Record<string, unknown>> =>
    mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .map((c) => c[0].input as Record<string, unknown>);

  // ─── UPDATE: the SKIP arm retains the PREVIOUS value ────────────────────

  it('records the PREVIOUS StreamSpecification when the update SKIPS the block', async () => {
    const previousSpec = { StreamViewType: 'KEYS_ONLY' };
    const desired = { ...baseProps, StreamSpecification: '' };

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, {
      ...baseProps,
      StreamSpecification: previousSpec,
    });

    // The load-bearing assertion: the exact PREVIOUS object, not the
    // malformed desired one and not the NEW_AND_OLD_IMAGES default. The
    // `UpdateTable` never ran, so AWS still holds the previous configuration.
    expect(result.effectiveProperties?.['StreamSpecification']).toEqual({
      StreamViewType: 'KEYS_ONLY',
    });
    // It REPLACES the desired bag wholesale, so it must be complete.
    expect(result.effectiveProperties).toEqual({
      ...desired,
      StreamSpecification: previousSpec,
    });

    // The WIRE half of the same claim: recording the previous value is only
    // correct BECAUSE nothing was sent. A mutation that both sends the block
    // and retains the previous value satisfies the assertions above.
    expect(updateInputs().some((i) => 'StreamSpecification' in i)).toBe(false);
    // ...and the skip is still ANNOUNCED. `effectiveProperties` records the
    // narrowing; it does not replace warning about it.
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::GlobalTable StreamSpecification')
    );
  });

  it('COPIES the previous value rather than aliasing the previous bag', async () => {
    // `rollback-executor.ts` spreads the returned bag shallowly, so an alias
    // would leave two state records sharing one mutable object.
    const previousSpec = { StreamViewType: 'KEYS_ONLY' };

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, StreamSpecification: '' },
      { ...baseProps, StreamSpecification: previousSpec }
    );

    expect(result.effectiveProperties?.['StreamSpecification']).toEqual(previousSpec);
    expect(result.effectiveProperties?.['StreamSpecification']).not.toBe(previousSpec);
  });

  // ─── UPDATE: a MALFORMED previous side is not laundered into state ──────
  //
  // issue #1653 review (item A2). `previousProperties` is a cdkd STATE record,
  // and a rollback replay whose record was written by an older binary is
  // exactly the #1544 scenario — so the previous side can be junk too, and
  // copying it in would re-create the phantom drift from the other direction.

  // The desired side is `{ StreamViewType: 42 }` rather than `''` so it
  // differs from every previous value under test: the guarded block is behind
  // a `!deepEqual(desired, previous)` gate, so an IDENTICALLY malformed pair
  // never reaches the skip at all (pinned separately below).
  const malformedDesired = { ...baseProps, StreamSpecification: { StreamViewType: 42 } };

  it.each([
    ['null', null],
    ['a blank string', ''],
    ['a bare string container', 'NEW_IMAGE'],
    ['an array container', []],
    ['a malformed StreamViewType field', { StreamViewType: null }],
    ['a blank StreamViewType field', { StreamViewType: '  ' }],
  ])('DROPS the key when the previous StreamSpecification is %s', async (_label, previousSpec) => {
    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      malformedDesired,
      { ...baseProps, StreamSpecification: previousSpec }
    );

    expect(result.effectiveProperties).toBeDefined();
    expect('StreamSpecification' in (result.effectiveProperties ?? {})).toBe(false);
    expect(result.effectiveProperties).toEqual(baseProps);
  });

  it('answers with NO effectiveProperties when BOTH sides are identically malformed', async () => {
    // The `!deepEqual` gate means the skip arm is never reached, so nothing
    // was sent AND nothing was narrowed — the desired bag is already what
    // state holds. Recording an answer here would be a no-op at best and, if
    // it dropped the key, a silent rewrite of a record this update never
    // touched.
    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, StreamSpecification: '' },
      { ...baseProps, StreamSpecification: '' }
    );

    expect(result.effectiveProperties).toBeUndefined();
    expect(updateInputs().some((i) => 'StreamSpecification' in i)).toBe(false);
  });

  it('RETAINS a previous EMPTY block, which is a legitimate recorded value', async () => {
    // `{}` is what a template declaring `StreamSpecification: {}` records, and
    // the create path already treats it as "enabled with the default view
    // type" — it is not malformed, so it must not be swept up by the guard.
    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, StreamSpecification: '' },
      { ...baseProps, StreamSpecification: {} }
    );

    expect(result.effectiveProperties?.['StreamSpecification']).toEqual({});
  });

  it('DROPS the key when the update skips and the previous side is ABSENT', async () => {
    const desired = { ...baseProps, StreamSpecification: '' };
    const previous = { ...baseProps };

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      desired,
      previous
    );

    // No previous value to retain. An explicit `undefined` would survive the
    // spread and read differently across `JSON.stringify` on the two sides of
    // the next diff, so the key must be genuinely absent.
    expect(result.effectiveProperties).toBeDefined();
    expect('StreamSpecification' in (result.effectiveProperties ?? {})).toBe(false);
    expect(result.effectiveProperties).toEqual(baseProps);
  });

  // ─── UPDATE: the well-formed polarity is untouched ──────────────────────

  it('answers with NO effectiveProperties when the desired StreamSpecification is VALID', async () => {
    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, StreamSpecification: { StreamViewType: 'NEW_IMAGE' } },
      { ...baseProps, StreamSpecification: { StreamViewType: 'KEYS_ONLY' } }
    );

    // Absent means "record the desired properties" — the normal case, and the
    // reason the engine gates on `??` rather than on truthiness.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('answers with NO effectiveProperties when no StreamSpecification is declared at all', async () => {
    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, baseProps, {
      ...baseProps,
      TableClass: 'STANDARD',
    });

    expect(result.effectiveProperties).toBeUndefined();
  });

  // ─── replay CREATE: the SUBSTITUTED value is what was SENT ──────────────

  it('records the SUBSTITUTED StreamSpecification on a replay create', async () => {
    const desired = { ...baseProps, StreamSpecification: '' };

    const result = await provider.create('MyTable', RESOURCE_TYPE, desired, {
      replayingState: true,
    });

    // Unlike the update SKIP, this arm APPLIES a stream — the downgrade
    // substitutes the default and `CreateTable` carries it — so "drop the
    // key" (the #1612 replay-CREATE answer for a genuine skip) would record
    // that cdkd sent nothing. The recorded shape is the CFn one:
    // `AWS::DynamoDB::GlobalTable`'s StreamSpecification declares only
    // `StreamViewType`, so this is byte-identical to what an ordinary
    // template-path create of the same table records.
    expect(result.effectiveProperties?.['StreamSpecification']).toEqual({
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    });
    expect(result.effectiveProperties).toEqual({
      ...desired,
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    });
    expect(
      mockSend.mock.calls.find((c) => c[0].constructor.name === 'CreateTableCommand')?.[0].input
        .StreamSpecification
    ).toEqual({ StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' });
  });

  it('records the SUBSTITUTED value when only the StreamViewType FIELD is malformed', async () => {
    const result = await provider.create(
      'MyTable',
      RESOURCE_TYPE,
      { ...baseProps, StreamSpecification: { StreamViewType: null } },
      { replayingState: true }
    );

    expect(result.effectiveProperties?.['StreamSpecification']).toEqual({
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    });
  });

  it('answers with NO effectiveProperties for a VALID value on a replay create', async () => {
    const result = await provider.create(
      'MyTable',
      RESOURCE_TYPE,
      { ...baseProps, StreamSpecification: { StreamViewType: 'KEYS_ONLY' } },
      { replayingState: true }
    );

    expect(result.effectiveProperties).toBeUndefined();
  });

  it('answers with NO effectiveProperties on an ordinary template-path create', async () => {
    const result = await provider.create('MyTable', RESOURCE_TYPE, {
      ...baseProps,
      StreamSpecification: { StreamViewType: 'KEYS_ONLY' },
    });

    expect(result.effectiveProperties).toBeUndefined();
  });

  it('keeps the template-path REFUSAL rather than substituting and recording', async () => {
    // The wrapper that tracks the substitution must not smuggle in a
    // downgrade of its own: with no replay context the read still throws, so
    // there is nothing to record.
    await expect(
      provider.create('MyTable', RESOURCE_TYPE, { ...baseProps, StreamSpecification: '' })
    ).rejects.toThrow(
      /AWS::DynamoDB::GlobalTable StreamSpecification must be an object \(got a blank string\)/
    );
    expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).not.toContain(
      'CreateTableCommand'
    );
  });
});
