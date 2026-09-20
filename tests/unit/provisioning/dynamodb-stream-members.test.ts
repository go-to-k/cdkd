import { describe, it, expect, vi } from 'vite-plus/test';
import {
  planStreamMemberOps,
  readStreamPolicy,
  readStreamTags,
  reverseMapStreamPolicy,
  streamDeclaresPolicy,
  streamDeclaresTags,
  streamMemberRefusals,
  streamPolicyMatchesDeclared,
  streamTagsMatchDeclared,
} from '../../../src/provisioning/dynamodb-stream-members.js';

const DOC = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: 'arn:aws:iam::111111111111:root' },
      Action: 'dynamodb:DescribeStream',
      Resource: '*',
    },
  ],
};
const OTHER_DOC = { ...DOC, Statement: [{ ...DOC.Statement[0], Action: 'dynamodb:GetRecords' }] };

function block(members: Record<string, unknown> = {}): Record<string, unknown> {
  return { StreamViewType: 'NEW_IMAGE', ...members };
}
const policy = (document: unknown): Record<string, unknown> => ({
  ResourcePolicy: { PolicyDocument: document },
});
const tags = (...pairs: Array<[string, string]>): Record<string, unknown> => ({
  Tags: pairs.map(([Key, Value]) => ({ Key, Value })),
});

const SAME = { freshStream: false };
const FRESH = { freshStream: true };

describe('readStreamPolicy', () => {
  it('reads an absent member as absent, for every spelling of "no block"', () => {
    for (const value of [undefined, null, 'x', [], block(), block({ ResourcePolicy: null })]) {
      expect(readStreamPolicy(value)).toEqual({ kind: 'absent' });
    }
  });

  it('serializes an object document and passes a string document through', () => {
    expect(readStreamPolicy(block(policy(DOC)))).toEqual({
      kind: 'usable',
      document: JSON.stringify(DOC),
    });
    expect(readStreamPolicy(block(policy('{"a":1}')))).toEqual({
      kind: 'usable',
      document: '{"a":1}',
    });
  });

  it.each([
    ['a string container', { ResourcePolicy: 'nope' }],
    ['an array container', { ResourcePolicy: [] }],
    ['an unresolved intrinsic container', { ResourcePolicy: { Ref: 'P' } }],
    ['a missing document', { ResourcePolicy: {} }],
    ['a null document', { ResourcePolicy: { PolicyDocument: null } }],
    ['a blank document', { ResourcePolicy: { PolicyDocument: '  ' } }],
    ['an array document', { ResourcePolicy: { PolicyDocument: [] } }],
    ['an unresolved intrinsic document', policy({ 'Fn::GetAtt': ['X', 'Y'] })],
  ])('reads %s as unusable, never as "no policy"', (_name, members) => {
    const read = readStreamPolicy(block(members));
    expect(read.kind).toBe('unusable');
    expect((read as { reason: string }).reason).toContain('StreamSpecification.ResourcePolicy');
  });
});

