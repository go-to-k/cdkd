import { describe, it, expect } from 'vite-plus/test';
import {
  planTagDiff,
  readTagList,
  recordedTagsUnreadableWarning,
  refuseMalformedDesiredTags,
  tagMapAsList,
  tagPlanWarning,
} from '../../../src/provisioning/tag-list.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { MALFORMED_TAGS, TAG_FIXTURE } from './tag-list-fixtures.js';

// go-to-k/cdkd#3994: the shared reader behind every provider's Tags diff.

const { NEEDLE, SECRET_REF } = TAG_FIXTURE;

describe('readTagList', () => {
  it.each([undefined, null])('reads %s as the empty list on both sides', (value) => {
    expect(readTagList(value, 'desired')).toEqual({ kind: 'tags', tags: [], hidden: 0 });
    expect(readTagList(value, 'recorded')).toEqual({ kind: 'tags', tags: [], hidden: 0 });
  });

  it('keeps an empty-string Value and case-distinct keys', () => {
    const tags = [
      { Key: 'Env', Value: '' },
      { Key: 'env', Value: 'dev' },
    ];
    expect(readTagList(tags, 'desired')).toEqual({ kind: 'tags', tags, hidden: 0 });
    expect(readTagList([], 'desired')).toEqual({ kind: 'tags', tags: [], hidden: 0 });
  });

  it.each(MALFORMED_TAGS)('reads %s as malformed on both sides', (_label, value) => {
    expect(readTagList(value, 'desired').kind).toBe('malformed');
    expect(readTagList(value, 'recorded').kind).toBe('malformed');
  });

  it.each([SECRET_REF, `x${SECRET_REF}`, '***'])(
    'refuses a desired Key holding %s, and drops it from a recorded list',
    (key) => {
      const tags = [
        { Key: key, Value: 'v' },
        { Key: 'env', Value: 'dev' },
      ];
      expect(readTagList(tags, 'desired')).toEqual({ kind: 'malformed', secretDerived: true });
      expect(readTagList(tags, 'recorded')).toEqual({
        kind: 'tags',
        tags: [{ Key: 'env', Value: 'dev' }],
        hidden: 1,
      });
    }
  );

  it('reads a numeric or boolean Value as its string, as CloudFormation coerces it', () => {
    const read = readTagList(
      [
        { Key: 'n', Value: 1 },
        { Key: 'b', Value: false },
      ],
      'desired'
    );
    expect(read).toEqual({
      kind: 'tags',
      tags: [
        { Key: 'n', Value: '1' },
        { Key: 'b', Value: 'false' },
      ],
      hidden: 0,
    });
    expect(planTagDiff([{ Key: 'n', Value: '1' }], [{ Key: 'n', Value: 1 }]).set.size).toBe(0);
  });

  it('keeps a key that only contains the mask, and a secret-derived Value', () => {
    const tags = [
      { Key: 'a***b', Value: 'v' },
      { Key: 'db', Value: SECRET_REF },
    ];
    expect(readTagList(tags, 'desired')).toEqual({ kind: 'tags', tags, hidden: 0 });
  });

  it('flags a malformed value holding a dynamic reference anywhere', () => {
    expect(readTagList([{ Key: SECRET_REF }], 'desired')).toEqual({
      kind: 'malformed',
      secretDerived: true,
    });
    expect(readTagList([{ Key: NEEDLE }], 'desired')).toEqual({
      kind: 'malformed',
      secretDerived: false,
    });
  });
});

