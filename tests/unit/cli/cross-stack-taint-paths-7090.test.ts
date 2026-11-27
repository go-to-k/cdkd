/**
 * go-to-k/cdkd#7090: the invariant behind the cross-stack provenance mask.
 *
 * A producer's value reaches a consumer's diff through the run's
 * `CrossStackPreview` (its two readers, `Fn::ImportValue` and
 * `Fn::GetStackOutput`) or through state, and the preview is where the
 * producer marks which outputs derive from a secret. The first block
 * enumerates every writer and reader of the preview in `src/`, so a new path
 * (a third reader, a second writer, a writer that drops the taint predicate)
 * fails here until it is routed through the taint. The rest is generated over
 * the read shapes a consumer can spell, and the output shapes a producer can
 * read a secret-fed name through.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { CrossStackPreview, markProducerTaint } from '../../../src/analyzer/cross-stack-preview.js';
import {
  crossStackTaintSeedsOf,
  producerReadsSecretFedName,
} from '../../../src/cli/commands/diff-recursive/cross-stack-taint.js';
import { taintedNamesOf } from '../../../src/cli/commands/diff-recursive/passed-secret-display.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const ROOT = join(__dirname, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** Each `src/` file, relative, whose code (comment lines dropped) matches `pattern`. */
function filesMatching(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    if (pattern.test(code)) hits.push(relative(ROOT, file));
  }
  return hits.sort();
}

