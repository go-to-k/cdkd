/**
 * go-to-k/cdkd#5064 phase 2: per-resource name generations.
 *
 * Pins the derivation (generation 0 hashes exactly the phase-1 input; a later
 * generation appends NUL + its decimal), the scope rules (an id scope with no
 * generations map throws; `withNameGeneration` moves one logical id only), and
 * the state helpers every writer and the replacement read.
 */
import { describe, expect, it } from 'vite-plus/test';
import {
  currentNameGeneration,
  generateResourceName,
  looksLikeCdkdGeneratedName,
  stackInstanceNameSuffix,
  withNameGeneration,
  withSkipPrefix,
  withStackScope,
} from '../../../src/provisioning/resource-name.js';
import {
  MalformedNameGenerationError,
  nameGenerationCarriedFrom,
  nameGenerationField,
  nameGenerationReachedField,
  nameGenerationsOf,
  nameScopeOf,
  nextNameGeneration,
  replacementNameGeneration,
  retiredAfterRollback,
  retiredNameGenerationsAfter,
  withNameGenerationReached,
  type RolledBackCreate,
} from '../../../src/state/name-generation.js';
import type { ResourceState } from '../../../src/types/state.js';

const ID = '0b1f6a2e-5c3d-4e8f-9a7b-1c2d3e4f5a6b';
const record = (over: Partial<ResourceState> = {}): ResourceState => ({
  physicalId: 'MyStack-Queue-5f24ac9179b8',
  resourceType: 'AWS::SQS::Queue',
  properties: {},
  ...over,
});
const scope = (generations: ReadonlyMap<string, number> | undefined) => ({
  stackName: 'MyStack',
  stackInstanceId: ID,
  nameGenerations: generations,
});

describe('generated names carry the generation (go-to-k/cdkd#5064 phase 2)', () => {
  it('generation 0 is the phase-1 name, byte for byte (golden)', () => {
    expect(stackInstanceNameSuffix(ID, 'Queue')).toBe('5f24ac9179b8');
    expect(stackInstanceNameSuffix(ID, 'Queue', 0)).toBe('5f24ac9179b8');
    expect(withStackScope(scope(new Map()), () => generateResourceName('Queue', { maxLength: 80 }))).toBe(
      'MyStack-Queue-5f24ac9179b8'
    );
  });

  it('a later generation hashes NUL + its decimal (golden)', () => {
    expect(stackInstanceNameSuffix(ID, 'Queue', 1)).toBe('974a14f26492');
    expect(stackInstanceNameSuffix(ID, 'Queue', 2)).toBe('0b6fa33cedb3');
    const gens = new Map([['Queue', 2]]);
    expect(withStackScope(scope(gens), () => generateResourceName('Queue', { maxLength: 80 }))).toBe(
      'MyStack-Queue-0b6fa33cedb3'
    );
  });

  it('withNameGeneration moves its own logical id only', () => {
    const gens = new Map([['Queue', 0]]);
    withStackScope(scope(gens), () => {
      withNameGeneration({ logicalId: 'Queue', generation: 1 }, () => {
        expect(generateResourceName('Queue', { maxLength: 80 })).toBe(
          'MyStack-Queue-974a14f26492'
        );
        expect(currentNameGeneration('Topic')).toBe(0);
        expect(generateResourceName('Topic', { maxLength: 80 })).toBe(
          `MyStack-Topic-${stackInstanceNameSuffix(ID, 'Topic')}`
        );
      });
      expect(generateResourceName('Queue', { maxLength: 80 })).toBe('MyStack-Queue-5f24ac9179b8');
    });
  });

  it("an inner stack scope does not inherit an outer stack's binding (a nested child)", () => {
    const name = withNameGeneration({ logicalId: 'Queue', generation: 1 }, () =>
      withStackScope(scope(new Map()), () => generateResourceName('Queue', { maxLength: 80 }))
    );
    expect(name).toBe('MyStack-Queue-5f24ac9179b8');
  });

  it('an id scope without a generations map refuses a generated name', () => {
    expect(() =>
      withStackScope(scope(undefined), () => generateResourceName('Queue', { maxLength: 80 }))
    ).toThrow(/carries no name generations/);
    // A declared name never reads the generation.
    expect(
      withStackScope(scope(undefined), () =>
        withSkipPrefix(true, () =>
          generateResourceName('my-queue', { maxLength: 80, userSupplied: true })
        )
      )
    ).toBe('my-queue');
  });

  it('a legacy scope (no id) ignores every generation', () => {
    const legacy = { stackName: 'MyStack', stackInstanceId: undefined, nameGenerations: undefined };
    expect(
      withStackScope(legacy, () =>
        withNameGeneration({ logicalId: 'Queue', generation: 3 }, () =>
          generateResourceName('Queue', { maxLength: 80 })
        )
      )
    ).toBe('MyStack-Queue');
  });

  it('withNameGeneration refuses a generation that is not a non-negative integer', () => {
    expect(() => withNameGeneration({ logicalId: 'Q', generation: -1 }, () => 1)).toThrow();
    expect(() => withNameGeneration({ logicalId: 'Q', generation: 1.5 }, () => 1)).toThrow();
  });
});

