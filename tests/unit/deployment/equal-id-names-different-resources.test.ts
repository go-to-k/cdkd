import { describe, it, expect } from 'vite-plus/test';
import {
  equalIdNamesDifferentResources,
  equalIdNamesSameResource,
} from '../../../src/deployment/type-change-guard.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

/**
 * Issue #3892: a Glue table's id is placed by its recorded DatabaseName, so two
 * DIFFERENT tables can share one id. The predicate says so only when it can
 * tell: two usable, different database names. Every unreadable input answers
 * `false` — the pre-#3892 reading — because a wrong `true` would let the engine
 * delete "the old resource" by an id that is the one it just created.
 */
describe('equalIdNamesDifferentResources (issue #3892)', () => {
  const GLUE = 'AWS::Glue::Table';
  const check = (
    id: string | undefined,
    oldDb: unknown,
    newDb: unknown,
    resourceType = GLUE
  ): boolean =>
    equalIdNamesDifferentResources({
      resourceType,
      physicalId: id,
      oldProperties: { DatabaseName: oldDb },
      newProperties: { DatabaseName: newDb },
    });

  it('is true for two databases that both anchor the shared id', () => {
    expect(check('my|db|orders', 'my', 'my|db')).toBe(true);
    expect(check('my|db|orders', 'my|db', 'my')).toBe(true);
  });

  // A DatabaseName that does not prefix the id says nothing about the table
  // the id names: `cdkd import` records `a|b` beside a template `x`, and its
  // readers address `a.b`. Correcting the template to `a` is the SAME table.
  it('is false when one DatabaseName does not anchor the id', () => {
    expect(check('a|b', 'x', 'a')).toBe(false);
    expect(check('a|b', 'a', 'x')).toBe(false);
  });

  it.each([
    ['the same database', 'my|db|orders', 'my', 'my'],
    ['a {{resolve:...}} expression beside its plaintext', 'my|orders', '{{resolve:ssm:DbName}}', 'my'],
    ['an unresolved intrinsic', 'my|orders', { Ref: 'Db' }, 'my'],
    ['a redaction mask', 'my|orders', SECRET_MASK, 'my'],
    ['an empty name', 'my|orders', '', 'my'],
    ['an absent name', 'my|orders', undefined, 'my'],
  ])('is false for %s', (_n, id, oldDb, newDb) => {
    expect(check(id, oldDb, newDb)).toBe(false);
    expect(check(id, newDb, oldDb)).toBe(false);
  });

  it('is false with no id', () => {
    expect(check(undefined, 'my', 'my|db')).toBe(false);
  });

  it('is false for every other type, whatever the bags say', () => {
    expect(check('my|db|orders', 'my', 'my|db', 'AWS::SQS::Queue')).toBe(false);
  });

  it('is false with no bags at all', () => {
    expect(
      equalIdNamesDifferentResources({
        resourceType: GLUE,
        physicalId: 'my|db|orders',
        oldProperties: undefined,
        newProperties: undefined,
      })
    ).toBe(false);
  });
});

describe('equalIdNamesSameResource with property bags (issue #3892)', () => {
  it('answers false within one type when the bags name different Glue tables', () => {
    expect(
      equalIdNamesSameResource({
        oldType: 'AWS::Glue::Table',
        newType: 'AWS::Glue::Table',
        createLayer: 'sdk',
        oldProperties: { DatabaseName: 'my' },
        newProperties: { DatabaseName: 'my|db' },
        physicalId: 'my|db|orders',
      })
    ).toBe(false);
  });

  it('keeps the type-only answer without bags, and for another type', () => {
    expect(
      equalIdNamesSameResource({
        oldType: 'AWS::Glue::Table',
        newType: 'AWS::Glue::Table',
        createLayer: 'sdk',
      })
    ).toBe(true);
    expect(
      equalIdNamesSameResource({
        oldType: 'AWS::SQS::Queue',
        newType: 'AWS::SQS::Queue',
        createLayer: 'sdk',
        oldProperties: { DatabaseName: 'my' },
        newProperties: { DatabaseName: 'my|db' },
        physicalId: 'my|db|orders',
      })
    ).toBe(true);
  });
});

/**
 * go-to-k/cdkd#5137: a Lambda permission's id is a StatementId AWS scopes to
 * its function, so the same id on two different functions is two statements.
 * Only two readable unqualified spellings with different function names prove
 * it; every doubt keeps the same-resource reading.
 */
describe('equalIdNamesDifferentResources: AWS::Lambda::Permission (go-to-k/cdkd#5137)', () => {
  const check = (oldFn: unknown, newFn: unknown): boolean =>
    equalIdNamesDifferentResources({
      resourceType: 'AWS::Lambda::Permission',
      physicalId: 'ApiPermission',
      oldProperties: { FunctionName: oldFn },
      newProperties: { FunctionName: newFn },
    });
  const ARN = (name: string): string => `arn:aws:lambda:us-east-1:123456789012:function:${name}`;

  it('is true for two different function names, in any unqualified spelling', () => {
    expect(check('old-fn', 'changed-name')).toBe(true);
    expect(check(ARN('old-fn'), ARN('changed-name'))).toBe(true);
    expect(check('123456789012:function:old-fn', 'changed-name')).toBe(true);
  });

  it.each([
    ['the same function', 'fn', 'fn'],
    ['one function spelled as a name and as an ARN', 'fn', ARN('fn')],
    ['a qualified ARN', `${ARN('old-fn')}:live`, 'changed-name'],
    ['a {{resolve:...}} expression', '{{resolve:ssm:FnName}}', 'changed-name'],
    ['an unresolved intrinsic', { Ref: 'Fn' }, 'changed-name'],
    ['a redaction mask', SECRET_MASK, 'changed-name'],
    ['an absent name', undefined, 'changed-name'],
  ])('is false for %s', (_n, oldFn, newFn) => {
    expect(check(oldFn, newFn)).toBe(false);
    expect(check(newFn, oldFn)).toBe(false);
  });

  it('makes equalIdNamesSameResource read the equal id as two statements', () => {
    expect(
      equalIdNamesSameResource({
        oldType: 'AWS::Lambda::Permission',
        newType: 'AWS::Lambda::Permission',
        createLayer: 'sdk',
        oldProperties: { FunctionName: 'old-fn' },
        newProperties: { FunctionName: 'changed-name' },
        physicalId: 'ApiPermission',
      })
    ).toBe(false);
  });
});
