/**
 * Issues go-to-k/cdkd#3503 / #3597: every image cdkd hands to cdk-local's OWN
 * builder is contained within the app's outdir, by the ENGINE, against the
 * bound cdkd forwards. cdkd carries no copy of the check since cdk-local
 * 0.149.4 renders its refusals display-safe (go-to-k/cdkd#3652);
 * `engine-docker-context.test.ts` runs the real engine over every escape
 * shape. This file stubs the engine and pins what that one cannot isolate,
 * the WIRING:
 *
 * - the shim hands the engine the asset, the manifest directory and the bound
 *   unchanged;
 * - each of the three call sites hands it the APP outdir as the bound, driven
 *   end to end over a real Stage-shaped assembly. A Stage is the shape that
 *   tells the bound apart: its manifest sits in `assembly-<Stage>/` and its
 *   asset one level up, so a site passing the manifest directory (or nothing)
 *   makes the engine refuse `../asset.<hash>`.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Spread the real module so everything else it exports stays live; only the
// channels are silenced.
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const quiet = {
    debug: () => {},
    info: () => {},
    warn: () => {},
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

afterEach(() => {
  builtWith.mockReset();
});

const HASH = 'b'.repeat(64);
const IMAGE_URI = `111122223333.dkr.ecr.us-east-1.amazonaws.com/cdk-assets:${HASH}`;

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-docker-context-')));
}

/**
 * `<outer>/cdk.out/assembly-MyStage/StageStack.assets.json`, naming one Docker
 * image asset whose `source.directory` is `directory`.
 */
function stageAssembly(directory: string): {
  assemblyDir: string;
  manifestDir: string;
  manifestPath: string;
} {
  const outer = tmp();
  const assemblyDir = join(outer, 'cdk.out');
  const manifestDir = join(assemblyDir, 'assembly-MyStage');
  mkdirSync(manifestDir, { recursive: true });
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
  return { assemblyDir, manifestDir, manifestPath };
}

describe('the container-image shim (src/local/docker-image-builder.ts)', () => {
  it('delegates an ordinary asset unchanged, forwarding the bound to the engine', async () => {
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
    // The bound goes WITH it: the engine checks the context too since
    // cdk-local 0.149.3, and without one narrows to the manifest directory
    // (go-to-k/cdkd#3597).
    expect(builtWith).toHaveBeenCalledWith(asset, cdkOut, {
      architecture: 'arm64',
      noBuild: true,
      assetOutdir: cdkOut,
    });
    expect(builtWith.mock.calls[0]![0]).toBe(asset);
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
    // the relative value onto, with the APP outdir as the engine's bound.
    expect(builtWith.mock.calls[0]![1]).toBe(a.manifestDir);
    expect(builtWith.mock.calls[0]![2]).toMatchObject({ assetOutdir: a.assemblyDir });
  });
});