describe('looksLikeCdkdGeneratedName across generations', () => {
  it('recognizes each generation up to the bound, and not past it', () => {
    const gen2 = 'MyStack-Queue-0b6fa33cedb3';
    expect(looksLikeCdkdGeneratedName(gen2, 'Queue', 'MyStack', ID, { through: 2 })).toBe(true);
    expect(looksLikeCdkdGeneratedName(gen2, 'Queue', 'MyStack', ID, { through: 1 })).toBe(false);
  });

  it('absent a bound, takes the scope generation plus one', () => {
    const gen1 = 'MyStack-Queue-974a14f26492';
    expect(
      withStackScope(scope(new Map([['Queue', 0]])), () =>
        looksLikeCdkdGeneratedName(gen1, 'Queue', 'MyStack', ID)
      )
    ).toBe(true);
    const gen2 = 'MyStack-Queue-0b6fa33cedb3';
    expect(
      withStackScope(scope(new Map([['Queue', 0]])), () =>
        looksLikeCdkdGeneratedName(gen2, 'Queue', 'MyStack', ID)
      )
    ).toBe(false);
  });
});

describe('state helpers', () => {
  it('nameGenerationsOf: a record wins, a retired id takes retired + 1, unknown is absent', () => {
    const gens = nameGenerationsOf({
      resources: { Queue: record({ nameGeneration: 3 }), Topic: record() },
      retiredNameGenerations: { Queue: 9, Gone: 4 },
    });
    expect(gens.get('Queue')).toBe(3);
    expect(gens.get('Topic')).toBe(0);
    expect(gens.get('Gone')).toBe(5);
    expect(gens.has('Never')).toBe(false);
  });

  it('nameGenerationsOf refuses a malformed generation, record or retired', () => {
    expect(() =>
      nameGenerationsOf({ resources: { Queue: record({ nameGeneration: -1 }) } })
    ).toThrow(MalformedNameGenerationError);
    expect(() =>
      nameGenerationsOf({
        resources: {},
        retiredNameGenerations: { Queue: '1' as unknown as number },
      })
    ).toThrow(MalformedNameGenerationError);
  });

  it('refuses a generation whose successor is not a safe integer, never deriving it', () => {
    const max = Number.MAX_SAFE_INTEGER;
    // A retired id re-added at retired + 1.
    expect(() => nameGenerationsOf({ resources: {}, retiredNameGenerations: { Queue: max } })).toThrow(
      MalformedNameGenerationError
    );
    expect(() =>
      nameGenerationsOf({ resources: {}, retiredNameGenerations: { Queue: max } })
    ).toThrow(/Queue.*too large/);
    expect(nameGenerationsOf({ resources: {}, retiredNameGenerations: { Queue: max - 1 } }).get('Queue')).toBe(max);
    // A replacement past the high-water mark, record or high field.
    expect(() => nextNameGeneration(record({ nameGeneration: max }), 'Queue', ID)).toThrow(
      MalformedNameGenerationError
    );
    expect(() =>
      nextNameGeneration(record({ nameGenerationHigh: max, physicalId: 'x' }), 'Queue', ID)
    ).toThrow(MalformedNameGenerationError);
    // ...and through the skip over a generation the physical id carries.
    const carried = record({
      nameGeneration: max - 1,
      physicalId: `x-${stackInstanceNameSuffix(ID, 'Queue', max)}`,
    });
    expect(() => nextNameGeneration(carried, 'Queue', ID)).toThrow(MalformedNameGenerationError);
    expect(nextNameGeneration(record({ nameGeneration: max - 1, physicalId: 'x' }), 'Queue', ID)).toBe(max);
    // The refusal never names the stack instance id.
    try {
      nextNameGeneration(record({ nameGeneration: max }), 'Queue', ID);
    } catch (e) {
      expect((e as Error).message).not.toContain(ID);
    }
  });

  it('nameScopeOf gives a map only beside an id', () => {
    expect(nameScopeOf('S', undefined, { resources: {} }).nameGenerations).toBeUndefined();
    expect(nameScopeOf('S', ID, { resources: {} }).nameGenerations).toBeInstanceOf(Map);
  });

  it('nextNameGeneration goes past the high-water mark', () => {
    expect(nextNameGeneration(record(), 'Queue', ID)).toBe(1);
    expect(nextNameGeneration(record({ nameGeneration: 2 }), 'Queue', ID)).toBe(3);
    expect(
      nextNameGeneration(
        record({ nameGeneration: 1, nameGenerationHigh: 4, physicalId: 'x' }),
        'Queue',
        ID
      )
    ).toBe(5);
  });

  it('nextNameGeneration skips a generation whose name the record already carries', () => {
    // A resource `cdkd import` adopted under generation 1's name records none.
    const imported = record({ physicalId: 'https://sqs/1/MyStack-Queue-974a14f26492' });
    expect(nextNameGeneration(imported, 'Queue', ID)).toBe(2);
  });

  it('withNameGenerationReached raises the high-water mark only upward', () => {
    expect(withNameGenerationReached(record(), 'Queue', 1).nameGenerationHigh).toBe(1);
    const r = record({ nameGeneration: 3 });
    expect(withNameGenerationReached(r, 'Queue', 2)).toBe(r);
    expect(withNameGenerationReached(r, 'Queue', undefined)).toBe(r);
  });

  it('retiredNameGenerationsAfter: none for a legacy stack, the max otherwise', () => {
    const leaving = [{ logicalId: 'Queue', record: record({ nameGenerationHigh: 2 }) }];
    expect(retiredNameGenerationsAfter({}, leaving)).toEqual({});
    expect(retiredNameGenerationsAfter({ stackInstanceId: ID }, leaving)).toEqual({
      retiredNameGenerations: { Queue: 2 },
    });
    expect(
      retiredNameGenerationsAfter(
        { stackInstanceId: ID, retiredNameGenerations: { Queue: 7 } },
        leaving
      )
    ).toEqual({ retiredNameGenerations: { Queue: 7 } });
    // A generation-0 record retires at 0, so a re-add takes 1.
    expect(
      retiredNameGenerationsAfter({ stackInstanceId: ID }, [
        { logicalId: 'Topic', record: record() },
      ])
    ).toEqual({ retiredNameGenerations: { Topic: 0 } });
  });

  it('retiredAfterRollback retires each orphan at its generation', () => {
    expect(
      retiredAfterRollback({ stackInstanceId: ID }, [
        { logicalId: 'Bucket', orphanedAt: 1, state: record({ nameGeneration: 1 }) },
      ])
    ).toEqual({ retiredNameGenerations: { Bucket: 1 } });
    expect(
      retiredAfterRollback({}, [{ logicalId: 'Bucket', orphanedAt: 1, state: record() }])
    ).toEqual({});
  });

  it('retiredAfterRollback retires each rolled-back CREATE at the highest generation it reached', () => {
    const at = (create: RolledBackCreate) =>
      retiredAfterRollback({ stackInstanceId: ID }, [], [create]).retiredNameGenerations;
    // A never-saved create: 0, so the next one takes generation 1.
    expect(at({ logicalId: 'Q', record: undefined })).toEqual({ Q: 0 });
    expect(at({ logicalId: 'Q', record: { nameGeneration: 1, nameGenerationHigh: 4 } })).toEqual({ Q: 4 });
    expect(at({ logicalId: 'Q', record: { nameGeneration: 2 }, nameGeneration: 5 })).toEqual({ Q: 5 });
    // A malformed value never stops the rollback's save: skipped.
    expect(
      at({ logicalId: 'Q', record: { nameGeneration: -1 as number }, nameGeneration: 'x' })
    ).toEqual({ Q: 0 });
    // Never below what the stack already retired, and beside an orphan.
    expect(
      retiredAfterRollback(
        { stackInstanceId: ID, retiredNameGenerations: { Q: 7 } },
        [{ logicalId: 'B', orphanedAt: 1, state: record({ nameGeneration: 2 }) }],
        [{ logicalId: 'Q', record: { nameGeneration: 3 } }]
      )
    ).toEqual({ retiredNameGenerations: { Q: 7, B: 2 } });
    // A legacy stack retires nothing.
    expect(retiredAfterRollback({}, [], [{ logicalId: 'Q', record: undefined }])).toEqual({});
  });

  it('field helpers write nothing for generation 0 and carry verbatim', () => {
    expect(nameGenerationField(0)).toEqual({});
    expect(nameGenerationField(2)).toEqual({ nameGeneration: 2 });
    expect(nameGenerationCarriedFrom(undefined)).toEqual({});
    expect(nameGenerationCarriedFrom(record({ nameGeneration: 1, nameGenerationHigh: 3 }))).toEqual(
      { nameGeneration: 1, nameGenerationHigh: 3 }
    );
    expect(nameGenerationReachedField(record({ nameGeneration: 2 }), 'Queue')).toEqual({
      nameGenerationHigh: 2,
    });
    expect(nameGenerationReachedField(record(), 'Queue')).toEqual({});
  });
});

