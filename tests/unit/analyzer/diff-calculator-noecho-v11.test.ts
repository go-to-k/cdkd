import { describe, it, expect, vi } from 'vite-plus/test';

// No DescribeType in a unit test: the lookup fails fast, as without the grant.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: vi.fn(() =>
        Promise.reject(
          Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          })
        )
      ),
    },
  }),
}));

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import { noEchoComparisonForTemplate } from '../../../src/deployment/deploy-engine/noecho.js';
import { PREVIOUS_NOECHO_VALUE } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#4043: the diff compares what the persist side writes for a
 * `NoEcho` parameter's value (`***`), and reads a pre-v11 record's plaintext
 * as the migration witness, so `cdkd diff --fail` of an unchanged migrated (or
 * not yet migrated) stack reports nothing.
 */
const TOKEN = 'diff-v11-token-value';

const template: CloudFormationTemplate = {
  Parameters: { Token: { Type: 'String', NoEcho: true, Default: TOKEN } },
  Resources: {
    P: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Name: '/p', Type: 'String', Value: { Ref: 'Token' } },
    },
  },
} as CloudFormationTemplate;

function state(record: Partial<ResourceState>): StackState {
  return {
    version: 11,
    stackName: 'S',
    resources: {
      P: {
        physicalId: '/p',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/p', Type: 'String', Value: '***' },
        ...record,
      } as ResourceState,
    },
    outputs: {},
    lastModified: 0,
  };
}

async function diff(current: StackState, token = TOKEN) {
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  const resolveFn = (value: unknown) =>
    resolver.resolve(value, {
      template,
      resources: current.resources,
      parameters: { Token: token },
      bestEffort: true,
    } as never);
  return new DiffCalculator().calculateDiff(
    current,
    template,
    resolveFn,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    noEchoComparisonForTemplate(template, {}, { Token: token }, current.resources)
  );
}

describe('DiffCalculator - NoEcho comparison (schema v11)', () => {
  it('reads a v11 record that holds the mask as NO_CHANGE', async () => {
    const changes = await diff(state({ noEchoLeaves: [['Value']] }));
    expect(changes.get('P')?.changeType).toBe('NO_CHANGE');
  });

  it('reads an unmarked record holding the SAME plaintext as NO_CHANGE (the witness)', async () => {
    const changes = await diff(
      state({ properties: { Name: '/p', Type: 'String', Value: TOKEN } })
    );
    expect(changes.get('P')?.changeType).toBe('NO_CHANGE');
  });

  it('reports a changed witness as an UPDATE that prints neither value', async () => {
    const changes = await diff(
      state({ properties: { Name: '/p', Type: 'String', Value: 'old-token-value' } })
    );
    const change = changes.get('P');
    expect(change?.changeType).toBe('UPDATE');
    expect(change?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', oldValue: PREVIOUS_NOECHO_VALUE, newValue: '***' }),
    ]);
    expect(JSON.stringify(change?.propertyChanges)).not.toContain(TOKEN);
    expect(JSON.stringify(change?.propertyChanges)).not.toContain('old-token-value');
  });

  it('never prints a pre-v11 list whose length changed (security review F1)', async () => {
    const { noEchoComparison } = await import('../../../src/deployment/secret-redaction.js');
    const compare = noEchoComparison({
      sources: { parameters: new Set(['L']) },
      values: { L: ['newv'] },
      minNeedleLength: 4,
    });
    const out = compare({
      templateProperties: { V: { Ref: 'L' } },
      desired: { V: ['newv'] },
      current: { V: ['oldsecret1', 'oldsecret2'] },
      record: {},
    });
    expect(JSON.stringify(out)).not.toContain('oldsecret');
    expect(out?.current).toEqual({ V: PREVIOUS_NOECHO_VALUE });
  });

  it('takes the witness over a leaf mixing a NoEcho Ref with a secret reference, and detects a changed NoEcho part (review MEDIUM-4)', async () => {
    const { noEchoComparison } = await import('../../../src/deployment/secret-redaction.js');
    const SM = '{{resolve:secretsmanager:app/db:SecretString:pw}}';
    const compare = noEchoComparison({
      sources: { parameters: new Set(['Token']) },
      values: { Token: TOKEN },
      minNeedleLength: 4,
    });
    const templateProperties = { V: { 'Fn::Join': ['', [{ Ref: 'Token' }, '-', SM]] } };
    // The diff resolves with secret references left as written.
    const desired = { V: `${TOKEN}-${SM}` };
    expect(
      compare({ templateProperties, desired, current: { V: `${TOKEN}-${SM}` }, record: {} })
    ).toEqual({ desired: { V: '***' }, current: { V: '***' } });
    const changed = compare({
      templateProperties,
      desired,
      current: { V: `old-token-value-x-${SM}` },
      record: {},
    });
    expect(changed?.current).toEqual({ V: PREVIOUS_NOECHO_VALUE });
  });

  it('without the comparison, a v11 record diffs against the plaintext (the defect it closes)', async () => {
    const current = state({ noEchoLeaves: [['Value']] });
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const changes = await new DiffCalculator().calculateDiff(current, template, (value: unknown) =>
      resolver.resolve(value, {
        template,
        resources: current.resources,
        parameters: { Token: TOKEN },
        bestEffort: true,
      } as never)
    );
    expect(changes.get('P')?.changeType).toBe('UPDATE');
  });
});
