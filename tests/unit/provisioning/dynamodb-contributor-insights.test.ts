import { describe, it, expect, vi } from 'vite-plus/test';
import {
  indexDeclaresContributorInsights,
  planContributorInsightsOp,
  planIndexContributorInsightsOps,
  readContributorInsightsSpec,
  contributorInsightsRefusals,
  reverseMapIndexContributorInsights,
  reverseMapTableContributorInsights,
  stripIndexContributorInsights,
} from '../../../src/provisioning/dynamodb-contributor-insights.js';

const read = (value: unknown) => readContributorInsightsSpec(value, 'CIS');

describe('readContributorInsightsSpec', () => {
  it('reads absent, enabled, disabled and a declared Mode', () => {
    expect(read(undefined)).toEqual({ kind: 'absent' });
    expect(read(null)).toEqual({ kind: 'absent' });
    expect(read({ Enabled: true })).toEqual({ kind: 'usable', enabled: true });
    expect(read({ Enabled: false })).toEqual({ kind: 'usable', enabled: false });
    expect(read({ Enabled: true, Mode: 'THROTTLED_KEYS' })).toEqual({
      kind: 'usable',
      enabled: true,
      mode: 'THROTTLED_KEYS',
    });
  });

  it("reads CloudFormation's stringly booleans by VALUE — 'false' must not enable", () => {
    // `Boolean('false')` is `true`: the pre-#1782 table-level read ENABLED a
    // block the template disabled.
    expect(read({ Enabled: 'false' })).toEqual({ kind: 'usable', enabled: false });
    expect(read({ Enabled: 'true' })).toEqual({ kind: 'usable', enabled: true });
  });

  it('defaults an ABSENT Enabled to false', () => {
    expect(read({})).toEqual({ kind: 'usable', enabled: false });
  });

  it.each([
    ['a scalar', 'yes'],
    ['an array', [{ Enabled: true }]],
    ['an unresolved intrinsic', { 'Fn::If': ['c', { Enabled: true }, { Enabled: false }] }],
    ['a non-boolean Enabled', { Enabled: 'yes' }],
    ['a null Enabled', { Enabled: null }],
    ['a non-string Mode', { Enabled: true, Mode: 7 }],
  ])('refuses %s instead of reading a default', (_label, value) => {
    const result = read(value);
    expect(result.kind).toBe('unusable');
  });
});

describe('planContributorInsightsOp', () => {
  const plan = (desired: unknown, previous: unknown) =>
    planContributorInsightsOp(read(desired), read(previous), () => undefined);

  it('enables, carrying Mode only when declared', () => {
    expect(plan({ Enabled: true }, undefined)).toEqual({ action: 'ENABLE' });
    expect(plan({ Enabled: true, Mode: 'THROTTLED_KEYS' }, undefined)).toEqual({
      action: 'ENABLE',
      mode: 'THROTTLED_KEYS',
    });
  });

  it('never carries Mode on DISABLE', () => {
    expect(plan({ Enabled: false, Mode: 'THROTTLED_KEYS' }, { Enabled: true })).toEqual({
      action: 'DISABLE',
    });
  });

  it('issues nothing for an unchanged block, in either polarity', () => {
    expect(plan({ Enabled: true }, { Enabled: true })).toBeUndefined();
    expect(plan({ Enabled: false }, { Enabled: false })).toBeUndefined();
    expect(plan({ Enabled: 'true' }, { Enabled: true })).toBeUndefined();
    // Mode is inert while disabled, so a Mode-only difference is no change.
    expect(plan({ Enabled: false, Mode: 'THROTTLED_KEYS' }, { Enabled: false })).toBeUndefined();
    expect(plan(undefined, undefined)).toBeUndefined();
  });

  it('re-enables on a Mode change', () => {
    expect(
      plan(
        { Enabled: true, Mode: 'THROTTLED_KEYS' },
        { Enabled: true, Mode: 'ACCESSED_AND_THROTTLED_KEYS' }
      )
    ).toEqual({ action: 'ENABLE', mode: 'THROTTLED_KEYS' });
  });

  it('DISABLES on removal, and the swapped sides (a rollback) re-enable', () => {
    const before = { Enabled: true, Mode: 'THROTTLED_KEYS' };
    expect(plan(undefined, before)).toEqual({ action: 'DISABLE' });
    expect(plan(before, undefined)).toEqual({ action: 'ENABLE', mode: 'THROTTLED_KEYS' });
  });

  it('disables on removal even when the recorded previous is unreadable', () => {
    expect(plan(undefined, 'junk')).toEqual({ action: 'DISABLE' });
  });

  it('issues nothing for an unusable desired block and reports why', () => {
    const onUnusable = vi.fn();
    expect(
      planContributorInsightsOp(read({ Enabled: 'yes' }), read({ Enabled: true }), onUnusable)
    ).toBeUndefined();
    expect(onUnusable).toHaveBeenCalledTimes(1);
    expect(onUnusable.mock.calls[0]?.[0]).toContain('CIS.Enabled');
  });
});

