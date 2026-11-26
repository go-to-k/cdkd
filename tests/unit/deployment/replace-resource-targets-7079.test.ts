/**
 * go-to-k/cdkd#7079: the pure halves of `--replace-resource` — the plan-time
 * marking, the run-level checks, the per-stack scoping and the union of the
 * diff's forced replacements.
 */
import { describe, it, expect } from 'vite-plus/test';
import { planReplaceResourceTargets } from '../../../src/deployment/replace-resource-targets.js';
import {
  checkReplaceResourceOptions,
  replaceResourcesForStack,
} from '../../../src/cli/commands/deploy/replace-resource-checks.js';
import { forcedReplacementIds } from '../../../src/deployment/deploy-engine/deploy-flow/diff.js';
import {
  notUpdatableRemedy,
  replacementRuleIssueUrl,
} from '../../../src/deployment/deploy-engine/update-in-place/update-failure-remedy.js';
import type { ResourceChange } from '../../../src/types/state.js';

const update = (
  propertyChanges: NonNullable<ResourceChange['propertyChanges']>,
  extra: Partial<ResourceChange> = {}
): ResourceChange =>
  ({
    logicalId: 'T',
    changeType: 'UPDATE',
    resourceType: 'AWS::SNS::Topic',
    propertyChanges,
    ...extra,
  }) as ResourceChange;

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: unknown }).code;
  }
  return undefined;
};

describe('planReplaceResourceTargets', () => {
  it('forces every change to a replacement and drops the speculative marks', () => {
    const changes = new Map([
      [
        'T',
        update([
          { path: 'DisplayName', oldValue: 'a', newValue: 'b', requiresReplacement: false },
          {
            path: 'KmsMasterKeyId',
            oldValue: 'k1',
            newValue: { Ref: 'Key' },
            requiresReplacement: false,
            replacementPropagated: true,
          },
        ]),
      ],
    ]);
    expect(planReplaceResourceTargets(changes, new Set(['T'])).replaced).toEqual(['T']);
    for (const pc of changes.get('T')!.propertyChanges!) {
      expect(pc.requiresReplacement).toBe(true);
      expect(pc.replacementPropagated).toBeUndefined();
      expect(pc.inPlacePropagated).toBeUndefined();
    }
  });

  it("drops the row's provider-replacement mark", () => {
    const changes = new Map([
      [
        'T',
        update([{ path: 'A', oldValue: 1, newValue: 2, requiresReplacement: false }], {
          providerReplacement: 'reason',
        } as Partial<ResourceChange>),
      ],
    ]);
    planReplaceResourceTargets(changes, new Set(['T']));
    expect(changes.get('T')!.providerReplacement).toBeUndefined();
  });

  it('refuses an UPDATE with no property change', () => {
    const changes = new Map([['T', update([])]]);
    expect(codeOf(() => planReplaceResourceTargets(changes, new Set(['T'])))).toBe(
      'REPLACE_RESOURCE_REFUSED'
    );
  });

  it('refuses an UPDATE whose only changes are speculative', () => {
    const changes = new Map([
      [
        'T',
        update([
          { path: 'A', oldValue: 1, newValue: 2, requiresReplacement: false, inPlacePropagated: true },
        ]),
      ],
    ]);
    expect(codeOf(() => planReplaceResourceTargets(changes, new Set(['T'])))).toBe(
      'REPLACE_RESOURCE_REFUSED'
    );
  });

  it('refuses a row a NoEcho value feeds', () => {
    const changes = new Map([
      [
        'T',
        update([
          { path: 'A', oldValue: 1, newValue: 2, requiresReplacement: false },
          {
            path: 'B',
            oldValue: '***',
            newValue: '***',
            requiresReplacement: false,
            inPlacePropagated: true,
            noEchoPromoted: true,
          },
        ]),
      ],
    ]);
    expect(codeOf(() => planReplaceResourceTargets(changes, new Set(['T'])))).toBe(
      'REPLACE_RESOURCE_REFUSED'
    );
    expect(changes.get('T')!.propertyChanges![0]!.requiresReplacement).toBe(false);
  });

  it('returns CREATE, DELETE and absent targets unchanged', () => {
    const changes = new Map<string, ResourceChange>([
      ['C', { logicalId: 'C', changeType: 'CREATE', resourceType: 'X' } as ResourceChange],
      ['D', { logicalId: 'D', changeType: 'DELETE', resourceType: 'X' } as ResourceChange],
    ]);
    expect(planReplaceResourceTargets(changes, new Set(['C', 'D', 'M'])).unreplaced).toEqual([
      { logicalId: 'C', changeType: 'CREATE' },
      { logicalId: 'D', changeType: 'DELETE' },
      { logicalId: 'M', changeType: undefined },
    ]);
  });
});