describe('every producer-to-consumer preview path (#7090)', () => {
  it('has a known set of src files', () => {
    expect(sourceFiles(join(ROOT, 'src')).length).toBeGreaterThan(100);
  });

  it('reads a previewed value only in the two cross-stack resolvers', () => {
    expect(filesMatching(/\.(exportValue|stackOutput)\(/)).toEqual([
      'src/analyzer/cross-stack-preview.ts',
      'src/deployment/intrinsic-resolver/cross-stack/import-value.ts',
      'src/deployment/intrinsic-resolver/stack-output.ts',
    ]);
  });

  it('writes the preview only through recordProducerPreview / markProducerTaint', () => {
    expect(filesMatching(/\bpreview\.record\(|\.markTainted\(/)).toEqual([
      'src/analyzer/cross-stack-preview.ts',
    ]);
    expect(filesMatching(/\b(recordProducerPreview|markProducerTaint)\(/)).toEqual([
      'src/analyzer/cross-stack-preview.ts',
      'src/cli/commands/diff-recursive/compute-stack-diff.ts',
    ]);
    // Its one caller hands the node's secret-fed names to both writers.
    const caller = readFileSync(
      join(ROOT, 'src/cli/commands/diff-recursive/compute-stack-diff.ts'),
      'utf8'
    );
    expect(caller).toContain('readsSecretFedName: readsSecretFed');
    expect(caller).toContain('producerReadsSecretFedName(secretFedNames)');
    expect(caller.match(/\b(recordProducerPreview|markProducerTaint)\(crossStackPreview/g)).toHaveLength(2);
  });

  it('builds a preview only in `cdkd diff`, and every node seeds its taint from it', () => {
    expect(filesMatching(/new CrossStackPreview\(/)).toEqual(['src/cli/commands/diff.ts']);
    const tree = readFileSync(join(ROOT, 'src/cli/commands/diff-recursive/build-tree.ts'), 'utf8');
    expect(tree).toContain('crossStackTaintSeedsOf(template, region, crossStackPreview)');
    expect(tree).toContain('crossStackPreview?.taintedValues()');
    expect(tree).toContain('secretFedNames: passedSecretNames');
  });
});

const REGION = 'us-east-1';

function previewWith(
  mark: (preview: CrossStackPreview) => void = (preview) =>
    preview.markTainted(REGION, 'Prod', 'Out', 'piece-export', ['Q7'])
): CrossStackPreview {
  const preview = new CrossStackPreview();
  mark(preview);
  return preview;
}

function consumer(value: unknown): CloudFormationTemplate {
  return {
    Resources: {
      Reader: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: value } },
      Echo: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Reader', 'Value'] } },
      },
      Unrelated: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'x' } },
    },
  } as CloudFormationTemplate;
}

const IMPORT = { 'Fn::ImportValue': 'piece-export' };
const OUTPUT = { 'Fn::GetStackOutput': { StackName: 'Prod', OutputName: 'Out' } };

/** Every place a consumer can spell a read of the tainted output. */
const TAINTED_READS: Record<string, unknown> = {
  import: IMPORT,
  stackOutput: OUTPUT,
  stackOutputSameRegion: { 'Fn::GetStackOutput': { StackName: 'Prod', OutputName: 'Out', Region: REGION } },
  join: { 'Fn::Join': ['', ['a', IMPORT]] },
  sub: { 'Fn::Sub': ['${V}-x', { V: IMPORT }] },
  select: { 'Fn::Select': [0, { 'Fn::Split': ['/', IMPORT] }] },
  ifBranch: { 'Fn::If': ['C', 'plain', OUTPUT] },
  base64: { 'Fn::Base64': IMPORT },
  list: [IMPORT],
  computedName: { 'Fn::ImportValue': { 'Fn::Join': ['-', ['piece', 'export']] } },
  computedStack: { 'Fn::GetStackOutput': { StackName: { Ref: 'S' }, OutputName: 'Out' } },
};

/** Reads that must stay clean: other exports and outputs. */
const CLEAN_READS: Record<string, unknown> = {
  otherExport: { 'Fn::ImportValue': 'other-export' },
  otherOutput: { 'Fn::GetStackOutput': { StackName: 'Prod', OutputName: 'Other' } },
  otherStack: { 'Fn::GetStackOutput': { StackName: 'Elsewhere', OutputName: 'Out' } },
  literal: 'piece-export',
};

describe('a consumer seeds its taint from every read shape (#7090)', () => {
  for (const [label, value] of Object.entries(TAINTED_READS)) {
    it(`taints a resource reading ${label}, and its readers`, () => {
      const template = consumer(value);
      const tainted = taintedNamesOf(template, crossStackTaintSeedsOf(template, REGION, previewWith()));
      expect(tainted.has('Reader')).toBe(true);
      expect(tainted.has('Echo')).toBe(true);
      expect(tainted.has('Unrelated')).toBe(false);
    });
  }
  for (const [label, value] of Object.entries(CLEAN_READS)) {
    it(`leaves ${label} clean`, () => {
      const template = consumer(value);
      expect(crossStackTaintSeedsOf(template, REGION, previewWith()).size).toBe(0);
    });
  }
  it('seeds nothing from a run with no tainted output, a computed name included', () => {
    const template = consumer(TAINTED_READS['computedName']);
    expect(crossStackTaintSeedsOf(template, REGION, previewWith(() => undefined)).size).toBe(0);
    expect(crossStackTaintSeedsOf(template, REGION, undefined).size).toBe(0);
  });
  it('taints every export when a tainted output exports under an unresolved name', () => {
    const preview = previewWith((p) => p.markTainted(REGION, 'Prod', 'Out', null, []));
    const template = consumer(CLEAN_READS['otherExport']);
    expect(crossStackTaintSeedsOf(template, REGION, preview).size).toBe(1);
  });
});

/** Producer output shapes reading the secret-fed row `Row`. */
const TAINTED_OUTPUTS: Record<string, unknown> = {
  getAtt: { 'Fn::GetAtt': ['Row', 'Outputs.Piece'] },
  getAttString: { 'Fn::GetAtt': 'Row.Outputs.Piece' },
  ref: { Ref: 'Row' },
  sub: { 'Fn::Sub': '${Row.Outputs.Piece}-x' },
  join: { 'Fn::Join': ['', ['a', { 'Fn::GetAtt': ['Row', 'Outputs.Piece'] }]] },
  ifBranch: { 'Fn::If': ['C', 'plain', { 'Fn::GetAtt': ['Row', 'Outputs.Piece'] }] },
  // A reader of the row (fixed point), and a chained import of a tainted export.
  reader: { 'Fn::GetAtt': ['Reader', 'Value'] },
  chainedImport: { 'Fn::ImportValue': 'upstream-export' },
};

function producer(value: unknown, exportName: unknown = 'out-export'): CloudFormationTemplate {
  return {
    Resources: {
      Row: {
        Type: 'AWS::CloudFormation::Stack',
        Properties: {
          TemplateURL: 'u',
          Parameters: { X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/{{resolve:ssm-secure:/a}}']] } },
        },
      },
      Reader: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Row', 'Outputs.Piece'] } },
      },
    },
    Outputs: {
      Out: { Value: value, Export: { Name: exportName } },
      Plain: { Value: 'literal', Export: { Name: 'plain-export' } },
    },
  } as CloudFormationTemplate;
}

async function marked(
  template: CloudFormationTemplate,
  upstream?: CrossStackPreview,
  resolve: (value: unknown) => Promise<unknown> = async (value) => value
) {
  const preview = upstream ?? new CrossStackPreview();
  const tainted = taintedNamesOf(template, crossStackTaintSeedsOf(template, REGION, preview));
  await markProducerTaint(preview, REGION, resolve, {
    stackName: 'Mid',
    template,
    desiredOutputs: { Out: 'Q7', Plain: 'literal' },
    storedOutputs: { Out: 'Q7old', 'out-export': 'Q7old', Plain: 'literal' },
    readsSecretFedName: producerReadsSecretFedName(tainted),
  });
  return preview;
}

describe('a producer marks every output reading a secret-fed name (#7090)', () => {
  for (const [label, value] of Object.entries(TAINTED_OUTPUTS)) {
    it(`marks ${label}, its export and its values`, async () => {
      const upstream = previewWith((p) =>
        p.markTainted(REGION, 'Up', 'U', 'upstream-export', ['Q7up'])
      );
      const preview = await marked(producer(value), upstream);
      expect(preview.stackOutputTainted(REGION, 'Mid', 'Out')).toBe(true);
      expect(preview.exportTainted(REGION, 'out-export')).toBe(true);
      expect(preview.stackOutputTainted(REGION, 'Mid', 'Plain')).toBe(false);
      expect(preview.exportTainted(REGION, 'plain-export')).toBe(false);
      expect([...preview.taintedValues()]).toEqual(expect.arrayContaining(['Q7', 'Q7old']));
      expect(preview.taintedValues().has('literal')).toBe(false);
    });
  }
  it('marks nothing on a stack with no secret-fed name', async () => {
    const template = producer({ 'Fn::GetAtt': ['Row', 'Outputs.Piece'] });
    (template.Resources['Row']!.Properties as Record<string, unknown>)['Parameters'] = {
      X: { Ref: 'Sep' },
    };
    const preview = await marked(template);
    expect(preview.anyTainted()).toBe(false);
  });
  it('takes an export name built from the secret as a needle', async () => {
    const preview = await marked(
      producer('literal', { 'Fn::GetAtt': ['Row', 'Outputs.Piece'] }),
      undefined,
      async () => 'Q7name'
    );
    expect(preview.exportTainted(REGION, 'Q7name')).toBe(true);
    expect(preview.taintedValues().has('Q7name')).toBe(true);
  });
  it('taints every export when the export name of a tainted output does not resolve', async () => {
    const preview = await marked(producer({ 'Fn::GetAtt': ['Row', 'Outputs.Piece'] }, { Ref: 'N' }));
    expect(preview.exportTainted(REGION, 'anything')).toBe(true);
  });
});
