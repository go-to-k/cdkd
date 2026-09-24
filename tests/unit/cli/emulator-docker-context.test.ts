/**
 * Issue go-to-k/cdkd#3503, the ECS emulator half: `cdkd local start-service` /
 * `start-alb` hand the run to cdk-local's `runEcsServiceEmulator`, whose own
 * image build joins `source.directory` onto the manifest directory raw. cdkd
 * checks the manifests from the strategy's `resolveBoots`, which the engine
 * calls after every synth and before any build.
 *
 * The first block drives the check over real manifests on disk. The second
 * runs each REAL command through commander with only the engine stubbed, and
 * drives whatever strategy the action hands it — so a call site that stops
 * decorating goes red however the action spells it.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmulatorStrategy } from '../../../src/cli/commands/ecs-service-emulator.js';

const warns: string[] = [];
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

const captured: { strategy?: EmulatorStrategy } = {};
vi.mock('../../../src/cli/commands/ecs-service-emulator.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runEcsServiceEmulator: vi.fn(async (_t: unknown, _o: unknown, strategy: EmulatorStrategy) => {
    captured.strategy = strategy;
  }),
}));

const { assertEmulatorDockerContextsContained, containEmulatorDockerContexts } = await import(
  '../../../src/cli/commands/emulator-docker-context.js'
);
const { createLocalStartServiceCommand } = await import(
  '../../../src/cli/commands/local-start-service.js'
);
const { createLocalStartAlbCommand } = await import('../../../src/cli/commands/local-start-alb.js');
const { LocalInvokeBuildError } = await import('../../../src/utils/error-handler.js');

afterEach(() => {
  warns.length = 0;
});

const HASH = 'c'.repeat(64);

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-emulator-context-')));
}

/**
 * A Stage-shaped assembly with one stack `StageStack` whose manifest names one
 * Docker image asset. `<outer>/victim` exists, so an escape lands somewhere.
 */
function stageAssembly(directory: string): {
  outer: string;
  assemblyDir: string;
  manifestDir: string;
  stack: { stackName: string; assetManifestPath: string; assetOutdir: string };
} {
  const outer = tmp();
  const assemblyDir = join(outer, 'cdk.out');
  const manifestDir = join(assemblyDir, 'assembly-MyStage');
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(join(outer, 'victim'));
  const assetManifestPath = join(manifestDir, 'StageStack.assets.json');
  writeManifest(assetManifestPath, directory);
  return {
    outer,
    assemblyDir,
    manifestDir,
    stack: { stackName: 'StageStack', assetManifestPath, assetOutdir: assemblyDir },
  };
}

