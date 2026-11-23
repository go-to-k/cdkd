/**
 * go-to-k/cdkd#6893 (forced parallel change): a nested `AWS::CloudFormation::Stack`
 * row carrying `Tags` was refused pre-flight, because `Tags` was listed
 * SDK-unwired (`CFn-only`) and the type has no Cloud Control route. CDK synth
 * puts a stack's `StackProps.tags` (and `Tags.of(...)`) on every NestedStack
 * row, so any such app failed to deploy. Since #6871 the provider consumes
 * the row's `Tags` (the child's stack tags), so it is now HANDLED: routed to
 * the SDK provider, recorded in the row's state, and an existing record
 * without it is an in-place UPDATE, never a replacement.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

// DescribeType fails fast, so the diff reads the committed create-only snapshot.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: () =>
        Promise.reject(
          Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          })
        ),
    },
  }),
}));

import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../src/provisioning/register-providers.js';
import {
  findSdkUnwiredProperties,
  withoutSdkUnwiredProperties,
} from '../../../src/provisioning/property-coverage.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const ROW = 'AWS::CloudFormation::Stack';
// The CDK-synth shape of a parent's `StackProps.tags: { team: 'core', env: 'prod' }`:
// CDK writes them onto the NestedStack's row as a sorted Key/Value list.
const SYNTH_TAGS = [
  { Key: 'env', Value: 'prod' },
  { Key: 'team', Value: 'core' },
];
const providerClasses = await loadProviderClasses();

describe('a nested-stack row with Tags (go-to-k/cdkd#6893)', () => {
  it('routes to the nested-stack provider instead of refusing pre-flight', () => {
    const registry = new ProviderRegistry();
    registerAllProviders(registry, providerClasses);
    const decision = registry.getProviderFor({
      resourceType: ROW,
      properties: { TemplateURL: 'https://bucket/child.json', Tags: SYNTH_TAGS },
    });
    expect(decision.provisionedBy).toBe('sdk');
    expect(decision.provider.constructor.name).toBe('NestedStackProvider');
    expect(findSdkUnwiredProperties(ROW, { Tags: SYNTH_TAGS })).toEqual([]);
  });

  it("keeps Tags in the row's state record", () => {
    const properties = { TemplateURL: 'u', Tags: SYNTH_TAGS };
    expect(withoutSdkUnwiredProperties(ROW, properties)).toBe(properties);
  });

  it('diffs an existing record without Tags as an in-place UPDATE, not a replacement', async () => {
    const state: StackState = {
      version: 1,
      stackName: 'Parent',
      resources: {
        Child: {
          physicalId: 'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
          resourceType: ROW,
          properties: { TemplateURL: 'u' },
          attributes: {},
        },
      },
      outputs: {},
      lastModified: 0,
    };
    const template: CloudFormationTemplate = {
      Resources: { Child: { Type: ROW, Properties: { TemplateURL: 'u', Tags: SYNTH_TAGS } } },
    };
    const change = (await new DiffCalculator().calculateDiff(state, template)).get('Child');
    expect(change?.changeType).toBe('UPDATE');
    expect(change?.propertyChanges?.map((c) => c.path)).toEqual(['Tags']);
    expect(change?.propertyChanges?.some((c) => c.requiresReplacement)).toBe(false);
  });
});
