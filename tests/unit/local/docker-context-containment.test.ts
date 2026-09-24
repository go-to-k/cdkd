/**
 * Issue go-to-k/cdkd#3503: the Docker build context of every image cdkd hands
 * to cdk-local's OWN builder is contained within the app's outdir.
 *
 * cdk-local joins `source.directory` onto the manifest directory raw, so the
 * guard lives in cdkd's shim (`src/local/docker-image-builder.ts`) and each
 * call site must hand it the right BOUND. Two halves:
 *
 * - the shim itself, against real directories (an absolute value and a
 *   symlink are both judged by the engine's own spelling);
 * - each of the three call sites, driven end to end over a real Stage-shaped
 *   assembly with only cdk-local's builder stubbed. A Stage is the shape that
 *   tells the bound apart: its manifest sits in `assembly-<Stage>/` and its
 *   asset one level up, so `../asset.<hash>` is ACCEPTED only when the bound is
 *   the app outdir, and a site passing the manifest directory (or nothing)
 *   refuses it.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const warns: string[] = [];
// Spread the real module so everything else it exports stays live; only the
// warn channel is captured, since the SINK clause is visible only there.
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const quiet = {
    debug: () => {},
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
  };
  return {
    ...(await importOriginal<object>()),
    getLogger: () => ({ ...quiet, child: () => quiet }),
  };
});

const builtWith = vi.fn();
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildContainerImage: (...args: unknown[]) => {
    builtWith(...args);
    return Promise.resolve('cdkd-local-invoke-stub');
  },
}));

const { buildContainerImage } = await import('../../../src/local/docker-image-builder.js');
const { resolveContainerImagePlan } = await import('../../../src/cli/commands/local-invoke.js');
const { resolveContainerImageForStartApi } = await import(
  '../../../src/cli/commands/local-start-api.js'
);
const { resolveAgentCoreImage } = await import(
  '../../../src/cli/commands/local-invoke-agentcore.js'
);
const { LocalInvokeBuildError } = await import('../../../src/utils/error-handler.js');

afterEach(() => {
  builtWith.mockReset();
  warns.length = 0;
});

const HASH = 'b'.repeat(64);
const IMAGE_URI = `111122223333.dkr.ecr.us-east-1.amazonaws.com/cdk-assets:${HASH}`;

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-docker-context-')));
}

/**
 * `<outer>/cdk.out/assembly-MyStage/StageStack.assets.json`, naming one Docker
 * image asset whose `source.directory` is `directory`. `<outer>/victim` exists
 * beside the assembly, so an escape has somewhere real to land.
 */
function stageAssembly(directory: string): {
  outer: string;
  assemblyDir: string;
  manifestDir: string;
  manifestPath: string;
} {
  const outer = tmp();
  const assemblyDir = join(outer, 'cdk.out');
  const manifestDir = join(assemblyDir, 'assembly-MyStage');
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(join(outer, 'victim'));
  const manifestPath = join(manifestDir, 'StageStack.assets.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: '54.0.0',
      files: {},
      dockerImages: {
        [HASH]: {
          source: { directory },
          destinations: { d: { repositoryName: 'r', imageTag: HASH } },
        },
      },
    })
  );
  return { outer, assemblyDir, manifestDir, manifestPath };
}

