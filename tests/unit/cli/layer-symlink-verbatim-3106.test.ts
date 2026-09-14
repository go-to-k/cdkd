import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
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
 * the merged `/opt` tmpdir as the SAME relative link. Both layer copies go
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
 * The second group pins why the fix is a helper and not `verbatimSymlinks:
 * true` on the old call: with that option, Node's C++ `cpSync` (every
 * release after 22.12) throws `EEXIST` when a later layer carries a symlink
 * at a path an earlier layer already placed one — `node_modules/.bin/<tool>`
 * in two layers built from the same dependency — so the merge that used to
 * succeed would refuse (found by the go-to-k/cdkd#3118 review). The helper
 * places symlinks by hand, last-wins, for link-over-link, link-over-file
 * and file-over-link, keeps `+x`, and never resolves a target.
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
});
