import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTrailCommand,
  GetEventConfigurationCommand,
  GetEventSelectorsCommand,
  GetInsightSelectorsCommand,
  GetTrailCommand,
  GetTrailStatusCommand,
  ListTagsCommand,
  PutEventConfigurationCommand,
  PutEventSelectorsCommand,
} from '@aws-sdk/client-cloudtrail';

const mockSend = vi.fn();
// Hoisted with the logger factory: it builds its child logger EAGERLY.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock('@aws-sdk/client-cloudtrail', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cloudtrail');
  return {
    ...actual,
    CloudTrailClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
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

import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';

/**
 * Issue #2762: `AdvancedEventSelectors` and `AggregationConfigurations` on
 * the SDK route. The first shares `PutEventSelectors` with `EventSelectors`
 * (one selector set, replaced whole); the second rides `PutEventConfiguration`.
 */

const TRAIL_ARN = 'arn:aws:cloudtrail:us-east-1:0:trail/my-trail';
const TYPE = 'AWS::CloudTrail::Trail';
const BASE = { S3BucketName: 'my-bucket', IsLogging: false };
const ADVANCED = [
  {
    Name: 's3-data',
    FieldSelectors: [
      { Field: 'eventCategory', Equals: ['Data'] },
      { Field: 'resources.type', Equals: ['AWS::S3::Object'] },
    ],
  },
];
const BASIC = [{ ReadWriteType: 'WriteOnly', IncludeManagementEvents: true }];
const AGGREGATION = [{ EventCategory: 'Data', Templates: ['API_ACTIVITY'] }];

/** The command names sent, in order. */
function sent(): string[] {
  return mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
}

function inputsOf(command: abstract new (...args: never[]) => unknown): Record<string, unknown>[] {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof command)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}

