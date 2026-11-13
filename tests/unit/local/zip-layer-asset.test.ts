import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { ResolvedLambdaLayer } from '../../../src/local/lambda-resolver.js';

/**
 * go-to-k/cdkd#6206: a layer CDK ships as a pre-packaged `.zip` file asset
 * (`s3deploy`'s `AwsCliLayer`) resolves and is extracted for the container,
 * on `local invoke`'s / the custom-resource runtime's plan and on
 * `local start-api`'s; the extracted dir is handed to the caller's cleanup,
 * and removed on a throw that never hands it over.
 */

const arnLayer = vi.hoisted(() => vi.fn());
vi.mock('../../../src/local/layer-arn-materializer.js', () => ({
  materializeLayerFromArn: arnLayer,
}));

const { resolveAssetCodePath } = await import('../../../src/local/lambda-resolver/asset-code.js');
const { materializeLambdaLayersIncludingArns } =
  await import('../../../src/cli/commands/local-invoke/image-plan.js');
const { materializeLambdaLayers: startApiMaterialize } =
  await import('../../../src/cli/commands/local-start-api/container-spec.js');

let dir: string;
let zipPath: string;
/** Content unique to this test file, so a scan of the OS tmpdir finds only its own extraction. */
const MARK = `zip-layer-asset-test-${process.pid}`;

beforeEach(() => {
  arnLayer.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'cdkd-zip-layer-test-'));
  zipPath = join(dir, 'asset.abc.zip');
  const zip = new AdmZip();
  zip.addFile('awscli/aws', Buffer.from(MARK), '', 0o755);
  zip.writeZip(zipPath);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const assetLayer = (): ResolvedLambdaLayer => ({
  kind: 'asset',
  logicalId: 'AwsCliLayer',
  assetPath: zipPath,
});

describe('resolveAssetCodePath: acceptZipFile', () => {
  const stack = (): StackInfo =>
    ({ stackName: 'S', assetManifestPath: join(dir, 'S.assets.json') }) as unknown as StackInfo;
  const layer = { Type: 'AWS::Lambda::LayerVersion', Metadata: { 'aws:asset:path': 'asset.abc.zip' } };

  it('accepts a .zip file asset when asked', () => {
    expect(resolveAssetCodePath(stack(), 'L', layer as never, { acceptZipFile: true })).toBe(zipPath);
  });

  it('still refuses it for function code', () => {
    expect(() => resolveAssetCodePath(stack(), 'L', layer as never)).toThrow(/not a directory/);
  });
});

describe('resolveLambdaLayers: a same-stack .zip layer asset', () => {
  it('resolves to the .zip file', async () => {
    const { resolveLambdaLayers } = await import('../../../src/local/lambda-resolver/layers.js');
    const stack = {
      stackName: 'S',
      assetManifestPath: join(dir, 'S.assets.json'),
      template: {
        Resources: {
          AwsCliLayer: {
            Type: 'AWS::Lambda::LayerVersion',
            Metadata: { 'aws:asset:path': 'asset.abc.zip' },
          },
        },
      },
    } as unknown as StackInfo;
    expect(resolveLambdaLayers(stack, 'Fn', { Layers: [{ Ref: 'AwsCliLayer' }] })).toEqual([
      { kind: 'asset', logicalId: 'AwsCliLayer', assetPath: zipPath },
    ]);
  });
});

describe('materializeLambdaLayersIncludingArns (local invoke, custom-resource runtime)', () => {
  it('extracts a .zip layer and hands the dir to the caller', async () => {
    const plan = await materializeLambdaLayersIncludingArns([assetLayer()], { pull: true });
    try {
      expect(plan.extraTmpDirs).toHaveLength(1);
      expect(plan.mount?.hostPath).toBe(plan.extraTmpDirs[0]);
      expect(readFileSync(join(plan.extraTmpDirs[0]!, 'awscli/aws'), 'utf8')).toBe(MARK);
    } finally {
      for (const d of plan.extraTmpDirs) rmSync(d, { recursive: true, force: true });
    }
  });

  it('removes the extracted dir when a later layer throws', async () => {
    // The ARN layer's download fails after the `.zip` layer was extracted;
    // the extracted dir is the one this mock sees on disk at that moment.
    let extracted: string | undefined;
    arnLayer.mockImplementation(() => {
      extracted = readdirSync(tmpdir())
        .filter((n) => n.startsWith('cdkd-layer-zip-'))
        .map((n) => join(tmpdir(), n))
        .find((d) => existsSync(join(d, 'awscli/aws')) && readFileSync(join(d, 'awscli/aws'), 'utf8') === MARK);
      return Promise.reject(new Error('GetLayerVersion denied'));
    });
    const arn = {
      kind: 'arn',
      arn: 'arn:aws:lambda:us-east-1:123456789012:layer:x:1',
    } as ResolvedLambdaLayer;
    await expect(
      materializeLambdaLayersIncludingArns([assetLayer(), arn], { pull: true })
    ).rejects.toThrow('GetLayerVersion denied');
    expect(extracted).toBeDefined();
    expect(existsSync(extracted!)).toBe(false);
  });
});

describe('materializeLambdaLayers (local start-api)', () => {
  it('extracts a .zip layer into a dir it registers for cleanup', async () => {
    const tmpDirs = new Set<string>();
    const mounted = await startApiMaterialize([assetLayer()], tmpDirs, undefined);
    try {
      expect(mounted).toBeDefined();
      expect(tmpDirs.has(mounted!)).toBe(true);
      expect(readFileSync(join(mounted!, 'awscli/aws'), 'utf8')).toBe(MARK);
    } finally {
      for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    }
  });
});