describe('planIndexContributorInsightsOps', () => {
  const gsi = (name: string, spec?: unknown) => ({
    IndexName: name,
    KeySchema: [{ AttributeName: name, KeyType: 'HASH' }],
    Projection: { ProjectionType: 'ALL' },
    ...(spec === undefined ? {} : { ContributorInsightsSpecification: spec }),
  });

  it('plans one op per declaring index and none for an index without the block', () => {
    expect(
      planIndexContributorInsightsOps(
        [gsi('a', { Enabled: true }), gsi('b')],
        undefined,
        () => undefined
      )
    ).toEqual([{ indexName: 'a', action: 'ENABLE' }]);
  });

  it('matches the previous side by NAME, never by position', () => {
    expect(
      planIndexContributorInsightsOps(
        [gsi('b', { Enabled: true }), gsi('a', { Enabled: true })],
        [gsi('a', { Enabled: true }), gsi('b')],
        () => undefined
      )
    ).toEqual([{ indexName: 'b', action: 'ENABLE' }]);
  });

  it('disables an index that STAYS and lost its block, but not an index that was removed', () => {
    expect(
      planIndexContributorInsightsOps(
        [gsi('stays')],
        [gsi('stays', { Enabled: true }), gsi('gone', { Enabled: true })],
        () => undefined
      )
    ).toEqual([{ indexName: 'stays', action: 'DISABLE' }]);
  });

  it('tolerates a non-array list and names the index of an unusable block', () => {
    expect(planIndexContributorInsightsOps({ Ref: 'x' }, 'junk', () => undefined)).toEqual([]);
    const onUnusable = vi.fn();
    expect(planIndexContributorInsightsOps([gsi('a', 'junk')], undefined, onUnusable)).toEqual([]);
    // The reason never repeats the NAME: it is a resolved value the caller
    // masks as a whole, and a copy inside the path would escape that mask.
    expect(onUnusable).toHaveBeenCalledWith(
      'a',
      expect.stringContaining('GlobalSecondaryIndexes[].ContributorInsightsSpecification')
    );
  });
});

describe('stripIndexContributorInsights', () => {
  it('removes only the block, without mutating the input', () => {
    const entry = { IndexName: 'a', ContributorInsightsSpecification: { Enabled: true } };
    expect(stripIndexContributorInsights(entry)).toEqual({ IndexName: 'a' });
    expect(entry.ContributorInsightsSpecification).toEqual({ Enabled: true });
  });

  it('returns an entry with nothing to strip by identity', () => {
    const entry = { IndexName: 'a' };
    expect(stripIndexContributorInsights(entry)).toBe(entry);
    expect(stripIndexContributorInsights('junk')).toBe('junk');
  });
});

describe('indexDeclaresContributorInsights', () => {
  it('is true only for a block the write plan would act on', () => {
    expect(indexDeclaresContributorInsights({ ContributorInsightsSpecification: { Enabled: false } })).toBe(true);
    expect(indexDeclaresContributorInsights({ IndexName: 'a' })).toBe(false);
    expect(indexDeclaresContributorInsights({ ContributorInsightsSpecification: 'junk' })).toBe(false);
    expect(indexDeclaresContributorInsights(undefined)).toBe(false);
  });
});

describe('reverseMapTableContributorInsights', () => {
  it('maps only the terminal statuses, with Mode while enabled', () => {
    expect(reverseMapTableContributorInsights('ENABLED', 'THROTTLED_KEYS')).toEqual({
      Enabled: true,
      Mode: 'THROTTLED_KEYS',
    });
    expect(reverseMapTableContributorInsights('DISABLED', 'THROTTLED_KEYS')).toEqual({
      Enabled: false,
    });
    for (const status of ['ENABLING', 'DISABLING', 'FAILED', undefined]) {
      expect(reverseMapTableContributorInsights(status, undefined)).toBeUndefined();
    }
  });
});

