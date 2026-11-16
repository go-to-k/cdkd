import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockExpandMacros = vi.hoisted(() => vi.fn());
/** Pins the temporary file's random suffix when set, to plant a link at it. */
const fixedRandom = vi.hoisted(() => ({ hex: undefined as string | undefined }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: ((n: number) =>
      fixedRandom.hex === undefined
        ? actual.randomBytes(n)
        : Buffer.from(fixedRandom.hex, 'hex')) as typeof actual.randomBytes,
  };
});
vi.mock('../../../src/synthesis/macro-expander.js', () => ({
  expandMacros: mockExpandMacros,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    setLevel: vi.fn(),
  }),
}));

import {
  EXPANDED_TEMPLATE_SUFFIX,
  expandNestedTemplateMacros,
  macroCarryingNestedTemplates,
} from '../../../src/synthesis/nested-macro-expansion.js';
import { Synthesizer } from '../../../src/synthesis/synthesizer.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate } from '../../../src/types/resource/template.js';

/**
 * go-to-k/cdkd#6395: a nested template's own Transform was never expanded, so
 * a `cdk.NestedStack` holding a HostedRotation (or any SAM resource) was
 * deployed raw. Every consumer reads the child from its FILE, so the expanded
 * child is written beside the original and the reference re-pointed.
 */

const SAM = 'AWS::Serverless-2016-10-31';

function nestedRow(assetPath: string): Record<string, unknown> {
  return {
    Type: 'AWS::CloudFormation::Stack',
    Properties: { TemplateURL: 'https://example.invalid/x.json' },
    Metadata: { 'aws:asset:path': assetPath },
  };
}

/** What the CFn round-trip answers for a SAM template, in miniature. */
function fakeExpand(template: CloudFormationTemplate): CloudFormationTemplate {
  const { Transform: _t, ...rest } = template as CloudFormationTemplate & { Transform?: unknown };
  const resources: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(rest.Resources ?? {})) {
    const row = r as { Type?: string };
    resources[id] =
      row.Type === 'AWS::Serverless::Function' ? { ...row, Type: 'AWS::Lambda::Function' } : row;
  }
  return { ...rest, Resources: resources } as CloudFormationTemplate;
}

