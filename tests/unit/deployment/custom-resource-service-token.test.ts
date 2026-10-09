/**
 * go-to-k/cdkd#4749: the verdicts behind the ServiceToken refusal, over the
 * row shapes `DiffCalculator` builds. The engine and `cdkd diff` cases drive
 * the same finder end to end (`deploy-engine-cr-service-token-4749.test.ts`,
 * `tests/unit/cli/diff-recursive.test.ts`); this file pins the arms neither
 * reaches cheaply: dynamic references, synthetic changes, a Type change, and
 * the shapes the plan defers.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  diffMovedServiceToken,
  findServiceTokenRefusals,
  renderServiceTokenRefusal,
  serviceTokenUpdateRefusal,
  uncomparableToken,
} from '../../../src/deployment/custom-resource-service-token.js';
import type { PropertyChange, ResourceChange, ResourceState } from '../../../src/types/state.js';

const OLD = 'arn:aws:lambda:us-east-1:123456789012:function:old';
const NEW = 'arn:aws:lambda:us-east-1:123456789012:function:new';
const REF = '{{resolve:ssm:/handler/arn}}';

function record(token: unknown, resourceType = 'Custom::Thing'): ResourceState {
  return {
    physicalId: 'cr-1',
    resourceType,
    properties: token === undefined ? {} : { ServiceToken: token },
    attributes: {},
    dependencies: [],
  } as ResourceState;
}

function row(pc: Partial<PropertyChange>, resourceType = 'Custom::Thing'): ResourceChange {
  return {
    logicalId: 'Cr',
    changeType: 'UPDATE',
    resourceType,
    propertyChanges: [
      { path: 'ServiceToken', oldValue: OLD, newValue: NEW, requiresReplacement: false, ...pc },
    ],
  } as ResourceChange;
}

const find = (change: ResourceChange, state: ResourceState, recreate?: Set<string>) =>
  findServiceTokenRefusals({
    changes: new Map([['Cr', change]]),
    stateResources: { Cr: state },
    recreateTargetIds: recreate,
  });

describe('uncomparableToken', () => {
  it.each([
    [OLD, undefined],
    [undefined, 'absent'],
    ['', 'absent'],
    [null, 'absent'],
    ['***', 'masked'],
    [`${OLD}***`, 'masked'],
    [REF, 'reference'],
    [`arn:aws:lambda:us-east-1:1:function:${REF}`, 'reference'],
    [{ 'Fn::GetAtt': ['Fn', 'Arn'] }, 'not-a-string'],
    [42, 'not-a-string'],
  ] as const)('%j -> %s', (value, expected) => {
    expect(uncomparableToken(value)).toBe(expected);
  });
});

describe('findServiceTokenRefusals (plan time)', () => {
  it('refuses two different plain tokens', () => {
    expect(find(row({}), record(OLD)).refused).toEqual([
      { logicalId: 'Cr', resourceType: 'Custom::Thing', kind: 'changed', desired: NEW },
    ]);
  });

  it('covers the generic custom type', () => {
    const type = 'AWS::CloudFormation::CustomResource';
    expect(find(row({}, type), record(OLD, type)).refused).toHaveLength(1);
  });

  it('ignores a row whose ServiceToken did not change', () => {
    const change = row({ path: 'Seed', oldValue: 'a', newValue: 'b' });
    expect(find(change, record(OLD))).toEqual({ refused: [], deferred: [] });
  });

  it('ignores a non-custom type', () => {
    expect(find(row({}, 'AWS::SNS::Topic'), record(OLD, 'AWS::SNS::Topic')).refused).toEqual([]);
  });

  it('ignores a Type change, which is replaced through each type', () => {
    expect(find(row({}, 'Custom::B'), record(OLD, 'Custom::A')).refused).toEqual([]);
  });

  it('ignores a --recreate-via-* target of this stack', () => {
    expect(find(row({}), record(OLD), new Set(['Cr'])).refused).toEqual([]);
  });

  it('ignores a logical id that only the prototype chain holds', () => {
    // A matching record planted on Object.prototype: a bare index would read
    // it and refuse; only an own record counts.
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto['Cr'] = record(OLD);
    try {
      expect(
        findServiceTokenRefusals({ changes: new Map([['Cr', row({})]]), stateResources: {} }).refused
      ).toEqual([]);
    } finally {
      delete proto['Cr'];
    }
  });

  it.each([
    ['masked', '***'],
    ['reference', REF],
    ['absent', undefined],
  ] as const)('refuses as unjudgeable over a recorded %s token', (kind, token) => {
    expect(find(row({}), record(token)).refused).toEqual([
      { logicalId: 'Cr', resourceType: 'Custom::Thing', kind: 'unjudgeable', recorded: kind },
    ]);
  });

  it('refuses a REPLACED referent over an unjudgeable record: the token moves', () => {
    for (const token of ['***', undefined]) {
      expect(find(row({ replacementPropagated: true, newValue: { Ref: 'Fn' } }), record(token)).refused, String(token)).toHaveLength(1);
    }
  });

  it('does NOT refuse a NoEcho or in-place promotion over an unjudgeable record: a NoEcho-fed token is promoted every deploy', () => {
    for (const flag of ['inPlacePropagated', 'noEchoPromoted'] as const) {
      expect(find(row({ [flag]: true, newValue: '***' }), record('***')), flag).toEqual({
        refused: [],
        deferred: [],
      });
    }
  });

  it('refuses a masked record whose template expression or inputs moved', () => {
    expect(
      find(row({ oldValue: '***', newValue: '***', maskedExpressionChanged: true }), record('***'))
        .refused
    ).toEqual([
      { logicalId: 'Cr', resourceType: 'Custom::Thing', kind: 'unjudgeable', recorded: 'masked' },
    ]);
  });

  it('diffMovedServiceToken counts only a change the diff computed from the template', () => {
    expect(diffMovedServiceToken(row({}))).toBe(true);
    expect(diffMovedServiceToken(row({ maskedExpressionChanged: true }))).toBe(true);
    expect(diffMovedServiceToken(row({ replacementPropagated: true }))).toBe(true);
    for (const flag of ['inPlacePropagated', 'noEchoPromoted'] as const) {
      expect(diffMovedServiceToken(row({ [flag]: true })), flag).toBe(false);
    }
    expect(diffMovedServiceToken(row({ path: 'Seed' }))).toBe(false);
  });

  it('defers a token reading a replaced resource, and warns about it', () => {
    const verdict = find(
      row({ replacementPropagated: true, newValue: { 'Fn::GetAtt': ['Fn', 'Arn'] } }),
      record(OLD)
    );
    expect(verdict.refused).toEqual([]);
    expect(verdict.deferred).toEqual([{ logicalId: 'Cr', resourceType: 'Custom::Thing' }]);
  });

  it('defers an intrinsic the preview could not resolve (a Lambda this deploy creates)', () => {
    const verdict = find(row({ newValue: { 'Fn::GetAtt': ['NewFn', 'Arn'] } }), record(OLD));
    expect(verdict).toEqual({
      refused: [],
      deferred: [{ logicalId: 'Cr', resourceType: 'Custom::Thing' }],
    });
  });

  it('warns, without refusing, about an in-place-propagated token (a nested output or another custom resource Data)', () => {
    expect(find(row({ inPlacePropagated: true, newValue: OLD }), record(OLD))).toEqual({
      refused: [],
      deferred: [{ logicalId: 'Cr', resourceType: 'Custom::Thing' }],
    });
  });

  it('neither refuses nor warns about a NoEcho promotion, which fires on every deploy', () => {
    expect(
      find(row({ inPlacePropagated: true, noEchoPromoted: true, newValue: '***' }), record(OLD))
    ).toEqual({ refused: [], deferred: [] });
  });

  it('never reads a SYNTHETIC change value as the verdict: the deploy resolves it', () => {
    for (const flag of ['inPlacePropagated', 'noEchoPromoted'] as const) {
      expect(find(row({ [flag]: true, newValue: NEW }), record(OLD)).refused, flag).toEqual([]);
    }
  });

  it('leaves a desired dynamic reference or mask to the deploy, which resolves it', () => {
    for (const desired of [REF, '***']) {
      expect(find(row({ newValue: desired }), record(OLD)), desired).toEqual({
        refused: [],
        deferred: [],
      });
    }
  });
});

describe('serviceTokenUpdateRefusal (provisioning time)', () => {
  const base = {
    logicalId: 'Cr',
    resourceType: 'Custom::Thing',
    recordedType: 'Custom::Thing',
    diffSawTokenChange: true,
  };

  it('refuses two different resolved tokens, and passes an equal pair', () => {
    expect(serviceTokenUpdateRefusal({ ...base, recorded: OLD, desired: NEW })?.kind).toBe(
      'changed'
    );
    expect(serviceTokenUpdateRefusal({ ...base, recorded: OLD, desired: OLD })).toBeUndefined();
  });

  it('refuses an unjudgeable record only when the diff saw the token move', () => {
    expect(serviceTokenUpdateRefusal({ ...base, recorded: '***', desired: NEW })?.kind).toBe(
      'unjudgeable'
    );
    expect(
      serviceTokenUpdateRefusal({ ...base, recorded: '***', desired: NEW, diffSawTokenChange: false })
    ).toBeUndefined();
  });

  it('leaves a desired side that is not a plain string to the provider', () => {
    expect(serviceTokenUpdateRefusal({ ...base, recorded: OLD, desired: undefined })).toBeUndefined();
  });

  it('ignores a non-custom type and a Type change', () => {
    expect(
      serviceTokenUpdateRefusal({
        ...base,
        resourceType: 'AWS::SNS::Topic',
        recordedType: 'AWS::SNS::Topic',
        recorded: OLD,
        desired: NEW,
      })
    ).toBeUndefined();
    expect(
      serviceTokenUpdateRefusal({ ...base, recordedType: 'Custom::Other', recorded: OLD, desired: NEW })
    ).toBeUndefined();
  });
});

describe('renderServiceTokenRefusal', () => {
  it('masks the printed tokens through the caller masker', () => {
    const message = renderServiceTokenRefusal(
      [{ logicalId: 'Cr', resourceType: 'Custom::Thing', kind: 'changed', desired: NEW }],
      'S',
      (text) => text.replace('new', 'MASKED')
    );
    expect(message).toContain('function:MASKED');
    expect(message).not.toContain(NEW);
    // The recorded token is never printed (a pre-v11 record may hold a NoEcho value).
    expect(message).not.toContain(OLD);
  });

  it('renders the plural headline and the unjudgeable remedy only when a row needs it', () => {
    const changed = {
      logicalId: 'A',
      resourceType: 'Custom::Thing',
      kind: 'changed' as const,
      desired: NEW,
    };
    const single = renderServiceTokenRefusal([changed], 'S');
    expect(single).toContain("Refusing to deploy S: a custom resource's ServiceToken changes,");
    expect(single).not.toContain('state.json');
    const both = renderServiceTokenRefusal(
      [
        changed,
        { logicalId: 'B', resourceType: 'Custom::Thing', kind: 'unjudgeable', recorded: 'reference' },
      ],
      'S'
    );
    expect(both).toContain("2 custom resources' ServiceTokens change");
    expect(both).toContain("B: its recorded ServiceToken is a '{{resolve:...}}' dynamic reference");
    expect(both).toContain('state.json');
  });
});
