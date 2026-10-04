import { describe, it, expect, vi } from 'vite-plus/test';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { maskedPropertyFingerprint } from '../../../src/deployment/masked-property-fingerprints.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#4451: the diff reports a property the record holds as `***`
 * whose UNRESOLVED template value moved, although both sides compare as the
 * mask; a record without the fingerprint diffs as before.
 */
// The CFn registry schema DescribeType would return for each test type.
const CREATE_ONLY: Record<string, string[]> = {
  'AWS::Test::CreateOnlyScript': ['/properties/Script'],
  'AWS::Test::NestedCreateOnly': ['/properties/Script/Inner'],
};
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: vi.fn((command: { input?: { TypeName?: string } }) =>
        Promise.resolve({
          Schema: JSON.stringify({
            createOnlyProperties: CREATE_ONLY[command.input?.TypeName ?? ''] ?? [],
          }),
        })
      ),
    },
  }),
}));

const SCRIPT = { 'Fn::Base64': { 'Fn::Join': ['', ['pw=', '{{resolve:ssm-secure:/app/pw}}']] } };
const EDITED = { 'Fn::Base64': { 'Fn::Join': ['', ['echo B\npw=', '{{resolve:ssm-secure:/app/pw}}']] } };
// What the deploy's diff resolver answers for a Base64 over a secret (#2909).
const resolveFn = (value: unknown): Promise<unknown> =>
  Promise.resolve(
    value !== null && typeof value === 'object' && 'Fn::Base64' in value ? '***' : value
  );

async function diffOf(
  type: string,
  templateScript: unknown,
  fingerprinted: boolean
): Promise<ReturnType<DiffCalculator['calculateDiff']> extends Promise<infer M> ? M : never> {
  const record: ResourceState = {
    physicalId: 'p',
    resourceType: type,
    properties: { Name: 'n', Script: '***' },
    ...(fingerprinted && {
      maskedPropertyFingerprints: { Script: maskedPropertyFingerprint(SCRIPT) },
    }),
  };
  const state: StackState = {
    version: 10,
    stackName: 's',
    region: 'us-east-1',
    resources: { R: record },
    outputs: {},
    lastModified: 0,
  };
  const template: CloudFormationTemplate = {
    Resources: { R: { Type: type, Properties: { Name: 'n', Script: templateScript } } },
  };
  return new DiffCalculator().calculateDiff(state, template, resolveFn);
}

describe('DiffCalculator - a masked property whose template expression moved (go-to-k/cdkd#4451)', () => {
  it('reports an in-place UPDATE for an updatable property', async () => {
    const change = (await diffOf('AWS::Test::Plain', EDITED, true)).get('R')!;
    expect(change.changeType).toBe('UPDATE');
    expect(change.propertyChanges).toEqual([
      { path: 'Script', oldValue: '***', newValue: '***', requiresReplacement: false },
    ]);
  });

  it('reports NO_CHANGE for the unchanged expression', async () => {
    expect((await diffOf('AWS::Test::Plain', SCRIPT, true)).get('R')!.changeType).toBe(
      'NO_CHANGE'
    );
  });

  it('reports NO_CHANGE for a record without the field, as before', async () => {
    expect((await diffOf('AWS::Test::Plain', EDITED, false)).get('R')!.changeType).toBe(
      'NO_CHANGE'
    );
  });

  it('replaces when the property itself is create-only', async () => {
    const change = (await diffOf('AWS::Test::CreateOnlyScript', EDITED, true)).get('R')!;
    expect(change.propertyChanges?.[0]?.requiresReplacement).toBe(true);
  });

  it('does not guess a replacement from a create-only path NESTED under it', async () => {
    const change = (await diffOf('AWS::Test::NestedCreateOnly', EDITED, true)).get('R')!;
    expect(change.changeType).toBe('UPDATE');
    expect(change.propertyChanges?.[0]?.requiresReplacement).toBe(false);
  });
});
