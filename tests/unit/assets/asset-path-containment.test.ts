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

const CONTAINMENT = /resolves to .*, outside .*\./;

const wrapErr = (m: string): Error => new Error(m);

/**
 * Test-local wrappers supplying the SINK clause each resolver now requires.
 * A literal here rather than the production wording on purpose: the cases
 * below assert that the caller's phrase reaches the warning, so pinning the
 * production string would make them pass on a resolver that ignored the
 * argument and baked its own text back in.
 */
const FILE_SINK = 'do the file thing with it';
const DOCKER_SINK = 'do the docker thing with it';
const resolveFile = (dir: string, a: FileAsset, bound: string): string =>
  resolveFileAssetSourcePath(dir, a, { assetOutdir: bound, sink: FILE_SINK });
const resolveDocker = (dir: string, d: string, bound: string, id?: string): string =>
  resolveDockerContextDirectory({
    manifestDir: dir,
    directory: d,
    wrapError: wrapErr,
    assetOutdir: bound,
    sink: DOCKER_SINK,
    ...(id !== undefined && { assetId: id }),
  });

describe("a file asset's source.path", () => {
  it('refuses one that leaves the assembly directory, naming the asset and the path', () => {
    const { dir } = assembly();

    expect(() => resolveFile(dir, fileAsset('../../outside.json'), dir)).toThrow(
      /File asset 'MyAsset' has source\.path='\.\.\/\.\.\/outside\.json' which resolves to .*, outside/
    );
  });

  it('refuses one that stays inside lexically but leads out through a symlink', () => {
    const { dir, outer } = assembly();
    symlinkSync(outer, join(dir, 'link'), 'dir');

    expect(() => resolveFile(dir, fileAsset('link/outside.json'), dir)).toThrow(
      /leads through a symbolic link to .*outside\.json, outside/
    );
  });

  it('still resolves an ordinary asset directory and one that normalises back inside', () => {
    const { dir } = assembly();

    expect(resolveFile(dir, fileAsset('asset.abc123'), dir)).toBe(
      join(dir, 'asset.abc123')
    );
    expect(resolveFile(dir, fileAsset('sub/../asset.abc123'), dir)).toBe(
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

    expect(resolveFile(manifestDir, fileAsset('../asset.abc123'), outdir)).toBe(
      join(outdir, 'asset.abc123')
    );
    expect(resolveDocker(manifestDir, '../asset.abc123', outdir)).toBe(
      join(outdir, 'asset.abc123')
    );
  });

  it('ACCEPTS a NESTED Stage reaching two levels up, which Stages legitimately do', () => {
    const outdir = tmp();
    const inner = join(outdir, 'assembly-Outer', 'assembly-Inner');
    mkdirSync(inner, { recursive: true });
    mkdirSync(join(outdir, 'asset.abc123'));

    expect(resolveFile(inner, fileAsset('../../asset.abc123'), outdir)).toBe(
      join(outdir, 'asset.abc123')
    );
  });

  it('still REFUSES an escape from a STAGE manifest', () => {
    const { outdir, manifestDir } = stage();

    expect(() =>
      resolveFile(manifestDir, fileAsset('../../outside.json'), outdir)
    ).toThrow(CONTAINMENT);
    expect(() =>
      resolveDocker(manifestDir, '../../outside-dir', outdir)
    ).toThrow(CONTAINMENT);
  });

  it('still REFUSES an escape from a TOP-LEVEL manifest, where the two bases coincide', () => {
    const outdir = tmp();

    expect(() =>
      resolveFile(outdir, fileAsset('../outside.json'), outdir)
    ).toThrow(CONTAINMENT);
    // ...and the widened base must not let ONE `..` through from the top level.
    expect(() => resolveDocker(outdir, '../outside-dir', outdir)).toThrow(
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
      resolveFile(data.cdkOutputDir, fileAsset('../asset.abc123'), data.assetOutdir)
    ).toBe(join(outdir, 'asset.abc123'));
  });

  it('NARROWS to the manifest directory when a caller has no outdir to thread', async () => {
    // The bound is no longer DEFAULTABLE on the resolvers, nor on
    // `FileAssetPublisher.publish` / `DockerAssetPublisher.build`, where it is
    // required and positioned so that dropping it is a compile error
    // (go-to-k/cdkd#3532). ONE `??` survives, in `buildDockerImage`, whose
    // options bag may legitimately lack an outdir (`ecs-task-runner` spreads
    // it conditionally). This asserts the direction that one falls: toward the
    // manifest directory, which is STRICTER than the app outdir, never looser.
    // Driven through `buildDockerImage`, since no resolver can express it.
    const { manifestDir } = stage();
    runDockerStreaming.mockClear();

    await expect(
      buildDockerImage({ source: { directory: '../asset.abc123' } }, manifestDir, {
        tag: 't',
        wrapError: wrapErr,
      })
    ).rejects.toThrow(CONTAINMENT);
    expect(runDockerStreaming).not.toHaveBeenCalled();
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
      /asset source\.directory='\.\.\/outside-dir' which resolves to .*outside-dir, outside/
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
    ).rejects.toThrow(/leads through a symbolic link to .*outside-dir, outside/);

    expect(runDockerStreaming).not.toHaveBeenCalled();
  });

  it('still resolves an ordinary directory and one that normalises back inside', () => {
    // Asserted on the extracted helper rather than through `buildDockerImage`,
    // which would spawn a real `docker` and could only assert the absence of a
    // containment error. The three cases above keep the WIRING fenced for both
    // arms; this one fences the accepting verdict itself.
    const { dir } = assembly();
    mkdirSync(join(dir, 'asset.abc123'));

    expect(resolveDocker(dir, 'asset.abc123', dir)).toBe(join(dir, 'asset.abc123'));
    expect(resolveDocker(dir, 'sub/../asset.abc123', dir)).toBe(join(dir, 'asset.abc123'));
  });

  it('throws through the CALLER-supplied wrapError, keeping its typed class', () => {
    const { dir } = assembly();
    class Typed extends Error {}

    expect(() =>
      resolveDockerContextDirectory({
        manifestDir: dir,
        directory: '../outside-dir',
        wrapError: (m: string) => new Typed(m),
        assetOutdir: dir,
        sink: DOCKER_SINK,
      })
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
    // The stub carries the WHOLE logger surface, not just `warn`. A
    // `warn`-only object is enough for a direct resolver call and explodes the
    // moment a case drives `buildDockerImage`, which also calls `debug` — and
    // the failure (`logger.debug is not a function`) accuses the code under
    // test rather than the stub.
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

  it('ACCEPTS a file asset whose absolute source.path leaves the outdir, and WARNS naming it', () => {
    const { dir, outer } = assembly();
    const victim = join(outer, 'outside-dir');
    const cap = captureWarn();

    // The verdict: the path is returned VERBATIM, not folded under `dir`.
    expect(resolveFile(dir, fileAsset(victim), dir)).toBe(victim);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(victim);
    expect(lines[0]).toContain('--no-staging');
    // Says what is DONE with it, which is the whole point of warning at all —
    // and says what THIS CALLER does, not a clause baked into the resolver.
    expect(lines[0]).toContain(FILE_SINK);
  });

  it('ACCEPTS an absolute source.path INSIDE the outdir, and stays SILENT', () => {
    const { dir } = assembly();
    const inside = join(dir, 'asset.abc123');
    mkdirSync(inside);
    const cap = captureWarn();

    expect(resolveFile(dir, fileAsset(inside), dir)).toBe(inside);

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

    expect(resolveFile(dir, fileAsset(viaLink), dir)).toBe(viaLink);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('symbolic link');
    expect(lines[0]).toContain(join(outer, 'outside-dir'));
  });

  it('ACCEPTS a Docker asset whose absolute source.directory leaves the outdir, and WARNS', () => {
    const { dir, outer } = assembly();
    const victim = join(outer, 'outside-dir');
    const cap = captureWarn();

    expect(resolveDocker(dir, victim, dir)).toBe(victim);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(victim);
    expect(lines[0]).toContain('--no-staging');
    // The sink comes from the CALLER; the two resolvers must not bake in one
    // shared clause, because their callers do different things.
    expect(lines[0]).toContain(DOCKER_SINK);
    expect(lines[0]).not.toContain(FILE_SINK);
  });

  it('ACCEPTS an absolute source.directory INSIDE the outdir, and stays SILENT', () => {
    const { dir } = assembly();
    const inside = join(dir, 'asset.abc123');
    mkdirSync(inside);
    const cap = captureWarn();

    expect(resolveDocker(dir, inside, dir)).toBe(inside);

    const lines = cap.warned();
    expect(lines).toEqual([]);
  });

  it('WARNS for an absolute source.directory inside the outdir that leads OUT via a symlink', () => {
    const { dir, outer } = assembly();
    symlinkSync(join(outer, 'outside-dir'), join(dir, 'link'), 'dir');
    const viaLink = join(dir, 'link');
    const cap = captureWarn();

    expect(resolveDocker(dir, viaLink, dir)).toBe(viaLink);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('symbolic link');
  });

  it('still REFUSES a RELATIVE escape, and warns about nothing', () => {
    // The two arms are NOT the same question. An accidental or legacy `..`
    // keeps failing closed; only the absolute spelling is honoured.
    const { dir } = assembly();
    const cap = captureWarn();

    expect(() => resolveFile(dir, fileAsset('../../outside.json'), dir)).toThrow(
      CONTAINMENT
    );
    expect(() => resolveDocker(dir, '../outside-dir', dir)).toThrow(
      CONTAINMENT
    );

    const lines = cap.warned();
    expect(lines).toEqual([]);
  });

  it('does NOT warn about two spellings of ONE directory (the macOS /var vs /private/var case)', () => {
    // A FALSE POSITIVE, not a missed escape. The bound and the target arrive
    // here independently — the bound from `-a` or the assembly's own
    // `directoryName`, the target from the manifest — so on macOS one can be
    // `/var/folders/...` and the other `/private/var/folders/...`, which name
    // the same directory. `absoluteAssemblyPathEscape` used to return its
    // LEXICAL verdict without consulting the real paths, so an ordinary
    // `--no-staging` asset inside the outdir was announced as "outside the
    // assembly". A warning that cries wolf is worse than none: users learn to
    // skip the line that matters.
    const unresolved = mkdtempSync(join(tmpdir(), 'cdkd-spelling-'));
    const real = realpathSync(unresolved);
    if (real === unresolved) {
      // Nothing to prove on a platform whose tmpdir is not behind a link.
      return;
    }
    const inside = join(real, 'asset.abc123');
    mkdirSync(inside);
    const cap = captureWarn();

    // Bound spelled one way, target the other. Both arms, since the two
    // resolvers must agree.
    expect(resolveFile(unresolved, fileAsset(inside), unresolved)).toBe(inside);
    expect(resolveDocker(unresolved, inside, unresolved)).toBe(inside);

    expect(cap.warned()).toEqual([]);
  });

  it('still WARNS when the real paths really are apart, so the exoneration is not a hole', () => {
    // The complement of the case above: if exonerating on real paths were
    // unconditional, or compared the wrong pair, a genuine escape would go
    // silent. Same unresolved spelling for the bound, a target outside it.
    const unresolved = mkdtempSync(join(tmpdir(), 'cdkd-spelling-'));
    const outsideReal = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-victim-')));
    const cap = captureWarn();

    expect(resolveFile(unresolved, fileAsset(outsideReal), unresolved)).toBe(outsideReal);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(outsideReal);
  });

  it('ACCEPTS a value naming the BOUND ITSELF by either spelling, and WARNS on all four', () => {
    // The two arms have to agree about the bound directory. The absolute arm
    // treats `target === bound` as inside; the relative arm reaches
    // `resolveAssemblyPath`, whose empty `path.relative` reads as "names the
    // directory rather than a file inside it" — true and useful for its other
    // callers, which all READ A FILE, and false here, where an asset source IS
    // a directory. Mirrors the local twin (go-to-k/cdkd#3494).
    //
    // **But it must not be SILENT, and a first revision of this case asserted
    // that it was.** The twin bind-mounts; this layer zips the directory and
    // uploads it to a bucket the manifest names, so accepting `.` silently
    // sends the WHOLE `cdk.out` — every template and every staged asset — with
    // no line printed. Parity of the verdict is right, parity of the silence
    // is not. Four spellings, because the absolute and relative arms of each
    // resolver reach the check by different routes.
    const { dir } = assembly();
    const cap = captureWarn();

    expect(resolveFile(dir, fileAsset(dir), dir)).toBe(dir);
    expect(resolveFile(dir, fileAsset('.'), dir)).toBe(dir);
    expect(resolveDocker(dir, dir, dir)).toBe(dir);
    expect(resolveDocker(dir, '.', dir)).toBe(dir);

    const lines = cap.warned();
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).toContain('output directory ITSELF');
      expect(line).toContain('WHOLE');
      expect(line).toContain(dir);
    }
    // The sink still comes from the caller, so a user reads what happens next.
    expect(lines[0]).toContain(FILE_SINK);
    expect(lines[2]).toContain(DOCKER_SINK);
  });

  it('WARNS for EVERY spelling of the output directory, not just the one `-a` used', () => {
    // The gap two reviewers found independently, and the reason this check is
    // `namesTheSameDirectory` rather than `resolve(a) === resolve(b)`.
    //
    // The escape check EXONERATES a second spelling of the bound as inside —
    // correctly, it IS inside. A lexical equality beside it then answers "not
    // the bound", so the one value meaning "the whole assembly is this asset"
    // passed both tests and printed nothing. The value is attacker-chosen, so
    // meeting the trigger is theirs: `<outdir>/self` needs only a symlink they
    // ship in the assembly, and the realpath spelling needs nothing at all on
    // macOS, where `$TMPDIR` and `/tmp` are already two spellings of one path.
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-spellings-')));
    const realOut = join(outer, 'real-outdir');
    mkdirSync(realOut);
    // The bound as `-a` gave it: a LINK to the real outdir.
    const linkOut = join(outer, 'cdk.out');
    symlinkSync(realOut, linkOut, 'dir');
    // A self-link inside the assembly, which an assembly author controls.
    symlinkSync(realOut, join(realOut, 'self'), 'dir');

    for (const spelling of [linkOut, realOut, join(linkOut, 'self'), join(realOut, 'self')]) {
      const cap = captureWarn();
      expect(resolveFile(linkOut, fileAsset(spelling), linkOut)).toBe(spelling);
      const lines = cap.warned();
      expect(lines, `absolute spelling ${spelling}`).toHaveLength(1);
      expect(lines[0]).toContain('output directory ITSELF');
      vi.restoreAllMocks();
    }

    // ...and the RELATIVE spelling of the same directory must agree. It used
    // to REFUSE (`resolveAssemblyPath`'s symlink arm), so one directory got a
    // refusal or a silent accept depending only on how it was written — the
    // relative-refuses / absolute-sails asymmetry this PR exists to reason
    // about, reproduced inside the fix for it.
    const cap = captureWarn();
    expect(resolveFile(linkOut, fileAsset('self'), linkOut)).toBe(join(linkOut, 'self'));
    expect(cap.warned()[0]).toContain('output directory ITSELF');
  });

  it("WARNS for a Stage manifest's `..`, which resolves onto the outdir the same way", () => {
    // The reachable spelling: from `cdk.out/assembly-<Stage>/`, `..` IS the
    // app outdir, so a tampered Stage manifest reaches the whole-assembly case
    // without ever writing `.`.
    const outdir = tmp();
    const manifestDir = join(outdir, 'assembly-MyStage');
    mkdirSync(manifestDir);
    const cap = captureWarn();

    expect(resolveFile(manifestDir, fileAsset('..'), outdir)).toBe(outdir);

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('output directory ITSELF');
  });

  it("names the Docker asset when the caller has an id, and does not when it has none", () => {
    // With several image assets under `--no-staging` a subject-less warning
    // gives N indistinguishable lines.
    const { dir, outer } = assembly();
    const victim = join(outer, 'outside-dir');
    const cap = captureWarn();

    expect(resolveDocker(dir, victim, dir, 'cdkd-asset-deadbeef')).toBe(victim);
    expect(resolveDocker(dir, victim, dir)).toBe(victim);

    const lines = cap.warned();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('cdkd-asset-deadbeef');
    expect(lines[1]).not.toContain('cdkd-asset-deadbeef');
  });

  it("describes the EXECUTABLE arm's sink as a working directory, not a build context", async () => {
    // `buildDockerImage` resolves `source.directory` through ONE closure for
    // both arms, so the sink is easy to get wrong in the direction that
    // UNDERSTATES: in the `executable` arm nothing reaches BuildKit and cdkd
    // pushes nothing — the directory becomes the cwd of a manifest-supplied
    // argv, which is the larger risk. A probe copying the build-context
    // wording onto this arm reds here and nowhere else.
    const { dir, outer } = assembly();
    const victim = join(outer, 'outside-dir');
    spawnStreaming.mockClear();
    spawnStreaming.mockResolvedValue({ stdout: 'built-image:v1', stderr: '', exitCode: 0 });
    const cap = captureWarn();

    await buildDockerImage(
      { source: { directory: victim, executable: ['/bin/echo', 'x'] } },
      dir,
      { tag: 't', wrapError: wrapErr, assetOutdir: dir }
    );

    // TWO lines now: this arm also announces that it is about to run a
    // manifest-chosen command line (go-to-k/cdkd#3497). Assert each, rather
    // than loosening the count — the point of the case is that the PATH line
    // describes a working directory, and a laxer assertion would pass on a
    // regression that emitted the build-context wording twice.
    const lines = cap.warned();
    expect(lines).toHaveLength(2);
    const pathLine = lines.find((l) => l.includes('absolute source.directory'));
    expect(pathLine).toBeDefined();
    expect(pathLine).toContain('working directory');
    expect(pathLine).toContain('source.executable');
    expect(pathLine).not.toContain('BuildKit');
    expect(lines.some((l) => l.includes('source.executable runs a command'))).toBe(true);
    // ...and the directory really is what the spawn got, so the warning is
    // describing the value that was used.
    expect(spawnStreaming).toHaveBeenCalledWith(
      '/bin/echo',
      ['x'],
      expect.objectContaining({ cwd: victim })
    );
  });

  it('describes the DIRECTORY arm as a build context, so the two are not copies', async () => {
    const { dir, outer } = assembly();
    const victim = join(outer, 'outside-dir');
    runDockerStreaming.mockClear();
    runDockerStreaming.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const cap = captureWarn();

    await buildDockerImage({ source: { directory: victim } }, dir, {
      tag: 't',
      wrapError: wrapErr,
      assetOutdir: dir,
    });

    const lines = cap.warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('BuildKit');
    expect(lines[0]).not.toContain('working directory');
  });

  it("WIRES buildDockerImage's (context, outdir) pair into the passthrough warning", async () => {
    // The callee is fenced in `manifest-passthrough-warnings.test.ts`; this is
    // the only case that can see the ARGUMENTS. Both are `string`, so a swap
    // compiles — and a swap is not inert: base and bound trade places,
    // `contextNarrows` flips, and ordinary relative passthroughs start warning
    // about paths outside the project. That pair is what five review rounds
    // were about, and nothing reached this call site with a non-empty field
    // list before.
    const { dir, outer } = assembly();
    const victim = join(outer, 'outside-dir');
    runDockerStreaming.mockClear();
    runDockerStreaming.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const cap = captureWarn();

    mkdirSync(join(dir, 'asset.abc123'));

    // `../Dockerfile` from the context is `<outdir>/Dockerfile` — INSIDE the
    // outdir, so it must be silent. That is the half that pins the ORDER: an
    // absolute victim path warns under either arrangement, while this one is
    // silent only when `base` is the context and `bound` is the outdir. Swap
    // them and `contextNarrows` flips, `../Dockerfile` resolves against the
    // outdir instead, lands outside the (now narrower) bound, and warns.
    writeFileSync(join(dir, 'Dockerfile'), '');

    await buildDockerImage(
      {
        source: {
          directory: 'asset.abc123',
          dockerFile: '../Dockerfile',
          dockerOutputs: [`type=local,dest=${victim}`],
        },
      },
      dir,
      { tag: 't', wrapError: wrapErr, assetOutdir: dir }
    );

    const lines = cap.warned();
    expect(lines, lines.join(' | ')).toHaveLength(1);
    expect(lines[0]).toContain('dockerOutputs');
    expect(lines[0]).toContain(victim);
    expect(lines[0]).toContain('cdkd will WRITE to it');
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
    expect(resolveFile(manifestDir, fileAsset(staged), outdir)).toBe(staged);
    const wideLines = wide.warned();
    expect(wideLines).toEqual([]);

    const narrow = captureWarn();
    expect(resolveFile(manifestDir, fileAsset(staged), manifestDir)).toBe(staged);
    const narrowLines = narrow.warned();
    expect(narrowLines).toHaveLength(1);
  });
});

describe('the asset manifest filename, built from a manifest-chosen stackName', () => {
  it('refuses a stack name that escapes the assembly directory', async () => {
    const { dir } = assembly();

    await expect(new AssetManifestLoader().loadManifest(dir, '../../evil')).rejects.toThrow(
      /Asset manifest for stack '\.\.\/\.\.\/evil' resolves to .*, outside/
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
    ).rejects.toThrow(/leads through a symbolic link to .*Reachable\.assets\.json, outside/);
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
