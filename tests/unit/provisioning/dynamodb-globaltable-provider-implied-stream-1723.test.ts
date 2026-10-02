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

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { makeCanonicalizePropertiesFn } from '../../../src/provisioning/canonicalize-properties.js';
import { withoutSilentDropProperties } from '../../../src/provisioning/property-coverage.js';
import {
  DynamoDBGlobalTableProvider,
  replicationImpliedStreamSpecification,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'implied-stream-table';
const IMPLIED = { StreamViewType: 'NEW_AND_OLD_IMAGES' };

const baseProps = {
  TableName: TABLE_NAME,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
};

/** Two replicas and no declared stream: the shape `create()` auto-enables. */
const twoReplicas = (): Record<string, unknown> => ({
  ...baseProps,
  Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }],
});

const describeResponse = (stream?: Record<string, unknown>): Record<string, unknown> => ({
  Table: {
    TableName: TABLE_NAME,
    TableStatus: 'ACTIVE',
    TableArn: `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}`,
    BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
    Replicas: [
      { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
      { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
    ],
    ...(stream && { StreamSpecification: stream }),
  },
});

/**
 * Issue #1723: `create()` enables a `NEW_AND_OLD_IMAGES` stream on a
 * multi-replica table whose template declares none, and used to record nothing
 * for it. A record without the stream is not phantom DRIFT (the drift walk only
 * descends into keys the record has), but it is a wrong PREVIOUS side: a
 * template that later declares that same stream diffs as a change, and
 * `update()` then asks AWS to enable a stream the table already has.
 *
 * The fix records the stream and pairs it with a `canonicalizeDesiredProperties`
 * twin over the one shared predicate, so neither a record written before the
 * fix nor one written after it diffs against the unchanged template.
 */
describe('DynamoDBGlobalTableProvider needsStream record + twin (issue #1723)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    childLogger.info.mockReset();
    mockSend.mockResolvedValue(describeResponse());
    provider = new DynamoDBGlobalTableProvider();
  });

  const createInput = (): Record<string, unknown> =>
    mockSend.mock.calls.find((c) => c[0].constructor.name === 'CreateTableCommand')?.[0]
      .input as Record<string, unknown>;

  const updateInputs = (): Array<Record<string, unknown>> =>
    mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .map((c) => c[0].input as Record<string, unknown>);

  // ─── create ────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('records the stream it auto-enables for two replicas, in the CFn shape', async () => {
      const desired = twoReplicas();

      const result = await provider.create('MyTable', RESOURCE_TYPE, desired);

      // The wire half first: the record is only honest because this went out.
      expect(createInput()['StreamSpecification']).toEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      });
      // The whole bag, since `effectiveProperties` REPLACES the desired one.
      expect(result.effectiveProperties).toEqual({ ...desired, StreamSpecification: IMPLIED });
      // ...and the caller's bag is not mutated into agreeing with it.
      expect('StreamSpecification' in desired).toBe(false);
    });

    it('records exactly what the twin folds the same template to', async () => {
      // The pairing the rules require, asserted rather than assumed: if the two
      // ever disagree, an unchanged template redeploys forever.
      const desired = twoReplicas();

      const result = await provider.create('MyTable', RESOURCE_TYPE, desired);

      expect(result.effectiveProperties).toEqual(
        provider.canonicalizeDesiredProperties(RESOURCE_TYPE, desired)
      );
    });

    it.each([
      ['a STRONG (MRSC) table', { ...twoReplicas(), MultiRegionConsistency: 'STRONG' }],
      ['an explicit EVENTUAL table', { ...twoReplicas(), MultiRegionConsistency: 'EVENTUAL' }],
    ])('still auto-enables but records NOTHING for %s', async (_label, desired) => {
      const result = await provider.create('MyTable', RESOURCE_TYPE, desired);

      expect(createInput()['StreamSpecification']).toEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      });
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('still auto-enables but records NOTHING for a single NON-LOCAL replica', async () => {
      // The region-dependent half: the twin cannot decide it, so recording it
      // here would be the unpaired `effectiveProperties` the rules forbid.
      const result = await provider.create('MyTable', RESOURCE_TYPE, {
        ...baseProps,
        Replicas: [{ Region: 'eu-west-1' }],
      });

      expect(createInput()['StreamSpecification']).toEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      });
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('records nothing for a DECLARED stream, even a null one the wire treats as absent', async () => {
      // `null` reaches the auto-enable on the wire (`!= null` gate), but it is
      // the template's own statement, so the presence-keyed fold leaves it.
      const declaredNull = await provider.create('MyTable', RESOURCE_TYPE, {
        ...twoReplicas(),
        StreamSpecification: null,
      });
      expect(createInput()['StreamSpecification']).toEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      });
      expect(declaredNull.effectiveProperties).toBeUndefined();

      mockSend.mockClear();
      const declared = await provider.create('MyTable', RESOURCE_TYPE, {
        ...twoReplicas(),
        StreamSpecification: { StreamViewType: 'KEYS_ONLY' },
      });
      expect(createInput()['StreamSpecification']).toEqual({
        StreamEnabled: true,
        StreamViewType: 'KEYS_ONLY',
      });
      expect(declared.effectiveProperties).toBeUndefined();
    });

    it('COMPOSES with an earlier replay-create arm rather than erasing it', async () => {
      // `billingModeSubstituted` runs first; assigning `{ ...properties }` at
      // the stream site would drop its recorded mode.
      const result = await provider.create(
        'MyTable',
        RESOURCE_TYPE,
        { ...twoReplicas(), BillingMode: '' },
        { replayingState: true }
      );

      expect(result.effectiveProperties?.['BillingMode']).toBe('PAY_PER_REQUEST');
      expect(result.effectiveProperties?.['StreamSpecification']).toEqual(IMPLIED);
    });
  });

  // ─── update ────────────────────────────────────────────────────────────

  describe('update()', () => {
    it('re-records the stream when the live table confirms it, without sending one', async () => {
      mockSend.mockResolvedValue(
        describeResponse({ StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' })
      );
      const desired = { ...twoReplicas(), TableClass: 'STANDARD_INFREQUENT_ACCESS' };

      const result = await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        desired,
        twoReplicas()
      );

      // An ordinary change went out, and no stream rode along with it.
      expect(updateInputs().some((i) => i['TableClass'] === 'STANDARD_INFREQUENT_ACCESS')).toBe(
        true
      );
      expect(updateInputs().some((i) => 'StreamSpecification' in i)).toBe(false);
      expect(result.effectiveProperties).toEqual({ ...desired, StreamSpecification: IMPLIED });
    });

    it.each([
      ['no stream at all', undefined],
      ['a disabled stream', { StreamEnabled: false }],
      // The `StreamEnabled === true` half of the re-record gate: a matching
      // view type alone is not a live stream.
      [
        'a disabled stream with the same view type',
        { StreamEnabled: false, StreamViewType: 'NEW_AND_OLD_IMAGES' },
      ],
      ['a different view type', { StreamEnabled: true, StreamViewType: 'KEYS_ONLY' }],
    ])('records NOTHING when the live table reports %s', async (_label, stream) => {
      // The update never sends the stream, so the record may only claim what
      // AWS holds; the twin folds the absent key on both diff sides anyway.
      mockSend.mockResolvedValue(describeResponse(stream));

      const result = await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        twoReplicas(),
        twoReplicas()
      );

      expect(result.effectiveProperties).toBeUndefined();
    });

    it('leaves a DECLARED stream to the declared-stream arm', async () => {
      mockSend.mockResolvedValue(
        describeResponse({ StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' })
      );
      const declared = { ...twoReplicas(), StreamSpecification: IMPLIED };

      const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, declared, declared);

      expect(result.effectiveProperties).toBeUndefined();
    });

    // The previous side is a cdkd RECORD, not proof of what AWS holds. Two
    // shapes reach the stream arm with a declared stream the table already
    // has: a pre-#1723 record (no key) whose deploy declares the stream AND
    // changes something else, and a rollback replay of a two-to-one replica
    // change (desired = the old record WITH the implied stream). Both used to
    // re-send `StreamEnabled: true` for a live stream.
    it.each([
      [
        'a pre-#1723 record, template declares the stream plus another change',
        { ...twoReplicas(), StreamSpecification: IMPLIED, TableClass: 'STANDARD_INFREQUENT_ACCESS' },
        twoReplicas(),
        undefined,
      ],
      [
        'a rollback replay handing back the old record with the implied stream',
        { ...twoReplicas(), StreamSpecification: IMPLIED },
        { ...twoReplicas(), TableClass: 'STANDARD_INFREQUENT_ACCESS' },
        { replayingState: true },
      ],
    ])('does NOT re-send a stream that is already live: %s', async (_l, desired, previous, ctx) => {
      mockSend.mockResolvedValue(
        describeResponse({ StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' })
      );

      const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous, ctx);

      expect(updateInputs().some((i) => 'StreamSpecification' in i)).toBe(false);
      // The declared value IS what AWS holds, so the desired bag is recorded.
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('still sends the stream when the live table does NOT have it (negative control)', async () => {
      mockSend.mockResolvedValue(describeResponse());

      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, Replicas: [{ Region: 'us-east-1' }], StreamSpecification: IMPLIED },
        { ...baseProps, Replicas: [{ Region: 'us-east-1' }] }
      );

      expect(updateInputs().map((i) => i['StreamSpecification'])).toContainEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      });
    });

    it('still sends the stream when the live one is DISABLED with the same view type', async () => {
      // Fences the `StreamEnabled === true` half of the gate: a disabled stream
      // with a matching view type is not "already live".
      mockSend.mockResolvedValue(
        describeResponse({ StreamEnabled: false, StreamViewType: 'NEW_AND_OLD_IMAGES' })
      );

      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, Replicas: [{ Region: 'us-east-1' }], StreamSpecification: IMPLIED },
        { ...baseProps, Replicas: [{ Region: 'us-east-1' }] }
      );

      expect(updateInputs().map((i) => i['StreamSpecification'])).toContainEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      });
    });

    it('still sends a DIFFERENT view type than the live one', async () => {
      mockSend.mockResolvedValue(
        describeResponse({ StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' })
      );

      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, Replicas: [{ Region: 'us-east-1' }], StreamSpecification: { StreamViewType: 'KEYS_ONLY' } },
        { ...baseProps, Replicas: [{ Region: 'us-east-1' }], StreamSpecification: IMPLIED }
      );

      expect(updateInputs().map((i) => i['StreamSpecification'])).toContainEqual({
        StreamEnabled: true,
        StreamViewType: 'KEYS_ONLY',
      });
    });

    it('keeps the unusable-desired arm when a stream is live (the gate does not swallow it)', async () => {
      // `readConfigString` answers the NEW_AND_OLD_IMAGES default for an
      // unusable block, which equals the live view type here: the live gate
      // must not pre-empt the arm that records the PREVIOUS value.
      mockSend.mockResolvedValue(
        describeResponse({ StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' })
      );
      const previousStream = { StreamViewType: 'KEYS_ONLY' };

      const result = await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, Replicas: [{ Region: 'us-east-1' }], StreamSpecification: '' },
        { ...baseProps, Replicas: [{ Region: 'us-east-1' }], StreamSpecification: previousStream },
        { replayingState: true }
      );

      expect(result.effectiveProperties?.['StreamSpecification']).toEqual(previousStream);
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('AWS::DynamoDB::GlobalTable StreamSpecification')
      );
    });

    it('COMPOSES the re-record onto an earlier update arm rather than erasing it', async () => {
      // `desiredGsiUnusable` (replay) retains the previous index list; the
      // implied-stream re-record runs last and must keep that answer.
      mockSend.mockResolvedValue(
        describeResponse({ StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' })
      );
      const validGsi = [
        {
          IndexName: 'byThing',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ];
      const desired = { ...twoReplicas(), GlobalSecondaryIndexes: 'oops-not-an-array' };

      const result = await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        desired,
        { ...twoReplicas(), GlobalSecondaryIndexes: validGsi },
        { replayingState: true }
      );

      expect(result.effectiveProperties).toEqual({
        ...desired,
        GlobalSecondaryIndexes: validGsi,
        StreamSpecification: IMPLIED,
      });
    });
  });

  // ─── the twin ──────────────────────────────────────────────────────────

  describe('canonicalizeDesiredProperties', () => {
    it('adds the implied stream to a multi-replica bag that declares none', () => {
      const bag = twoReplicas();

      const out = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, bag);

      expect(out).toEqual({ ...bag, StreamSpecification: IMPLIED });
      expect('StreamSpecification' in bag).toBe(false);
    });

    it.each([
      ['a single replica', { ...baseProps, Replicas: [{ Region: 'eu-west-1' }] }],
      ['no replicas key', { ...baseProps }],
      ['a non-array Replicas', { ...baseProps, Replicas: { Ref: 'Replicas' } }],
      ['a declared stream', { ...twoReplicas(), StreamSpecification: { StreamViewType: 'KEYS_ONLY' } }],
      ['a declared null stream', { ...twoReplicas(), StreamSpecification: null }],
      // Any declared consistency mode stops the fold: the key routes through
      // Cloud Control, where only the desired side would be folded.
      ['a STRONG (MRSC) table', { ...twoReplicas(), MultiRegionConsistency: 'STRONG' }],
      ['an explicit EVENTUAL table', { ...twoReplicas(), MultiRegionConsistency: 'EVENTUAL' }],
      [
        'an unresolved MultiRegionConsistency',
        { ...twoReplicas(), MultiRegionConsistency: { Ref: 'Mode' } },
      ],
    ])('returns the bag itself for %s', (_label, bag) => {
      expect(provider.canonicalizeDesiredProperties(RESOURCE_TYPE, bag)).toBe(bag);
    });

    it('returns the bag itself for a foreign resource type', () => {
      const bag = twoReplicas();
      expect(provider.canonicalizeDesiredProperties('AWS::DynamoDB::Table', bag)).toBe(bag);
    });

    it('counts replicas whose Region is still an unresolved intrinsic', () => {
      // The count is decidable without the region, whatever each entry holds.
      expect(
        replicationImpliedStreamSpecification({
          Replicas: [{ Region: { Ref: 'AWS::Region' } }, { Region: 'eu-west-1' }],
        })
      ).toEqual(IMPLIED);
    });
  });

  // ─── the diff, through the real builder ──────────────────────────────────

  describe('DiffCalculator with the real twin', () => {
    const canonicalize = makeCanonicalizePropertiesFn({
      hasProvider: (t: string) => t === RESOURCE_TYPE,
      getProvider: () => provider,
    });

    const stateWith = (properties: Record<string, unknown>): StackState =>
      ({
        version: 3,
        region: 'us-east-1',
        stackName: 'gt-stack',
        resources: {
          MyTable: {
            physicalId: TABLE_NAME,
            resourceType: RESOURCE_TYPE,
            properties,
            attributes: {},
          },
        },
        outputs: {},
        lastModified: 0,
      }) as unknown as StackState;

    const templateWith = (properties: Record<string, unknown>): CloudFormationTemplate => ({
      Resources: { MyTable: { Type: RESOURCE_TYPE, Properties: properties } },
    });

    const diff = async (
      state: Record<string, unknown>,
      template: Record<string, unknown>,
      withTwin = true
    ) =>
      (
        await new DiffCalculator().calculateDiff(
          stateWith(state),
          templateWith(template),
          undefined,
          withTwin ? canonicalize : undefined
        )
      ).get('MyTable');

    const recorded = (): Record<string, unknown> => ({ ...twoReplicas(), StreamSpecification: IMPLIED });

    // `MultiRegionConsistency` is a silent-drop key for this provider, so one
    // template reaches the three helper sites as DIFFERENT bags: `create()`
    // reads it raw, the engine strips it from the SDK-route record, and
    // `DiffCalculator` strips it from both sides when it is allow-listed. Pin
    // that every route still diffs the unchanged template as NO_CHANGE.
    it.each([['EVENTUAL'], ['STRONG']])(
      'SDK route with an allow-listed MultiRegionConsistency %s: NO_CHANGE after create',
      async (mode) => {
        const template = { ...twoReplicas(), MultiRegionConsistency: mode };
        const result = await provider.create('MyTable', RESOURCE_TYPE, template);
        // What the engine records on the SDK route (record-shape.ts).
        const record = withoutSilentDropProperties(
          RESOURCE_TYPE,
          result.effectiveProperties ?? template
        );
        expect('MultiRegionConsistency' in record).toBe(false);

        const change = (
          await new DiffCalculator().calculateDiff(
            stateWith(record),
            templateWith(template),
            undefined,
            canonicalize,
            new Set([`${RESOURCE_TYPE}:MultiRegionConsistency`])
          )
        ).get('MyTable');
        expect(change?.changeType).toBe('NO_CHANGE');
      }
    );

    it.each([['EVENTUAL'], ['STRONG']])(
      'Cloud Control record with MultiRegionConsistency %s and no stream: NO_CHANGE (desired-only fold stays off)',
      async (mode) => {
        const bag = { ...twoReplicas(), MultiRegionConsistency: mode };
        const state = stateWith(bag);
        (state.resources['MyTable'] as unknown as Record<string, unknown>)['provisionedBy'] = 'cc-api';

        const change = (
          await new DiffCalculator().calculateDiff(state, templateWith(bag), undefined, canonicalize)
        ).get('MyTable');
        expect(change?.changeType).toBe('NO_CHANGE');
      }
    );

    it('WITHOUT the twin the new record reads back as a change (the hazard it pairs with)', async () => {
      // Pinned so the next rows are not vacuously green.
      const change = await diff(recorded(), twoReplicas(), false);
      expect(change?.changeType).toBe('UPDATE');
    });

    it.each([
      ['a NEW record against the unchanged template', recorded, twoReplicas],
      ['a PRE-#1723 record against the unchanged template', twoReplicas, twoReplicas],
      [
        'a PRE-#1723 record against a template now DECLARING the same stream',
        twoReplicas,
        recorded,
      ],
      ['a NEW record against a template now DECLARING the same stream', recorded, recorded],
    ])('%s is NO_CHANGE', async (_label, state, template) => {
      const change = await diff(state(), template());
      expect(change?.changeType).toBe('NO_CHANGE');
      expect(change?.propertyChanges ?? []).toEqual([]);
    });

    it('ACCEPTED RESIDUAL: dropping to one replica shows a one-time stream removal beside the Replicas change', async () => {
      // Pinned so the PR body's stated residual cannot change silently: the
      // twin does not fold a one-replica bag, so the recorded stream reads as
      // removed. The resource is an UPDATE for its Replicas change anyway, and
      // `update()` sends no stream for an undeclared desired side.
      const change = await diff(recorded(), { ...baseProps, Replicas: [{ Region: 'us-east-1' }] });
      expect(change?.changeType).toBe('UPDATE');
      expect(change?.propertyChanges?.map((pc) => pc.path)).toEqual(
        expect.arrayContaining(['Replicas', 'StreamSpecification'])
      );
    });

    it('a template declaring a DIFFERENT view type still diffs as a change', async () => {
      const change = await diff(recorded(), {
        ...twoReplicas(),
        StreamSpecification: { StreamViewType: 'KEYS_ONLY' },
      });
      expect(change?.changeType).toBe('UPDATE');
      expect(change?.propertyChanges?.map((pc) => pc.path)).toContain('StreamSpecification');
    });
  });
});
