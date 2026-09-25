import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #3769, end to end through the REAL wiring both commands use:
// DiffCalculator -> makeCreateOnlyEquivalenceFn -> a registry holding the real
// Glue providers. Only the DescribeType-backed createOnly lookup is stubbed;
// the Glue hook is pure, so no AWS client is ever called.
const mockGetCreateOnly = vi.fn();
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return {
    ...actual,
    getCreateOnlyPropertyPaths: (resourceType: string) => mockGetCreateOnly(resourceType),
  };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { makeCreateOnlyEquivalenceFn } from '../../../src/provisioning/canonicalize-properties.js';
import {
  GlueConnectionProvider,
  GlueProvider,
} from '../../../src/provisioning/providers/glue-provider.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const providers: Record<string, ResourceProvider> = {
  'AWS::Glue::Table': new GlueProvider(),
  'AWS::Glue::Connection': new GlueConnectionProvider(),
};
const equivalence = makeCreateOnlyEquivalenceFn({
  hasProvider: (type) => type in providers,
  getProvider: (type) => providers[type]!,
});
const ACCOUNT = '111111111111';
const resolveFn = async (value: unknown) =>
  JSON.stringify(value) === JSON.stringify({ Ref: 'AWS::AccountId' }) ? ACCOUNT : value;

const state = (type: string, properties: Record<string, unknown>): StackState => ({
  version: 1,
  stackName: 'S',
  resources: { R: { physicalId: 'p', resourceType: type, properties, attributes: {} } },
  outputs: {},
  lastModified: 0,
});
const template = (type: string, properties: Record<string, unknown>): CloudFormationTemplate => ({
  Resources: { R: { Type: type, Properties: properties } },
});

async function catalogChange(
  type: string,
  recorded: Record<string, unknown>,
  desired: Record<string, unknown>
) {
  const changes = await new DiffCalculator().calculateDiff(
    state(type, recorded),
    template(type, desired),
    resolveFn,
    undefined,
    undefined,
    undefined,
    equivalence
  );
  return changes.get('R')?.propertyChanges?.find((c) => c.path === 'CatalogId');
}

describe('Glue CatalogId spelling change through the diff (issue #3769)', () => {
  beforeEach(() => {
    mockGetCreateOnly.mockReset();
    mockGetCreateOnly.mockResolvedValue([['CatalogId'], ['DatabaseName']]);
  });

  it.each(['AWS::Glue::Table', 'AWS::Glue::Connection'])(
    '%s: absent -> own account id is an in-place update, not a replacement',
    async (type) => {
      const pc = await catalogChange(type, { DatabaseName: 'db' }, { DatabaseName: 'db', CatalogId: ACCOUNT });
      expect(pc).toBeDefined();
      expect(pc?.requiresReplacement).toBe(false);
    }
  );

  it.each(['AWS::Glue::Table', 'AWS::Glue::Connection'])(
    '%s: absent -> ANOTHER account is still a replacement',
    async (type) => {
      const pc = await catalogChange(
        type,
        { DatabaseName: 'db' },
        { DatabaseName: 'db', CatalogId: '222222222222' }
      );
      expect(pc?.requiresReplacement).toBe(true);
    }
  );

  it('own account id -> absent is an in-place update too', async () => {
    const pc = await catalogChange(
      'AWS::Glue::Table',
      { DatabaseName: 'db', CatalogId: ACCOUNT },
      { DatabaseName: 'db' }
    );
    expect(pc?.requiresReplacement).toBe(false);
  });
});