describe('CloudTrailProvider AdvancedEventSelectors / AggregationConfigurations (#2762)', () => {
  let provider: CloudTrailProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation((command: unknown) =>
      Promise.resolve(command instanceof CreateTrailCommand ? { TrailARN: TRAIL_ARN } : {})
    );
    provider = new CloudTrailProvider();
  });

  describe('create', () => {
    it('sends AdvancedEventSelectors alone, then the aggregation after the selectors', async () => {
      await provider.create('T', TYPE, {
        ...BASE,
        AdvancedEventSelectors: ADVANCED,
        AggregationConfigurations: AGGREGATION,
      });
      expect(inputsOf(PutEventSelectorsCommand)).toEqual([
        { TrailName: TRAIL_ARN, AdvancedEventSelectors: ADVANCED },
      ]);
      expect(inputsOf(PutEventConfigurationCommand)).toEqual([
        { TrailName: TRAIL_ARN, AggregationConfigurations: AGGREGATION },
      ]);
      expect(sent().indexOf('PutEventSelectorsCommand')).toBeLessThan(
        sent().indexOf('PutEventConfigurationCommand')
      );
    });

    it('sends both lists when both are declared, so AWS refuses the combination', async () => {
      await provider.create('T', TYPE, {
        ...BASE,
        EventSelectors: BASIC,
        AdvancedEventSelectors: ADVANCED,
      });
      expect(inputsOf(PutEventSelectorsCommand)).toEqual([
        { TrailName: TRAIL_ARN, AdvancedEventSelectors: ADVANCED, EventSelectors: BASIC },
      ]);
    });

    it('makes neither call for empty lists', async () => {
      await provider.create('T', TYPE, {
        ...BASE,
        AdvancedEventSelectors: [],
        AggregationConfigurations: [],
      });
      expect(inputsOf(PutEventSelectorsCommand)).toEqual([]);
      expect(inputsOf(PutEventConfigurationCommand)).toEqual([]);
    });

    it.each(['AdvancedEventSelectors', 'AggregationConfigurations'])(
      'refuses a non-array %s before any call',
      async (key) => {
        await expect(
          provider.create('T', TYPE, { ...BASE, [key]: 'not-a-list' })
        ).rejects.toThrow(new RegExp(`${key} must be an array`));
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it.each(['AdvancedEventSelectors', 'AggregationConfigurations'])(
      'downgrades a non-array %s to a warning on a state replay',
      async (key) => {
        await provider.create(
          'T',
          TYPE,
          { ...BASE, [key]: 'not-a-list' },
          { replayingState: true }
        );
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`${key} must be an array`));
        expect(inputsOf(PutEventSelectorsCommand)).toEqual([]);
        expect(inputsOf(PutEventConfigurationCommand)).toEqual([]);
      }
    );
  });

  describe('update: selectors', () => {
    it('switches a basic trail to advanced selectors with one Put carrying only the advanced list', async () => {
      await provider.update(
        'T',
        TRAIL_ARN,
        TYPE,
        { ...BASE, AdvancedEventSelectors: ADVANCED },
        { ...BASE, EventSelectors: BASIC }
      );
      expect(inputsOf(PutEventSelectorsCommand)).toEqual([
        { TrailName: TRAIL_ARN, AdvancedEventSelectors: ADVANCED },
      ]);
    });

    it('switches an advanced trail back to basic selectors', async () => {
      await provider.update(
        'T',
        TRAIL_ARN,
        TYPE,
        { ...BASE, EventSelectors: BASIC },
        { ...BASE, AdvancedEventSelectors: ADVANCED }
      );
      expect(inputsOf(PutEventSelectorsCommand)).toEqual([
        { TrailName: TRAIL_ARN, EventSelectors: BASIC },
      ]);
    });

    it('resets a removed AdvancedEventSelectors to the default selector a selector-less trail has', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, {
        ...BASE,
        AdvancedEventSelectors: ADVANCED,
      });
      expect(inputsOf(PutEventSelectorsCommand)).toEqual([
        {
          TrailName: TRAIL_ARN,
          EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: true }],
        },
      ]);
    });

    it('does NOT tolerate an advanced-selector rejection of that reset: the removal was asked for', async () => {
      mockSend.mockImplementation((command: unknown) =>
        command instanceof PutEventSelectorsCommand
          ? Promise.reject(
              Object.assign(new Error('The trail uses advanced event selectors.'), {
                name: 'InvalidEventSelectorsException',
              })
            )
          : Promise.resolve({})
      );
      await expect(
        provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, AdvancedEventSelectors: ADVANCED })
      ).rejects.toThrow(/Failed to update CloudTrail Trail T/);
    });

    it('still tolerates it for a basic removal on a trail whose record has no advanced selectors', async () => {
      mockSend.mockImplementation((command: unknown) =>
        command instanceof PutEventSelectorsCommand
          ? Promise.reject(
              Object.assign(new Error('The trail uses advanced event selectors.'), {
                name: 'InvalidEventSelectorsException',
              })
            )
          : Promise.resolve({})
      );
      await expect(
        provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, EventSelectors: BASIC })
      ).resolves.toMatchObject({ physicalId: TRAIL_ARN });
    });

    it('changes one advanced selector value with a Put of the whole new list', async () => {
      const next = [{ ...ADVANCED[0]!, Name: 'renamed' }];
      await provider.update(
        'T',
        TRAIL_ARN,
        TYPE,
        { ...BASE, AdvancedEventSelectors: next },
        { ...BASE, AdvancedEventSelectors: ADVANCED }
      );
      expect(inputsOf(PutEventSelectorsCommand)).toEqual([
        { TrailName: TRAIL_ARN, AdvancedEventSelectors: next },
      ]);
    });

    it('makes no selector call when neither list changed', async () => {
      await provider.update(
        'T',
        TRAIL_ARN,
        TYPE,
        { ...BASE, AdvancedEventSelectors: ADVANCED, AggregationConfigurations: AGGREGATION },
        { ...BASE, AdvancedEventSelectors: ADVANCED, AggregationConfigurations: AGGREGATION }
      );
      expect(inputsOf(PutEventSelectorsCommand)).toEqual([]);
      expect(inputsOf(PutEventConfigurationCommand)).toEqual([]);
    });

    it.each([
      ['AdvancedEventSelectors', { EventSelectors: BASIC }],
      ['EventSelectors', { AdvancedEventSelectors: ADVANCED }],
    ])(
      'skips the WHOLE selector Put when %s is unusable, even though the other list changed',
      async (key, other) => {
        await provider.update(
          'T',
          TRAIL_ARN,
          TYPE,
          { ...BASE, ...other, [key]: { not: 'a list' } },
          BASE
        );
        expect(inputsOf(PutEventSelectorsCommand)).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`${key} must be an array`));
      }
    );
  });

  describe('update: aggregation', () => {
    it('adds aggregation after the selector change that delivers its events', async () => {
      await provider.update(
        'T',
        TRAIL_ARN,
        TYPE,
        { ...BASE, AdvancedEventSelectors: ADVANCED, AggregationConfigurations: AGGREGATION },
        BASE
      );
      expect(inputsOf(PutEventConfigurationCommand)).toEqual([
        { TrailName: TRAIL_ARN, AggregationConfigurations: AGGREGATION },
      ]);
      expect(sent().indexOf('PutEventSelectorsCommand')).toBeLessThan(
        sent().indexOf('PutEventConfigurationCommand')
      );
    });

    it('clears a removed aggregation with an empty list, BEFORE the selector change', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, {
        ...BASE,
        AdvancedEventSelectors: ADVANCED,
        AggregationConfigurations: AGGREGATION,
      });
      expect(inputsOf(PutEventConfigurationCommand)).toEqual([
        { TrailName: TRAIL_ARN, AggregationConfigurations: [] },
      ]);
      expect(sent().indexOf('PutEventConfigurationCommand')).toBeLessThan(
        sent().indexOf('PutEventSelectorsCommand')
      );
    });

    it('leaves the aggregation alone, with a warning, when the desired value is unusable', async () => {
      await provider.update(
        'T',
        TRAIL_ARN,
        TYPE,
        { ...BASE, AggregationConfigurations: 'not-a-list' },
        { ...BASE, AggregationConfigurations: AGGREGATION }
      );
      expect(inputsOf(PutEventConfigurationCommand)).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('AggregationConfigurations must be an array')
      );
    });
  });

  describe('readCurrentState', () => {
    function armRead(selectors: Record<string, unknown>): void {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof GetTrailCommand)
          return Promise.resolve({
            Trail: { Name: 'my-trail', S3BucketName: 'my-bucket', TrailARN: TRAIL_ARN },
          });
        if (command instanceof GetTrailStatusCommand) return Promise.resolve({ IsLogging: false });
        if (command instanceof GetEventSelectorsCommand) return Promise.resolve(selectors);
        if (command instanceof GetInsightSelectorsCommand)
          return Promise.resolve({
            InsightSelectors: [{ InsightType: 'ApiCallRateInsight', EventCategories: ['Data'] }],
          });
        if (command instanceof ListTagsCommand) return Promise.resolve({ ResourceTagList: [] });
        if (command instanceof GetEventConfigurationCommand)
          return Promise.resolve({ AggregationConfigurations: AGGREGATION });
        return Promise.reject(new Error('unexpected command'));
      });
    }

    it('reads advanced selectors back, without an EventSelectors key, plus the aggregation', async () => {
      armRead({
        AdvancedEventSelectors: [
          {
            Name: 's3-data',
            FieldSelectors: [
              { Field: 'eventCategory', Equals: ['Data'], StartsWith: undefined },
              { Field: 'resources.type', Equals: ['AWS::S3::Object'] },
            ],
          },
        ],
      });
      const result = (await provider.readCurrentState(TRAIL_ARN, 'T', TYPE)) as Record<
        string,
        unknown
      >;
      expect(result['AdvancedEventSelectors']).toEqual(ADVANCED);
      expect(
        Object.keys(
          (result['AdvancedEventSelectors'] as Array<{ FieldSelectors: object[] }>)[0]!
            .FieldSelectors[0]!
        )
      ).toEqual(['Field', 'Equals']);
      expect('EventSelectors' in result).toBe(false);
      expect(result['AggregationConfigurations']).toEqual(AGGREGATION);
    });

    it('emits AdvancedEventSelectors: [] on a basic-selector trail', async () => {
      armRead({ EventSelectors: BASIC });
      const result = (await provider.readCurrentState(TRAIL_ARN, 'T', TYPE)) as Record<
        string,
        unknown
      >;
      expect(result['AdvancedEventSelectors']).toEqual([]);
      expect(result['EventSelectors']).toEqual(BASIC);
    });

    it('keeps InsightSelectors EventCategories, so a declared category does not read as drift', async () => {
      armRead({ EventSelectors: BASIC });
      const result = (await provider.readCurrentState(TRAIL_ARN, 'T', TYPE)) as Record<
        string,
        unknown
      >;
      expect(result['InsightSelectors']).toEqual([
        { InsightType: 'ApiCallRateInsight', EventCategories: ['Data'] },
      ]);
    });
  });
});
