import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { withNestedStacks } from '../../../src/local/custom-resource-nested-stacks.js';

/**
 * go-to-k/cdkd#6261: the nested stacks of the assembly, named as cdkd deploys
 * them, for the `--aws-emulator` custom-resource runtime.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cdkd-cr-nested-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const nestedRow = (assetPath: string) => ({
  Type: 'AWS::CloudFormation::Stack',
  Properties: { TemplateURL: 'https://example.invalid/x.json' },
  Metadata: { 'aws:asset:path': assetPath },
});

function writeTemplate(name: string, resources: Record<string, unknown>): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ Resources: resources }));
  return file;
}

function top(nestedTemplates: Record<string, string> | undefined): StackInfo {
  return {
    stackName: 'App',
    displayName: 'Stage/App',
    artifactId: 'App',
    region: 'eu-west-1',
    assetManifestPath: join(dir, 'App.assets.json'),
    assetOutdir: dir,
    template: { Resources: {} },
    ...(nestedTemplates && { nestedTemplates }),
  } as unknown as StackInfo;
}

describe('withNestedStacks', () => {
  it('adds each nested stack, recursively, as `<parent>~<logicalId>` with its own template', () => {
    writeTemplate('Inner.nested.template.json', { Leaf: { Type: 'AWS::SNS::Topic' } });
    const child = writeTemplate('Child.nested.template.json', {
      Inner: nestedRow('Inner.nested.template.json'),
      Fn: { Type: 'AWS::Lambda::Function' },
    });
    const stacks = [top({ Child: child })];

    const all = withNestedStacks(stacks);

    expect(all.map((s) => s.stackName)).toEqual(['App', 'App~Child', 'App~Child~Inner']);
    expect(all.map((s) => s.displayName)).toEqual([
      'Stage/App',
      'Stage/App/Child',
      'Stage/App/Child/Inner',
    ]);
    expect(Object.keys(all[1]!.template.Resources!)).toEqual(['Inner', 'Fn']);
    expect(Object.keys(all[2]!.template.Resources!)).toEqual(['Leaf']);
    // The assets of a nested stack are the top-level stack's.
    for (const s of all.slice(1)) {
      expect(s.assetManifestPath).toBe(stacks[0]!.assetManifestPath);
      expect(s.assetOutdir).toBe(dir);
      expect(s.region).toBe('eu-west-1');
    }
  });

  it('reads the assembly once', () => {
    const stacks = [top({ Child: writeTemplate('Child.nested.template.json', {}) })];
    expect(withNestedStacks(stacks)).toBe(withNestedStacks(stacks));
  });

  it('returns the stacks as they are without nested stacks', () => {
    const stacks = [top(undefined)];
    expect(withNestedStacks(stacks)).toEqual(stacks);
  });

  it('skips an unreadable template, an escaping or absolute path, and a cycle', () => {
    mkdirSync(join(dir, 'sub'));
    const loop = join(dir, 'sub', 'Loop.nested.template.json');
    writeFileSync(
      loop,
      JSON.stringify({
        Resources: {
          Again: nestedRow('Loop.nested.template.json'),
          Out: nestedRow('../../etc/passwd'),
          Abs: nestedRow('/etc/passwd'),
        },
      })
    );
    const stacks = [top({ Loop: loop, Missing: join(dir, 'missing.json') })];

    expect(withNestedStacks(stacks).map((s) => s.stackName)).toEqual(['App', 'App~Loop']);
  });
});