describe('reverseMapIndexContributorInsights', () => {
  it('maps the terminal statuses against the declared block', () => {
    expect(
      reverseMapIndexContributorInsights('ENABLED', 'THROTTLED_KEYS', {
        Enabled: true,
        Mode: 'THROTTLED_KEYS',
      })
    ).toEqual({ Enabled: true, Mode: 'THROTTLED_KEYS' });
    expect(
      reverseMapIndexContributorInsights('DISABLED', 'THROTTLED_KEYS', {
        Enabled: true,
        Mode: 'THROTTLED_KEYS',
      })
    ).toEqual({ Enabled: false });
  });

  it('withholds a Mode the declared block does not carry, including an empty one', () => {
    expect(
      reverseMapIndexContributorInsights('ENABLED', 'ACCESSED_AND_THROTTLED_KEYS', { Enabled: true })
    ).toEqual({ Enabled: true });
    expect(
      reverseMapIndexContributorInsights('ENABLED', 'ACCESSED_AND_THROTTLED_KEYS', {
        Enabled: true,
        Mode: '',
      })
    ).toEqual({ Enabled: true });
  });

  it('reads a transient status as its target', () => {
    expect(reverseMapIndexContributorInsights('ENABLING', undefined, { Enabled: true })).toEqual({
      Enabled: true,
    });
    expect(reverseMapIndexContributorInsights('DISABLING', undefined, { Enabled: false })).toEqual({
      Enabled: false,
    });
  });

  it('reads the DECLARED Mode while ENABLING when AWS does not report one yet', () => {
    const declared = { Enabled: true, Mode: 'THROTTLED_KEYS' };
    expect(reverseMapIndexContributorInsights('ENABLING', undefined, declared)).toEqual(declared);
    // ...but never once the toggle settled: an ENABLED answer with no mode is
    // AWS's own report, and the difference must surface.
    expect(reverseMapIndexContributorInsights('ENABLED', undefined, declared)).toEqual({
      Enabled: true,
    });
    // A mode AWS DOES report wins, transient or not.
    expect(
      reverseMapIndexContributorInsights('ENABLING', 'ACCESSED_AND_THROTTLED_KEYS', declared)
    ).toEqual({ Enabled: true, Mode: 'ACCESSED_AND_THROTTLED_KEYS' });
  });

  it("keeps the declared SPELLING of a stringly Enabled, and still reports a real flip", () => {
    expect(reverseMapIndexContributorInsights('ENABLED', undefined, { Enabled: 'True' })).toEqual({
      Enabled: 'True',
    });
    expect(reverseMapIndexContributorInsights('DISABLED', undefined, { Enabled: 'True' })).toEqual({
      Enabled: 'false',
    });
  });

  it('maps FAILED, an absent status and an undeclared or unreadable block to nothing', () => {
    expect(reverseMapIndexContributorInsights('FAILED', undefined, { Enabled: true })).toBeUndefined();
    expect(reverseMapIndexContributorInsights(undefined, undefined, { Enabled: true })).toBeUndefined();
    expect(reverseMapIndexContributorInsights('ENABLED', undefined, undefined)).toBeUndefined();
    expect(reverseMapIndexContributorInsights('ENABLED', undefined, 'junk')).toBeUndefined();
  });
});

describe('contributorInsightsRefusals', () => {
  it('is empty for readable and absent blocks', () => {
    expect(contributorInsightsRefusals(undefined, undefined)).toEqual([]);
    expect(
      contributorInsightsRefusals({ Enabled: 'false' }, [
        { IndexName: 'a', ContributorInsightsSpecification: { Enabled: true } },
      ])
    ).toEqual([]);
    expect(contributorInsightsRefusals(undefined, { Ref: 'x' })).toEqual([]);
  });

  it('names the table-level block, and an index by POSITION rather than by name', () => {
    const refusals = contributorInsightsRefusals('junk', [
      { IndexName: 'fine' },
      { IndexName: 's3k', ContributorInsightsSpecification: { Enabled: 'yes' } },
    ]);
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toContain('ContributorInsightsSpecification must be an object');
    expect(refusals[1]).toContain(
      'GlobalSecondaryIndexes[1].ContributorInsightsSpecification.Enabled'
    );
    expect(refusals.join(' ')).not.toContain('s3k');
  });
});