describe('the container-image shim (src/local/docker-image-builder.ts)', () => {
  it('refuses a relative source.directory escaping the bound, before the builder runs', async () => {
    const cdkOut = join(tmp(), 'cdk.out');
    mkdirSync(cdkOut);

    const run = buildContainerImage({ source: { directory: '../victim' } }, cdkOut, {
      architecture: 'x86_64',
      assetOutdir: cdkOut,
    });

    await expect(run).rejects.toBeInstanceOf(LocalInvokeBuildError);
    await expect(run).rejects.toThrow(
      /Refusing to build the container image: asset source\.directory='\.\.\/victim'/
    );
    expect(builtWith).not.toHaveBeenCalled();
  });

  it('warns, naming the build context as the sink, when source.directory names the bound itself', async () => {
    const cdkOut = join(tmp(), 'cdk.out');
    mkdirSync(cdkOut);

    await buildContainerImage({ source: { directory: '.' } }, cdkOut, {
      architecture: 'x86_64',
      assetOutdir: cdkOut,
    });

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(
      'cdkd will send that directory to docker build as the context of an image cdkd then runs locally'
    );
    expect(builtWith).toHaveBeenCalledTimes(1);
  });

  it("names the executable's working directory as the sink when source.executable is set", async () => {
    // The engine takes the executable arm first, and there the directory is a
    // cwd for a manifest-supplied argv, not a build context.
    const cdkOut = join(tmp(), 'cdk.out');
    mkdirSync(cdkOut);

    await buildContainerImage({ source: { directory: '.', executable: ['./build.sh'] } }, cdkOut, {
      architecture: 'x86_64',
      assetOutdir: cdkOut,
    });

    const whole = warns.filter((w) => w.includes('naming the output directory ITSELF'));
    expect(whole).toHaveLength(1);
    expect(whole[0]).toContain(
      "cdkd will run this asset's source.executable with that directory as its working directory"
    );
  });

  it('delegates an ordinary asset unchanged, and does not forward the bound', async () => {
    const cdkOut = join(tmp(), 'cdk.out');
    mkdirSync(join(cdkOut, 'asset.abc'), { recursive: true });
    const asset = { source: { directory: 'asset.abc' } };

    await buildContainerImage(asset, cdkOut, {
      architecture: 'arm64',
      noBuild: true,
      assetOutdir: cdkOut,
    });

    // The SAME asset object and directory string: cdk-local derives the image
    // tag from `source`, so a rewritten directory would change every tag.
    expect(builtWith).toHaveBeenCalledWith(asset, cdkOut, { architecture: 'arm64', noBuild: true });
    expect(builtWith.mock.calls[0]![0]).toBe(asset);
  });

  it('names the build context as the sink for an EMPTY source.executable', async () => {
    // The engine takes the directory arm for `executable: []`, so the sink must
    // follow it rather than the field's mere presence.
    const cdkOut = join(tmp(), 'cdk.out');
    mkdirSync(cdkOut);

    await buildContainerImage({ source: { directory: '.', executable: [] } }, cdkOut, {
      architecture: 'x86_64',
      assetOutdir: cdkOut,
    });

    expect(warns.join('\n')).toContain('send that directory to docker build as the context');
  });

  it('refuses `<link>/..`, which the kernel resolves AFTER following the link', async () => {
    // Lexically `sub/link/..` is `sub`, inside the assembly. The engine hands
    // the raw string to the OS as a cwd, which follows `link` first and then
    // climbs from its target — out of the assembly.
    const outer = tmp();
    const cdkOut = join(outer, 'cdk.out');
    mkdirSync(join(cdkOut, 'sub'), { recursive: true });
    mkdirSync(join(outer, 'victim', 'secret'), { recursive: true });
    symlinkSync(join(outer, 'victim', 'secret'), join(cdkOut, 'sub', 'link'));

    await expect(
      buildContainerImage({ source: { directory: 'sub/link/..' } }, cdkOut, {
        architecture: 'x86_64',
        assetOutdir: cdkOut,
      })
    ).rejects.toThrow(
      new RegExp(`source\\.directory='sub/link/\\.\\.' which .*${join(outer, 'victim')}, outside`)
    );
    expect(builtWith).not.toHaveBeenCalled();
  });

  it("refuses `<link>/..` whose physical result is the assembly's own PARENT", async () => {
    // The widest shape: the link points at a sibling of `cdk.out`, so `..`
    // from its target lands on `<outer>` itself (a relative path of exactly
    // `..` from the bound), not below it.
    const outer = tmp();
    const cdkOut = join(outer, 'cdk.out');
    mkdirSync(join(cdkOut, 'sub'), { recursive: true });
    mkdirSync(join(outer, 'victim'));
    symlinkSync(join(outer, 'victim'), join(cdkOut, 'sub', 'link'));

    await expect(
      buildContainerImage({ source: { directory: 'sub/link/..' } }, cdkOut, {
        architecture: 'x86_64',
        assetOutdir: cdkOut,
      })
    ).rejects.toThrow(new RegExp(`leads through a symbolic link to ${outer}, outside`));
    expect(builtWith).not.toHaveBeenCalled();
  });

  it('delegates an executable-only asset (no directory to judge)', async () => {
    const cdkOut = join(tmp(), 'cdk.out');
    mkdirSync(cdkOut);

    await buildContainerImage({ source: { executable: ['./build.sh'] } }, cdkOut, {
      architecture: 'x86_64',
      assetOutdir: cdkOut,
    });

    expect(builtWith).toHaveBeenCalledTimes(1);
  });

  it('judges an ABSOLUTE value as the engine joins it: folded under the manifest directory', async () => {
    // `${cdkOutDir}/${'/etc'}` is `<cdk.out>//etc`, inside the assembly, so it
    // is not an escape and is not refused (the engine then fails to find it,
    // as it always has).
    const cdkOut = join(tmp(), 'cdk.out');
    mkdirSync(cdkOut);

    await buildContainerImage({ source: { directory: '/etc' } }, cdkOut, {
      architecture: 'x86_64',
      assetOutdir: cdkOut,
    });

    expect(builtWith).toHaveBeenCalledTimes(1);
    // ...and the honour-and-warn arm, which would claim a build from `/etc`
    // itself, was not taken.
    expect(warns).toEqual([]);
  });

  it('refuses an ABSOLUTE value that the engine join would carry out through a symlink', async () => {
    // Judged as the honour-and-warn arm, `/link` would be "honoured" as the
    // real root-level `/link`; the engine instead opens `<cdk.out>/link`, which
    // leads out of the assembly. The stripped spelling is what catches it.
    const outer = tmp();
    const cdkOut = join(outer, 'cdk.out');
    mkdirSync(cdkOut);
    mkdirSync(join(outer, 'victim'));
    symlinkSync(join(outer, 'victim'), join(cdkOut, 'link'));

    await expect(
      buildContainerImage({ source: { directory: '/link' } }, cdkOut, {
        architecture: 'x86_64',
        assetOutdir: cdkOut,
      })
    ).rejects.toThrow(/Refusing to build the container image/);
    expect(builtWith).not.toHaveBeenCalled();
  });
});

