import { describe, it, expect } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_NESTING_DEPTH,
  MAX_ROWS_FOLLOWED,
  findNestedTemplateTreeDefect,
  listNestedTemplateRows,
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
    // 20 levels, two rows per level naming the same next template: 2^20 paths,
    // each a file read. Without the clean-subtree memo the walk outlives the
    // test timeout; sized so that regression fails in seconds, not hours.
    const dir = tmp();
    const depth = 20;
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
    // sub/x.json is a symlink to x.json. Children resolve against the directory
    // a template was REACHED in, so the two spellings have different children:
    // reached as sub/x.json the row `y.json` is sub/y.json, reached as x.json it
    // is y.json. Both are leaves, the tree is finite, and it must not be refused
    // — neither as a repeat nor by the containment check, which follows the
    // symlink to a file still inside the directory (go-to-k/cdkd#3489).
    const dir = tmp();
    mkdirSync(join(dir, 'sub'));
    const x = writeTemplate(dir, 'x.json', { Y: 'y.json' });
    symlinkSync(join('..', 'x.json'), join(dir, 'sub', 'x.json'), 'file');
    writeTemplate(dir, 'y.json', {});
    writeTemplate(join(dir, 'sub'), 'y.json', {});
    const a = writeTemplate(dir, 'a.json', { ViaSub: 'sub/x.json', Direct: 'x.json' });

    expect(findNestedTemplateTreeDefect({ Child: a })).toBeUndefined();
    expect(findNestedTemplateTreeDefect({ Child: x })).toBeUndefined();
  });

  it('resolves a template identity through realpath(3), not the lexical JS walker', () => {
    // `templateIdentity` realpaths the template's DIRECTORY, and plain
    // `fs.realpathSync` is a JS walker that folds `..` lexically. The `..`
    // must live inside a LINK TARGET on disk — every path the walk builds is
    // already `path.join`ed, and `join` folds `..` first. With
    // `a -> <root>/outside/sub` and `d -> a/../real`, the walker answers
    // ENOENT for a directory the kernel resolves, so two spellings of ONE
    // file get two identities and the cycle guard stops seeing the repeat.
    const root = tmp();
    mkdirSync(join(root, 'outside', 'sub'), { recursive: true });
    mkdirSync(join(root, 'outside', 'real'), { recursive: true });
    symlinkSync(join(root, 'outside', 'sub'), join(root, 'a'), 'dir');
    symlinkSync('a/../real', join(root, 'd'), 'dir');
    // One real file at <root>/outside/real/t.json, self-referencing.
    writeTemplate(join(root, 'outside', 'real'), 't.json', { Loop: 't.json' });

    const defect = findNestedTemplateTreeDefect({ Entry: join(root, 'd', 't.json') });

    expect(defect?.kind).toBe('cycle');
    // Both hops report the REAL location, which is what proves the kernel
    // resolved it; the lexical walker cannot name this path at all.
    expect(defect?.chain.map((h) => h.templatePath)).toEqual([
      join(root, 'outside', 'real', 't.json'),
      join(root, 'outside', 'real', 't.json'),
    ]);
  });

  it('refuses a row whose `..` leaves the directory it is resolved against', () => {
    // `path.join` folds `..`, so this row used to be walked — and, at deploy
    // and diff time, READ and deployed (go-to-k/cdkd#3489). The walk refuses
    // exactly the rows `NestedStackProvider.indexGrandchildTemplates` and
    // `indexNestedChildTemplates` refuse, so the up-front guard and the
    // per-level backstop cannot disagree about which trees are well-formed.
    const dir = tmp();
    mkdirSync(join(dir, 'out'));
    const a = writeTemplate(join(dir, 'out'), 'a.json', { Escape: '../outside.json' });
    writeTemplate(dir, 'outside.json', {});

    const defect = findNestedTemplateTreeDefect({ Root: a });

    expect(defect).toEqual({
      kind: 'escaping-path',
      chain: [{ logicalId: 'Root', templatePath: a }],
      logicalId: 'Escape',
      assetPath: '../outside.json',
      escape: { contained: false, escape: 'lexical', path: join(dir, 'outside.json') },
      dir: join(dir, 'out'),
    });
  });

  it('refuses a row that stays inside lexically but leads out through a symlink', () => {
    // The shape this once described: `out/d -> ../other/real`, where t.json's
    // row `../a.json` is a leaf when t.json is reached as other/real/t.json and
    // closes a cycle when it is reached as out/d/t.json — so a subtree proven
    // clean under one spelling must not vouch for the other. Containment now
    // refuses `d/t.json` first: it is lexically inside `out` and the symlink
    // leads to `other/real/t.json`, which is not (go-to-k/cdkd#3489). The
    // memo's LEXICAL keying is still exercised by the `d1 -> .` / `d2 -> .`
    // trees below, whose spellings differ without leaving the directory.
    const dir = tmp();
    mkdirSync(join(dir, 'out'));
    mkdirSync(join(dir, 'other', 'real'), { recursive: true });
    symlinkSync(join('..', 'other', 'real'), join(dir, 'out', 'd'), 'dir');
    const c = writeTemplate(join(dir, 'out'), 'c.json', { Y: 'a.json' });
    writeTemplate(join(dir, 'out'), 'a.json', { T: 'd/t.json' });
    writeTemplate(join(dir, 'other', 'real'), 't.json', { U: '../a.json' });
    writeTemplate(join(dir, 'other'), 'a.json', {});

    const defect = findNestedTemplateTreeDefect({ C: c });

    expect(defect?.kind).toBe('escaping-path');
    expect(defect?.chain.map((h) => h.logicalId)).toEqual(['C', 'Y']);
    expect(defect).toMatchObject({
      logicalId: 'T',
      assetPath: 'd/t.json',
      escape: {
        escape: 'symlink',
        path: join(dir, 'out', 'd', 't.json'),
        realPath: join(dir, 'other', 'real', 't.json'),
      },
    });
  });

  it('follows an ARRAY-valued Resources exactly as the deploy does', () => {
    // `Object.entries` indexes an array as '0', '1', ..., and the provider
    // follows those rows, so a walk that skipped them accepted this cycle.
    const dir = tmp();
    const a = join(dir, 'a.json');
    writeFileSync(
      a,
      JSON.stringify({
        Resources: [
          { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': 'a.json' } },
        ],
      })
    );

    expect(findNestedTemplateTreeDefect({ Child: a })).toEqual({
      kind: 'cycle',
      chain: [
        { logicalId: 'Child', templatePath: a },
        { logicalId: '0', templatePath: a },
      ],
    });
  });

  it('ignores an entry whose path is not a string instead of throwing', () => {
    // What a plain-object index answers for a logical id of `__proto__`.
    const poisoned = { Child: Object.prototype } as unknown as Record<string, string>;

    expect(findNestedTemplateTreeDefect(poisoned)).toBeUndefined();
  });

  it('walks every entry row, not only the first', () => {
    const dir = tmp();
    const fine = writeTemplate(dir, 'fine.json', {});
    const loop = writeTemplate(dir, 'loop.json', { Loop: 'loop.json' });

    const defect = findNestedTemplateTreeDefect({ First: fine, Second: loop });

    expect(defect?.chain.map((h) => h.logicalId)).toEqual(['Second', 'Loop']);
  });

  it('stops quietly at a row that points into a directory that does not exist', () => {
    const dir = tmp();
    const a = writeTemplate(dir, 'a.json', { Gone: 'no-such-dir/x.json' });

    expect(findNestedTemplateTreeDefect({ Child: a })).toBeUndefined();
  });

  it(`refuses a chain of more than ${MAX_NESTING_DEPTH} DISTINCT templates instead of overflowing the stack`, () => {
    const dir = tmp();
    const count = MAX_NESTING_DEPTH + 40;
    writeTemplate(dir, `t${count}.json`, {});
    for (let i = count - 1; i >= 0; i--) writeTemplate(dir, `t${i}.json`, { N: `t${i + 1}.json` });

    const defect = findNestedTemplateTreeDefect({ Child: join(dir, 't0.json') });

    expect(defect?.kind).toBe('too-deep');
    expect(defect?.chain).toHaveLength(MAX_NESTING_DEPTH + 1);
  });

  it(`accepts a chain of exactly ${MAX_NESTING_DEPTH} templates`, () => {
    const dir = tmp();
    const last = MAX_NESTING_DEPTH - 1;
    writeTemplate(dir, `t${last}.json`, {});
    for (let i = last - 1; i >= 0; i--) writeTemplate(dir, `t${i}.json`, { N: `t${i + 1}.json` });

    expect(findNestedTemplateTreeDefect({ Child: join(dir, 't0.json') })).toBeUndefined();
  });

  it('refuses a tree that symlinked directories multiply without ever repeating on one chain', () => {
    // `d1 -> .` and `d2 -> .` let every row be spelled through either link, so
    // one file has ever more lexical paths the deeper it sits, and the
    // path-keyed memo cannot collapse them. No chain repeats an identity,
    // because each level is a different file. The spellings double per level
    // (the bare step adds no new spelling).
    // Sized just past the budget on that base so that a LOST budget lets the walk
    // finish and return `undefined`, failing the assertion below, rather than
    // spinning a synchronous walk no test timeout can interrupt.
    const dir = tmp();
    symlinkSync('.', join(dir, 'd1'), 'dir');
    symlinkSync('.', join(dir, 'd2'), 'dir');
    const levels = Math.ceil(Math.log2(MAX_ROWS_FOLLOWED)) + 1;
    writeTemplate(dir, `t${levels}.json`, {});
    for (let i = levels - 1; i >= 0; i--) {
      const next = `t${i + 1}.json`;
      writeTemplate(dir, `t${i}.json`, { A: next, B: `d1/${next}`, C: `d2/${next}` });
    }

    const defect = findNestedTemplateTreeDefect({ Child: join(dir, 't0.json') });

    expect(defect?.kind).toBe('too-large');
  });

  it(`accepts a tree that follows exactly ${MAX_ROWS_FOLLOWED} rows and refuses one more`, () => {
    // One wide template whose rows all name a single leaf: the entry row, the
    // first leaf visit, and then one row per memo hit. Pins the budget's value
    // (a shrunken budget would refuse a legitimate wide assembly) and that a
    // memo hit costs one row.
    const wide = (rows: number): string => {
      const dir = tmp();
      writeTemplate(dir, 'leaf.json', {});
      const map: Record<string, string> = {};
      for (let i = 0; i < rows; i++) map[`R${i}`] = 'leaf.json';
      return writeTemplate(dir, 'wide.json', map);
    };

    expect(findNestedTemplateTreeDefect({ Child: wide(MAX_ROWS_FOLLOWED - 1) })).toBeUndefined();
    expect(findNestedTemplateTreeDefect({ Child: wide(MAX_ROWS_FOLLOWED) })?.kind).toBe(
      'too-large'
    );
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

describe('listNestedTemplateRows', () => {
  it('returns no rows for a template with no usable Resources container', () => {
    for (const template of [null, undefined, 7, 'text', {}, { Resources: null }, { Resources: 7 }]) {
      expect(listNestedTemplateRows(template)).toEqual([]);
    }
  });

  it('returns the rows that name a child template, in template order', () => {
    expect(
      listNestedTemplateRows({
        Resources: {
          B: { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': 'b.json' } },
          Topic: { Type: 'AWS::SNS::Topic' },
          A: { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': '/abs/a.json' } },
        },
      })
    ).toEqual([
      { logicalId: 'B', assetPath: 'b.json' },
      { logicalId: 'A', assetPath: '/abs/a.json' },
    ]);
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
    // The OWNING stack of the closing row, derived the way the provider
    // derives a child's name: one `~<logicalId>` per hop above it.
    expect(text).toContain(
      "Nested stack 'BackToA' (declared in stack 'Parent~Child~ToB') resolves to a template " +
        'that is already on that nesting chain'
    );
    expect(text).toContain('Refusing to deploy any level of it.');
    // Anchors the needle the too-large case asserts is ABSENT.
    expect(text).toContain('hand-modified');
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

  it('renders a chain of exactly 8 hops in full and elides from 9', () => {
    const hops = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ logicalId: `L${i}`, templatePath: `/out/t${i}.json` }));

    const eight = renderNestedTemplateTreeDefect({ kind: 'cycle', chain: hops(8) }, 'P', 'deploy');
    const nine = renderNestedTemplateTreeDefect({ kind: 'cycle', chain: hops(9) }, 'P', 'deploy');

    expect(eight).not.toContain(' more ...');
    expect(eight).toContain("'L4' (/out/t4.json)");
    expect(nine).toContain('... 1 more ...');
    expect(nine).not.toContain("'L4' (/out/t4.json)");
  });

  it('says why a too-large tree is refused', () => {
    const text = renderNestedTemplateTreeDefect(
      { kind: 'too-large', chain: [{ logicalId: 'Child', templatePath: '/out/a.json' }] },
      'P',
      'deploy'
    );

    expect(text).toContain(`has more than ${MAX_ROWS_FOLLOWED} nested-stack rows to follow`);
    expect(text).toContain("the walk stopped at 'Child' (/out/a.json)");
    expect(text).toContain('Refusing to deploy.');
    // A genuinely huge tree need not be hand-modified, so this arm does not
    // carry the provenance sentence the other refusals do.
    expect(text).not.toContain('hand-modified');
  });

  it('elides the owning stack name of a long chain the way it elides the chain', () => {
    const chain = Array.from({ length: 30 }, (_, i) => ({
      logicalId: `L${i}`,
      templatePath: `/out/t${i}.json`,
    }));
    chain.push({ logicalId: 'Closer', templatePath: '/out/t0.json' });

    const text = renderNestedTemplateTreeDefect({ kind: 'cycle', chain }, 'P', 'deploy');

    expect(text).toContain("(declared in stack 'P~L0~L1~L2~L3~...22 more...~L26~L27~L28~L29')");
  });

  it('says why a too-deep tree is refused', () => {
    const text = renderNestedTemplateTreeDefect(
      { kind: 'too-deep', chain: [{ logicalId: 'Child', templatePath: '/out/a.json' }] },
      'P',
      'deploy'
    );

    expect(text).toContain(`nests more than ${MAX_NESTING_DEPTH} levels deep`);
    expect(text).toContain('S3 caps a key at 1024 bytes');
    expect(text).toContain('Refusing to deploy.');
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
    expect(text).toContain("Metadata['aws:asset:path']=/abs.json which is absolute");
  });

  it('names the rows leading to an ESCAPING path, worded apart from the absolute one', () => {
    // The two refusals answer different questions (go-to-k/cdkd#3489):
    // `path.join` never lets an absolute value leave the directory, and `..`,
    // which does, is invisible to the absolute tripwire.
    const text = renderNestedTemplateTreeDefect(
      {
        kind: 'escaping-path',
        chain: [{ logicalId: 'Child', templatePath: '/out/a.json' }],
        logicalId: 'E',
        assetPath: '../../etc/passwd',
        escape: { contained: false, escape: 'lexical', path: '/etc/passwd' },
        dir: '/out',
      },
      'P',
      'deploy'
    );

    expect(text).toContain("nested stack 'E' (reached through 'Child' (/out/a.json))");
    expect(text).toContain(
      "Metadata['aws:asset:path']=../../etc/passwd which resolves to /etc/passwd, outside /out."
    );
    expect(text).toContain('Refusing to deploy.');
    expect(text).not.toContain('is absolute');
  });

  it('names the symlink target when an escaping path is lexically contained', () => {
    const text = renderNestedTemplateTreeDefect(
      {
        kind: 'escaping-path',
        chain: [{ logicalId: 'Child', templatePath: '/out/a.json' }],
        logicalId: 'E',
        assetPath: 'link/t.json',
        escape: {
          contained: false,
          escape: 'symlink',
          path: '/out/link/t.json',
          realPath: '/etc/t.json',
        },
        dir: '/out',
      },
      'P',
      'diff'
    );

    expect(text).toContain("leads through a symbolic link to /etc/t.json, outside /out.");
    expect(text).toContain('Refusing to diff.');
  });

  it('strips terminal-forging characters from an escaping-path refusal', () => {
    const forged = `E${String.fromCharCode(0x9b)}[2KFORGED`;
    const text = renderNestedTemplateTreeDefect(
      {
        kind: 'escaping-path',
        chain: [{ logicalId: forged, templatePath: `/out/${forged}.json` }],
        logicalId: forged,
        assetPath: `../${forged}`,
        escape: { contained: false, escape: 'lexical', path: `/${forged}` },
        dir: `/o\u202eut`,
      },
      `P${String.fromCharCode(0x85)}Stack`,
      'deploy'
    );

    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
  });
});
