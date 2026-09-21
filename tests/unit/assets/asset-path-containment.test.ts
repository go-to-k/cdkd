/**
 * The assets layer turns THREE assembly-supplied strings into filesystem paths
 * and must hold each inside the assembly directory (issue go-to-k/cdkd#3489).
 *
 * This is the sharpest edge of that issue, not a footnote. `cdkd deploy -a
 * <dir>` consumes a PRE-SYNTHESIZED assembly, the asset manifest names BOTH the
 * source path and the destination bucket, and the publisher zips whatever the
 * source names and `PutObject`s it with the caller's own credentials. A
 * `source.path` of `../../../home/<user>/.aws` was therefore an exfiltration
 * primitive: cdkd would package the maintainer's credentials directory and
 * upload it to a bucket the manifest chose. `redirectFileAsset` rewrites only
 * default-bootstrap-shaped destinations, so a custom bucket name survives
 * verbatim.
 *
 * `source.directory` is the Docker twin — it becomes the build context and is
 * baked into the published image — and the manifest FILENAME is built from the
 * manifest-chosen `stackName`.
 *
 * Real files on disk rather than a `vi.mock` of `node:fs`: the escape is a
 * property of the filesystem resolution, and the symlink arm cannot be
 * exhibited against a mock.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

// R5: `buildDockerImage` is driven for real below, so without this a guard
// moved BELOW `buildDockerBuildCommand` still throws the same message and the
// suite stays green while the outside build context has already reached
// BuildKit — and a regression shells out to a real `docker build` against a
// path outside the fixture. Mocking the spawn surface makes "nothing reached
// docker" assertable.
const runDockerStreaming = vi.fn();
const spawnStreaming = vi.fn();
vi.mock('../../../src/utils/docker-cmd.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/docker-cmd.js')>();
  return {
    ...actual,
    runDockerStreaming: (...args: unknown[]) => runDockerStreaming(...args),
    spawnStreaming: (...args: unknown[]) => spawnStreaming(...args),
  };
});
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AssetManifestLoader,
  resolveFileAssetSourcePath,
} from '../../../src/assets/asset-manifest-loader.js';
import { AssetPublisher } from '../../../src/assets/asset-publisher.js';
import { WorkGraph } from '../../../src/deployment/work-graph.js';
import {
  buildDockerImage,
  resolveDockerContextDirectory,
} from '../../../src/assets/docker-build.js';
import type { FileAsset } from '../../../src/types/assets.js';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-asset-containment-')));
}

/** A cdk.out with a file OUTSIDE it, as a hostile tarball has. */
function assembly(): { dir: string; outer: string } {
  const outer = tmp();
  const dir = join(outer, 'cdk.out');
  mkdirSync(dir);
  writeFileSync(join(outer, 'outside.json'), '{}');
  mkdirSync(join(outer, 'outside-dir'));
  return { dir, outer };
}

function fileAsset(path: string): FileAsset {
  return {
    displayName: 'MyAsset',
    source: { path, packaging: 'zip' },
    destinations: {
      'acct-region': { bucketName: 'attacker-named-bucket', objectKey: 'x.zip' },
    },
  };
}

const CONTAINMENT = /resolves to '.*', outside '.*'\./;

const wrapErr = (m: string): Error => new Error(m);

describe("a file asset's source.path", () => {
  it('refuses one that leaves the assembly directory, naming the asset and the path', () => {
    const { dir } = assembly();

    expect(() => resolveFileAssetSourcePath(dir, fileAsset('../../outside.json'))).toThrow(
      /File asset 'MyAsset' has source\.path='\.\.\/\.\.\/outside\.json' which resolves to '.*', outside/
    );
  });

  it('refuses one that stays inside lexically but leads out through a symlink', () => {
    const { dir, outer } = assembly();
    symlinkSync(outer, join(dir, 'link'), 'dir');

    expect(() => resolveFileAssetSourcePath(dir, fileAsset('link/outside.json'))).toThrow(
      /leads through a symbolic link to '.*outside\.json', outside/
    );
  });

  it('still resolves an ordinary asset directory and one that normalises back inside', () => {
    const { dir } = assembly();

    expect(resolveFileAssetSourcePath(dir, fileAsset('asset.abc123'))).toBe(
      join(dir, 'asset.abc123')
    );
    expect(resolveFileAssetSourcePath(dir, fileAsset('sub/../asset.abc123'))).toBe(
      join(dir, 'asset.abc123')
    );
  });

  // The publisher's use of this same function is fenced BEHAVIOURALLY, in
  // `file-asset-publisher.test.ts` — driving `publish()` and asserting both the
  // refusal and that no S3 command was sent. A source-text assertion here
  // would be satisfied by the string appearing in a comment, and would pin one
  // spelling of the join it forbids while `${a}/${b}` slipped past.
});

