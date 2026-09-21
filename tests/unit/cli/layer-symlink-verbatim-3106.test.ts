import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { materializeLambdaLayers as materializeForInvoke } from '../../../src/cli/commands/local-invoke.js';
import { materializeLambdaLayers as materializeForStartApi } from '../../../src/cli/commands/local-start-api.js';
import { copyLayerTreeLastWins } from '../../../src/local/layer-tree-copy.js';

/**
 * Issue #3106: a RELATIVE symlink inside a Lambda Layer asset must arrive in
 * the merged `/opt` tmpdir as the SAME relative link. Both layer copies WENT
 * through `fs.cpSync`, whose `verbatimSymlinks` defaults to false — and a
 * non-verbatim copy rewrites the link target to the ABSOLUTE path of the
 * source on the host, which is dangling inside the container (only the
 * merged tmpdir is bind-mounted). Measured on Node 22.12 / 24.21 before the
 * fix: `readlink` on the copy answered `<asset dir>/bin/real.sh`, and the
 * comment above the call had claimed the opposite since the #241 backlog.
 *
 * The discriminator is `readlinkSync` of the copied link, not "the link
 * exists": both the fixed and the broken copy produce a symlink at that
 * path. Two layers are handed in so the MERGE branch runs — a single layer
 * is bind-mounted directly and never copied. The `local-invoke-layers`
 * fixture carries the same link and EXECS through it inside the container.
 *
 * The second group pins why the fix is an explicit walk and not a `cpSync`
 * option: with `verbatimSymlinks: true`, Node's C++ `cpSync` (every release
 * after 22.12) throws `EEXIST` when a later layer carries a symlink at a
 * path an earlier layer already placed one — `node_modules/.bin/<tool>` in
 * two layers built from the same dependency — so the merge that used to
 * succeed would refuse; and a recursive `readdirSync` DESCENDS into
 * directory symlinks on the same releases, so a cyclic link hung the merge
 * and an absolute link to a host directory made it write INSIDE the host
 * directory (both found by the go-to-k/cdkd#3118 review rounds). The helper
 * recurses only on real directories, applies last-wins to every kind
 * (link / file / directory over any of the others), keeps `+x`, and never
 * resolves or writes through a link.
 */

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function layerWithRelativeSymlink(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-3106-layer-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'real.sh'), '#!/bin/sh\necho real\n', { mode: 0o755 });
  symlinkSync('real.sh', join(dir, 'bin', 'rel-link'));
  return dir;
}

function plainLayer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-3106-plain-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'nodejs'));
  writeFileSync(join(dir, 'nodejs', 'x.js'), 'module.exports = 1;\n');
  return dir;
}

describe('a relative symlink inside a layer stays relative in the merged /opt (#3106)', () => {
  it('cdkd local invoke: materializeLambdaLayers copies the link verbatim', () => {
    const withLink = layerWithRelativeSymlink();
    const plain = plainLayer();
    const result = materializeForInvoke([
      { logicalId: 'WithLink', assetPath: withLink },
      { logicalId: 'Plain', assetPath: plain },
    ]);
    expect(result.tmpDir, 'two layers must take the merge branch').toBeDefined();
    scratch.push(result.tmpDir!);
    expect(readlinkSync(join(result.tmpDir!, 'bin', 'rel-link'))).toBe('real.sh');
  });

  it('cdkd local start-api: materializeLambdaLayers copies the link verbatim', async () => {
    const withLink = layerWithRelativeSymlink();
    const plain = plainLayer();
    const tmpDirs = new Set<string>();
    const merged = await materializeForStartApi(
      [
        { kind: 'asset', logicalId: 'WithLink', assetPath: withLink },
        { kind: 'asset', logicalId: 'Plain', assetPath: plain },
      ],
      tmpDirs,
      undefined
    );
    expect(merged, 'two layers must take the merge branch').toBeDefined();
    for (const d of tmpDirs) scratch.push(d);
    scratch.push(merged!);
    expect(readlinkSync(join(merged!, 'bin', 'rel-link'))).toBe('real.sh');
  });
});

