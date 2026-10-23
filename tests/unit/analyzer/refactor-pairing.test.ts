/**
 * go-to-k/cdkd#5201: `cdkd refactor`'s pair proposal. It may be loose (the
 * command confirms every pair with a real diff), but it must never guess
 * between look-alikes.
 */
import { describe, expect, it } from 'vite-plus/test';
import {
  looselyEqual,
  mappingPairs,
  parseMappingFile,
  proposeRenames,
} from '../../../src/analyzer/refactor-pairing.js';

const queue = 'AWS::SQS::Queue';
const c = (logicalId: string, properties: Record<string, unknown> = {}, resourceType = queue) => ({
  logicalId,
  resourceType,
  properties,
});
const d = c;

describe('proposeRenames', () => {
  it('pairs a type with exactly one DELETE and one CREATE, whatever the properties', () => {
    const p = proposeRenames([c('New', { A: 1 })], [d('Old', { A: 2 })]);
    expect(p.renames).toEqual([{ from: 'Old', to: 'New', resourceType: queue, source: 'detected' }]);
    expect(p.ambiguous).toEqual([]);
  });

  it('never pairs across types', () => {
    const p = proposeRenames([c('New', {}, 'AWS::SNS::Topic')], [d('Old')]);
    expect(p.renames).toEqual([]);
  });

  it('splits look-alikes by their properties', () => {
    const p = proposeRenames(
      [c('NewA', { Timeout: 1 }), c('NewB', { Timeout: 2 })],
      [d('OldB', { Timeout: 2 }), d('OldA', { Timeout: 1 })]
    );
    expect(p.renames.map((r) => [r.from, r.to])).toEqual([
      ['OldA', 'NewA'],
      ['OldB', 'NewB'],
    ]);
  });

  it('leaves a CREATE with no matching record alone beside one that pairs', () => {
    const p = proposeRenames(
      [c('NewA', { T: 1 }), c('Brand', { T: 7 })],
      [d('OldA', { T: 1 }), d('Gone', { T: 9 })]
    );
    expect(p.renames.map((r) => [r.from, r.to])).toEqual([['OldA', 'NewA']]);
    expect(p.ambiguous).toEqual([]);
  });

  it('reports identical look-alikes as ambiguous instead of guessing', () => {
    const p = proposeRenames(
      [c('NewA', { Timeout: 1 }), c('NewB', { Timeout: 1 })],
      [d('OldA', { Timeout: 1 }), d('OldB', { Timeout: 1 })]
    );
    expect(p.renames).toEqual([]);
    expect(p.ambiguous).toEqual([{ resourceType: queue, from: ['OldA', 'OldB'], to: ['NewA', 'NewB'] }]);
  });

  it('reports a CREATE whose one candidate is also another CREATE\'s as ambiguous', () => {
    const p = proposeRenames(
      [c('NewA', { T: 1 }), c('NewB', { T: 1 })],
      [d('Old', { T: 1 }), d('Unrelated', { T: 9 })]
    );
    expect(p.renames).toEqual([]);
    expect(p.ambiguous).toEqual([{ resourceType: queue, from: ['Old'], to: ['NewA', 'NewB'] }]);
  });

  it('lets a mapping resolve an ambiguity and pairs the rest', () => {
    const p = proposeRenames(
      [c('NewA', { T: 1 }), c('NewB', { T: 1 })],
      [d('OldA', { T: 1 }), d('OldB', { T: 1 })],
      [{ from: 'OldA', to: 'NewB' }]
    );
    expect(p.renames).toEqual([
      { from: 'OldA', to: 'NewB', resourceType: queue, source: 'override' },
      { from: 'OldB', to: 'NewA', resourceType: queue, source: 'detected' },
    ]);
  });

  it.each([
    ['a from that is not a DELETE row', { from: 'Nope', to: 'New' }],
    ['a to that is not a CREATE row', { from: 'Old', to: 'Nope' }],
  ])('refuses %s', (_label, override) => {
    const p = proposeRenames([c('New')], [d('Old')], [override]);
    expect(p.refusedOverrides).toHaveLength(1);
    expect(p.refusedOverrides[0]).toMatchObject(override);
  });

  it('refuses a mapping across types and one naming an id twice', () => {
    const p = proposeRenames(
      [c('New'), c('Topic', {}, 'AWS::SNS::Topic'), c('New2')],
      [d('Old'), d('Old2')],
      [
        { from: 'Old', to: 'Topic' },
        { from: 'Old2', to: 'New' },
        { from: 'Old2', to: 'New2' },
      ]
    );
    expect(p.refusedOverrides.map((r) => r.to)).toEqual(['Topic', 'New2']);
  });

  it.each(['AWS::CloudFormation::Stack', 'AWS::CDK::Metadata'])(
    'never pairs a %s row, detected or named',
    (type) => {
      expect(proposeRenames([c('New', {}, type)], [d('Old', {}, type)]).renames).toEqual([]);
      const named = proposeRenames([c('New', {}, type)], [d('Old', {}, type)], [
        { from: 'Old', to: 'New' },
      ]);
      expect(named.renames).toEqual([]);
      expect(named.refusedOverrides).toHaveLength(1);
    }
  );
});