describe('refuseMalformedDesiredTags', () => {
  it('returns a well-formed list', () => {
    const tags = [{ Key: 'env', Value: 'dev' }];
    expect(refuseMalformedDesiredTags(tags, 'AWS::SQS::Queue', 'Q')).toEqual(tags);
    expect(refuseMalformedDesiredTags(undefined, 'AWS::SQS::Queue', 'Q', 'pid')).toEqual([]);
  });

  it.each(MALFORMED_TAGS)(
    'refuses %s non-retryably, naming the property and not its content',
    (_label, value) => {
      let caught: unknown;
      try {
        refuseMalformedDesiredTags(value, 'AWS::SQS::Queue', 'Q', 'pid');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProvisioningError);
      expect(isMarkedNonRetryable(caught)).toBe(true);
      const msg = (caught as Error).message;
      expect(msg).toContain('desired Tags of AWS::SQS::Queue Q is not a list of tags');
      expect(msg).toContain('the resource was not updated');
      expect(msg).not.toContain(NEEDLE);
      expect(msg).not.toContain('dynamic reference');
    }
  );

  it('says "created" without a physical id, and names the secret-derived cause', () => {
    expect(() =>
      refuseMalformedDesiredTags([{ Key: SECRET_REF, Value: 'v' }], 'AWS::KMS::Key', 'K')
    ).toThrow(
      /^Tags of AWS::KMS::Key K is not a list .*\(Tags holds a dynamic reference or its mask where a tag key belongs, which names nothing AWS holds\) — the resource was not created$/
    );
    try {
      refuseMalformedDesiredTags([{ Key: SECRET_REF, Value: 'v' }], 'AWS::KMS::Key', 'K');
    } catch (e) {
      expect((e as Error).message).not.toContain('issue3994/tags');
    }
  });

  it('names the key cause only when a Key, not a Value, is secret-derived', () => {
    const valueRef = () =>
      refuseMalformedDesiredTags([{ Key: 'k', Value: { ref: SECRET_REF } }], 'AWS::T::T', 'L');
    expect(valueRef).toThrow(/is not a list/);
    expect(valueRef).not.toThrow(/dynamic reference/);
    expect(() =>
      refuseMalformedDesiredTags([{ Key: SECRET_REF, Value: { v: 1 } }], 'AWS::T::T', 'L')
    ).toThrow(/holds a dynamic reference or its mask where a tag key belongs/);
    expect(() => refuseMalformedDesiredTags(SECRET_REF, 'AWS::T::T', 'L')).not.toThrow(
      /dynamic reference/
    );
  });

  it('flattens a line break in an interpolated id to one line', () => {
    let msg = '';
    try {
      refuseMalformedDesiredTags('x', 'AWS::T::T', 'L\nforged: line');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('AWS::T::T L');
    expect(msg).not.toContain('\n');
  });

  it('names a non-default property', () => {
    expect(() => refuseMalformedDesiredTags('x', 'AWS::T::T', 'L', undefined, 'TagList')).toThrow(
      /^TagList of AWS::T::T L is not a list/
    );
  });
});

describe('planTagDiff', () => {
  const OLD = [
    { Key: 'keep', Value: 'same' },
    { Key: 'change', Value: 'old' },
    { Key: 'drop', Value: 'x' },
  ];
  const NEW = [
    { Key: 'keep', Value: 'same' },
    { Key: 'change', Value: 'new' },
    { Key: 'add', Value: '' },
  ];

  it('sets new and changed tags and removes dropped keys', () => {
    expect(planTagDiff(OLD, NEW)).toEqual({
      set: new Map([
        ['change', 'new'],
        ['add', ''],
      ]),
      remove: ['drop'],
      recordedUnreadable: false,
      recordedHidden: 0,
    });
  });

  it('removes every recorded key when the desired Tags is absent', () => {
    expect(planTagDiff(OLD, undefined).remove).toEqual(['keep', 'change', 'drop']);
    expect(planTagDiff(OLD, null).remove).toEqual(['keep', 'change', 'drop']);
  });

  it('treats keys case-sensitively', () => {
    const plan = planTagDiff([{ Key: 'Env', Value: 'a' }], [{ Key: 'env', Value: 'a' }]);
    expect(plan.remove).toEqual(['Env']);
    expect([...plan.set.keys()]).toEqual(['env']);
  });

  it.each(MALFORMED_TAGS)(
    'applies a recorded %s ADD-only: every desired tag, no removal',
    (_label, value) => {
      expect(planTagDiff(value, NEW)).toEqual({
        set: new Map([
          ['keep', 'same'],
          ['change', 'new'],
          ['add', ''],
        ]),
        remove: [],
        recordedUnreadable: true,
        recordedHidden: 0,
      });
    }
  );

  it('never removes a recorded secret-derived key', () => {
    const plan = planTagDiff(
      [
        { Key: SECRET_REF, Value: 'v' },
        { Key: '***', Value: 'v' },
        { Key: 'drop', Value: 'v' },
      ],
      []
    );
    expect(plan).toEqual({
      set: new Map(),
      remove: ['drop'],
      recordedUnreadable: false,
      recordedHidden: 2,
    });
  });

  it.each(MALFORMED_TAGS)('throws on a desired %s instead of reading it as empty', (_l, value) => {
    expect(() => planTagDiff(OLD, value)).toThrow(/desired Tags is not a list of tags/);
  });
});

describe('tagMapAsList', () => {
  it('converts a map of non-empty keys to scalars into the list', () => {
    expect(tagMapAsList({ a: 'x', n: 1, b: true, e: '' })).toEqual([
      { Key: 'a', Value: 'x' },
      { Key: 'n', Value: 1 },
      { Key: 'b', Value: true },
      { Key: 'e', Value: '' },
    ]);
    expect(tagMapAsList({})).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['a map with an object value', { a: { v: 1 } }],
    ['a map with a null value', { a: null }],
    ['a map with an empty key', { '': 'v' }],
    ['a string', NEEDLE],
    ['a list', [{ Key: 'a', Value: 'x' }]],
    ['a list of scalars', ['x']],
    ['null', null],
    ['undefined', undefined],
  ])('returns %s unchanged for the list reader', (_label, value) => {
    expect(tagMapAsList(value)).toBe(value);
  });

  it('feeds a malformed map to the reader as malformed, never as no tags', () => {
    expect(readTagList(tagMapAsList({ a: { v: 1 } }), 'desired').kind).toBe('malformed');
    expect(readTagList(tagMapAsList({ [SECRET_REF]: 'v' }), 'desired')).toEqual({
      kind: 'malformed',
      secretDerived: true,
    });
  });
});

describe('allowOmittedValue', () => {
  const opts = { allowOmittedValue: true };

  it('reads an omitted Value as the empty string only when allowed', () => {
    expect(readTagList([{ Key: 'k' }], 'desired', opts)).toEqual({
      kind: 'tags',
      tags: [{ Key: 'k', Value: '' }],
      hidden: 0,
    });
    expect(readTagList([{ Key: 'k' }], 'desired').kind).toBe('malformed');
    expect(refuseMalformedDesiredTags([{ Key: 'k' }], 'AWS::T::T', 'L', undefined, 'Tags', undefined, opts)).toEqual([
      { Key: 'k', Value: '' },
    ]);
    expect(planTagDiff([{ Key: 'k' }], [{ Key: 'k', Value: '' }], opts).set.size).toBe(0);
  });

  it.each<[string, unknown]>([
    ['a null Value', [{ Key: 'k', Value: null }]],
    ['an object Value', [{ Key: 'k', Value: { v: 1 } }]],
  ])('still reads %s as malformed', (_label, value) => {
    expect(readTagList(value, 'desired', opts).kind).toBe('malformed');
  });
});

describe('tagPlanWarning', () => {
  it('warns about recorded keys it cannot name, echoing no content', () => {
    const plan = planTagDiff(
      [
        { Key: SECRET_REF, Value: 'v' },
        { Key: 'keep', Value: 'same' },
      ],
      [{ Key: 'keep', Value: 'same' }]
    );
    expect(plan.recordedHidden).toBe(1);
    const msg = tagPlanWarning(plan, 'AWS::SQS::Queue', 'Q');
    expect(msg).toContain('The recorded Tags of AWS::SQS::Queue Q holds 1 key(s) derived from a dynamic reference');
    expect(msg).not.toContain('issue3994/tags');
    expect(tagPlanWarning(plan, 'AWS::SQS::Queue', 'q\nforged')).not.toContain('\n');
  });

  it('warns about an unreadable record, and is silent on a readable one', () => {
    expect(tagPlanWarning(planTagDiff(NEEDLE, []), 'AWS::SQS::Queue', 'Q')).toContain('removed no tag');
    expect(tagPlanWarning(planTagDiff([], [{ Key: 'a', Value: 'b' }]), 'AWS::SQS::Queue', 'Q')).toBe(
      undefined
    );
  });
});

describe('recordedTagsUnreadableWarning', () => {
  it('names the resource and the count, flattened to one line', () => {
    const msg = recordedTagsUnreadableWarning('AWS::SQS::Queue', 'q\nforged', 3);
    expect(msg).toContain('The recorded Tags of AWS::SQS::Queue q');
    expect(msg).toContain('applied the 3 desired tag(s) only');
    expect(msg).not.toContain('\n');
  });
});