describe('copyLayerTreeLastWins merges symlinks last-wins without resolving them (#3106)', () => {
  function layer(name: string, build: (dir: string) => void): string {
    const dir = mkdtempSync(join(tmpdir(), `cdkd-3106-${name}-`));
    scratch.push(dir);
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'nodejs', 'node_modules', 'x'), { recursive: true });
    build(dir);
    return dir;
  }
  function mergedOf(...layers: string[]): string {
    const dest = mkdtempSync(join(tmpdir(), 'cdkd-3106-merged-'));
    scratch.push(dest);
    for (const l of layers) copyLayerTreeLastWins(l, dest);
    return dest;
  }

  it('the same relative link in two layers merges (the shape that made bare verbatimSymlinks throw EEXIST)', () => {
    const a = layer('a', (d) => {
      writeFileSync(join(d, 'bin', 'real.sh'), '#!/bin/sh\necho a\n', { mode: 0o755 });
      symlinkSync('real.sh', join(d, 'bin', 'link'));
      symlinkSync('x', join(d, 'nodejs', 'node_modules', 'dirlink'));
    });
    const b = layer('b', (d) => {
      writeFileSync(join(d, 'bin', 'real.sh'), '#!/bin/sh\necho b\n', { mode: 0o755 });
      symlinkSync('real.sh', join(d, 'bin', 'link'));
      symlinkSync('x', join(d, 'nodejs', 'node_modules', 'dirlink'));
    });
    const dest = mergedOf(a, b);
    expect(readlinkSync(join(dest, 'bin', 'link'))).toBe('real.sh');
    expect(readlinkSync(join(dest, 'nodejs', 'node_modules', 'dirlink'))).toBe('x');
    // Last wins for the file the link resolves to, and `+x` survives.
    expect(readFileSync(join(dest, 'bin', 'real.sh'), 'utf8')).toContain('echo b');
    expect(statSync(join(dest, 'bin', 'real.sh')).mode & 0o111).not.toBe(0);
  });

  it('a later layer replaces a link with a file, and a file with a link (last wins in both directions)', () => {
    const a = layer('a', (d) => {
      writeFileSync(join(d, 'bin', 'real.sh'), 'a\n');
      symlinkSync('real.sh', join(d, 'bin', 'link-then-file'));
      writeFileSync(join(d, 'bin', 'file-then-link'), 'FILE\n');
    });
    const b = layer('b', (d) => {
      writeFileSync(join(d, 'bin', 'real.sh'), 'b\n');
      writeFileSync(join(d, 'bin', 'link-then-file'), 'FILE\n');
      symlinkSync('real.sh', join(d, 'bin', 'file-then-link'));
    });
    const dest = mergedOf(a, b);
    expect(lstatSync(join(dest, 'bin', 'link-then-file')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dest, 'bin', 'link-then-file'), 'utf8')).toBe('FILE\n');
    expect(readlinkSync(join(dest, 'bin', 'file-then-link'))).toBe('real.sh');
  });

  it('an absolute link and a dangling link are copied as they are, never resolved', () => {
    const a = layer('a', (d) => {
      symlinkSync('/abs/host/path', join(d, 'bin', 'abs'));
      symlinkSync('missing', join(d, 'bin', 'dangling'));
    });
    const b = layer('b', () => {});
    const dest = mergedOf(a, b);
    expect(readlinkSync(join(dest, 'bin', 'abs'))).toBe('/abs/host/path');
    expect(readlinkSync(join(dest, 'bin', 'dangling'))).toBe('missing');
  });

  it("a later layer's link replaces an earlier layer's DIRECTORY at that path (last wins, subtree included)", () => {
    const a = layer('a', (d) => {
      mkdirSync(join(d, 'python'));
      writeFileSync(join(d, 'python', 'a.py'), 'a\n');
    });
    const b = layer('b', (d) => {
      mkdirSync(join(d, 'python3.12'));
      writeFileSync(join(d, 'python3.12', 'b.py'), 'b\n');
      symlinkSync('python3.12', join(d, 'python'));
    });
    const dest = mergedOf(a, b);
    expect(readlinkSync(join(dest, 'python'))).toBe('python3.12');
    expect(existsSync(join(dest, 'python', 'a.py'))).toBe(false);
    expect(readFileSync(join(dest, 'python', 'b.py'), 'utf8')).toBe('b\n');
  });

  it("a later layer's DIRECTORY replaces an earlier layer's link — nothing is written through the link", () => {
    const a = layer('a', (d) => {
      writeFileSync(join(d, 'nodejs', 'node_modules', 'x', 'index.js'), 'A\n');
      symlinkSync('x', join(d, 'nodejs', 'node_modules', 'pkg'));
    });
    const b = layer('b', (d) => {
      mkdirSync(join(d, 'nodejs', 'node_modules', 'pkg'));
      writeFileSync(join(d, 'nodejs', 'node_modules', 'pkg', 'index.js'), 'B\n');
    });
    const dest = mergedOf(a, b);
    expect(lstatSync(join(dest, 'nodejs', 'node_modules', 'pkg')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dest, 'nodejs', 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('B\n');
    // The link's former target, from layer A, is untouched — the old
    // `cpSync({ force })` wrote B's files THROUGH the link into it.
    expect(readFileSync(join(dest, 'nodejs', 'node_modules', 'x', 'index.js'), 'utf8')).toBe('A\n');
    expect(readFileSync(join(a, 'nodejs', 'node_modules', 'x', 'index.js'), 'utf8')).toBe('A\n');
  });

  it("a later layer's FILE replaces a directory and a dangling link, and its DIRECTORY replaces a file", () => {
    // The two arms the cases above do not reach: the file branch's guard and
    // the directory branch's guard, each against the OTHER kind. Measured on
    // Node 24.21 with the guard removed: a single-file `cpSync` onto a
    // directory throws `ERR_FS_CP_NON_DIR_TO_DIR`, onto a dangling link it
    // ABORTS THE PROCESS (a C++ `filesystem_error` no JS frame catches, rc
    // 134), and `mkdirSync({ recursive })` onto a file throws `EEXIST`.
    const a = layer('a', (d) => {
      mkdirSync(join(d, 'python', 'foo'), { recursive: true });
      writeFileSync(join(d, 'python', 'foo', 'x.py'), 'a\n');
      symlinkSync('missing', join(d, 'bin', 'tool'));
      writeFileSync(join(d, 'bin', 'pkg'), 'FILE\n');
    });
    const b = layer('b', (d) => {
      mkdirSync(join(d, 'python'));
      writeFileSync(join(d, 'python', 'foo'), 'FILE\n');
      writeFileSync(join(d, 'bin', 'tool'), '#!/bin/sh\necho tool\n', { mode: 0o755 });
      mkdirSync(join(d, 'bin', 'pkg'));
      writeFileSync(join(d, 'bin', 'pkg', 'y'), 'B\n');
    });
    const dest = mergedOf(a, b);
    expect(lstatSync(join(dest, 'python', 'foo')).isFile()).toBe(true);
    expect(readFileSync(join(dest, 'python', 'foo'), 'utf8')).toBe('FILE\n');
    expect(lstatSync(join(dest, 'bin', 'tool')).isFile()).toBe(true);
    expect(readFileSync(join(dest, 'bin', 'tool'), 'utf8')).toContain('echo tool');
    expect(lstatSync(join(dest, 'bin', 'pkg')).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, 'bin', 'pkg', 'y'), 'utf8')).toBe('B\n');
  });

  it('a cyclic directory link terminates the walk, and an absolute link to a host directory never reaches the host', () => {
    const host = mkdtempSync(join(tmpdir(), 'cdkd-3106-host-'));
    scratch.push(host);
    writeFileSync(join(host, 'host.txt'), 'HOST\n');
    symlinkSync('host.txt', join(host, 'hostlink'));
    const a = layer('a', (d) => {
      mkdirSync(join(d, 'sub', 'real'), { recursive: true });
      writeFileSync(join(d, 'sub', 'real', 'f'), 'f\n');
      symlinkSync('..', join(d, 'sub', 'up'));
      symlinkSync(host, join(d, 'nodejs', 'node_modules', 'ext'));
    });
    const b = layer('b', (d) => {
      // A real directory at the path A linked to the host: it must land in
      // dest, never inside the host directory.
      mkdirSync(join(d, 'nodejs', 'node_modules', 'ext'));
      writeFileSync(join(d, 'nodejs', 'node_modules', 'ext', 'payload.txt'), 'PAYLOAD\n');
      symlinkSync('payload.txt', join(d, 'nodejs', 'node_modules', 'ext', 'l'));
    });
    const dest = mergedOf(a, b);
    expect(readlinkSync(join(dest, 'sub', 'up'))).toBe('..');
    expect(readFileSync(join(dest, 'sub', 'real', 'f'), 'utf8')).toBe('f\n');
    expect(lstatSync(join(dest, 'nodejs', 'node_modules', 'ext')).isDirectory()).toBe(true);
    expect(readlinkSync(join(dest, 'nodejs', 'node_modules', 'ext', 'l'))).toBe('payload.txt');
    expect(readdirSync(host).sort()).toEqual(['host.txt', 'hostlink']);
  });

  it('an asset dir handed over through a symlink is copied whole (the root is resolved first)', () => {
    const real = layer('real', (d) => {
      writeFileSync(join(d, 'bin', 'x'), 'x\n');
      symlinkSync('x', join(d, 'bin', 'l'));
    });
    const holder = mkdtempSync(join(tmpdir(), 'cdkd-3106-linkroot-'));
    scratch.push(holder);
    const linkRoot = join(holder, 'asset');
    symlinkSync(real, linkRoot);
    const dest = mergedOf(linkRoot, plainLayer());
    expect(readFileSync(join(dest, 'bin', 'x'), 'utf8')).toBe('x\n');
    expect(readlinkSync(join(dest, 'bin', 'l'))).toBe('x');
  });
});