describe('a Stage manifest, whose assets are staged one level UP', () => {
  // The regression this file did not catch: every case above uses a sibling,
  // and `cdk synth` stages a Stage's assets into the APP's outdir while the
  // Stage's manifest sits in `cdk.out/assembly-<Stage>/`. Upstream therefore
  // emits `source.path: '../asset.<hash>'` BY DESIGN — measured on
  // aws-cdk-lib 2.268 with no flags. Containing against the manifest's own
  // directory refused every Stage asset (go-to-k/cdkd#3489).
  //
  // The rule is unchanged; only the BASE is. `path.relative` must still be
  // non-empty, non-`..`-prefixed and relative — against the app outdir.
  const stage = (): { outdir: string; manifestDir: string } => {
    const outdir = tmp();
    const manifestDir = join(outdir, 'assembly-MyStage');
    mkdirSync(manifestDir);
    mkdirSync(join(outdir, 'asset.abc123'));
    return { outdir, manifestDir };
  };

  it("ACCEPTS a Stage's `../asset.<hash>` when contained against the app outdir", () => {
    const { outdir, manifestDir } = stage();

    expect(resolveFileAssetSourcePath(manifestDir, fileAsset('../asset.abc123'), outdir)).toBe(
      join(outdir, 'asset.abc123')
    );
    expect(resolveDockerContextDirectory(manifestDir, '../asset.abc123', wrapErr, outdir)).toBe(
      join(outdir, 'asset.abc123')
    );
  });

  it('ACCEPTS a NESTED Stage reaching two levels up, which Stages legitimately do', () => {
    const outdir = tmp();
    const inner = join(outdir, 'assembly-Outer', 'assembly-Inner');
    mkdirSync(inner, { recursive: true });
    mkdirSync(join(outdir, 'asset.abc123'));

    expect(resolveFileAssetSourcePath(inner, fileAsset('../../asset.abc123'), outdir)).toBe(
      join(outdir, 'asset.abc123')
    );
  });

  it('still REFUSES an escape from a STAGE manifest', () => {
    const { outdir, manifestDir } = stage();

    expect(() =>
      resolveFileAssetSourcePath(manifestDir, fileAsset('../../outside.json'), outdir)
    ).toThrow(CONTAINMENT);
    expect(() =>
      resolveDockerContextDirectory(manifestDir, '../../outside-dir', wrapErr, outdir)
    ).toThrow(CONTAINMENT);
  });

  it('still REFUSES an escape from a TOP-LEVEL manifest, where the two bases coincide', () => {
    const outdir = tmp();

    expect(() =>
      resolveFileAssetSourcePath(outdir, fileAsset('../outside.json'), outdir)
    ).toThrow(CONTAINMENT);
    // ...and the widened base must not let ONE `..` through from the top level.
    expect(() => resolveDockerContextDirectory(outdir, '../outside-dir', wrapErr, outdir)).toThrow(
      CONTAINMENT
    );
  });

  it('reaches the resolver from AssetPublisher, not only when a test passes it', () => {
    // The hole this file had: every case above calls the resolver DIRECTLY
    // with the third argument, so `options.assetOutdir ?? cdkOutputDir` in
    // `addAssetsToGraph` could ignore the plumbed value and the suite stayed
    // green — reintroducing the measured Stage regression in one line.
    const outdir = tmp();
    const manifestDir = join(outdir, 'assembly-MyStage');
    mkdirSync(manifestDir);
    mkdirSync(join(outdir, 'asset.abc123'));
    const manifestPath = join(manifestDir, 'Stage-Stack.assets.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: '54.0.0',
        // `../asset.<hash>`, exactly as `cdk synth` writes it for a Stage.
        files: {
          h1: {
            source: { path: '../asset.abc123', packaging: 'zip' },
            destinations: { d: { bucketName: 'b', objectKey: 'k' } },
          },
        },
        dockerImages: {},
      })
    );

    const graph = new WorkGraph();
    new AssetPublisher().addAssetsToGraph(graph, manifestPath, {
      accountId: '123456789012',
      region: 'us-east-1',
      assetOutdir: outdir,
    });

    // `nodes` is private; reach it the way the graph's own tests do.
    const nodes = (graph as unknown as { nodes: Map<string, { data: unknown }> }).nodes;
    const node = nodes.get('asset-publish:file:h1');
    expect(node).toBeDefined();
    const data = node!.data as { cdkOutputDir: string; assetOutdir: string };
    // The bound must arrive as the APP outdir, not the manifest's directory.
    expect(data.assetOutdir).toBe(outdir);
    expect(data.cdkOutputDir).toBe(manifestDir);
    // ...and resolving with exactly what the node carries must ACCEPT.
    expect(
      resolveFileAssetSourcePath(data.cdkOutputDir, fileAsset('../asset.abc123'), data.assetOutdir)
    ).toBe(join(outdir, 'asset.abc123'));
  });

  it('defaults the bound to the manifest directory when no outdir is supplied', () => {
    // Hand-built callers (tests, tooling) keep the pre-Stage behaviour, which
    // is correct for a top-level stack.
    const { manifestDir } = stage();

    expect(() => resolveFileAssetSourcePath(manifestDir, fileAsset('../asset.abc123'))).toThrow(
      CONTAINMENT
    );
  });
});

