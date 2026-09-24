/**
 * `loadAgentCoreAssetContext` resolves a Docker asset's `source.directory`
 * from the asset manifest and hands the result to `docker cp <dir>/.`
 * (issue go-to-k/cdkd#3489).
 *
 * Its FILE-asset arm one branch above already went through the guarded
 * `getAssetSourcePath`, while the DOCKER arm still joined raw — the shape
 * this PR exists to remove, and the one that makes a guard on one twin a
 * guard on neither. `cdkOutDir` here is `--output`, the app root, so it is
 * both the resolution base and the containment bound.
 */
import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveOldAssetHash,
  loadAgentCoreAssetContext,
} from '../../../src/local/invoke-agentcore-watch-loop.js';
import { AssetManifestLoader } from '../../../src/assets/asset-manifest-loader.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-agentcore-containment-')));
}

/** An app outdir holding one stack's asset manifest, plus a dir OUTSIDE it. */
function assembly(directory: string): { outdir: string; outer: string } {
  const outer = tmp();
  const outdir = join(outer, 'cdk.out');
  mkdirSync(outdir);
  mkdirSync(join(outer, 'outside-dir'));
  mkdirSync(join(outdir, 'asset.abc123'));
  writeFileSync(
    join(outdir, 'AgentStack.assets.json'),
    JSON.stringify({
      version: '54.0.0',
      files: {},
      dockerImages: {
        deadbeef: {
          source: { directory },
          destinations: {
            'acct-region': { repositoryName: 'repo', imageTag: 'deadbeef' },
          },
        },
      },
    })
  );
  return { outdir, outer };
}

const stack = { stackName: 'AgentStack' } as unknown as StackInfo;

const call = (outdir: string): Promise<unknown> =>
  loadAgentCoreAssetContext({
    resolvedTarget: 'AgentStack',
    // Only `containerUri` matters: it selects the DOCKER arm.
    resolved: { containerUri: 'deadbeef' } as never,
    stacks: [stack],
    cdkOutDir: outdir,
    assetLoader: new AssetManifestLoader(),
  });

/**
 * BOTH arms of `loadAgentCoreAssetContext` hand their directory to
 * `docker cp <dir>/. <container>:<workdir>` (`softReload`). Neither uploads
 * and neither builds a BuildKit context, so the warning each emits for an
 * absolute path must say THAT — the file arm inherited a read-only default
 * clause while actually copying into a running container
 * (go-to-k/cdkd#3532).
 */
