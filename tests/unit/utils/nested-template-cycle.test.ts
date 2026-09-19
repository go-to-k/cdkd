import { describe, it, expect } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findNestedTemplateTreeDefect,
  renderNestedTemplateTreeDefect,
} from '../../../src/utils/nested-template-cycle.js';

/**
 * Write `<name>` into `dir` as a template whose nested-stack rows are
 * `rows` (logical id -> `aws:asset:path`), plus one ordinary resource so the
 * walker has a non-nested row to step over.
 */
function writeTemplate(dir: string, name: string, rows: Record<string, string>): string {
  const file = join(dir, name);
  const Resources: Record<string, unknown> = { Topic: { Type: 'AWS::SNS::Topic' } };
  for (const [logicalId, assetPath] of Object.entries(rows)) {
    Resources[logicalId] = {
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: 'https://example.com/t.json' },
      Metadata: { 'aws:asset:path': assetPath },
    };
  }
  writeFileSync(file, JSON.stringify({ Resources }));
  return file;
}

function tmp(): string {
  // realpath: macOS spells the temp dir through a `/var -> /private/var`
  // symlink, and the walker reports REAL paths.
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-nested-cycle-')));
}

describe('findNestedTemplateTreeDefect', () => {
  it('reports a template that names itself', () => {
    const dir = tmp();
    const a = writeTemplate(dir, 'a.json', { Loop: 'a.json' });

    const defect = findNestedTemplateTreeDefect({ Child: a });

    expect(defect).toEqual({
      kind: 'cycle',
      chain: [
        { logicalId: 'Child', templatePath: a },
        { logicalId: 'Loop', templatePath: a },
      ],
    });
  });

  it('reports a longer cycle (A -> B -> A), which a self-reference check alone would miss', () => {
    const dir = tmp();
    const a = writeTemplate(dir, 'a.json', { ToB: 'b.json' });
    const b = writeTemplate(dir, 'b.json', { BackToA: 'a.json' });

    const defect = findNestedTemplateTreeDefect({ Child: a });

    expect(defect).toEqual({
      kind: 'cycle',
      chain: [
        { logicalId: 'Child', templatePath: a },
        { logicalId: 'ToB', templatePath: b },
        { logicalId: 'BackToA', templatePath: a },
      ],
    });
  });

  it('reports a cycle that sits below an acyclic lead-in', () => {
    const dir = tmp();
    const a = writeTemplate(dir, 'a.json', { ToB: 'b.json' });
    const b = writeTemplate(dir, 'b.json', { ToC: 'c.json' });
    const c = writeTemplate(dir, 'c.json', { BackToB: 'b.json' });

    const defect = findNestedTemplateTreeDefect({ Child: a });

    expect(defect?.kind).toBe('cycle');
    expect(defect?.chain.map((h) => h.templatePath)).toEqual([a, b, c, b]);
  });

  it('accepts a diamond: two sibling rows naming one template are not a cycle', () => {
    const dir = tmp();
    writeTemplate(dir, 'shared.json', {});
    const a = writeTemplate(dir, 'a.json', { Left: 'shared.json', Right: 'shared.json' });

    expect(findNestedTemplateTreeDefect({ Child: a })).toBeUndefined();
  });

  it('accepts one template reached at two different depths', () => {
    const dir = tmp();
    writeTemplate(dir, 'leaf.json', {});
    writeTemplate(dir, 'mid.json', { Leaf: 'leaf.json' });
    const a = writeTemplate(dir, 'a.json', { Mid: 'mid.json', Leaf: 'leaf.json' });

    expect(findNestedTemplateTreeDefect({ Child: a })).toBeUndefined();
  });

  it('still reports a cycle reached only through a template an earlier sibling walked clean', () => {
    // `First` walks shared.json clean; `Second` reaches b.json, which closes a
    // cycle through a.json. The clean-subtree memo must not hide it.
    const dir = tmp();
    writeTemplate(dir, 'shared.json', {});
    const a = writeTemplate(dir, 'a.json', { First: 'shared.json', Second: 'b.json' });
    writeTemplate(dir, 'b.json', { Shared: 'shared.json', Back: 'a.json' });

    const defect = findNestedTemplateTreeDefect({ Child: a });

    expect(defect?.kind).toBe('cycle');
    expect(defect?.chain.map((h) => h.logicalId)).toEqual(['Child', 'Second', 'Back']);
  });

  it('walks a wide tree of diamonds once per template, not once per path', () => {
    // 24 levels, two rows per level naming the same next template: 2^24 paths.
    // Without the clean-subtree memo this does not finish inside the timeout.
    const dir = tmp();
    const depth = 24;
    writeTemplate(dir, `t${depth}.json`, {});
    for (let i = depth - 1; i >= 0; i--) {
      writeTemplate(dir, `t${i}.json`, { L: `t${i + 1}.json`, R: `t${i + 1}.json` });
    }

    expect(findNestedTemplateTreeDefect({ Child: join(dir, 't0.json') })).toBeUndefined();
  });

  it('accepts a legitimate multi-level tree across sub-directories', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'sub'));
    writeTemplate(join(dir, 'sub'), 'grand.json', {});
    // Relative to the CHILD's directory, as the provider resolves it.
    const a = writeTemplate(dir, 'a.json', { Grand: 'sub/grand.json' });

    expect(findNestedTemplateTreeDefect({ Child: a })).toBeUndefined();
  });

  it('sees through path spellings that differ for one file', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'sub'));
    const a = writeTemplate(dir, 'a.json', { Loop: 'sub/../a.json' });

    const defect = findNestedTemplateTreeDefect({ Child: join(dir, 'sub', '..', 'a.json') });

    expect(defect?.kind).toBe('cycle');
    expect(defect?.chain.map((h) => h.templatePath)).toEqual([a, a]);
  });

  it('reports a cycle spelled through a symlinked directory, whose joined path never repeats', () => {
    // `d -> .` makes each level's path one segment longer (`d/a.json`,
    // `d/d/a.json`, ...) for the SAME file, so a comparison of resolved path
    // STRINGS would follow it until the OS path limit.
    const dir = tmp();
    symlinkSync('.', join(dir, 'd'), 'dir');
    const a = writeTemplate(dir, 'a.json', { Loop: 'd/a.json' });

    const defect = findNestedTemplateTreeDefect({ Child: a });

    expect(defect?.kind).toBe('cycle');
    expect(defect?.chain.map((h) => h.templatePath)).toEqual([a, a]);
  });

  it('treats one real file reached in two directories as two subtrees, not a repeat', () => {
    // dir1/x.json is a symlink to dir2/x.json. Children resolve against the
    // directory a template was REACHED in, so the two spellings have different
    // children: under dir1 the row leads on to dir2/x.json, under dir2 it ends
    // at a leaf. The tree is finite and must not be refused.
    const dir = tmp();
    mkdirSync(join(dir, 'dir1'));
    mkdirSync(join(dir, 'dir2'));
    writeTemplate(join(dir, 'dir2'), 'x.json', { Y: 'y.json' });
    symlinkSync(join('..', 'dir2', 'x.json'), join(dir, 'dir1', 'x.json'), 'file');
    writeTemplate(join(dir, 'dir1'), 'y.json', { Onward: '../dir2/x.json' });
    writeTemplate(join(dir, 'dir2'), 'y.json', {});

    expect(findNestedTemplateTreeDefect({ Child: join(dir, 'dir1', 'x.json') })).toBeUndefined();
  });

  it('uses a seeded ancestor: a child naming the template above the entry rows is refused at once', () => {
    const dir = tmp();
    const root = writeTemplate(dir, 'root.json', { Child: 'a.json' });
    const a = writeTemplate(dir, 'a.json', { BackToRoot: 'root.json' });

    const defect = findNestedTemplateTreeDefect({ Child: a }, [root]);

    expect(defect?.chain.map((h) => h.logicalId)).toEqual(['Child', 'BackToRoot']);
  });

  it('terminates without the seed too, one lap later', () => {
    const dir = tmp();
    writeTemplate(dir, 'root.json', { Child: 'a.json' });
    const a = writeTemplate(dir, 'a.json', { BackToRoot: 'root.json' });

    const defect = findNestedTemplateTreeDefect({ Child: a });

    expect(defect?.kind).toBe('cycle');
    expect(defect?.chain.map((h) => h.logicalId)).toEqual(['Child', 'BackToRoot', 'Child']);
  });

  it('reports an absolute aws:asset:path at depth, with the rows that lead to it', () => {
    const dir = tmp();
    const a = writeTemplate(dir, 'a.json', { Mid: 'mid.json' });
    const mid = writeTemplate(dir, 'mid.json', { Escapes: '/etc/outside.json' });

    expect(findNestedTemplateTreeDefect({ Child: a })).toEqual({
      kind: 'absolute-path',
      chain: [
        { logicalId: 'Child', templatePath: a },
        { logicalId: 'Mid', templatePath: mid },
      ],
      logicalId: 'Escapes',
      assetPath: '/etc/outside.json',
    });
  });

  it('leaves a missing or unparseable template to the site that loads it', () => {
    const dir = tmp();
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json');
    const a = writeTemplate(dir, 'a.json', { Missing: 'nope.json', Broken: 'broken.json' });

    expect(findNestedTemplateTreeDefect({ Child: a })).toBeUndefined();
    expect(findNestedTemplateTreeDefect({ Child: join(dir, 'absent.json') })).toBeUndefined();
  });

  it('ignores rows that are not nested stacks or carry no usable asset path', () => {
    const dir = tmp();
    const a = join(dir, 'a.json');
    writeFileSync(
      a,
      JSON.stringify({
        Resources: {
          NotAStack: { Type: 'AWS::SNS::Topic', Metadata: { 'aws:asset:path': 'a.json' } },
          NoMetadata: { Type: 'AWS::CloudFormation::Stack' },
          EmptyPath: { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': '' } },
          NonString: { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': 7 } },
          NullRow: null,
        },
      })
    );

    expect(findNestedTemplateTreeDefect({ Child: a })).toBeUndefined();
  });
});

