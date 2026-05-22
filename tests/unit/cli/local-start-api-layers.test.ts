import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedLambdaLayer } from '../../../src/local/lambda-resolver.js';

// MUST-FIX 3 from PR #491 review: caller-integration tests verifying
// that `cdkd local start-api`'s `materializeLambdaLayers` registers
// every per-ARN tmpdir in the shared `layerTmpDirs: Set<string>` so the
// server's graceful-shutdown loop in `shutdown(...)` can `rmSync` them.
// Without these tests, a future refactor that drops the `layerTmpDirs.add(dir)`
// inside the ARN branch would silently leak tmpdirs across the lifetime
// of a long-running `start-api` process.
vi.mock('../../../src/local/layer-arn-materializer.js', () => ({
  materializeLayerFromArn: vi.fn(),
  LayerMaterializationError: class extends Error {},
}));

import { materializeLambdaLayers } from '../../../src/cli/commands/local-start-api.js';
import { materializeLayerFromArn } from '../../../src/local/layer-arn-materializer.js';
const mockMaterializeLayerFromArn = vi.mocked(materializeLayerFromArn);

function fakeArnLayerDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `cdkd-mock-start-api-arn-${label}-`));
  mkdirSync(path.join(dir, 'nodejs'), { recursive: true });
  writeFileSync(path.join(dir, 'nodejs', 'index.js'), `// ${label}`, 'utf-8');
  return dir;
}

function fakeAssetLayerDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `cdkd-mock-start-api-asset-${label}-`));
  writeFileSync(path.join(dir, 'a.txt'), label, 'utf-8');
  return dir;
}

describe("local-start-api materializeLambdaLayers — layerTmpDirs cleanup contract (PR #491 review MUST-FIX 3)", () => {
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

  it('registers a single ARN layer\'s tmpdir in layerTmpDirs (single-layer fast path)', async () => {
    const arnDir = fakeArnLayerDir('single');
    dirsToCleanup.push(arnDir);
    mockMaterializeLayerFromArn.mockResolvedValueOnce(arnDir);

    const layerTmpDirs = new Set<string>();
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

    const optDir = await materializeLambdaLayers(layers, layerTmpDirs, undefined);

    // Single-layer fast path bind-mounts the per-ARN dir directly.
    expect(optDir).toBe(arnDir);
    // Critical: the per-ARN tmpdir MUST be in the shared set so
    // graceful shutdown's rmSync loop finds it. Pre-PR-491 review this
    // worked; this test pins it against future regression.
    expect(layerTmpDirs.has(arnDir)).toBe(true);
    expect(layerTmpDirs.size).toBe(1);
  });

  it('registers every ARN layer tmpdir AND the merged tmpdir for multi-layer cases', async () => {
    const arn1Dir = fakeArnLayerDir('m1');
    const arn2Dir = fakeArnLayerDir('m2');
    const assetDir = fakeAssetLayerDir('m-asset');
    dirsToCleanup.push(arn1Dir, arn2Dir, assetDir);

    mockMaterializeLayerFromArn
      .mockResolvedValueOnce(arn1Dir)
      .mockResolvedValueOnce(arn2Dir);

    const layerTmpDirs = new Set<string>();
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

    const optDir = await materializeLambdaLayers(layers, layerTmpDirs, undefined);

    // Multi-layer path: optDir is a merged tmpdir under the OS tmp root.
    expect(optDir).toBeDefined();
    expect(optDir).not.toBe(assetDir);
    expect(optDir).not.toBe(arn1Dir);
    expect(optDir).not.toBe(arn2Dir);
    if (optDir) dirsToCleanup.push(optDir);

    // Critical: BOTH per-ARN tmpdirs AND the merged tmpdir surface in
    // the shared set. The asset's pre-existing dir is NOT registered
    // (it's owned by synth output, not by this invoke's lifecycle).
    expect(layerTmpDirs.has(arn1Dir)).toBe(true);
    expect(layerTmpDirs.has(arn2Dir)).toBe(true);
    expect(layerTmpDirs.has(optDir!)).toBe(true);
    expect(layerTmpDirs.has(assetDir)).toBe(false);
    expect(layerTmpDirs.size).toBe(3);

    // End-to-end cleanup contract: shutdown's rmSync loop empties the
    // set, and every dir disappears.
    for (const dir of layerTmpDirs) {
      expect(existsSync(dir)).toBe(true);
      rmSync(dir, { recursive: true, force: true });
      expect(existsSync(dir)).toBe(false);
    }
  });

  it('forwards the layerRoleArn option through to materializeLayerFromArn', async () => {
    const arnDir = fakeArnLayerDir('role');
    dirsToCleanup.push(arnDir);
    mockMaterializeLayerFromArn.mockResolvedValueOnce(arnDir);

    const layerTmpDirs = new Set<string>();
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

    await materializeLambdaLayers(
      layers,
      layerTmpDirs,
      'arn:aws:iam::999988887777:role/CrossAccountReadLayer'
    );

    expect(mockMaterializeLayerFromArn).toHaveBeenCalledTimes(1);
    const opts = mockMaterializeLayerFromArn.mock.calls[0]![1];
    expect(opts).toEqual({ roleArn: 'arn:aws:iam::999988887777:role/CrossAccountReadLayer' });
  });

  it('returns undefined and adds nothing to layerTmpDirs when layers is empty', async () => {
    const layerTmpDirs = new Set<string>();
    const optDir = await materializeLambdaLayers([], layerTmpDirs, undefined);

    expect(optDir).toBeUndefined();
    expect(layerTmpDirs.size).toBe(0);
    expect(mockMaterializeLayerFromArn).not.toHaveBeenCalled();
  });
});
