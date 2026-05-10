import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materializeLambdaLayers } from '../../../src/cli/commands/local-invoke.js';

/**
 * Tests for `materializeLambdaLayers` — the load-bearing helper of PR 6
 * of #224 (issue #232). The integ test at
 * `tests/integration/local-invoke-layers/` exercises the same code path
 * end-to-end with a real Docker container, but it's skipped in CI
 * (Docker not available in the runner) so the merge-on-host semantic
 * was previously only verified by manual integ runs. These unit tests
 * close that CI-coverage gap.
 *
 * Spec recap (from the docstring on `materializeLambdaLayers`):
 *
 *   1. zero layers → `{}` (no mount, no tmpDir).
 *   2. one layer → `{ mount: { hostPath: <asset>, /opt, ro }, tmpDir: undefined }`
 *      (bind-mount the asset dir directly — no copy).
 *   3. 2+ layers → `{ mount: { hostPath: <merged-tmpdir>, /opt, ro }, tmpDir: <set> }`
 *      where the tmpdir contains every layer's files, with LATER LAYERS
 *      OVERWRITING EARLIER ones (AWS "last layer wins" on file collision).
 */

// Create a fresh fixture layer asset dir under an OS tmpdir. Returns the
// path; caller is responsible for cleanup (via the `dirsToCleanup` ledger
// below).
function makeLayerAsset(label: string, files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), `cdkd-test-layer-${label}-`));
  for (const [relPath, contents] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf-8');
  }
  return dir;
}