function writeManifest(path: string, directory: string): void {
  writeFileSync(
    path,
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
}

/**
 * The shape the ENGINE produces for a Stage: cdk-local enumerates no Stage
 * stacks from the app root, so `--app cdk.out/assembly-MyStage` is how a Stage
 * runs, and its `StackInfo.assetOutdir` is that sub-assembly. `declared`
 * decides whether the parent `manifest.json` names it as a nested assembly.
 */
function engineStageApp(directory: string, declared: boolean): {
  assemblyDir: string;
  subAssembly: string;
  stack: { stackName: string; assetManifestPath: string; assetOutdir: string };
} {
  const { assemblyDir, manifestDir, stack } = stageAssembly(directory);
  writeFileSync(
    join(assemblyDir, 'manifest.json'),
    JSON.stringify({
      version: '54.0.0',
      artifacts: declared
        ? {
            'assembly-MyStage': {
              type: 'cdk:cloud-assembly',
              properties: { directoryName: 'assembly-MyStage' },
            },
          }
        : {},
    })
  );
  return { assemblyDir, subAssembly: manifestDir, stack: { ...stack, assetOutdir: manifestDir } };
}

describe('assertEmulatorDockerContextsContained', () => {
  it("accepts a Stage run the engine's way (--app <sub-assembly>), climbing to the declaring parent", () => {
    const { assemblyDir, subAssembly, stack } = engineStageApp(`../asset.${HASH}`, true);
    expect(() => assertEmulatorDockerContextsContained([stack])).not.toThrow();
    // The widening is announced, naming both directories.
    const climbed = warns.filter((w) => w.includes('is a cdk.Stage sub-assembly'));
    expect(climbed).toHaveLength(1);
    expect(climbed[0]).toContain(`${subAssembly} is a cdk.Stage sub-assembly`);
    expect(climbed[0]).toContain(`its parent ${assemblyDir} as the assembly root`);
  });

  it('warns about a derived root ONCE, not on every check (every --watch reload re-runs it)', () => {
    const { stack } = engineStageApp(`../asset.${HASH}`, true);
    assertEmulatorDockerContextsContained([stack]);
    assertEmulatorDockerContextsContained([stack]);
    expect(warns.filter((w) => w.includes('is a cdk.Stage sub-assembly'))).toHaveLength(1);
  });

  it('does not climb for a parent artifact of another type carrying the same directoryName', () => {
    const { assemblyDir, stack } = engineStageApp(`../asset.${HASH}`, false);
    writeFileSync(
      join(assemblyDir, 'manifest.json'),
      JSON.stringify({
        artifacts: {
          x: { type: 'aws:cloudformation:stack', properties: { directoryName: 'assembly-MyStage' } },
        },
      })
    );
    expect(() => assertEmulatorDockerContextsContained([stack])).toThrow(/outside/);
  });

  it('does not climb when the parent does not declare the sub-assembly', () => {
    const { stack } = engineStageApp(`../asset.${HASH}`, false);
    expect(() => assertEmulatorDockerContextsContained([stack])).toThrow(/outside/);
  });

  it('still refuses an escape past the climbed root', () => {
    const { stack } = engineStageApp('../../victim', true);
    expect(() => assertEmulatorDockerContextsContained([stack])).toThrow(/victim.*outside/);
  });

  it('refuses `<link>/..`, which the kernel resolves after following the link', () => {
    const { outer, manifestDir, stack } = stageAssembly('sub/link/..');
    mkdirSync(join(manifestDir, 'sub'));
    mkdirSync(join(outer, 'victim', 'secret'));
    symlinkSync(join(outer, 'victim', 'secret'), join(manifestDir, 'sub', 'link'));
    expect(() => assertEmulatorDockerContextsContained([stack])).toThrow(/symbolic link/);
  });

  it('skips an entry with no source object or a non-string directory', () => {
    const { stack } = stageAssembly(`../asset.${HASH}`);
    writeFileSync(
      stack.assetManifestPath,
      JSON.stringify({ dockerImages: { a: null, b: { source: null }, c: { source: { directory: 7 } } } })
    );
    expect(() => assertEmulatorDockerContextsContained([stack])).not.toThrow();
  });

  it("accepts a Stage's ../asset.<hash> against the app outdir", () => {
    const { stack } = stageAssembly(`../asset.${HASH}`);
    expect(() => assertEmulatorDockerContextsContained([stack])).not.toThrow();
  });

  it('refuses a source.directory escaping the app outdir, naming the asset and the stack', () => {
    const { stack } = stageAssembly('../../victim');
    let thrown: unknown;
    try {
      assertEmulatorDockerContextsContained([stack]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LocalInvokeBuildError);
    expect((thrown as Error).message).toMatch(
      new RegExp(
        `^Refusing to build container image asset ${HASH} of stack StageStack: ` +
          `asset source\\.directory=\\.\\./\\.\\./victim which resolves to .*victim, outside`
      )
    );
  });

  it('binds to assetOutdir: without one the bound narrows to the manifest directory', () => {
    // The fallback is `assetPathDirs`'s, and it NARROWS: a Stage asset is then
    // refused. This is what tells a dropped bound apart from a passed one.
    const { stack } = stageAssembly(`../asset.${HASH}`);
    const { assetOutdir: _dropped, ...withoutBound } = stack;
    expect(() => assertEmulatorDockerContextsContained([withoutBound])).toThrow(/outside/);
  });

  it('checks EVERY stack, not only the first', () => {
    const benign = stageAssembly(`../asset.${HASH}`).stack;
    const hostile = stageAssembly('../../victim').stack;
    expect(() => assertEmulatorDockerContextsContained([benign, hostile])).toThrow(/victim/);
  });

  it('refuses an ABSOLUTE value the engine join would carry out through a symlink', () => {
    const { outer, manifestDir, stack } = stageAssembly('/link');
    symlinkSync(join(outer, 'victim'), join(manifestDir, 'link'));
    expect(() => assertEmulatorDockerContextsContained([stack])).toThrow(/Refusing/);
    // Control: the same absolute value without the link folds under the
    // manifest directory, which is not an escape.
    const plain = stageAssembly('/link').stack;
    expect(() => assertEmulatorDockerContextsContained([plain])).not.toThrow();
  });

  it('reads <stackName>.assets.json as the engine does, not assetManifestPath verbatim', () => {
    // The engine loads `<dirname(assetManifestPath)>/<stackName>.assets.json`.
    // Point `assetManifestPath` at a BENIGN file of another name; the file the
    // engine will read is the hostile one, and it must be the one judged.
    const { manifestDir, stack } = stageAssembly('../../victim');
    const decoy = join(manifestDir, 'decoy.json');
    writeManifest(decoy, `../asset.${HASH}`);
    expect(() =>
      assertEmulatorDockerContextsContained([{ ...stack, assetManifestPath: decoy }])
    ).toThrow(/victim/);
  });

  it('refuses a stackName that carries the manifest filename out of its directory', () => {
    const { stack } = stageAssembly(`../asset.${HASH}`);
    expect(() =>
      assertEmulatorDockerContextsContained([{ ...stack, stackName: '../../../elsewhere' }])
    ).toThrow(/Refusing to build container images: the asset manifest for stack/);
  });

  it('skips a stack with no manifest, a missing file, and a file that is not JSON', () => {
    const outer = tmp();
    const bad = join(outer, 'Broken.assets.json');
    writeFileSync(bad, '{ not json');
    expect(() =>
      assertEmulatorDockerContextsContained([
        { stackName: 'NoManifest' },
        { stackName: 'Missing', assetManifestPath: join(outer, 'Missing.assets.json') },
        { stackName: 'Broken', assetManifestPath: bad },
      ])
    ).not.toThrow();
  });
});

describe('containEmulatorDockerContexts', () => {
  const inner = (): EmulatorStrategy =>
    ({
      resolveBoots: vi.fn(() => ({ boots: [{ target: 'S/Svc' }], warnings: ['w'] })),
      lbPortOverrides: {},
    }) as unknown as EmulatorStrategy;

  it("returns the inner strategy's plan unchanged when every context is contained", () => {
    const { stack } = stageAssembly(`../asset.${HASH}`);
    const decorated = containEmulatorDockerContexts(inner());
    expect(decorated.resolveBoots([stack] as never, ['S/Svc'])).toEqual({
      boots: [{ target: 'S/Svc' }],
      warnings: ['w'],
    });
  });

  it('throws BEFORE the inner strategy plans anything when a context escapes', () => {
    const { stack } = stageAssembly('../../victim');
    const strategy = inner();
    const decorated = containEmulatorDockerContexts(strategy);
    expect(() => decorated.resolveBoots([stack] as never, ['S/Svc'])).toThrow(
      LocalInvokeBuildError
    );
    expect(strategy.resolveBoots).not.toHaveBeenCalled();
  });
});

describe('the strategy each command hands the engine', () => {
  afterEach(() => {
    captured.strategy = undefined;
  });

  async function strategyFrom(
    create: () => import('commander').Command,
    argv: string[]
  ): Promise<EmulatorStrategy> {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`the action exited (${code}) instead of reaching the engine`);
    }) as never);
    try {
      await create().parseAsync(argv, { from: 'user' });
    } finally {
      exit.mockRestore();
    }
    if (captured.strategy === undefined) throw new Error('the action never reached the engine');
    return captured.strategy;
  }

  const commands = [
    { name: 'start-service', create: createLocalStartServiceCommand, argv: ['S/Svc'] },
    { name: 'start-service --watch', create: createLocalStartServiceCommand, argv: ['S/Svc', '--watch'] },
    { name: 'start-alb', create: createLocalStartAlbCommand, argv: ['S/Alb'] },
    { name: 'start-alb --from-state', create: createLocalStartAlbCommand, argv: ['S/Alb', '--from-state'] },
  ];

  it.each(commands)('$name refuses an escaping source.directory at resolveBoots', async ({
    create,
    argv,
  }) => {
    const strategy = await strategyFrom(create, argv);
    const { stack } = stageAssembly('../../victim');
    // Whatever the inner strategy makes of these targets, the containment
    // check must refuse the assembly.
    expect(() => strategy.resolveBoots([stack] as never, ['S/Svc'])).toThrow(
      /Refusing to build container image asset/
    );
  });
});