describe('the three call sites hand the shim the APP outdir as the bound', () => {
  const imageLambda = (stack: Record<string, unknown>): never =>
    ({
      kind: 'image',
      stack: { stackName: 'StageStack', displayName: 'StageStack', ...stack },
      logicalId: 'ImageFn',
      resource: { Type: 'AWS::Lambda::Function', Properties: {} },
      memoryMb: 128,
      timeoutSec: 3,
      layers: [],
      imageUri: IMAGE_URI,
      imageConfig: {},
      architecture: 'x86_64',
    }) as never;

  const sites: Array<{
    name: string;
    run: (a: ReturnType<typeof stageAssembly>) => Promise<unknown>;
  }> = [
    {
      name: 'cdkd local invoke (resolveContainerImagePlan)',
      run: (a) =>
        resolveContainerImagePlan(
          imageLambda({ assetManifestPath: a.manifestPath, assetOutdir: a.assemblyDir }),
          { build: true, pull: true } as never
        ),
    },
    {
      name: 'cdkd local start-api (resolveContainerImageForStartApi)',
      run: (a) =>
        resolveContainerImageForStartApi(
          imageLambda({ assetManifestPath: a.manifestPath, assetOutdir: a.assemblyDir }),
          false
        ),
    },
    {
      name: "cdkd local invoke-agentcore's container arm (resolveAgentCoreImage)",
      run: (a) =>
        resolveAgentCoreImage(
          {
            logicalId: 'AgentRuntime',
            containerUri: IMAGE_URI,
            stack: { stackName: 'StageStack', assetManifestPath: a.manifestPath },
          } as never,
          { platform: 'linux/amd64', build: true, pull: true } as never,
          a.assemblyDir
        ),
    },
  ];

  it.each(sites)("$name ACCEPTS a Stage's ../asset.<hash>", async ({ run }) => {
    const a = stageAssembly(`../asset.${HASH}`);

    await run(a);

    expect(builtWith).toHaveBeenCalledTimes(1);
    // Built from the manifest's own directory, which is what the engine joins
    // the relative value onto.
    expect(builtWith.mock.calls[0]![1]).toBe(a.manifestDir);
  });

  it.each(sites)('$name REFUSES a source.directory escaping the app outdir', async ({ run }) => {
    const a = stageAssembly('../../victim');

    await expect(run(a)).rejects.toThrow(
      /Refusing to build the container image: asset source\.directory='\.\.\/\.\.\/victim'/
    );
    expect(builtWith).not.toHaveBeenCalled();
  });
});
