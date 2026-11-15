import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const tmp = mkdtempSync(join(tmpdir(), 'cdkd-local-synth-'));
const nestedPath = join(tmp, 'nested.template.json');
writeFileSync(
  nestedPath,
  JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue' } } }),
  'utf-8'
);

const parent = {
  stackName: 'App',
  displayName: 'App',
  artifactId: 'App',
  template: {
    Resources: {
      InnerNS: {
        Type: 'AWS::CloudFormation::Stack',
        Properties: { TemplateURL: 'x' },
        Metadata: { 'aws:cdk:path': 'App/Inner.NestedStack/Inner.NestedStackResource' },
      },
    },
  },
  dependencyNames: [],
  nestedTemplates: { InnerNS: nestedPath },
} as unknown as StackInfo;

const failedLookups = [{ key: 'k' }];

vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: class {
    synthesize = async () => ({ stacks: [parent], failedLookups, assemblyDir: 'x' });
  },
}));

import { localCommandSynthesizer } from '../../../src/cli/commands/local-host-synthesizer.js';

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('localCommandSynthesizer', () => {
  it('lists CDK nested stacks and preserves the rest of the synthesis result', async () => {
    const result = (await localCommandSynthesizer().synthesize({ app: 'x' } as never)) as unknown as {
      stacks: StackInfo[];
      failedLookups: unknown;
      assemblyDir: string;
    };
    expect(result.stacks).toHaveLength(2);
    expect(result.stacks[0]!.stackName).toBe('App');
    expect(result.stacks[1]!.stackName).toBe('App~InnerNS');
    expect(result.failedLookups).toBe(failedLookups);
    expect(result.assemblyDir).toBe('x');
  });
});
