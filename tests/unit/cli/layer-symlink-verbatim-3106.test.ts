import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { materializeLambdaLayers as materializeForInvoke } from '../../../src/cli/commands/local-invoke.js';
import { materializeLambdaLayers as materializeForStartApi } from '../../../src/cli/commands/local-start-api.js';

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