describe("a Docker asset's source.directory", () => {
  const wrap = (m: string): Error => new Error(m);
  const options = { tag: 't', wrapError: wrap };

  it('refuses a build context that leaves the assembly directory, BEFORE docker runs', async () => {
    const { dir } = assembly();
    runDockerStreaming.mockClear();
    spawnStreaming.mockClear();

    await expect(
      buildDockerImage({ source: { directory: '../outside-dir' } }, dir, options)
    ).rejects.toThrow(
      /asset source\.directory='\.\.\/outside-dir' which resolves to '.*outside-dir', outside/
    );

    // The message alone does not prove the guard PRECEDES the build: a guard
    // moved below the argv builder throws the same text with the context
    // already handed to BuildKit.
    expect(runDockerStreaming).not.toHaveBeenCalled();
    expect(spawnStreaming).not.toHaveBeenCalled();
  });

  it('refuses an executable whose cwd leaves the assembly directory, spawning nothing', async () => {
    // The `executable` arm resolves the same field and took the same raw
    // `${cdkOutDir}/${directory}` concatenation.
    const { dir } = assembly();

    await expect(
      buildDockerImage(
        { source: { directory: '../outside-dir', executable: ['/bin/echo', 'x'] } },
        dir,
        options
      )
    ).rejects.toThrow(CONTAINMENT);

    expect(spawnStreaming).not.toHaveBeenCalled();
  });

  it('refuses one that stays inside lexically but leads out through a symlink', async () => {
    const { dir, outer } = assembly();
    symlinkSync(outer, join(dir, 'link'), 'dir');
    runDockerStreaming.mockClear();

    await expect(
      buildDockerImage({ source: { directory: 'link/outside-dir' } }, dir, options)
    ).rejects.toThrow(/leads through a symbolic link to '.*outside-dir', outside/);

    expect(runDockerStreaming).not.toHaveBeenCalled();
  });

  it('still resolves an ordinary directory and one that normalises back inside', () => {
    // Asserted on the extracted helper rather than through `buildDockerImage`,
    // which would spawn a real `docker` and could only assert the absence of a
    // containment error. The three cases above keep the WIRING fenced for both
    // arms; this one fences the accepting verdict itself.
    const { dir } = assembly();
    mkdirSync(join(dir, 'asset.abc123'));

    expect(resolveDockerContextDirectory(dir, 'asset.abc123', wrap)).toBe(
      join(dir, 'asset.abc123')
    );
    expect(resolveDockerContextDirectory(dir, 'sub/../asset.abc123', wrap)).toBe(
      join(dir, 'asset.abc123')
    );
  });

  it('throws through the CALLER-supplied wrapError, keeping its typed class', () => {
    const { dir } = assembly();
    class Typed extends Error {}

    expect(() =>
      resolveDockerContextDirectory(dir, '../outside-dir', (m) => new Typed(m))
    ).toThrow(Typed);
  });
});

describe('the asset manifest filename, built from a manifest-chosen stackName', () => {
  it('refuses a stack name that escapes the assembly directory', async () => {
    const { dir } = assembly();

    await expect(new AssetManifestLoader().loadManifest(dir, '../../evil')).rejects.toThrow(
      /Asset manifest for stack '\.\.\/\.\.\/evil' resolves to '.*', outside/
    );
  });

  it('still reads an ordinary stack name, and answers null when there is no manifest', async () => {
    const { dir } = assembly();
    writeFileSync(
      join(dir, 'MainStack.assets.json'),
      JSON.stringify({ version: '54.0.0', files: {}, dockerImages: {} })
    );

    await expect(new AssetManifestLoader().loadManifest(dir, 'MainStack')).resolves.not.toBeNull();
    await expect(new AssetManifestLoader().loadManifest(dir, 'Absent')).resolves.toBeNull();
  });

  it('refuses a stack name that stays inside lexically but leads out through a symlink', async () => {
    const { dir, outer } = assembly();
    symlinkSync(outer, join(dir, 'link'), 'dir');
    writeFileSync(
      join(outer, 'Reachable.assets.json'),
      JSON.stringify({ version: '54.0.0', files: {}, dockerImages: {} })
    );

    await expect(
      new AssetManifestLoader().loadManifest(dir, 'link/Reachable')
    ).rejects.toThrow(/leads through a symbolic link to '.*Reachable\.assets\.json', outside/);
  });

  it('keeps the outer directory out of reach even when it exists', async () => {
    const { dir, outer } = assembly();
    writeFileSync(
      join(outer, 'Reachable.assets.json'),
      JSON.stringify({ version: '54.0.0', files: {}, dockerImages: {} })
    );

    await expect(
      new AssetManifestLoader().loadManifest(dir, join('..', 'Reachable'))
    ).rejects.toThrow(CONTAINMENT);
  });
});