describe('loadAgentCoreAssetContext absolute-path warning names ITS OWN sink', () => {
  function captureWarn(): { warned: () => string[] } {
    const lines: string[] = [];
    vi.spyOn(getLogger(), 'child').mockImplementation(
      () =>
        ({
          warn: (m: string) => lines.push(m),
          debug: () => {},
          info: () => {},
          error: () => {},
          child: () => getLogger().child(''),
        }) as never
    );
    return { warned: () => lines };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stageAssembly = (
    // Takes a FUNCTION, not a literal: the manifest body names the victim
    // directory, which this helper creates, so a literal argument would
    // reference it before it exists.
    body: (victim: string) => Record<string, unknown>
  ): { outdir: string; manifestDir: string; victim: string } => {
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');
    const manifestDir = join(outdir, 'assembly-MyStage');
    mkdirSync(manifestDir, { recursive: true });
    const victim = join(outer, 'victim');
    mkdirSync(victim);
    writeFileSync(
      join(manifestDir, 'StageStack.assets.json'),
      JSON.stringify({ version: '54.0.0', files: {}, dockerImages: {}, ...body(victim) })
    );
    return { outdir, manifestDir, victim };
  };

  it('FILE arm says it will COPY into the container, not read-and-build', async () => {
    const { outdir, manifestDir, victim } = stageAssembly((v) => ({
      files: {
        codehash: {
          source: { path: v, packaging: 'zip' },
          destinations: { d: { bucketName: 'b', objectKey: 'codehash' } },
        },
      },
    }));
    const cap = captureWarn();

    await expect(
      loadAgentCoreAssetContext({
        resolvedTarget: 'StageStack',
        resolved: { codeArtifact: { codeAssetHash: 'codehash' } } as never,
        stacks: [
          {
            stackName: 'StageStack',
            assetOutdir: outdir,
            assetManifestPath: join(manifestDir, 'StageStack.assets.json'),
          } as unknown as StackInfo,
        ],
        cdkOutDir: outdir,
        assetLoader: new AssetManifestLoader(),
      })
    ).resolves.toMatchObject({ newAssetSourceDir: victim });

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(victim);
    expect(lines[0]).toContain('copy that directory');
    // The clause that was wrong: this arm does not build a local image.
    expect(lines[0]).not.toContain('build a local image');
  });

  it('DOCKER arm says the same, since it feeds the same docker cp', async () => {
    const { outdir, manifestDir, victim } = stageAssembly((v) => ({
      dockerImages: {
        deadbeef: {
          source: { directory: v },
          destinations: { d: { repositoryName: 'repo', imageTag: 'deadbeef' } },
        },
      },
    }));
    const cap = captureWarn();

    await expect(
      loadAgentCoreAssetContext({
        resolvedTarget: 'StageStack',
        resolved: { containerUri: 'deadbeef' } as never,
        stacks: [
          {
            stackName: 'StageStack',
            assetOutdir: outdir,
            assetManifestPath: join(manifestDir, 'StageStack.assets.json'),
          } as unknown as StackInfo,
        ],
        cdkOutDir: outdir,
        assetLoader: new AssetManifestLoader(),
      })
    ).resolves.toMatchObject({ newAssetSourceDir: victim });

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('copy that directory');
  });
});

describe('loadAgentCoreAssetContext docker source.directory containment', () => {
  it('refuses a source.directory that escapes the app outdir', async () => {
    const { outdir } = assembly('../outside-dir');

    await expect(call(outdir)).rejects.toThrow(
      /asset source\.directory='\.\.\/outside-dir' which resolves to .*outside-dir, outside/
    );
  });

  it('refuses one that stays inside lexically but leads out through a symlink', async () => {
    const { outdir, outer } = assembly('link/outside-dir');
    symlinkSync(outer, join(outdir, 'link'), 'dir');

    await expect(call(outdir)).rejects.toThrow(
      /leads through a symbolic link to .*outside-dir, outside/
    );
  });

  it('still resolves an ordinary asset directory', async () => {
    const { outdir } = assembly('asset.abc123');

    await expect(call(outdir)).resolves.toMatchObject({
      newAssetSourceDir: join(outdir, 'asset.abc123'),
      newAssetHash: 'deadbeef',
    });
  });

  it('still resolves one that normalises back inside', async () => {
    const { outdir } = assembly('sub/../asset.abc123');

    await expect(call(outdir)).resolves.toMatchObject({
      newAssetSourceDir: join(outdir, 'asset.abc123'),
    });
  });

  it("ACCEPTS a Stage's `../asset.<hash>`, bounded by the app outdir", async () => {
    // All the cases above are TOP-LEVEL shapes, where the manifest directory
    // and the app outdir coincide — the same blind spot that let the Stage
    // regression through in `src/assets/`. Here the manifest lives in
    // `assembly-<Stage>/` and its asset is staged one level up, so the bound
    // must come from the stack's `assetOutdir` (go-to-k/cdkd#3489).
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');
    const manifestDir = join(outdir, 'assembly-MyStage');
    mkdirSync(manifestDir, { recursive: true });
    mkdirSync(join(outdir, 'asset.abc123'));
    writeFileSync(
      join(manifestDir, 'StageStack.assets.json'),
      JSON.stringify({
        version: '54.0.0',
        files: {},
        dockerImages: {
          deadbeef: {
            source: { directory: '../asset.abc123' },
            destinations: { d: { repositoryName: 'repo', imageTag: 'deadbeef' } },
          },
        },
      })
    );

    await expect(
      loadAgentCoreAssetContext({
        resolvedTarget: 'StageStack',
        resolved: { containerUri: 'deadbeef' } as never,
        // cdkd's own record carries the app outdir; the watch loop looks it up
        // by stack name because cdk-local's StackInfo has no such field.
        stacks: [{ stackName: 'StageStack', assetOutdir: outdir } as unknown as StackInfo],
        cdkOutDir: manifestDir,
        assetLoader: new AssetManifestLoader(),
      })
    ).resolves.toMatchObject({ newAssetSourceDir: join(outdir, 'asset.abc123') });
  });

  it('still REFUSES an escape from a Stage manifest, with the wider bound', async () => {
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');
    const manifestDir = join(outdir, 'assembly-MyStage');
    mkdirSync(manifestDir, { recursive: true });
    mkdirSync(join(outer, 'victim'));
    writeFileSync(
      join(manifestDir, 'StageStack.assets.json'),
      JSON.stringify({
        version: '54.0.0',
        files: {},
        dockerImages: {
          deadbeef: {
            source: { directory: '../../victim' },
            destinations: { d: { repositoryName: 'repo', imageTag: 'deadbeef' } },
          },
        },
      })
    );

    await expect(
      loadAgentCoreAssetContext({
        resolvedTarget: 'StageStack',
        resolved: { containerUri: 'deadbeef' } as never,
        stacks: [{ stackName: 'StageStack', assetOutdir: outdir } as unknown as StackInfo],
        cdkOutDir: manifestDir,
        assetLoader: new AssetManifestLoader(),
      })
    ).rejects.toThrow(/outside/);
  });

  it("FILE arm: ACCEPTS a Stage's `../asset.<hash>` and REFUSES an escape", async () => {
    // The docker arm above is only half this function. The file arm resolves
    // `source.path` through `getAssetSourcePath` and needs the same bound.
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');
    const manifestDir = join(outdir, 'assembly-MyStage');
    mkdirSync(manifestDir, { recursive: true });
    mkdirSync(join(outdir, 'asset.abc123'));
    mkdirSync(join(outer, 'victim'));

    const write = (path: string): void =>
      writeFileSync(
        join(manifestDir, 'StageStack.assets.json'),
        JSON.stringify({
          version: '54.0.0',
          files: {
            codehash: {
              source: { path, packaging: 'zip' },
              destinations: { d: { bucketName: 'b', objectKey: 'codehash' } },
            },
          },
          dockerImages: {},
        })
      );

    const callFileArm = (): Promise<unknown> =>
      loadAgentCoreAssetContext({
        resolvedTarget: 'StageStack',
        resolved: { codeArtifact: { codeAssetHash: 'codehash' } } as never,
        stacks: [{ stackName: 'StageStack', assetOutdir: outdir } as unknown as StackInfo],
        cdkOutDir: manifestDir,
        assetLoader: new AssetManifestLoader(),
      });

    write('../asset.abc123');
    await expect(callFileArm()).resolves.toMatchObject({
      newAssetSourceDir: join(outdir, 'asset.abc123'),
    });

    write('../../victim');
    await expect(callFileArm()).rejects.toThrow(/outside/);
  });

  it('finds a Stage manifest from the APP OUTDIR, the way the watch loop calls it', async () => {
    // Every case above hands `cdkOutDir` the MANIFEST's directory, which the
    // production caller never does: `invoke-agentcore-watch-loop.ts` passes
    // `options.output`, the app root. Under a `cdk.Stage` the manifest is in
    // `assembly-<Stage>/`, so resolving it from the app root found NOTHING and
    // the arm returned `undefined` before the containment bound was ever read
    // — an unreachable guard, and a Stage `--watch` that silently never
    // hot-reloaded an asset. The manifest directory now comes from the cdkd
    // record's `assetManifestPath` (go-to-k/cdkd#3489).
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');
    const manifestDir = join(outdir, 'assembly-MyStage');
    mkdirSync(manifestDir, { recursive: true });
    mkdirSync(join(outdir, 'asset.abc123'));
    writeFileSync(
      join(manifestDir, 'StageStack.assets.json'),
      JSON.stringify({
        version: '54.0.0',
        files: {},
        dockerImages: {
          deadbeef: {
            source: { directory: '../asset.abc123' },
            destinations: { d: { repositoryName: 'repo', imageTag: 'deadbeef' } },
          },
        },
      })
    );

    await expect(
      loadAgentCoreAssetContext({
        resolvedTarget: 'StageStack',
        resolved: { containerUri: 'deadbeef' } as never,
        stacks: [
          {
            stackName: 'StageStack',
            assetManifestPath: join(manifestDir, 'StageStack.assets.json'),
            assetOutdir: outdir,
          } as unknown as StackInfo,
        ],
        // What the caller really passes: `--output`, NOT the manifest's dir.
        cdkOutDir: outdir,
        assetLoader: new AssetManifestLoader(),
      })
    ).resolves.toMatchObject({ newAssetSourceDir: join(outdir, 'asset.abc123') });
  });

  it('still REFUSES an escape found that way', async () => {
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');
    const manifestDir = join(outdir, 'assembly-MyStage');
    mkdirSync(manifestDir, { recursive: true });
    mkdirSync(join(outer, 'victim'));
    writeFileSync(
      join(manifestDir, 'StageStack.assets.json'),
      JSON.stringify({
        version: '54.0.0',
        files: {},
        dockerImages: {
          deadbeef: {
            source: { directory: '../../victim' },
            destinations: { d: { repositoryName: 'repo', imageTag: 'deadbeef' } },
          },
        },
      })
    );

    await expect(
      loadAgentCoreAssetContext({
        resolvedTarget: 'StageStack',
        resolved: { containerUri: 'deadbeef' } as never,
        stacks: [
          {
            stackName: 'StageStack',
            assetManifestPath: join(manifestDir, 'StageStack.assets.json'),
            assetOutdir: outdir,
          } as unknown as StackInfo,
        ],
        cdkOutDir: outdir,
        assetLoader: new AssetManifestLoader(),
      })
    ).rejects.toThrow(/outside/);
  });

  it('deriveOldAssetHash finds the SAME Stage manifest, so soft reload can engage', async () => {
    // The twin of the lookup above, called from the same block one line
    // earlier. It reads no path out of the manifest, so it is not a
    // containment site -- but it took its manifest directory from `--output`
    // too, where a Stage's manifest never is. It returned `undefined`, the
    // classifier reads `undefined` as "force rebuild", and soft reload could
    // therefore never engage for a container-arm runtime inside a Stage.
    // Fixing one half of a pair and not the other is how twins drift.
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');
    const manifestDir = join(outdir, 'assembly-MyStage');
    mkdirSync(manifestDir, { recursive: true });
    mkdirSync(join(outdir, 'asset.abc123'));
    writeFileSync(
      join(manifestDir, 'StageStack.assets.json'),
      JSON.stringify({
        version: '54.0.0',
        files: {},
        dockerImages: {
          deadbeef: {
            source: { directory: '../asset.abc123' },
            destinations: { d: { repositoryName: 'repo', imageTag: 'deadbeef' } },
          },
        },
      })
    );
    const stacks = [
      {
        stackName: 'StageStack',
        assetManifestPath: join(manifestDir, 'StageStack.assets.json'),
        assetOutdir: outdir,
      } as unknown as StackInfo,
    ];

    await expect(
      deriveOldAssetHash({
        resolvedTarget: 'StageStack',
        resolved: { containerUri: 'deadbeef' } as never,
        stacks,
        // `--output`, as the watch loop passes it.
        cdkOutDir: outdir,
        assetLoader: new AssetManifestLoader(),
      })
    ).resolves.toBe('deadbeef');
  });

  it('deriveOldAssetHash still answers for a top-level stack with no record fields', async () => {
    // The fallback half: a hand-built record carrying neither field must still
    // resolve through `cdkOutDir`, which IS the manifest directory there.
    const { outdir } = assembly('asset.abc123');

    await expect(
      deriveOldAssetHash({
        resolvedTarget: 'AgentStack',
        resolved: { containerUri: 'deadbeef' } as never,
        stacks: [stack],
        cdkOutDir: outdir,
        assetLoader: new AssetManifestLoader(),
      })
    ).resolves.toBe('deadbeef');
  });

  it('matches the guard its FILE-asset sibling already used', async () => {
    // The two arms of this one function must not disagree about what an
    // escaping manifest path is.
    const { outdir } = assembly('../outside-dir');
    const loader = new AssetManifestLoader();
    const manifest = await loader.loadManifest(outdir, 'AgentStack');
    expect(manifest).not.toBeNull();

    expect(() =>
      loader.getAssetSourcePath(
        outdir,
        {
          displayName: 'x',
          source: { path: '../outside-dir', packaging: 'zip' },
          destinations: {},
        },
        { assetOutdir: outdir, sink: 'read that directory and build a local image from it' }
      )
    ).toThrow(/outside/);
    await expect(call(outdir)).rejects.toThrow(/outside/);
  });
});