describe('retiredNameGenerationsLeaving (a partial destroy)', () => {
  it('retires what is gone from the kept record, tolerates a malformed one', async () => {
    const { retiredNameGenerationsLeaving } = await import('../../../src/state/name-generation.js');
    const state = {
      stackInstanceId: ID,
      resources: { Gone: record({ nameGeneration: 2 }), Kept: record() },
    };
    expect(retiredNameGenerationsLeaving(state, { Kept: record() })).toEqual({
      retiredNameGenerations: { Gone: 2 },
    });
    expect(retiredNameGenerationsLeaving({ ...state, stackInstanceId: undefined }, {})).toEqual({});
    const broken = {
      ...state,
      resources: { Gone: record({ nameGeneration: -1 }) },
      retiredNameGenerations: { Old: 1 },
    };
    expect(retiredNameGenerationsLeaving(broken, {})).toEqual({ retiredNameGenerations: { Old: 1 } });
  });
});

describe('replacementNameGeneration', () => {
  it('moves to the next generation on an id stack', () => {
    expect(replacementNameGeneration(record({ nameGeneration: 1 }), 'Queue', ID, false)).toEqual({
      generation: 2,
      fields: { nameGeneration: 2 },
    });
  });
  it('a resource that went with its parent keeps its fields (no bump)', () => {
    const r = record({ nameGeneration: 1, nameGenerationHigh: 3 });
    expect(replacementNameGeneration(r, 'Queue', ID, true)).toEqual({
      generation: undefined,
      fields: { nameGeneration: 1, nameGenerationHigh: 3 },
    });
  });
  it('a legacy stack moves nothing', () => {
    expect(replacementNameGeneration(record(), 'Queue', undefined, false)).toEqual({
      generation: undefined,
      fields: {},
    });
  });
});