describe('readStreamTags', () => {
  it('reads declared tags in order, a blank or absent Value as the empty value', () => {
    const read = readStreamTags(
      block({ Tags: [{ Key: 'a', Value: '1' }, { Key: 'b', Value: '' }, { Key: 'c' }] })
    );
    expect(read).toEqual({
      kind: 'usable',
      tags: new Map([
        ['a', '1'],
        ['b', ''],
        ['c', ''],
      ]),
    });
  });

  it('reads an empty list as a usable empty set, not as absent', () => {
    expect(readStreamTags(block({ Tags: [] }))).toEqual({ kind: 'usable', tags: new Map() });
    expect(readStreamTags(block())).toEqual({ kind: 'absent' });
  });

  it.each([
    ['a non-array', { Tags: { Key: 'a', Value: '1' } }, 'StreamSpecification.Tags must be'],
    ['an intrinsic list', { Tags: { 'Fn::If': ['c', [], []] } }, 'StreamSpecification.Tags must be'],
    ['a string entry', { Tags: ['a'] }, 'StreamSpecification.Tags[0]'],
    ['an intrinsic entry', { Tags: [{ Key: 'ok', Value: 'v' }, { Ref: 'T' }] }, 'Tags[1]'],
    ['a missing key', { Tags: [{ Value: 'v' }] }, 'Tags[0].Key'],
    ['a blank key', { Tags: [{ Key: ' ', Value: 'v' }] }, 'Tags[0].Key'],
    ['an intrinsic value', { Tags: [{ Key: 'k', Value: { Ref: 'V' } }] }, 'Tags[0].Value'],
    ['a numeric value', { Tags: [{ Key: 'k', Value: 7 }] }, 'Tags[0].Value'],
  ])('reads %s as unusable and names the position', (_name, members, needle) => {
    const read = readStreamTags(block(members));
    expect(read.kind).toBe('unusable');
    expect((read as { reason: string }).reason).toContain(needle);
  });

  it('never names a resolved tag key or value in a refusal', () => {
    const read = readStreamTags(
      block({ Tags: [{ Key: 'sekrit-key', Value: 'v' }, { Key: 'other-key', Value: 9 }] })
    );
    const reason = (read as { reason: string }).reason;
    expect(reason).not.toContain('sekrit-key');
    expect(reason).not.toContain('other-key');
  });
});

describe('streamMemberRefusals', () => {
  it('is empty for a readable or member-less block and lists each unreadable member', () => {
    expect(streamMemberRefusals(undefined)).toEqual([]);
    expect(streamMemberRefusals(block({ ...policy(DOC), ...tags(['a', '1']) }))).toEqual([]);
    const refusals = streamMemberRefusals(block({ ResourcePolicy: 'x', Tags: 'y' }));
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toContain('StreamSpecification.ResourcePolicy');
    expect(refusals[1]).toContain('StreamSpecification.Tags');
  });
});

