/**
 * go-to-k/cdkd#4156: `isInlinePolicyClaimedByCompletedWriter` answers, at the
 * moment of a removal, whether ANOTHER resource of the deploy has ALREADY
 * written the inline policy name onto the principal, reading what that
 * resource RECORDED. A wrong `true` is fail-open (the removed policy's old
 * document stays attached), so every doubt answers `false`.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  isInlinePolicyClaimedByCompletedWriter,
  type InlinePolicyWrite,
} from '../../../src/deployment/inline-policy-claims.js';
import type { InlinePolicyPrincipalKind } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

const DOC = { Version: '2012-10-17', Statement: [] };

const policyRecord = (physicalId: unknown, props: Record<string, unknown>): ResourceState =>
  ({
    physicalId,
    resourceType: 'AWS::IAM::Policy',
    properties: { PolicyDocument: DOC, ...props },
  }) as ResourceState;

const principalRecord = (
  type: string,
  physicalId: unknown,
  policies: unknown
): ResourceState =>
  ({ physicalId, resourceType: type, properties: { Policies: policies } }) as ResourceState;

const policiesRow = (extra: Record<string, unknown> = {}): ResourceChange => ({
  logicalId: 'x',
  changeType: 'UPDATE',
  resourceType: 'x',
  propertyChanges: [
    { path: 'Policies', oldValue: [], newValue: [], requiresReplacement: false, ...extra },
  ],
});

function claimed(
  state: Record<string, ResourceState>,
  writers: Array<[string, InlinePolicyWrite]>,
  query: [InlinePolicyPrincipalKind, string, string],
  changes: Array<[string, ResourceChange]> = []
): boolean {
  return isInlinePolicyClaimedByCompletedWriter(
    {
      selfLogicalId: 'Self',
      writers: new Map(writers),
      changes: new Map(changes),
      stateResources: state,
    },
    ...query
  );
}

describe('isInlinePolicyClaimedByCompletedWriter (go-to-k/cdkd#4156)', () => {
  const B = policyRecord('x', { Roles: ['r'], Groups: ['g'], Users: ['u'] });

  it.each([
    ['role', 'r'],
    ['group', 'g'],
    ['user', 'u'],
  ] as const)('a completed AWS::IAM::Policy writer claims its name on each recorded %s', (kind, principal) => {
    expect(claimed({ B }, [['B', 'update']], [kind, principal, 'x'])).toBe(true);
  });

  it('the same record, NOT a completed writer (not run yet, in flight or failed), claims nothing', () => {
    expect(claimed({ B }, [], ['role', 'r', 'x'])).toBe(false);
  });

  it.each([
    ['another kind', ['role', 'u', 'x']],
    ['another principal', ['role', 'other', 'x']],
    ['another name', ['role', 'r', 'y']],
  ] as const)('a writer claims nothing on %s', (_what, query) => {
    expect(claimed({ B }, [['B', 'create']], [...query])).toBe(false);
  });

  it.each([
    ['the query upper-case, the record lower-case', 'R', 'X', 'r', 'x'],
    ['the query lower-case, the record upper-case', 'r', 'x', 'R', 'X'],
  ])('matches principal and name case-insensitively (%s)', (_what, qp, qn, rp, rn) => {
    const state = { B: policyRecord(rn, { Roles: [rp] }) };
    expect(claimed(state, [['B', 'update']], ['role', qp, qn])).toBe(true);
  });

  it('the name is the one the writer RECORDED as its physical id, not its PolicyName property', () => {
    // A policy with no PolicyName records the name create() generated (a long
    // logical id truncated to 64 characters) as its physical id.
    const generated = 'Stk-' + 'L'.repeat(51) + '-abcdefgh';
    const state = { Gen: policyRecord(generated, { Roles: ['r'] }) };
    expect(claimed(state, [['Gen', 'create']], ['role', 'r', generated])).toBe(true);
    const renamed = { B: policyRecord('actual', { PolicyName: 'template-name', Roles: ['r'] }) };
    expect(claimed(renamed, [['B', 'update']], ['role', 'r', 'template-name'])).toBe(false);
    expect(claimed(renamed, [['B', 'update']], ['role', 'r', 'actual'])).toBe(true);
  });

  it('a Cloud Control-provisioned AWS::IAM::Policy writer claims nothing; an SDK one does', () => {
    expect(claimed({ B: { ...B, provisionedBy: 'cc-api' } }, [['B', 'update']], ['role', 'r', 'x'])).toBe(false);
    expect(claimed({ B: { ...B, provisionedBy: 'sdk' } }, [['B', 'update']], ['role', 'r', 'x'])).toBe(true);
  });

  it('never claims for the resource doing the removal', () => {
    expect(claimed({ Self: B }, [['Self', 'update']], ['role', 'r', 'x'])).toBe(false);
  });

  it.each([
    ['a string (never walked per character)', { Roles: 'r' }],
    ['a redacted secret reference', { Roles: ['{{resolve:secretsmanager:s:SecretString:r::}}'] }],
    ['the mask', { Roles: ['***'] }],
    ['a non-string entry', { Roles: [{ Ref: 'Role' }] }],
    ['an empty entry', { Roles: [''] }],
  ])('a recorded principal list holding %s claims nothing on it', (_what, props) => {
    const state = { B: policyRecord('x', props) };
    for (const principal of ['r', '', '***']) {
      expect(claimed(state, [['B', 'update']], ['role', principal, 'x'])).toBe(false);
    }
  });

  it.each([
    ['empty', ''],
    ['not a string', 7],
  ])('a writer whose recorded physical id is %s claims nothing', (_what, physicalId) => {
    const state = { B: policyRecord(physicalId, { Roles: ['r'] }) };
    expect(claimed(state, [['B', 'update']], ['role', 'r', ''])).toBe(false);
    expect(claimed(state, [['B', 'update']], ['role', 'r', 'x'])).toBe(false);
  });

  it('a writer with no record in the state bag claims nothing', () => {
    expect(claimed({}, [['B', 'update']], ['role', 'r', 'x'])).toBe(false);
  });

  it('a writer whose logical id is an Object.prototype key is judged by its own record', () => {
    expect(claimed({}, [['constructor', 'update']], ['role', 'r', 'x'])).toBe(false);
    expect(claimed({ constructor: B }, [['constructor', 'update']], ['role', 'r', 'x'])).toBe(true);
  });

  describe('a role / group / user writer claims its own Policies', () => {
    const cases = [
      ['AWS::IAM::Role', 'role'],
      ['AWS::IAM::Group', 'group'],
      ['AWS::IAM::User', 'user'],
    ] as const;

    it.each(cases)('%s created in this deploy claims each recorded PolicyName on its physical id', (type, kind) => {
      const state = { P: principalRecord(type, 'p-phys', [{ PolicyName: 'x' }, { PolicyName: 'z' }]) };
      expect(claimed(state, [['P', 'create']], [kind, 'p-phys', 'x'])).toBe(true);
      expect(claimed(state, [['P', 'create']], [kind, 'P-PHYS', 'Z'])).toBe(true);
      expect(claimed(state, [['P', 'create']], [kind, 'other', 'x'])).toBe(false);
    });

    it.each(cases)('%s updated claims only when its own diff changed Policies', (type, kind) => {
      const state = { P: principalRecord(type, 'p-phys', [{ PolicyName: 'x' }]) };
      expect(claimed(state, [['P', 'update']], [kind, 'p-phys', 'x'], [['P', policiesRow()]])).toBe(true);
      // A Tags-only update: its record lists `x`, but the write never put it.
      const tags: ResourceChange = {
        ...policiesRow(),
        propertyChanges: [{ path: 'Tags', oldValue: 1, newValue: 2, requiresReplacement: false }],
      };
      expect(claimed(state, [['P', 'update']], [kind, 'p-phys', 'x'], [['P', tags]])).toBe(false);
      expect(claimed(state, [['P', 'update']], [kind, 'p-phys', 'x'])).toBe(false);
      for (const flag of ['inPlacePropagated', 'replacementPropagated']) {
        expect(
          claimed(state, [['P', 'update']], [kind, 'p-phys', 'x'], [['P', policiesRow({ [flag]: true })]])
        ).toBe(false);
      }
    });

    it('a Cloud Control-provisioned principal claims nothing; an SDK one does', () => {
      const record = principalRecord('AWS::IAM::Role', 'p-phys', [{ PolicyName: 'x' }]);
      expect(claimed({ P: { ...record, provisionedBy: 'cc-api' } }, [['P', 'create']], ['role', 'p-phys', 'x'])).toBe(false);
      expect(claimed({ P: { ...record, provisionedBy: 'sdk' } }, [['P', 'create']], ['role', 'p-phys', 'x'])).toBe(true);
    });

    it('a principal of another kind claims nothing', () => {
      const state = { P: principalRecord('AWS::IAM::Role', 'p-phys', [{ PolicyName: 'x' }]) };
      expect(claimed(state, [['P', 'create']], ['user', 'p-phys', 'x'])).toBe(false);
    });

    it('a type that is not an IAM principal claims nothing, a prototype key included', () => {
      for (const type of ['AWS::SQS::Queue', 'constructor', 'toString']) {
        const state = { P: principalRecord(type, 'p-phys', [{ PolicyName: 'x' }]) };
        expect(claimed(state, [['P', 'create']], ['role', 'p-phys', 'x'])).toBe(false);
      }
    });

    it.each([
      ['a non-array Policies', { PolicyName: 'x' }],
      ['non-object entries', ['x', null, [{ PolicyName: 'x' }]]],
      ['an empty PolicyName', [{ PolicyName: '' }]],
    ])('%s claims nothing', (_what, policies) => {
      const state = { P: principalRecord('AWS::IAM::Role', 'p-phys', policies) };
      expect(claimed(state, [['P', 'create']], ['role', 'p-phys', 'x'])).toBe(false);
      expect(claimed(state, [['P', 'create']], ['role', 'p-phys', ''])).toBe(false);
    });

    it('a principal whose recorded physical id is empty claims nothing', () => {
      const state = { P: principalRecord('AWS::IAM::Role', '', [{ PolicyName: 'x' }]) };
      expect(claimed(state, [['P', 'create']], ['role', '', 'x'])).toBe(false);
    });
  });
});
