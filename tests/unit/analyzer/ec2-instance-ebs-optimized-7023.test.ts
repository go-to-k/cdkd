import { describe, it, expect, vi } from 'vite-plus/test';

// go-to-k/cdkd#7023: an AWS::EC2::Instance EbsOptimized change is an in-place
// update (CloudFormation stops and starts the instance, measured us-east-1),
// never a replacement, which would terminate the instance and its root volume.

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/provisioning/create-only-properties.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    ...actual,
    getCreateOnlyPropertyPaths: async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? [],
  };
});

vi.mock('../../../src/provisioning/write-only-properties.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, tryGetTopLevelWriteOnlyProperties: async () => new Set<string>() };
});

import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const TYPE = 'AWS::EC2::Instance';

describe('AWS::EC2::Instance EbsOptimized is updated in place (go-to-k/cdkd#7023)', () => {
  it.each([
    [undefined, true],
    [false, true],
    [true, false],
    [true, undefined],
  ])('the registry does not replace for %s -> %s', (before, after) => {
    const registry = new ReplacementRulesRegistry();
    expect(registry.requiresReplacement(TYPE, 'EbsOptimized', before, after)).toBe(false);
    expect(registry.isClassified(TYPE, 'EbsOptimized')).toBe(true);
  });

  it('the diff shows an update, not a replacement', async () => {
    const base = { ImageId: 'ami-1', InstanceType: 't3.micro', SubnetId: 'subnet-1' };
    const state = {
      version: 3,
      region: 'us-east-1',
      stackName: 's',
      resources: {
        Inst: { physicalId: 'i-1', resourceType: TYPE, properties: base, attributes: {}, dependencies: [] },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const template = {
      Resources: { Inst: { Type: TYPE, Properties: { ...base, EbsOptimized: true } } },
    } as CloudFormationTemplate;
    const change = (await new DiffCalculator().calculateDiff(state, template)).get('Inst');
    expect(change?.changeType).toBe('UPDATE');
    const prop = change?.propertyChanges?.find((p) => p.path === 'EbsOptimized');
    expect(prop?.requiresReplacement).toBe(false);
  });
});
