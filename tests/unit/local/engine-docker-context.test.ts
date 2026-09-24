/**
 * Issue go-to-k/cdkd#3597: the three direct container builds (`cdkd local
 * invoke`, `local start-api`, `local invoke-agentcore`) run against the REAL
 * bundled cdk-local engine, which contains the Docker build context itself
 * since 0.149.3. Only `docker` is faked: `CDK_DOCKER` names a script that
 * records the working directory each build would have sent to BuildKit.
 *
 * `docker-context-containment.test.ts` stubs the engine to pin cdkd's own
 * pre-engine check; this file pins what that stub cannot see:
 *
 * - the bound reaches the ENGINE. Without it the engine narrows to the
 *   manifest directory and refuses a `cdk.Stage` image's `../asset.<hash>`,
 *   which cdkd's own check had just accepted;
 * - an escape is refused end to end, with cdkd's error class, and nothing is
 *   spawned;
 * - a manifest-chosen `source.executable` is announced ONCE per build, by the
 *   engine, not a second time by cdkd's shim.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cdkdWarns: string[] = [];
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const quiet = {
    debug: () => {},
    info: () => {},
    warn: (m: string) => cdkdWarns.push(m),
    error: () => {},
  };
  return {
    ...(await importOriginal<object>()),
    getLogger: () => ({ ...quiet, child: () => quiet }),
  };
});

const { buildContainerImage } = await import('../../../src/local/docker-image-builder.js');
const { resolveContainerImagePlan } = await import('../../../src/cli/commands/local-invoke.js');
const { resolveContainerImageForStartApi } = await import(
  '../../../src/cli/commands/local-start-api.js'
);
const { resolveAgentCoreImage } = await import(
  '../../../src/cli/commands/local-invoke-agentcore.js'
);
const { LocalInvokeBuildError } = await import('../../../src/utils/error-handler.js');

const HASH = 'd'.repeat(64);
const IMAGE_URI = `111122223333.dkr.ecr.us-east-1.amazonaws.com/cdk-assets:${HASH}`;

const created: string[] = [];
function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-engine-context-')));
  created.push(dir);
  return dir;
}

const fakeDir = tmp();
const dockerLog = join(fakeDir, 'docker.log');
let savedDocker: string | undefined;

beforeAll(() => {
  // Records `<cwd>|<argv>` per call and succeeds, so a build that reaches the
  // spawn leaves a line and a refused one leaves none.
  const script = join(fakeDir, 'docker');
  writeFileSync(script, `#!/bin/sh\necho "$PWD|$*" >> '${dockerLog}'\nexit 0\n`);
  chmodSync(script, 0o755);
  savedDocker = process.env['CDK_DOCKER'];
  process.env['CDK_DOCKER'] = script;
});

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  if (savedDocker === undefined) delete process.env['CDK_DOCKER'];
  else process.env['CDK_DOCKER'] = savedDocker;
});

afterEach(() => {
  writeFileSync(dockerLog, '');
  cdkdWarns.length = 0;
  vi.restoreAllMocks();
});

/** Every `docker` invocation since the last reset, as `{ cwd, argv }`. */
function dockerCalls(): Array<{ cwd: string; argv: string }> {
  if (!existsSync(dockerLog)) return [];
  return readFileSync(dockerLog, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const at = l.indexOf('|');
      return { cwd: l.slice(0, at), argv: l.slice(at + 1) };
    });
}

/**
 * `<outer>/cdk.out/assembly-MyStage/StageStack.assets.json` naming one Docker
 * image asset. `<outer>/cdk.out/asset.<hash>` is where CDK stages a Stage's
 * image, and `<outer>/victim` gives an escape somewhere real to land.
 */
function stageAssembly(directory: string): {
  assemblyDir: string;
  manifestDir: string;
  manifestPath: string;
  stagedAsset: string;
} {
  const outer = tmp();
  const assemblyDir = join(outer, 'cdk.out');
  const manifestDir = join(assemblyDir, 'assembly-MyStage');
  const stagedAsset = join(assemblyDir, `asset.${HASH}`);
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(stagedAsset);
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
  return { assemblyDir, manifestDir, manifestPath, stagedAsset };
}

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
    name: 'the buildContainerImage shim',
    run: (a) =>
      buildContainerImage({ source: { directory: readDirectory(a) } }, a.manifestDir, {
        architecture: 'x86_64',
        assetOutdir: a.assemblyDir,
      }),
  },
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

/** The shim case reads its value back out of the manifest the sites read. */
function readDirectory(a: ReturnType<typeof stageAssembly>): string {
  const manifest = JSON.parse(readFileSync(a.manifestPath, 'utf-8')) as {
    dockerImages: Record<string, { source: { directory: string } }>;
  };
  return manifest.dockerImages[HASH]!.source.directory;
}

describe('the real engine builds a cdk.Stage image through every cdkd site', () => {
  it.each(sites)(
    "$name builds ../asset.<hash> from the staged directory, not a refusal",
    async ({ run }) => {
      const a = stageAssembly(`../asset.${HASH}`);

      await run(a);

      const builds = dockerCalls().filter((c) => c.argv.startsWith('build '));
      expect(builds).toHaveLength(1);
      expect(builds[0]!.cwd).toBe(a.stagedAsset);
    }
  );

  it.each(sites)('$name refuses an escape with cdkd\'s error class, spawning nothing', async ({
    run,
  }) => {
    const a = stageAssembly('../../victim');

    const thrown = await run(a).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(thrown).toBeInstanceOf(LocalInvokeBuildError);
    expect((thrown as Error).message).toMatch(/victim.*outside/);
    expect(dockerCalls()).toEqual([]);
  });
});

describe('a manifest-chosen source.executable', () => {
  it('is announced once, by the engine, and not again by the shim', async () => {
    // The engine dedupes per (cwd, argv) per process, so any further case here
    // needs its own directory or it is silently deduped.
    const cdkOut = join(tmp(), 'cdk.out');
    mkdirSync(cdkOut);
    // The engine spawns the executable from the manifest directory and reads
    // the image tag it prints.
    writeFileSync(join(cdkOut, 'build.sh'), '#!/bin/sh\necho built:tag\n');
    chmodSync(join(cdkOut, 'build.sh'), 0o755);
    const engineWarns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      engineWarns.push(args.map(String).join(' '));
    });

    await buildContainerImage({ source: { executable: ['./build.sh'] } }, cdkOut, {
      architecture: 'x86_64',
      assetOutdir: cdkOut,
    });

    const announcements = [...cdkdWarns, ...engineWarns].filter((w) =>
      w.includes('source.executable runs a command this asset manifest chose')
    );
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toContain('./build.sh');
    // ...and the build really ran: the engine re-tags the script's image.
    expect(dockerCalls().filter((c) => c.argv.startsWith('tag built:tag '))).toHaveLength(1);
  });
});