describe('a merge that throws mid-loop removes the tmpdir it had allocated (#3106 round 3)', () => {
  // A later layer whose asset path does not exist makes the helper throw
  // after the tmpdir exists; without the guard nobody ever sees that
  // tmpdir, so it sits in the OS tmp root forever. `os.tmpdir()` re-reads
  // `TMPDIR` on every call, so pointing it at a per-test scratch directory
  // makes "nothing left behind" a hermetic assertion — a concurrent vitest
  // worker or a real invoke on the host cannot write into it.
  const missing = join(tmpdir(), 'cdkd-3106-does-not-exist-' + process.pid);
  // The fixture layer is created BEFORE `TMPDIR` is redirected, so the only
  // thing that can appear in the scratch directory is the helper's tmpdir.
  function withScratchTmpdir(
    run: (scratchTmp: string, plain: string) => void | Promise<void>
  ): Promise<void> {
    const plain = plainLayer();
    const scratchTmp = mkdtempSync(join(tmpdir(), 'cdkd-3106-tmp-'));
    scratch.push(scratchTmp);
    const saved = process.env['TMPDIR'];
    process.env['TMPDIR'] = scratchTmp;
    return Promise.resolve()
      .then(() => run(scratchTmp, plain))
      .finally(() => {
        if (saved === undefined) delete process.env['TMPDIR'];
        else process.env['TMPDIR'] = saved;
      });
  }

  it('cdkd local invoke', () =>
    withScratchTmpdir((scratchTmp, plain) => {
      expect(() =>
        materializeForInvoke([
          { logicalId: 'Plain', assetPath: plain },
          { logicalId: 'Missing', assetPath: missing },
        ])
      ).toThrow(/ENOENT/);
      expect(readdirSync(scratchTmp), 'the merge tmpdir was left behind').toEqual([]);
    }));

  it('cdkd local start-api', () =>
    withScratchTmpdir(async (scratchTmp, plain) => {
      const tmpDirs = new Set<string>();
      await expect(
        materializeForStartApi(
          [
            { kind: 'asset', logicalId: 'Plain', assetPath: plain },
            { kind: 'asset', logicalId: 'Missing', assetPath: missing },
          ],
          tmpDirs,
          undefined
        )
      ).rejects.toThrow(/ENOENT/);
      expect(tmpDirs.size).toBe(0);
      expect(readdirSync(scratchTmp), 'the merge tmpdir was left behind').toEqual([]);
    }));
});