describe('recognition bounds', () => {
  it('nextNameGeneration skips every generation the physical id carries, in a row', () => {
    const both = record({
      physicalId: `x-${stackInstanceNameSuffix(ID, 'Queue', 1)}-${stackInstanceNameSuffix(ID, 'Queue', 2)}`,
    });
    expect(nextNameGeneration(both, 'Queue', ID)).toBe(3);
  });
  it('looksLikeCdkdGeneratedName stops at its cap however high a bound a state claims', () => {
    const past = `MyStack-Queue-${stackInstanceNameSuffix(ID, 'Queue', 1025)}`;
    const at = `MyStack-Queue-${stackInstanceNameSuffix(ID, 'Queue', 1024)}`;
    expect(looksLikeCdkdGeneratedName(at, 'Queue', 'MyStack', ID, { through: 5000 })).toBe(true);
    expect(looksLikeCdkdGeneratedName(past, 'Queue', 'MyStack', ID, { through: 5000 })).toBe(false);
  });
});

describe('a replay derives the replayed record at ITS generation', () => {
  it("replayPrefixScope binds the record's generation over the scope's", async () => {
    const { replayPrefixScope } = await import('../../../src/deployment/rollback-executor/names.js');
    const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined };
    // `cdkd rollback` reads the post-failure record (generation 1); the old
    // resource it re-creates was generation 0.
    const name = withStackScope(scope(new Map([['Queue', 1]])), () => {
      const run = replayPrefixScope(
        {
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          logicalId: 'Queue',
          physicalId: 'MyStack-Queue-5f24ac9179b8',
          via: 'sdk',
          nameGeneration: 0,
        },
        quiet as never,
        (text: string) => text,
        true
      );
      return run(() => generateResourceName('Queue', { maxLength: 80 }));
    });
    expect(name).toBe('MyStack-Queue-5f24ac9179b8');
  });
});

