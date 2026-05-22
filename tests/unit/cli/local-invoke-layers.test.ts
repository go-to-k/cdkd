import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  materializeLambdaLayers,
  materializeLambdaLayersIncludingArns,
} from '../../../src/cli/commands/local-invoke.js';
import type { ResolvedLambdaLayer } from '../../../src/local/lambda-resolver.js';

// MUST-FIX 3 from PR #491 review: caller-integration tests verifying
// that `ImagePlan.layerArnTmpDirs` is populated for `cdkd local invoke`
// and that the same `extraTmpDirs` list surfaces from the helper. The
// caller's `cleanup()` walks this list with `rmSync`; without it the
// per-ARN unzip tmpdirs leak across invokes.
vi.mock('../../../src/local/layer-arn-materializer.js', () => ({
  materializeLayerFromArn: vi.fn(),
  // Re-export the error class so the production source's `import { ... }`
  // resolves; tests below don't exercise the error path here.
  LayerMaterializationError: class extends Error {},
}));

// Eagerly imported AFTER vi.mock so the production module's
// `materializeLayerFromArn` import is intercepted.
import { materializeLayerFromArn } from '../../../src/local/layer-arn-materializer.js';
const mockMaterializeLayerFromArn = vi.mocked(materializeLayerFromArn);

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

describe('materializeLambdaLayersIncludingArns (caller integration — PR #491 review MUST-FIX 3)', () => {
  // Track per-ARN tmpdirs we hand the helper from the mock so we can
  // clean them up at the end of each test.
  const dirsToCleanup: string[] = [];

  beforeEach(() => {
    mockMaterializeLayerFromArn.mockReset();
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

  /**
   * Provision a fake tmpdir on disk that the materializer mock can
   * "return" — caller-side cleanup tests need a real path that
   * `existsSync(...)` can observe before `rmSync`.
   */
  function fakeArnLayerDir(label: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `cdkd-mock-arn-layer-${label}-`));
    mkdirSync(path.join(dir, 'nodejs'), { recursive: true });
    writeFileSync(path.join(dir, 'nodejs', 'index.js'), `// ${label}`, 'utf-8');
    return dir;
  }

  it('populates extraTmpDirs with the per-ARN tmpdir (single ARN layer)', async () => {
    const arnDir = fakeArnLayerDir('single-arn');
    dirsToCleanup.push(arnDir);
    mockMaterializeLayerFromArn.mockResolvedValueOnce(arnDir);

    const layers: ResolvedLambdaLayer[] = [
      {
        kind: 'arn',
        logicalId: 'arn:aws:lambda:us-east-1:123456789012:layer:External:1',
        arn: 'arn:aws:lambda:us-east-1:123456789012:layer:External:1',
        region: 'us-east-1',
        accountId: '123456789012',
        name: 'External',
        version: '1',
      },
    ];

    // Cast to the helper's `LocalInvokeOptions` argument shape — the
    // helper only reads `layerRoleArn` so an empty literal is fine here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await materializeLambdaLayersIncludingArns(layers, {} as any);

    // The list of per-ARN tmpdirs surfaced for the caller's outer
    // cleanup to walk.
    expect(result.extraTmpDirs).toEqual([arnDir]);
    expect(existsSync(arnDir)).toBe(true);

    // Single-layer fast path: the helper does not create a merge tmpdir;
    // it bind-mounts the per-ARN dir directly.
    expect(result.tmpDir).toBeUndefined();
    expect(result.mount?.hostPath).toBe(arnDir);
    expect(result.mount?.containerPath).toBe('/opt');

    expect(mockMaterializeLayerFromArn).toHaveBeenCalledTimes(1);
  });

  it('populates extraTmpDirs for every ARN layer in a mixed [asset, arn, arn] list', async () => {
    const assetDir = mkdtempSync(path.join(tmpdir(), 'cdkd-mock-asset-layer-'));
    writeFileSync(path.join(assetDir, 'a.txt'), 'asset', 'utf-8');
    dirsToCleanup.push(assetDir);

    const arn1Dir = fakeArnLayerDir('arn1');
    const arn2Dir = fakeArnLayerDir('arn2');
    dirsToCleanup.push(arn1Dir, arn2Dir);

    mockMaterializeLayerFromArn
      .mockResolvedValueOnce(arn1Dir)
      .mockResolvedValueOnce(arn2Dir);

    const layers: ResolvedLambdaLayer[] = [
      { kind: 'asset', logicalId: 'AssetLayer', assetPath: assetDir },
      {
        kind: 'arn',
        logicalId: 'arn:aws:lambda:us-east-1:123456789012:layer:LA:1',
        arn: 'arn:aws:lambda:us-east-1:123456789012:layer:LA:1',
        region: 'us-east-1',
        accountId: '123456789012',
        name: 'LA',
        version: '1',
      },
      {
        kind: 'arn',
        logicalId: 'arn:aws:lambda:us-east-1:123456789012:layer:LB:2',
        arn: 'arn:aws:lambda:us-east-1:123456789012:layer:LB:2',
        region: 'us-east-1',
        accountId: '123456789012',
        name: 'LB',
        version: '2',
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await materializeLambdaLayersIncludingArns(layers, {} as any);

    // Both ARN dirs surface; the asset dir is NOT in extraTmpDirs (it's
    // owned by the caller / synth output, not by cdkd's per-invoke
    // lifecycle).
    expect(result.extraTmpDirs).toEqual([arn1Dir, arn2Dir]);
    expect(result.extraTmpDirs).not.toContain(assetDir);

    // Multi-layer merge ran (3 layers → tmpDir created).
    expect(result.tmpDir).toBeDefined();
    if (result.tmpDir) dirsToCleanup.push(result.tmpDir);

    // The caller cleanup contract: rmSync'ing every extraTmpDirs entry
    // is observable end-to-end here.
    for (const dir of result.extraTmpDirs) {
      expect(existsSync(dir)).toBe(true);
      rmSync(dir, { recursive: true, force: true });
      expect(existsSync(dir)).toBe(false);
    }
  });

  it('forwards options.layerRoleArn to materializeLayerFromArn', async () => {
    const arnDir = fakeArnLayerDir('role-arn');
    dirsToCleanup.push(arnDir);
    mockMaterializeLayerFromArn.mockResolvedValueOnce(arnDir);

    const layers: ResolvedLambdaLayer[] = [
      {
        kind: 'arn',
        logicalId: 'arn:aws:lambda:us-east-1:123456789012:layer:External:1',
        arn: 'arn:aws:lambda:us-east-1:123456789012:layer:External:1',
        region: 'us-east-1',
        accountId: '123456789012',
        name: 'External',
        version: '1',
      },
    ];

    await materializeLambdaLayersIncludingArns(layers, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      layerRoleArn: 'arn:aws:iam::999988887777:role/CrossAccountReadLayer',
    } as any);

    expect(mockMaterializeLayerFromArn).toHaveBeenCalledTimes(1);
    const callOpts = mockMaterializeLayerFromArn.mock.calls[0]![1];
    expect(callOpts).toEqual({
      roleArn: 'arn:aws:iam::999988887777:role/CrossAccountReadLayer',
    });
  });
});