describe('materializeLambdaLayers', () => {
  // Track tmpdirs created across tests so we always clean up even when
  // a test throws — `materializeLambdaLayers` itself returns the merged
  // tmpdir for the caller to cleanup, but the per-layer fixture dirs
  // are ours.
  const dirsToCleanup: string[] = [];

  beforeEach(() => {
    dirsToCleanup.length = 0;
  });

  afterEach(() => {
    for (const dir of dirsToCleanup) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  it('returns {} when layers is empty (no mount, no tmpDir)', () => {
    const result = materializeLambdaLayers([]);
    expect(result).toEqual({});
    expect(result.mount).toBeUndefined();
    expect(result.tmpDir).toBeUndefined();
  });

  it('returns mount only (no tmpDir) for a single layer — bind-mount the asset dir directly', () => {
    const single = makeLayerAsset('single', {
      'nodejs/node_modules/my-pkg/index.js': "module.exports = 'single';",
    });
    dirsToCleanup.push(single);

    const result = materializeLambdaLayers([{ logicalId: 'L1', assetPath: single }]);

    expect(result.mount).toEqual({
      hostPath: single,
      containerPath: '/opt',
      readOnly: true,
    });
    expect(result.tmpDir).toBeUndefined();
  });

  it('merges multiple layers with last-wins semantics (later layers overwrite earlier files)', () => {
    // Two layers that BOTH install `util-greetings/index.js`. The
    // function declares `Layers: [A, B]` so B wins.
    const layerA = makeLayerAsset('a', {
      'nodejs/node_modules/util-greetings/index.js': "module.exports = 'from-A';",
      'nodejs/node_modules/util-greetings/package.json': '{"name":"util-greetings","version":"1"}',
      // A-only file — must survive the merge (only the colliding path is
      // overwritten, every other file stays).
      'nodejs/node_modules/util-only-a/index.js': "module.exports = 'a-only';",
    });
    const layerB = makeLayerAsset('b', {
      'nodejs/node_modules/util-greetings/index.js': "module.exports = 'from-B';",
      // B-only file — must also survive.
      'nodejs/node_modules/util-only-b/index.js': "module.exports = 'b-only';",
    });
    dirsToCleanup.push(layerA, layerB);

    const result = materializeLambdaLayers([
      { logicalId: 'A', assetPath: layerA },
      { logicalId: 'B', assetPath: layerB },
    ]);

    expect(result.mount).toBeDefined();
    expect(result.mount?.containerPath).toBe('/opt');
    expect(result.mount?.readOnly).toBe(true);
    expect(result.tmpDir).toBeDefined();
    expect(result.mount?.hostPath).toBe(result.tmpDir);

    const tmpDir = result.tmpDir as string;
    dirsToCleanup.push(tmpDir);

    // Last-wins: the colliding file resolves to B's content.
    const greetings = readFileSync(
      path.join(tmpDir, 'nodejs/node_modules/util-greetings/index.js'),
      'utf-8'
    );
    expect(greetings).toBe("module.exports = 'from-B';");

    // Disjoint files from BOTH layers survive.
    const onlyA = readFileSync(
      path.join(tmpDir, 'nodejs/node_modules/util-only-a/index.js'),
      'utf-8'
    );
    expect(onlyA).toBe("module.exports = 'a-only';");
    const onlyB = readFileSync(
      path.join(tmpDir, 'nodejs/node_modules/util-only-b/index.js'),
      'utf-8'
    );
    expect(onlyB).toBe("module.exports = 'b-only';");
  });

  it('honors template order strictly — [A, B] gives B-wins, [B, A] gives A-wins', () => {
    const layerA = makeLayerAsset('order-a', {
      'shared/file.txt': 'A',
    });
    const layerB = makeLayerAsset('order-b', {
      'shared/file.txt': 'B',
    });
    dirsToCleanup.push(layerA, layerB);

    const ab = materializeLambdaLayers([
      { logicalId: 'A', assetPath: layerA },
      { logicalId: 'B', assetPath: layerB },
    ]);
    if (ab.tmpDir) dirsToCleanup.push(ab.tmpDir);
    expect(readFileSync(path.join(ab.tmpDir as string, 'shared/file.txt'), 'utf-8')).toBe('B');

    const ba = materializeLambdaLayers([
      { logicalId: 'B', assetPath: layerB },
      { logicalId: 'A', assetPath: layerA },
    ]);
    if (ba.tmpDir) dirsToCleanup.push(ba.tmpDir);
    expect(readFileSync(path.join(ba.tmpDir as string, 'shared/file.txt'), 'utf-8')).toBe('A');
  });

  it('produces a tmpDir under the OS tmp root with the expected prefix', () => {
    const layerA = makeLayerAsset('prefix-a', { 'foo.txt': 'a' });
    const layerB = makeLayerAsset('prefix-b', { 'bar.txt': 'b' });
    dirsToCleanup.push(layerA, layerB);

    const result = materializeLambdaLayers([
      { logicalId: 'A', assetPath: layerA },
      { logicalId: 'B', assetPath: layerB },
    ]);
    if (result.tmpDir) dirsToCleanup.push(result.tmpDir);

    expect(result.tmpDir).toBeDefined();
    expect(path.dirname(result.tmpDir as string)).toBe(tmpdir());
    expect(path.basename(result.tmpDir as string)).toMatch(/^cdkd-local-invoke-layers-/);
  });

  it('cleanup: caller can rmSync the returned tmpDir to remove the merged tree', () => {
    // Documents the cleanup contract: `materializeLambdaLayers` does NOT
    // own the tmpdir's lifecycle — the caller (`localInvokeCommand`'s
    // `cleanup()` helper, OR `cdkd local start-api`'s shutdown) owns it
    // by recording the returned `tmpDir` and `rmSync`'ing it.
    const layerA = makeLayerAsset('cleanup-a', { 'a.txt': 'A' });
    const layerB = makeLayerAsset('cleanup-b', { 'b.txt': 'B' });
    dirsToCleanup.push(layerA, layerB);

    const result = materializeLambdaLayers([
      { logicalId: 'A', assetPath: layerA },
      { logicalId: 'B', assetPath: layerB },
    ]);

    expect(result.tmpDir).toBeDefined();
    const tmpDir = result.tmpDir as string;
    expect(existsSync(tmpDir)).toBe(true);
    expect(existsSync(path.join(tmpDir, 'a.txt'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'b.txt'))).toBe(true);

    // Caller-driven cleanup, mirroring what `localInvokeCommand`'s
    // `cleanup()` helper and `local-start-api`'s shutdown loop do.
    rmSync(tmpDir, { recursive: true, force: true });
    expect(existsSync(tmpDir)).toBe(false);
  });

  it('single-layer path does NOT create a tmpdir (optimization — bind-mount asset dir directly)', () => {
    const single = makeLayerAsset('opt', { 'foo.txt': 'foo' });
    dirsToCleanup.push(single);

    const result = materializeLambdaLayers([{ logicalId: 'L1', assetPath: single }]);

    expect(result.tmpDir).toBeUndefined();
    expect(result.mount?.hostPath).toBe(single);
  });
});