describe('looselyEqual', () => {
  it('treats an unresolved intrinsic on the template side as matching anything', () => {
    expect(looselyEqual({ Q: { Ref: 'X' }, T: 1 }, { Q: 'https://q', T: 1 })).toBe(true);
    expect(looselyEqual({ Q: { 'Fn::GetAtt': ['X', 'Arn'] } }, { Q: ['a'] })).toBe(true);
  });

  it('ignores keys whose value is undefined on either side', () => {
    expect(looselyEqual({ T: 1, U: undefined }, { T: 1 })).toBe(true);
    expect(looselyEqual({ T: 1 }, { T: 1, U: undefined })).toBe(true);
  });

  it('compares literals, key sets and array lengths', () => {
    expect(looselyEqual({ T: 1 }, { T: 2 })).toBe(false);
    expect(looselyEqual({ T: 1 }, { T: 1, U: 2 })).toBe(false);
    expect(looselyEqual([1], [1, 2])).toBe(false);
    expect(looselyEqual({ T: '1' }, { T: 1 })).toBe(true);
    expect(looselyEqual({ T: { Ref: 'X', Other: 1 } }, { T: 'v' })).toBe(false);
  });
});

describe('parseMappingFile / mappingPairs', () => {
  const text = JSON.stringify({
    environments: [
      { account: '123456789012', region: 'us-east-1', resources: { 'S.Old': 'S.New' } },
    ],
  });

  it('parses the cdk refactor shape and splits locations', () => {
    const [env] = parseMappingFile(text);
    expect(env).toEqual({ account: '123456789012', region: 'us-east-1', resources: { 'S.Old': 'S.New' } });
    expect(mappingPairs(env!.resources, false)).toEqual([
      { fromStack: 'S', from: 'Old', toStack: 'S', to: 'New' },
    ]);
    expect(mappingPairs(env!.resources, true)).toEqual([
      { fromStack: 'S', from: 'New', toStack: 'S', to: 'Old' },
    ]);
  });

  it.each([
    ['not JSON', '{'],
    ['no environments', '{}'],
    ['the stale "mappings" key', '{"mappings":[]}'],
    ['a non-string account', '{"environments":[{"account":1,"region":"r","resources":{}}]}'],
    ['a non-object resources', '{"environments":[{"account":"a","region":"r","resources":[]}]}'],
    ['a duplicate destination', '{"environments":[{"account":"a","region":"r","resources":{"S.A":"S.C","S.B":"S.C"}}]}'],
  ])('refuses %s', (_label, body) => {
    expect(() => parseMappingFile(body)).toThrow();
  });

  it.each([
    ['from', '{"environments":[{"account":"a","region":"r","resources":{"Old":"S.New"}}]}'],
    ['to', '{"environments":[{"account":"a","region":"r","resources":{"S.Old":"New."}}]}'],
  ])('refuses a malformed %s location at parse time', (_side, body) => {
    expect(() => parseMappingFile(body)).toThrow(/StackName/);
  });

  it('refuses a location without a stack', () => {
    expect(() => mappingPairs({ Old: 'S.New' }, false)).toThrow(/StackName/);
  });
});