describe('planStreamMemberOps', () => {
  const plan = (
    desired: unknown,
    previous: unknown,
    options = SAME,
    onUnusable: (reason: string) => void = () => undefined
  ) => planStreamMemberOps(desired, previous, options, onUnusable);

  it('applies every declared member to a fresh stream: tags first, the policy LAST', () => {
    expect(plan(block({ ...policy(DOC), ...tags(['a', '1'], ['b', '2']) }), undefined, FRESH)).toEqual(
      [
        {
          kind: 'tag',
          tags: [
            { Key: 'a', Value: '1' },
            { Key: 'b', Value: '2' },
          ],
        },
        { kind: 'putPolicy', document: JSON.stringify(DOC) },
      ]
    );
  });

  it('re-applies UNCHANGED members to a fresh stream and never deletes there', () => {
    const same = block({ ...policy(DOC), ...tags(['a', '1']) });
    // The same members on the SAME stream need nothing...
    expect(plan(same, { ...same, StreamViewType: 'KEYS_ONLY' }, SAME)).toEqual([]);
    // ...but a fresh arn holds nothing, so they are applied again.
    expect(plan(same, { ...same, StreamViewType: 'KEYS_ONLY' }, FRESH).map((op) => op.kind)).toEqual([
      'tag',
      'putPolicy',
    ]);
    // Members the update REMOVED are not deleted from an arn that never had them.
    expect(plan(block(), same, FRESH)).toEqual([]);
  });

  it('issues nothing for an unchanged block on the same stream', () => {
    const same = block({ ...policy(DOC), ...tags(['a', '1']) });
    expect(plan(same, structuredClone(same))).toEqual([]);
  });

  it('puts a changed policy and diffs the tags on the same stream', () => {
    expect(
      plan(
        block({ ...policy(OTHER_DOC), ...tags(['a', '1'], ['b', 'new'], ['d', '4']) }),
        block({ ...policy(DOC), ...tags(['a', '1'], ['b', 'old'], ['c', '3']) })
      )
    ).toEqual([
      // The old policy goes BEFORE the first tag call: it must never be
      // evaluated against the new tag set, nor the new one against the old.
      { kind: 'deletePolicy' },
      { kind: 'untag', keys: ['c'] },
      {
        kind: 'tag',
        tags: [
          { Key: 'b', Value: 'new' },
          { Key: 'd', Value: '4' },
        ],
      },
      { kind: 'putPolicy', document: JSON.stringify(OTHER_DOC) },
    ]);
  });

  it('keeps an UNCHANGED policy in place across a tag-only change, and the tags across a policy-only one', () => {
    expect(
      plan(block({ ...policy(DOC), ...tags(['a', '2']) }), block({ ...policy(DOC), ...tags(['a', '1']) }))
    ).toEqual([{ kind: 'tag', tags: [{ Key: 'a', Value: '2' }] }]);
    expect(
      plan(
        block({ ...policy(OTHER_DOC), ...tags(['a', '1']) }),
        block({ ...policy(DOC), ...tags(['a', '1']) })
      )
    ).toEqual([{ kind: 'putPolicy', document: JSON.stringify(OTHER_DOC) }]);
    // A policy ADDED alongside a tag change has nothing to delete first.
    expect(plan(block({ ...policy(DOC), ...tags(['a', '2']) }), block(tags(['a', '1'])))).toEqual([
      { kind: 'tag', tags: [{ Key: 'a', Value: '2' }] },
      { kind: 'putPolicy', document: JSON.stringify(DOC) },
    ]);
  });

  it('REMOVES a member that left a block whose stream stays: the policy delete FIRST', () => {
    expect(plan(block(), block({ ...policy(DOC), ...tags(['a', '1'], ['b', '2']) }))).toEqual([
      { kind: 'deletePolicy' },
      { kind: 'untag', keys: ['a', 'b'] },
    ]);
    // A declared EMPTY list untags too.
    expect(plan(block({ Tags: [] }), block(tags(['a', '1'])))).toEqual([
      { kind: 'untag', keys: ['a'] },
    ]);
  });

  it('is symmetric, so a rollback (sides swapped) restores what the update removed', () => {
    const withMembers = block({ ...policy(DOC), ...tags(['a', '1']) });
    const forward = plan(block(), withMembers);
    const rollback = plan(withMembers, block());
    expect(forward.map((op) => op.kind)).toEqual(['deletePolicy', 'untag']);
    expect(rollback).toEqual([
      { kind: 'tag', tags: [{ Key: 'a', Value: '1' }] },
      { kind: 'putPolicy', document: JSON.stringify(DOC) },
    ]);
    // Across a view-type change the rollback mints yet another arn.
    expect(plan(withMembers, block({ StreamViewType: 'KEYS_ONLY' }), FRESH)).toEqual(rollback);
  });

  it('deletes the policy when the previous one is unreadable: something was declared', () => {
    expect(plan(block(), block({ ResourcePolicy: 'junk' }))).toEqual([{ kind: 'deletePolicy' }]);
  });

  it('untags nothing against an unreadable previous list', () => {
    expect(plan(block(), block({ Tags: 'junk' }))).toEqual([]);
  });

  it('reports an unusable member and leaves it alone on a stream that stays', () => {
    const onUnusable = vi.fn();
    const ops = plan(
      block({ ResourcePolicy: { Ref: 'P' }, Tags: 'junk' }),
      block({ ...policy(DOC), ...tags(['a', '1']) }),
      SAME,
      onUnusable
    );
    expect(ops).toEqual([]);
    expect(onUnusable).toHaveBeenCalledTimes(2);
  });

  it('keeps applying the READABLE member when only the other one is unusable', () => {
    const onUnusable = vi.fn();
    expect(
      plan(block({ ResourcePolicy: 'junk', ...tags(['a', '2']) }), block(tags(['a', '1'])), SAME, onUnusable)
    ).toEqual([{ kind: 'tag', tags: [{ Key: 'a', Value: '2' }] }]);
    expect(onUnusable).toHaveBeenCalledTimes(1);
  });

  it('carries the PREVIOUS member onto a fresh stream when the desired one is unusable', () => {
    const onUnusable = vi.fn();
    expect(
      plan(
        block({ ResourcePolicy: 'junk', Tags: 'junk' }),
        block({ StreamViewType: 'KEYS_ONLY', ...policy(DOC), ...tags(['a', '1']) }),
        FRESH,
        onUnusable
      )
    ).toEqual([
      { kind: 'tag', tags: [{ Key: 'a', Value: '1' }] },
      { kind: 'putPolicy', document: JSON.stringify(DOC) },
    ]);
    expect(onUnusable).toHaveBeenCalledTimes(2);
  });
});

