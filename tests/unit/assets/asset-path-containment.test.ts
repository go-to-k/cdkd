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
import { describe, it, expect, vi, afterEach } from 'vite-plus/test';

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
import { getLogger } from '../../../src/utils/logger.js';
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

    expect(() => resolveFileAssetSourcePath(dir, fileAsset('../../outside.json'), dir)).toThrow(
      /File asset 'MyAsset' has source\.path='\.\.\/\.\.\/outside\.json' which resolves to '.*', outside/
    );
  });

  it('refuses one that stays inside lexically but leads out through a symlink', () => {
    const { dir, outer } = assembly();
    symlinkSync(outer, join(dir, 'link'), 'dir');

    expect(() => resolveFileAssetSourcePath(dir, fileAsset('link/outside.json'), dir)).toThrow(
      /leads through a symbolic link to '.*outside\.json', outside/
    );
  });

  it('still resolves an ordinary asset directory and one that normalises back inside', () => {
    const { dir } = assembly();

    expect(resolveFileAssetSourcePath(dir, fileAsset('asset.abc123'), dir)).toBe(
      join(dir, 'asset.abc123')
    );
    expect(resolveFileAssetSourcePath(dir, fileAsset('sub/../asset.abc123'), dir)).toBe(
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

  it('NARROWS to the manifest directory when a caller has no outdir to thread', async () => {
    // The bound is no longer DEFAULTABLE on the resolvers themselves — it is a
    // required parameter there, so dropping it is a compile error rather than
    // a silent re-expression of go-to-k/cdkd#3489's own defect
    // (go-to-k/cdkd#3532). The `??` now lives at the two CALLERS whose options
    // bag may legitimately lack it, and this asserts the direction it falls:
    // toward the manifest directory, which is STRICTER than the app outdir,
    // never looser. Driven through `publish()` rather than the resolver, since
    // the resolver can no longer express the case.
    const { manifestDir } = stage();
    const { FileAssetPublisher } = await import('../../../src/assets/file-asset-publisher.js');

    await expect(
      new FileAssetPublisher().publish(
        'h1',
        fileAsset('../asset.abc123'),
        manifestDir,
        '123456789012',
        'us-east-1'
      )
    ).rejects.toThrow(CONTAINMENT);
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

    expect(resolveDockerContextDirectory(dir, 'asset.abc123', wrap, dir)).toBe(
      join(dir, 'asset.abc123')
    );
    expect(resolveDockerContextDirectory(dir, 'sub/../asset.abc123', wrap, dir)).toBe(
      join(dir, 'asset.abc123')
    );
  });

  it('throws through the CALLER-supplied wrapError, keeping its typed class', () => {
    const { dir } = assembly();
    class Typed extends Error {}

    expect(() =>
      resolveDockerContextDirectory(dir, '../outside-dir', (m) => new Typed(m), dir)
    ).toThrow(Typed);
  });
});

/**
 * An ABSOLUTE `source.path` / `source.directory` is HONOURED and warned about,
 * never refused (issue go-to-k/cdkd#3532) — the deploy-side twin of the
 * decision go-to-k/cdkd#3494 took for `cdkd local invoke`.
 *
 * What was there before was neither acceptance nor refusal:
 * `resolveAssemblyPath` joins with `path.join`, which does not honour a
 * leading separator, so an absolute value was folded INTO the outdir, read as
 * CONTAINED, and died later at `statSync` / BuildKit with an error naming a
 * path that exists nowhere. So the ASSERTION that matters in every case below
 * is `toBe(absolute)` — a fold would return `join(outdir, absolute)` and is
 * what these cases are shaped to catch.
 */
describe('an ABSOLUTE asset source path (cdk synth --no-staging)', () => {
  /**
   * Capture whatever the resolver's logger emits.
   *
   * Spying on `getLogger().child` rather than `vi.mock`ing the logger module:
   * both resolvers reach the logger through the SAME process-wide singleton,
   * and a module mock would pin what the caller PASSES while saying nothing
   * about the child a resolver actually takes.
   *
   * The spy is undone by the `afterEach` below, NEVER by a call trailing the
   * assertions. A failing `expect` throws, the trailing restore never runs,
   * and the still-live spy hands a `{warn}` stub to every later
   * `getLogger().child(...)` in the file — including `AssetManifestLoader`'s
   * constructor, whose `logger.debug` then explodes. The symptom is unrelated
   * suites reddening AFTER the one that really broke, which reads as a wider
   * regression than there is. Measured here while probing this very PR.
   */
  function captureWarn(): { warned: () => string[] } {
    const lines: string[] = [];
    vi.spyOn(getLogger(), 'child').mockImplementation(
      () => ({ warn: (m: string) => lines.push(m) }) as never
    );
    return { warned: () => lines };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ACCEPTS a file asset whose absolute source.path leaves the outdir, and WARNS naming it', () => {
    const { dir, outer } = assembly();
    const victim = join(outer, 'outside-dir');
    const cap = captureWarn();

    // The verdict: the path is returned VERBATIM, not folded under `dir`.
    expect(resolveFileAssetSourcePath(dir, fileAsset(victim), dir)).toBe(victim);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(victim);
    expect(lines[0]).toContain('--no-staging');
    // Says what is DONE with it, which is the whole point of warning at all.
    expect(lines[0]).toMatch(/upload/i);
  });

  it('ACCEPTS an absolute source.path INSIDE the outdir, and stays SILENT', () => {
    const { dir } = assembly();
    const inside = join(dir, 'asset.abc123');
    mkdirSync(inside);
    const cap = captureWarn();

    expect(resolveFileAssetSourcePath(dir, fileAsset(inside), dir)).toBe(inside);

    const lines = cap.warned();
    expect(lines).toEqual([]);
  });

  it('WARNS for an absolute source.path inside the outdir that leads OUT via a symlink', () => {
    // The ONLY case that exercises the `escape.escape === 'symlink'` arm of
    // the warning. Without it that ternary is dead: every other accepting case
    // takes the lexical branch, and a probe deleting the symlink clause stays
    // green.
    const { dir, outer } = assembly();
    symlinkSync(join(outer, 'outside-dir'), join(dir, 'link'), 'dir');
    const viaLink = join(dir, 'link');
    const cap = captureWarn();

    expect(resolveFileAssetSourcePath(dir, fileAsset(viaLink), dir)).toBe(viaLink);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('symbolic link');
    expect(lines[0]).toContain(join(outer, 'outside-dir'));
  });

  it('ACCEPTS a Docker asset whose absolute source.directory leaves the outdir, and WARNS', () => {
    const { dir, outer } = assembly();
    const victim = join(outer, 'outside-dir');
    const cap = captureWarn();

    expect(resolveDockerContextDirectory(dir, victim, wrapErr, dir)).toBe(victim);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(victim);
    expect(lines[0]).toContain('--no-staging');
    // The Docker sink is a BUILD CONTEXT, not an upload — the two warnings
    // must not be copies of each other.
    expect(lines[0]).toMatch(/build context/i);
  });

  it('ACCEPTS an absolute source.directory INSIDE the outdir, and stays SILENT', () => {
    const { dir } = assembly();
    const inside = join(dir, 'asset.abc123');
    mkdirSync(inside);
    const cap = captureWarn();

    expect(resolveDockerContextDirectory(dir, inside, wrapErr, dir)).toBe(inside);

    const lines = cap.warned();
    expect(lines).toEqual([]);
  });

  it('WARNS for an absolute source.directory inside the outdir that leads OUT via a symlink', () => {
    const { dir, outer } = assembly();
    symlinkSync(join(outer, 'outside-dir'), join(dir, 'link'), 'dir');
    const viaLink = join(dir, 'link');
    const cap = captureWarn();

    expect(resolveDockerContextDirectory(dir, viaLink, wrapErr, dir)).toBe(viaLink);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('symbolic link');
  });

  it('still REFUSES a RELATIVE escape, and warns about nothing', () => {
    // The two arms are NOT the same question. An accidental or legacy `..`
    // keeps failing closed; only the absolute spelling is honoured.
    const { dir } = assembly();
    const cap = captureWarn();

    expect(() => resolveFileAssetSourcePath(dir, fileAsset('../../outside.json'), dir)).toThrow(
      CONTAINMENT
    );
    expect(() => resolveDockerContextDirectory(dir, '../outside-dir', wrapErr, dir)).toThrow(
      CONTAINMENT
    );

    const lines = cap.warned();
    expect(lines).toEqual([]);
  });

  it('measures the absolute path against the APP OUTDIR, not the manifest directory', () => {
    // The bound is what a dropped argument used to get wrong, so assert it
    // directly: the SAME absolute path is silent under the app outdir and
    // warned about under the Stage's own manifest directory. A resolver that
    // bound to `manifestDir` would warn in both.
    const outdir = tmp();
    const manifestDir = join(outdir, 'assembly-MyStage');
    mkdirSync(manifestDir);
    const staged = join(outdir, 'asset.abc123');
    mkdirSync(staged);

    const wide = captureWarn();
    expect(resolveFileAssetSourcePath(manifestDir, fileAsset(staged), outdir)).toBe(staged);
    const wideLines = wide.warned();
    expect(wideLines).toEqual([]);

    const narrow = captureWarn();
    expect(resolveFileAssetSourcePath(manifestDir, fileAsset(staged), manifestDir)).toBe(staged);
    const narrowLines = narrow.warned();
    expect(narrowLines).toHaveLength(1);
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
