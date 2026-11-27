/**
 * go-to-k/cdkd#7090: the invariant behind the cross-stack provenance mask.
 *
 * A producer's value reaches a consumer's diff through the run's
 * `CrossStackPreview` (its two readers, `Fn::ImportValue` and
 * `Fn::GetStackOutput`) or through the producer's state. Either way the
 * consumer's provenance comes from the preview's taint marks: made from the
 * app's templates before any diff (`markAppProducerTaint`, so a producer this
 * run does not diff, or diffs later, is covered), and again by each
 * producer's diff, which adds the values. The first block enumerates every
 * writer and reader of the preview in `src/`, so a new path (a third reader,
 * another writer, a writer that drops the taint predicate) fails here until
 * it is routed through the taint. The rest is generated over the read shapes
 * a consumer can spell, the output shapes a producer can read a secret-fed
 * name through, and nested subtrees on both sides.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { CrossStackPreview, markProducerTaint } from '../../../src/analyzer/cross-stack-preview.js';
import {
  crossStackTaintSeedsOf,
  markAppProducerTaint,
  producerReadsSecretFedName,
  subtreeTaintedNames,
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
      'src/cli/commands/diff-recursive/cross-stack-taint.ts',
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
    expect(tree).toContain('subtreeTaintedNames(');
    const diff = readFileSync(join(ROOT, 'src/cli/commands/diff.ts'), 'utf8');
    expect(diff).toContain('markAppProducerTaint(crossStackPreview, allStacks)');
    expect(tree).toContain('crossStackPreview?.taintedValues()');
    expect(tree).toContain('secretFedNames: passedSecretNames');
  });
});

const REGION = 'us-east-1';

function previewWith(
  mark: (preview: CrossStackPreview) => void = (preview) =>
    preview.markTainted('Prod', 'Out', 'piece-export', ['Q7'])
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
    const preview = previewWith((p) => p.markTainted('Prod', 'Out', null, []));
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
  await markProducerTaint(preview, resolve, {
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
        p.markTainted('Up', 'U', 'upstream-export', ['Q7up'])
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

describe('the app-wide marks, before any diff (#7090)', () => {
  const rowFed = (outputs: CloudFormationTemplate['Outputs']): CloudFormationTemplate =>
    ({ ...producer({ 'Fn::GetAtt': ['Row', 'Outputs.Piece'] }), Outputs: outputs }) as CloudFormationTemplate;

  it('marks a secret-fed output in every region, and a re-export of it downstream', () => {
    const preview = new CrossStackPreview();
    markAppProducerTaint(preview, [
      // Listed consumer-first: the fixed point does not depend on order.
      {
        stackName: 'Relay',
        template: {
          Resources: {},
          Outputs: { Again: { Value: IMPORT, Export: { Name: 'again-export' } } },
        } as CloudFormationTemplate,
      },
      {
        stackName: 'Prod',
        template: rowFed({
          Out: { Value: { 'Fn::GetAtt': ['Row', 'Outputs.Piece'] }, Export: { Name: 'piece-export' } },
          Plain: { Value: 'literal', Export: { Name: 'plain-export' } },
        }),
      },
    ]);
    for (const region of ['us-east-1', 'eu-west-1']) {
      expect(preview.exportTainted(region, 'piece-export')).toBe(true);
      expect(preview.stackOutputTainted(region, 'Prod', 'Out')).toBe(true);
      expect(preview.exportTainted(region, 'again-export')).toBe(true);
      expect(preview.exportTainted(region, 'plain-export')).toBe(false);
    }
    expect(preview.taintedValues().size).toBe(0);
  });

  it('taints every export when a secret-fed output exports under a computed name', () => {
    const preview = new CrossStackPreview();
    markAppProducerTaint(preview, [
      {
        stackName: 'Prod',
        template: rowFed({
          Out: {
            Value: { 'Fn::GetAtt': ['Row', 'Outputs.Piece'] },
            Export: { Name: { 'Fn::Sub': '${AWS::StackName}-${AWS::Region}' } as unknown as string },
          },
        }),
      },
    ]);
    expect(preview.exportTainted(REGION, 'anything')).toBe(true);
  });

  it('reads a `${AWS::StackName}` export name as CDK writes it, without tainting every export', () => {
    const preview = new CrossStackPreview();
    markAppProducerTaint(preview, [
      {
        stackName: 'Prod',
        template: rowFed({
          Out: {
            Value: { 'Fn::GetAtt': ['Row', 'Outputs.Piece'] },
            Export: { Name: { 'Fn::Sub': '${AWS::StackName}-x' } as unknown as string },
          },
        }),
      },
    ]);
    expect(preview.exportTainted(REGION, 'Prod-x')).toBe(true);
    expect(preview.exportTainted(REGION, 'anything')).toBe(false);
  });

  it('marks nothing in an app with no secret-fed name', () => {
    const preview = new CrossStackPreview();
    markAppProducerTaint(preview, [
      {
        stackName: 'Prod',
        template: { Resources: {}, Outputs: { Out: { Value: IMPORT } } } as CloudFormationTemplate,
      },
    ]);
    expect(preview.anyTainted()).toBe(false);
  });
});

describe('nested subtrees, read from disk (#7090)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-7090-paths-'));
    // A child exporting a piece of a parameter its row mixes with a reference.
    writeFileSync(
      join(dir, 'exporting.json'),
      JSON.stringify({
        Parameters: { X: { Type: 'String' } },
        Resources: {},
        Outputs: {
          Piece: {
            Value: { 'Fn::Select': [0, { 'Fn::Split': ['/', { Ref: 'X' }] }] },
            Export: { Name: 'child-export' },
          },
          Plain: { Value: 'literal', Export: { Name: 'child-plain' } },
        },
      })
    );
    // A consumer's child importing the tainted export, and outputting it.
    writeFileSync(
      join(dir, 'relay.json'),
      JSON.stringify({
        Resources: {},
        Outputs: { Y: { Value: { 'Fn::ImportValue': 'child-export' } } },
      })
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const nestedRow = (asset: string, parameters: Record<string, unknown> = {}) => ({
    Type: 'AWS::CloudFormation::Stack',
    Metadata: { 'aws:asset:path': asset },
    Properties: { TemplateURL: 'u', Parameters: parameters },
  });
  type AppStack = {
    stackName: string;
    template: CloudFormationTemplate;
    nestedTemplates: Record<string, string>;
  };
  const app = (): AppStack[] => [
    {
      stackName: 'Prod',
      template: {
        Resources: {
          Row: nestedRow('exporting.json', {
            X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/{{resolve:ssm-secure:/a}}']] },
          }),
        },
      } as unknown as CloudFormationTemplate,
      nestedTemplates: { Row: join(dir, 'exporting.json') },
    },
    {
      stackName: 'Cons',
      template: {
        Resources: { Row2: nestedRow('relay.json') },
        Outputs: {
          X: { Value: { 'Fn::GetAtt': ['Row2', 'Outputs.Y'] }, Export: { Name: 'relay-export' } },
        },
      } as unknown as CloudFormationTemplate,
      nestedTemplates: { Row2: join(dir, 'relay.json') },
    },
  ];

  it("marks a nested child's own export, without diffing the child", () => {
    const preview = new CrossStackPreview();
    markAppProducerTaint(preview, app());
    expect(preview.exportTainted(REGION, 'child-export')).toBe(true);
    expect(preview.exportTainted(REGION, 'child-plain')).toBe(false);
    // Its stack name is the deploy's: any non-top-level stack's output is tainted.
    expect(preview.stackOutputTainted(REGION, 'Prod-RowNested-ABC', 'Piece')).toBe(true);
    expect(preview.stackOutputTainted(REGION, 'Cons', 'Other')).toBe(false);
  });

  it("taints a row whose child reads a tainted export, and a root output reading the row", () => {
    const preview = new CrossStackPreview();
    markAppProducerTaint(preview, app());
    const [, cons] = app();
    const tainted = subtreeTaintedNames(cons!.template, cons!.nestedTemplates, [], preview);
    expect(tainted.has('Row2')).toBe(true);
    // ...so a third stack importing the root's re-export is masked too.
    expect(preview.exportTainted(REGION, 'relay-export')).toBe(true);
  });

  it('terminates on a cyclic assembly (rows naming their own template)', () => {
    const cyclic = join(dir, 'cyclic.json');
    writeFileSync(
      cyclic,
      JSON.stringify({
        Resources: { A: nestedRow('cyclic.json'), B: nestedRow('cyclic.json') },
        Outputs: { O: { Value: { 'Fn::ImportValue': 'child-export' } } },
      })
    );
    // Each child visit reports its tainted output: a walk that re-enters the
    // cycle would report it without bound, so fail fast past a small budget.
    const marked = previewWith((p) => p.markTainted('Prod', 'Piece', 'child-export'));
    let visits = 0;
    subtreeTaintedNames(
      { Resources: { A: nestedRow('cyclic.json'), B: nestedRow('cyclic.json') } } as never,
      { A: cyclic, B: cyclic },
      [],
      marked,
      {
        onChildOutput: () => {
          visits += 1;
          if (visits > 100) throw new Error('the walk re-entered a cyclic template');
        },
      }
    );
    expect(visits).toBe(2);
    // ...and the app-wide pass over such a stack terminates too.
    const preview = new CrossStackPreview();
    markAppProducerTaint(preview, [
      ...app(),
      {
        stackName: 'Loop',
        template: {
          Resources: { A: nestedRow('cyclic.json'), B: nestedRow('cyclic.json') },
        } as unknown as CloudFormationTemplate,
        nestedTemplates: { A: cyclic, B: cyclic },
      },
    ]);
    expect(preview.exportTainted(REGION, 'child-export')).toBe(true);
  });

  it('marks nothing when the row passes no reference', () => {
    const preview = new CrossStackPreview();
    const [prod] = app();
    (prod!.template.Resources['Row']!.Properties as Record<string, unknown>)['Parameters'] = {
      X: { Ref: 'Sep' },
    };
    markAppProducerTaint(preview, [prod!]);
    expect(preview.anyTainted()).toBe(false);
  });
});
