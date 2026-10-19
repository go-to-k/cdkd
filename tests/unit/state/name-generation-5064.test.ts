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
  retiredAfterRollbackOrphans,
  retiredNameGenerationsAfter,
  withNameGenerationReached,
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

  it('retiredAfterRollbackOrphans retires each orphan at its generation', () => {
    expect(
      retiredAfterRollbackOrphans({ stackInstanceId: ID }, [
        { logicalId: 'Bucket', orphanedAt: 1, state: record({ nameGeneration: 1 }) },
      ])
    ).toEqual({ retiredNameGenerations: { Bucket: 1 } });
    expect(
      retiredAfterRollbackOrphans({}, [{ logicalId: 'Bucket', orphanedAt: 1, state: record() }])
    ).toEqual({});
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