describe('copyLayerTreeLastWins resolves its source through realpath(3)', () => {
  // `.native`, not plain `fs.realpathSync`: the plain form is a JS walker that
  // folds `..` LEXICALLY, so a source reached through a directory link whose
  // path carries a `..` after it answers ENOENT for a tree the kernel resolves
  // — the copy then throws instead of merging a layer that is really there.
  // On a case-insensitive filesystem the same shape can make it spin
  // (go-to-k/cdkd#3489). Reverting the `.native` reds this.
  it('copies a layer whose root is a link whose TARGET carries a `..`', () => {
    // The `..` has to live inside the LINK TARGET on disk, not in the path
    // string: every caller's path is already `path.join`ed, and `join` folds
    // `..` before `realpath` ever sees it. With `a -> <root>/outside/sub` and
    // `alias -> a/../real`, the JS walker folds `a/..` lexically to the
    // staging dir and answers ENOENT for a directory the kernel resolves —
    // so the copy throws instead of merging a layer that is really there.
    // Measured: js=ENOENT, native=<root>/outside/real.
    const root = mkdtempSync(join(tmpdir(), 'cdkd-layer-native-'));
    try {
      mkdirSync(join(root, 'outside', 'sub'), { recursive: true });
      mkdirSync(join(root, 'outside', 'real', 'nodejs'), { recursive: true });
      writeFileSync(join(root, 'outside', 'real', 'nodejs', 'index.js'), 'module.exports = 1;\n');
      mkdirSync(join(root, 'stage'), { recursive: true });
      symlinkSync(join(root, 'outside', 'sub'), join(root, 'stage', 'a'), 'dir');
      symlinkSync('a/../real', join(root, 'stage', 'alias'), 'dir');

      const dest = join(root, 'dest');
      copyLayerTreeLastWins(join(root, 'stage', 'alias'), dest);

      expect(readFileSync(join(dest, 'nodejs', 'index.js'), 'utf-8')).toContain('module.exports');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