describe('nested-template macro expansion (go-to-k/cdkd#6395)', () => {
  let dir: string;
  const write = (name: string, template: unknown): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(template));
    return p;
  };
  const read = (p: string): Record<string, any> => JSON.parse(fs.readFileSync(p, 'utf-8'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdkd-6395-'));
    mockExpandMacros.mockReset();
    mockExpandMacros.mockImplementation(async (t: CloudFormationTemplate) => fakeExpand(t));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('expands a macro child beside the original and re-points the stack map', async () => {
    const childPath = write('Child.nested.template.json', {
      Transform: SAM,
      Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: {} } },
    });
    const original = fs.readFileSync(childPath, 'utf-8');
    const stack = { nestedTemplates: { ChildRow: childPath } };

    expect(macroCarryingNestedTemplates(stack)).toEqual([childPath]);
    const count = await expandNestedTemplateMacros(stack, async (t) => fakeExpand(t));

    expect(count).toBe(1);
    const expandedPath = path.join(dir, `Child.nested.template${EXPANDED_TEMPLATE_SUFFIX}`);
    expect(stack.nestedTemplates.ChildRow).toBe(expandedPath);
    expect(read(expandedPath)['Transform']).toBeUndefined();
    expect(read(expandedPath)['Resources']['Fn']['Type']).toBe('AWS::Lambda::Function');
    // The assembly's own file is never modified.
    expect(fs.readFileSync(childPath, 'utf-8')).toBe(original);
  });

  it('re-points a parent row at an expanded grandchild, through the parent copy', async () => {
    const grandPath = write('Grand.nested.template.json', {
      Transform: [SAM],
      Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: {} } },
    });
    const childPath = write('Child.nested.template.json', {
      Resources: {
        GrandRow: nestedRow('Grand.nested.template.json'),
        Q: { Type: 'AWS::SQS::Queue' },
      },
    });
    const stack = { nestedTemplates: { ChildRow: childPath } };

    expect(macroCarryingNestedTemplates(stack)).toEqual([grandPath]);
    expect(await expandNestedTemplateMacros(stack, async (t) => fakeExpand(t))).toBe(1);

    // The child carried no macro, but its row must name the expanded grandchild,
    // so the child is copied too and the stack points at the copy.
    const childCopy = stack.nestedTemplates.ChildRow;
    expect(childCopy).toBe(path.join(dir, `Child.nested.template${EXPANDED_TEMPLATE_SUFFIX}`));
    const row = read(childCopy)['Resources']['GrandRow'];
    expect(row['Metadata']['aws:asset:path']).toBe(
      `Grand.nested.template${EXPANDED_TEMPLATE_SUFFIX}`
    );
    expect(row['Properties']).toEqual({ TemplateURL: 'https://example.invalid/x.json' });
    expect(read(path.join(dir, row['Metadata']['aws:asset:path']))['Resources']['Fn']['Type']).toBe(
      'AWS::Lambda::Function'
    );
  });

  it('leaves a tree with no macro untouched (no copy, no re-point)', async () => {
    const childPath = write('Child.nested.template.json', {
      Resources: { Q: { Type: 'AWS::SQS::Queue' } },
    });
    const stack = { nestedTemplates: { ChildRow: childPath } };
    expect(macroCarryingNestedTemplates(stack)).toEqual([]);
    const expand = vi.fn();
    expect(await expandNestedTemplateMacros(stack, expand)).toBe(0);
    expect(expand).not.toHaveBeenCalled();
    expect(stack.nestedTemplates.ChildRow).toBe(childPath);
    expect(fs.readdirSync(dir)).toEqual(['Child.nested.template.json']);
  });

  it('follows the rows of the EXPANDED child (a transform-added row is walked)', async () => {
    write('Added.nested.template.json', {
      Transform: SAM,
      Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: {} } },
    });
    const childPath = write('Child.nested.template.json', {
      Transform: 'AddsNestedRow',
      Resources: { Q: { Type: 'AWS::SQS::Queue' } },
    });
    const stack = { nestedTemplates: { ChildRow: childPath } };
    const expand = vi.fn(async (t: CloudFormationTemplate, p: string) =>
      p === childPath
        ? ({
            Resources: { ...t.Resources, AddedRow: nestedRow('Added.nested.template.json') },
          } as unknown as CloudFormationTemplate)
        : fakeExpand(t)
    );
    expect(await expandNestedTemplateMacros(stack, expand)).toBe(2);
    const row = read(stack.nestedTemplates.ChildRow)['Resources']['AddedRow'];
    expect(row['Metadata']['aws:asset:path']).toBe(
      `Added.nested.template${EXPANDED_TEMPLATE_SUFFIX}`
    );
  });

  it('expands a file two rows name only once', async () => {
    const childPath = write('Child.nested.template.json', {
      Transform: SAM,
      Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: {} } },
    });
    const stack = { nestedTemplates: { A: childPath, B: childPath } };
    const expand = vi.fn(async (t: CloudFormationTemplate) => fakeExpand(t));
    expect(await expandNestedTemplateMacros(stack, expand)).toBe(1);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(stack.nestedTemplates.A).toBe(stack.nestedTemplates.B);
    expect(stack.nestedTemplates.A).not.toBe(childPath);
  });

  describe('the write into the assembly directory (a base cdkd did not create)', () => {
    const samChild = (): string =>
      write('Child.nested.template.json', {
        Transform: SAM,
        Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: {} } },
      });
    const expandedName = `Child.nested.template${EXPANDED_TEMPLATE_SUFFIX}`;

    it('refuses a symbolic link planted at the expanded name pointing outside, writing nothing through it', async () => {
      const childPath = samChild();
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cdkd-6395-outside-'));
      const target = path.join(outside, 'authorized_keys');
      try {
        // A DANGLING link: following it would create the target.
        fs.symlinkSync(target, path.join(dir, expandedName));
        const stack = { nestedTemplates: { ChildRow: childPath } };
        await expect(expandNestedTemplateMacros(stack, async (t) => fakeExpand(t))).rejects.toThrow(
          /Cannot write the macro-expanded copy/
        );
        expect(fs.existsSync(target)).toBe(false);
        expect(stack.nestedTemplates.ChildRow).toBe(childPath);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('refuses a symbolic link at the expanded name even when it points inside the assembly', async () => {
      const childPath = samChild();
      const victim = write('Victim.nested.template.json', { Resources: {} });
      const before = fs.readFileSync(victim, 'utf-8');
      fs.symlinkSync(victim, path.join(dir, expandedName));
      const stack = { nestedTemplates: { ChildRow: childPath } };
      await expect(expandNestedTemplateMacros(stack, async (t) => fakeExpand(t))).rejects.toThrow(
        /already exists and is a symbolic link/
      );
      expect(fs.readFileSync(victim, 'utf-8')).toBe(before);
    });

    it('never writes through a link raced in at the temporary name (exclusive create)', async () => {
      const childPath = samChild();
      const victim = write('Victim.nested.template.json', { Resources: {} });
      const before = fs.readFileSync(victim, 'utf-8');
      fixedRandom.hex = 'aabbccddeeff';
      try {
        const tmpName = `.${expandedName}.${process.pid}.aabbccddeeff.tmp`;
        fs.symlinkSync(victim, path.join(dir, tmpName));
        const stack = { nestedTemplates: { ChildRow: childPath } };
        await expect(expandNestedTemplateMacros(stack, async (t) => fakeExpand(t))).rejects.toThrow(
          /\(EEXIST\)/
        );
        expect(fs.readFileSync(victim, 'utf-8')).toBe(before);
      } finally {
        fixedRandom.hex = undefined;
      }
    });

    it('replaces a stale regular copy from an earlier run, leaving no temporary file', async () => {
      const childPath = samChild();
      fs.writeFileSync(path.join(dir, expandedName), '{"stale":true}');
      const stack = { nestedTemplates: { ChildRow: childPath } };
      await expandNestedTemplateMacros(stack, async (t) => fakeExpand(t));
      expect(read(path.join(dir, expandedName))['stale']).toBeUndefined();
      expect(fs.readdirSync(dir).sort()).toEqual(
        [expandedName, 'Child.nested.template.json'].sort()
      );
    });

    it('reports an unwritable assembly directory as a SynthesisError naming the copy', async () => {
      const childPath = samChild();
      fs.chmodSync(dir, 0o555);
      try {
        const stack = { nestedTemplates: { ChildRow: childPath } };
        await expect(expandNestedTemplateMacros(stack, async (t) => fakeExpand(t))).rejects.toThrow(
          /Could not write the macro-expanded copy of nested template .* \(EACCES\)/
        );
      } finally {
        fs.chmodSync(dir, 0o755);
      }
    });

    it('refuses an assembly row that names a file with the reserved suffix', async () => {
      const reserved = write(`Other${EXPANDED_TEMPLATE_SUFFIX}`, {
        Resources: { Q: { Type: 'AWS::SQS::Queue' } },
      });
      const childPath = samChild();
      const stack = { nestedTemplates: { ChildRow: childPath, OtherRow: reserved } };
      await expect(expandNestedTemplateMacros(stack, async (t) => fakeExpand(t))).rejects.toThrow(
        /ends in \.cdkd-expanded\.json/
      );
    });
  });

  it('expandMacrosForStacks expands a nested child of a stack whose own template has no macro', async () => {
    const childPath = write('Child.nested.template.json', {
      Transform: SAM,
      Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: {} } },
    });
    const ownTemplate = {
      Resources: { ChildRow: nestedRow('Child.nested.template.json') },
    };
    const stack = {
      stackName: 'S',
      template: ownTemplate,
      nestedTemplates: { ChildRow: childPath },
    } as unknown as StackInfo;

    await new Synthesizer().expandMacrosForStacks(
      [stack],
      { app: 'x', region: 'us-east-1', stateBucket: 'b' } as never,
      { region: 'us-east-1' }
    );

    // The stack's own template had no macro, so only the child went through.
    expect(mockExpandMacros).toHaveBeenCalledTimes(1);
    expect(mockExpandMacros.mock.calls[0]![0]).toEqual(read(childPath));
    expect(stack.template).toBe(ownTemplate);
    expect(stack.nestedTemplates!['ChildRow']).toBe(
      path.join(dir, `Child.nested.template${EXPANDED_TEMPLATE_SUFFIX}`)
    );
  });
});