describe('renderNestedTemplateTreeDefect', () => {
  it('names the stack, every hop, the closing row and the repeated file', () => {
    const text = renderNestedTemplateTreeDefect(
      {
        kind: 'cycle',
        chain: [
          { logicalId: 'Child', templatePath: '/out/a.json' },
          { logicalId: 'ToB', templatePath: '/out/b.json' },
          { logicalId: 'BackToA', templatePath: '/out/a.json' },
        ],
      },
      'Parent',
      'deploy any level of it'
    );

    expect(text).toContain("under stack 'Parent' contains a cycle");
    expect(text).toContain(
      "'Child' (/out/a.json) -> 'ToB' (/out/b.json) -> 'BackToA' (/out/a.json)"
    );
    expect(text).toContain(
      "Nested stack 'BackToA' resolves to a template that is already on that nesting chain"
    );
    expect(text).toContain('Refusing to deploy any level of it.');
  });

  it('strips terminal control sequences from every template-controlled interpolation', () => {
    const esc = String.fromCharCode(0x1b) + '[2K' + String.fromCharCode(0x0d) + 'FORGED';
    const csi = String.fromCharCode(0x9b);
    const lineSeparator = String.fromCharCode(0x2028);
    const cycle = renderNestedTemplateTreeDefect(
      {
        kind: 'cycle',
        chain: [
          { logicalId: `A${esc}`, templatePath: `/out/a${esc}.json` },
          { logicalId: `B${String.fromCharCode(0x0a)}${esc}`, templatePath: `/out/a${esc}.json` },
        ],
      },
      `Parent~X${esc}`,
      'deploy'
    );
    const absolute = renderNestedTemplateTreeDefect(
      {
        kind: 'absolute-path',
        chain: [{ logicalId: `A${esc}`, templatePath: `/out/a${esc}.json` }],
        logicalId: `E${csi}${esc}`,
        assetPath: `/abs${esc}${lineSeparator}.json`,
      },
      `Parent${esc}`,
      'deploy'
    );

    const forbidden = (text: string): number[] =>
      [...text]
        .map((ch) => ch.codePointAt(0)!)
        .filter((cp) => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029);
    for (const text of [cycle, absolute]) {
      expect(forbidden(text)).toEqual([]);
      // The printable remainder survives, so the assertion above is not
      // satisfied by the value having been dropped wholesale.
      expect(text).toContain('FORGED');
    }
  });

  it('elides the middle of a long chain but keeps the entry row and the closing row', () => {
    const chain = Array.from({ length: 40 }, (_, i) => ({
      logicalId: `L${i}`,
      templatePath: `/out/t${i}.json`,
    }));
    chain.push({ logicalId: 'Closer', templatePath: '/out/t0.json' });

    const text = renderNestedTemplateTreeDefect({ kind: 'cycle', chain }, 'P', 'deploy');

    expect(text).toContain("'L0' (/out/t0.json)");
    expect(text).toContain('... 33 more ...');
    expect(text).toContain("'Closer' (/out/t0.json)");
    expect(text).not.toContain("'L20'");
  });

  it('names the rows leading to an absolute path and the path itself', () => {
    const text = renderNestedTemplateTreeDefect(
      {
        kind: 'absolute-path',
        chain: [{ logicalId: 'Child', templatePath: '/out/a.json' }],
        logicalId: 'E',
        assetPath: '/abs.json',
      },
      'P',
      'deploy'
    );

    expect(text).toContain("nested stack 'E' (reached through 'Child' (/out/a.json))");
    expect(text).toContain("Metadata['aws:asset:path']='/abs.json' which is absolute");
  });
});