describe('settled tests for the eventually consistent read-back', () => {
  it('accepts the declared policy in any key order, and nothing else', () => {
    const declared = block(policy(DOC));
    const reordered = JSON.stringify({ Statement: DOC.Statement, Version: DOC.Version });
    expect(streamPolicyMatchesDeclared(reordered, declared)).toBe(true);
    expect(streamPolicyMatchesDeclared(JSON.stringify(OTHER_DOC), declared)).toBe(false);
    expect(streamPolicyMatchesDeclared(undefined, declared)).toBe(false);
    expect(streamPolicyMatchesDeclared('not json', declared)).toBe(false);
    expect(streamPolicyMatchesDeclared(reordered, block())).toBe(false);
  });

  it('accepts exactly the declared tag set, in any order', () => {
    const declared = block(tags(['a', '1'], ['b', '2']));
    const live = (...pairs: Array<[string, string]>) => pairs.map(([Key, Value]) => ({ Key, Value }));
    expect(streamTagsMatchDeclared(live(['b', '2'], ['a', '1']), declared)).toBe(true);
    expect(streamTagsMatchDeclared(live(['a', '1']), declared)).toBe(false);
    expect(streamTagsMatchDeclared(live(['a', '1'], ['b', 'old']), declared)).toBe(false);
    expect(streamTagsMatchDeclared(live(['a', '1'], ['b', '2'], ['c', '3']), declared)).toBe(false);
    expect(streamTagsMatchDeclared([], block({ Tags: [] }))).toBe(true);
    expect(streamTagsMatchDeclared([], block())).toBe(false);
  });
});

describe('read-back gates and reverse map', () => {
  it('gates each member on a block cdkd would SEND, separately', () => {
    expect(streamDeclaresPolicy(block(policy(DOC)))).toBe(true);
    expect(streamDeclaresTags(block(policy(DOC)))).toBe(false);
    expect(streamDeclaresTags(block(tags(['a', '1'])))).toBe(true);
    expect(streamDeclaresTags(block({ Tags: [] }))).toBe(true);
    expect(streamDeclaresPolicy(block({ ResourcePolicy: 'junk' }))).toBe(false);
    expect(streamDeclaresTags(block({ Tags: 'junk' }))).toBe(false);
    expect(streamDeclaresPolicy(undefined)).toBe(false);
  });

  it('re-shapes the live policy in the DECLARED spelling of the document', () => {
    const live = JSON.stringify(DOC);
    expect(reverseMapStreamPolicy(undefined, block(policy(DOC)))).toBeUndefined();
    expect(reverseMapStreamPolicy('', block(policy(DOC)))).toBeUndefined();
    expect(reverseMapStreamPolicy(live, block(policy(DOC)))).toEqual({ PolicyDocument: DOC });
    // Declared as a string with other whitespace / key order: equal, so the
    // declared string itself comes back.
    const declared = JSON.stringify({ Statement: DOC.Statement, Version: DOC.Version }, null, 2);
    expect(reverseMapStreamPolicy(live, block(policy(declared)))).toEqual({
      PolicyDocument: declared,
    });
    // A REAL difference stays visible against a string declaration.
    expect(reverseMapStreamPolicy(JSON.stringify(OTHER_DOC), block(policy(declared)))).toEqual({
      PolicyDocument: JSON.stringify(OTHER_DOC),
    });
    expect(reverseMapStreamPolicy('not json', block(policy(DOC)))).toEqual({
      PolicyDocument: 'not json',
    });
  });
});