describe('checkReplaceResourceOptions', () => {
  const stacks = [
    { stackName: 'Dev', template: { Resources: { Topic: {}, Queue: {} } } },
    { stackName: 'Prod', template: { Resources: { Topic: {} } } },
  ];

  it('passes an id exactly one stack declares', () => {
    expect(() => checkReplaceResourceOptions({ replaceResource: ['Queue'] }, stacks)).not.toThrow();
  });

  it('refuses an id no stack declares, or two stacks declare, naming them', () => {
    let message = '';
    try {
      checkReplaceResourceOptions({ replaceResource: ['Typo', 'Topic'] }, stacks);
    } catch (e) {
      message = (e as Error).message;
      expect((e as { code?: unknown }).code).toBe('REPLACE_RESOURCE_INVALID');
    }
    expect(message).toContain('Typo: no stack of this deploy declares it');
    expect(message).toContain('Topic: declared by Dev, Prod');
  });

  it('refuses an id --recreate-via-* also names', () => {
    expect(
      codeOf(() =>
        checkReplaceResourceOptions(
          { replaceResource: ['Queue'], recreateViaCcApi: ['Queue'] },
          stacks
        )
      )
    ).toBe('REPLACE_RESOURCE_INVALID');
  });

  it('does nothing without the flag', () => {
    expect(() => checkReplaceResourceOptions({}, stacks)).not.toThrow();
  });
});

describe('replaceResourcesForStack', () => {
  it("keeps only the ids the stack's template declares, scoped to it", () => {
    expect(
      replaceResourcesForStack(['Topic', 'Queue'], 'Prod', { Resources: { Topic: {} } })
    ).toEqual({ stackName: 'Prod', logicalIds: new Set(['Topic']) });
    expect(replaceResourcesForStack(['Queue'], 'Prod', { Resources: { Topic: {} } })).toBeUndefined();
    expect(replaceResourcesForStack(undefined, 'Prod', { Resources: { Topic: {} } })).toBeUndefined();
  });
});

describe('forcedReplacementIds', () => {
  it('unions the recreate and replace targets', () => {
    expect(forcedReplacementIds(new Set(['A']), new Set(['B']))).toEqual(new Set(['A', 'B']));
    expect(forcedReplacementIds(new Set(['A']), undefined)).toEqual(new Set(['A']));
    expect(forcedReplacementIds(undefined, new Set(['B']))).toEqual(new Set(['B']));
    expect(forcedReplacementIds(undefined, undefined)).toBeUndefined();
  });
});

describe('replacementRuleIssueUrl', () => {
  it('carries an AWS type and its property', () => {
    const params = new URL(replacementRuleIssueUrl('AWS::EC2::Volume', ['Iops'])!).searchParams;
    expect(params.get('title')).toBe('Replacement rule: AWS::EC2::Volume Iops');
  });

  it('gives no link for a non-AWS registry type: it never reaches a public issue', () => {
    expect(replacementRuleIssueUrl('MyOrg::Billing::Ledger', ['InternalAccountCode'])).toBeUndefined();
  });

  it('drops the report line from the remedy for a non-AWS type', () => {
    const text = notUpdatableRemedy({
      logicalId: 'L',
      resourceType: 'MyOrg::Billing::Ledger',
      stackName: 'S',
      changedProperties: new Set(['InternalAccountCode']),
      record: { physicalId: 'p', resourceType: 'MyOrg::Billing::Ledger', properties: {} } as never,
      updateReplacePolicy: undefined,
      nestedChild: false,
    });
    expect(text).toContain('--replace-resource L');
    expect(text).not.toContain('github.com');
  });

  it('treats Alexa:: as an AWS namespace', () => {
    expect(replacementRuleIssueUrl('Alexa::ASK::Skill', ['X'])).toContain('Alexa');
  });
});
