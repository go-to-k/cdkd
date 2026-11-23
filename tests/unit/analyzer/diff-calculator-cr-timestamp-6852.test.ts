/**
 * go-to-k/cdkd#6853 (found by the #6852 audit): the diff ignored a custom
 * resource's top-level `Timestamp` as non-deterministic, so a template writing
 * a fresh one to re-run the handler (`Timestamp: Date.now().toString()`) got
 * NO_CHANGE from `cdkd diff` and no Update from `cdkd deploy`. CloudFormation
 * sends an Update for that change, so the property is compared like any other.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  // No DescribeType call: no property here is create-only.
  return { ...actual, getCreateOnlyPropertyPaths: async () => [] };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const changes = async (
  type: string,
  current: Record<string, unknown>,
  desired: Record<string, unknown>
) => await new DiffCalculator().compareProperties(type, current, desired);

describe('a custom resource `Timestamp` is compared (#6853)', () => {
  it.each(['Custom::Thing', 'AWS::CloudFormation::CustomResource'])(
    'a changed Timestamp alone is a change on %s, in place',
    async (type) => {
      const out = await changes(
        type,
        { ServiceToken: 'arn:t', Timestamp: '1' },
        { ServiceToken: 'arn:t', Timestamp: '2' }
      );
      expect(out.map((c) => [c.path, c.requiresReplacement])).toEqual([['Timestamp', false]]);
    }
  );

  it('an unchanged Timestamp is no change', async () => {
    expect(await changes('Custom::Thing', { Timestamp: '1' }, { Timestamp: '1' })).toEqual([]);
  });

  it('a Timestamp added or removed is a change', async () => {
    expect((await changes('Custom::Thing', {}, { Timestamp: '1' })).map((c) => c.path)).toEqual([
      'Timestamp',
    ]);
    expect((await changes('Custom::Thing', { Timestamp: '1' }, {})).map((c) => c.path)).toEqual([
      'Timestamp',
    ]);
  });

  it('classifies the resource UPDATE through calculateDiff', async () => {
    const state: StackState = {
      version: 1,
      stackName: 'S',
      resources: {
        Cr: {
          physicalId: 'cr-1',
          resourceType: 'Custom::Thing',
          properties: { ServiceToken: 'arn:t', Timestamp: '1' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
    const template: CloudFormationTemplate = {
      Resources: {
        Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: 'arn:t', Timestamp: '2' } },
      },
    };
    const diff = await new DiffCalculator().calculateDiff(state, template);
    expect(diff.get('Cr')?.changeType).toBe('UPDATE');
  });
});