describe('cdkd import and the name generation', () => {
  it('keeps the fields on an unchanged physical id, records the reached one otherwise', async () => {
    const { importedNameGenerationFields } = await import('../../../src/cli/commands/import.js');
    const prior = record({ nameGeneration: 2, nameGenerationHigh: 3 });
    expect(importedNameGenerationFields(prior, { logicalId: 'Queue', physicalId: prior.physicalId })).toEqual({
      nameGeneration: 2,
      nameGenerationHigh: 3,
    });
    expect(importedNameGenerationFields(prior, { logicalId: 'Queue', physicalId: 'other' })).toEqual({
      nameGenerationHigh: 3,
    });
    expect(importedNameGenerationFields(undefined, { logicalId: 'Queue', physicalId: 'x' })).toEqual({});
    // A row the import repairs contributes nothing, never a refusal.
    expect(importedNameGenerationFields(null, { logicalId: 'Queue', physicalId: 'x' })).toEqual({});
    // A logical id that left the stack: the re-imported record goes past the
    // generation an earlier copy reached (it may still hold that name).
    expect(importedNameGenerationFields(undefined, { logicalId: 'Queue', physicalId: 'x' }, 2)).toEqual(
      { nameGenerationHigh: 2 }
    );
    expect(
      importedNameGenerationFields(prior, { logicalId: 'Queue', physicalId: 'other' }, 5)
    ).toEqual({ nameGenerationHigh: 5 });
    const broken = record({ nameGeneration: -1 });
    expect(importedNameGenerationFields(broken, { logicalId: 'Queue', physicalId: broken.physicalId })).toEqual({});
  });
});

describe('the D2 sequence: a refused crash re-run, `cdkd import`, the next replacement (generated-name-lifecycle)', () => {
  it('takes generation 3: past the replaced record (1) and the generation the imported resource holds (2)', async () => {
    const { importedNameGenerationFields } = await import('../../../src/cli/commands/import.js');
    // The refusal raised nothing; the import carried the replaced record's reach.
    const imported = importedNameGenerationFields(
      { physicalId: 'gen1-table', resourceType: 'AWS::DynamoDB::Table', properties: {}, nameGeneration: 1 },
      { logicalId: 'Table', physicalId: `MyStack-Table-${stackInstanceNameSuffix(ID, 'Table', 2)}` }
    );
    expect(imported).toEqual({ nameGenerationHigh: 1 });
    const record = {
      ...imported,
      physicalId: `MyStack-Table-${stackInstanceNameSuffix(ID, 'Table', 2)}`,
    };
    expect(nextNameGeneration(record, 'Table', ID)).toBe(3);
  });
});
