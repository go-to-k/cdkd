/**
 * go-to-k/cdkd#7061 (group 4): pins for the diff-rendering readers the slice
 * routed through `recorded-secrecy.ts`, whose marker arms no other test
 * reached. Each case fails when its arm is dropped.
 */
import { describe, it, expect } from 'vite-plus/test';
import type { CrossStackPreview } from '../../../src/analyzer/cross-stack-preview.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { deletedRowRecordTainted } from '../../../src/cli/commands/diff-recursive/deleted-subtree-taint.js';
import {
  maskPassedSecretChanges,
  recordedValuesOf,
} from '../../../src/cli/commands/diff-recursive/passed-secret-display.js';
import { rowValueTrusted } from '../../../src/cli/commands/diff-recursive/trust.js';
import { logOnlyValuesOf } from '../../../src/deployment/secret-redaction/log-only.js';

const STACK_TYPE = 'AWS::CloudFormation::Stack';

describe('deletedRowRecordTainted: the mask is no tainted text (#7061)', () => {
  const record = (parameters: Record<string, unknown>): ResourceState =>
    ({ physicalId: 'arn:child', resourceType: STACK_TYPE, properties: { Parameters: parameters } }) as never;
  const preview = (texts: string[]): CrossStackPreview =>
    ({ taintedValues: () => new Set(texts) }) as unknown as CrossStackPreview;

  it('a recorded parameter holding the mask is not tainted by a mask in the preview', () => {
    expect(deletedRowRecordTainted(record({ P: '***' }), preview(['***']))).toBe(false);
  });

  it('a recorded parameter holding a tainted text is (control)', () => {
    expect(deletedRowRecordTainted(record({ P: 'tainted-7061' }), preview(['tainted-7061']))).toBe(true);
  });
});

describe('maskPassedSecretChanges: a key the record already shows as the mask is not re-masked (#7061)', () => {
  const template = {
    Resources: { Child: { Type: STACK_TYPE, Properties: { Parameters: { P: { Ref: 'Secret' }, Q: 'b' } } } },
  };
  const changesOf = (oldP: string, newP: string): Map<string, ResourceChange> =>
    new Map([
      [
        'Child',
        {
          logicalId: 'Child',
          resourceType: STACK_TYPE,
          changeType: 'UPDATE',
          propertyChanges: [{ path: 'Parameters', oldValue: { P: oldP, Q: 'a' }, newValue: { P: newP, Q: 'b' } }],
        } as never,
      ],
    ]);

  it('returns the changes themselves when every flagged side is already masked', () => {
    const changes = changesOf('***', '***');
    expect(maskPassedSecretChanges(changes, template as never, new Set(['Secret']))).toBe(changes);
  });

  it('masks a flagged key holding a value (control)', () => {
    const changes = changesOf('***', 'plain-7061');
    const shown = maskPassedSecretChanges(changes, template as never, new Set(['Secret']));
    expect(shown).not.toBe(changes);
    expect(shown.get('Child')!.propertyChanges![0]!.newValue).toEqual({ P: '***', Q: 'b' });
  });
});

describe('recordedValuesOf: the mask is no log-only needle (#7061)', () => {
  it('records the values of a tainted record but not its mask', () => {
    const needles = recordedValuesOf(
      { R: { physicalId: 'phys-7061-id', resourceType: 'AWS::X::Y', properties: {}, attributes: { A: '***', B: 'attr-7061-value' } } as never },
      new Set(['R'])
    );
    // Log-only needles live beside the map, not in it.
    expect([...(logOnlyValuesOf.get(needles) ?? [])].sort()).toEqual(['attr-7061-value', 'phys-7061-id']);
  });
});

describe('rowValueTrusted: a public ssm reference is resolved live, so never trusted (#7061)', () => {
  const state = { resources: {} } as unknown as StackState;
  const trust = { parameters: new Set<string>(), conditions: new Set<string>(), resources: new Set<string>() };

  it.each([
    ['a literal', '{{resolve:ssm:/public/flag}}'],
    ['an Fn::Sub', { 'Fn::Sub': 'x-{{resolve:ssm:/public/flag}}' }],
  ])('%s holding one is untrusted', (_what, value) => {
    expect(rowValueTrusted(value, state, undefined, trust as never)).toBe(false);
  });

  it('a plain literal is trusted (control)', () => {
    expect(rowValueTrusted('plain-7061', state, undefined, trust as never)).toBe(true);
  });
});
