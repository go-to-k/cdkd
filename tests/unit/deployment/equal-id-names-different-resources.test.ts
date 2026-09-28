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
