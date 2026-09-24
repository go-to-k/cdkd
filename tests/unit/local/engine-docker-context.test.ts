/**
 * Every cdkd command that builds a container image through the bundled
 * cdk-local engine runs here against the REAL engine. Only `docker` is faked:
 * `CDK_DOCKER` names a script that records the working directory of each call.
 *
 * Since cdk-local 0.149.4 this is the ONLY containment check on these paths.
 * cdkd used to run its own copy first, because the engine's refusal quoted
 * the assembly-chosen value in a boundary the value could close
 * (go-to-k/cdk-local#758). go-to-k/cdkd#3652 removed that copy. This file is
 * the proof that the engine alone covers every shape the copy's tests pinned:
 *
 * - an escape is refused with cdkd's error class and nothing is spawned, for
 *   the `buildContainerImage` shim, its three call sites (`cdkd local invoke`,
 *   `start-api`, `invoke-agentcore`), and `cdkd local start-service` /
 *   `start-alb` run through commander;
 * - the refusal renders a forging value display-safe: a quote-closing value,
 *   a `"`-pairing value and a default-ignorable mark all stay inside one JSON
 *   string literal;
 * - an absolute value is folded under the manifest directory, and a symlink
 *   that it or a `<link>/..` spelling leads through never reaches docker;
 * - the bound reaches the ENGINE. Without it the engine narrows to the
 *   manifest directory and refuses a `cdk.Stage` image's `../asset.<hash>`;
 * - a manifest-chosen `source.executable` is announced ONCE per build, by the
 *   engine, and a value naming the assembly itself is warned about in cdkd's
 *   branding.
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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cdkdWarns: string[] = [];
const cdkdErrors: string[] = [];
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const quiet = {
    debug: () => {},
    info: () => {},
    warn: (m: string) => cdkdWarns.push(m),
    error: (m: string) => cdkdErrors.push(m),
  };
  return {
    ...(await importOriginal<object>()),
    getLogger: () => ({ ...quiet, child: () => quiet }),
  };
});

const { buildContainerImage } = await import('../../../src/local/docker-image-builder.js');
const { createLocalCommand, resolveContainerImagePlan } = await import(
  '../../../src/cli/commands/local-invoke.js'
);
const { resolveContainerImageForStartApi } = await import(
  '../../../src/cli/commands/local-start-api.js'
);
const { resolveAgentCoreImage } = await import(
  '../../../src/cli/commands/local-invoke-agentcore.js'
);
const { LocalInvokeBuildError } = await import('../../../src/utils/error-handler.js');

const HASH = 'd'.repeat(64);
const IMAGE_URI = `111122223333.dkr.ecr.us-east-1.amazonaws.com/cdk-assets:${HASH}`;

/**
 * The forging values. Each escapes a Stage manifest directory by two levels,
 * so the engine must refuse it, and each would forge the refusal if the
 * engine quoted it in `'...'` (the first) or `"..."` (the second). The third
 * carries U+034F, which draws as nothing: printed raw, `.ss<mark>h` reads as
 * `.ssh`.
 */
const FORGES = [
  { name: 'a quote-closing value', value: "../../x'. Contained and healthy. Nothing 'y" },
  { name: 'a "-pairing value', value: '../../x". Contained and healthy. Nothing "y' },
  { name: 'a default-ignorable mark', value: '../../.ss\u034fh' },
];

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
  // spawn leaves a line and a refused one leaves none. It fails an ECS
  // replica's own `docker run` (the only call carrying `--network-alias`), so
  // an emulator run whose build was accepted ends there.
  const script = join(fakeDir, 'docker');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `echo "$PWD|$*" >> '${dockerLog}'`,
      'case "$*" in *--network-alias*) echo "replica run refused by the fake docker" >&2; exit 1;; esac',
      'exit 0',
      '',
    ].join('\n')
  );
  chmodSync(script, 0o755);
  savedDocker = process.env['CDK_DOCKER'];
  process.env['CDK_DOCKER'] = script;
  // What `cdkd local` does at startup: the engine renders cdkd's branding.
  createLocalCommand();
});

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  if (savedDocker === undefined) delete process.env['CDK_DOCKER'];
  else process.env['CDK_DOCKER'] = savedDocker;
});

afterEach(() => {
  writeFileSync(dockerLog, '');
  cdkdWarns.length = 0;
  cdkdErrors.length = 0;
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

const builds = (): Array<{ cwd: string; argv: string }> =>
  dockerCalls().filter((c) => c.argv.startsWith('build '));

/** What the engine printed through `console.warn`, from a spy set up first. */
function captureEngineWarns(): string[] {
  const said: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    said.push(args.map(String).join(' '));
  });
  return said;
}

/**
 * The JSON string literal the engine renders a forging value as: what
 * `JSON.stringify` writes, with the one blank-drawing mark the forges carry
 * `\u`-escaped as well.
 */
const literal = (value: string): string => JSON.stringify(value).replaceAll('\u034f', '\\u034f');

/**
 * Assert a forging value stayed inside one JSON string literal: the message
 * names the value as `source.directory=<literal>`, and with every literal the
 * message quotes cut out, the forged clause and the raw mark are gone.
 */
function expectDisplaySafe(message: string, value: string, resolvedPath: string): void {
  expect(message).toContain(`source.directory=${literal(value)} which `);
  const rest = [value, resolvedPath].reduce((text, v) => text.split(literal(v)).join(''), message);
  expect(rest).not.toContain('Contained and healthy');
  expect(message).not.toContain('\u034f');
}

/**
 * `<outer>/cdk.out/assembly-MyStage/StageStack.assets.json` naming one Docker
 * image asset. `<outer>/cdk.out/asset.<hash>` is where CDK stages a Stage's
 * image, and `<outer>/victim` gives an escape somewhere real to land.
 */
function stageAssembly(directory: string): {
  outer: string;
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
  return { outer, assemblyDir, manifestDir, manifestPath, stagedAsset };
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

/** The rejection a run ended in, or `undefined` when it resolved. */
async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (e: unknown) => e
  );
}

describe('the real engine builds a cdk.Stage image through every cdkd site', () => {
  it.each(sites)(
    '$name builds ../asset.<hash> from the staged directory, not a refusal',
    async ({ run }) => {
      const a = stageAssembly(`../asset.${HASH}`);

      await run(a);

      expect(builds()).toHaveLength(1);
      expect(builds()[0]!.cwd).toBe(a.stagedAsset);
    }
  );

  it.each(sites)("$name refuses an escape with cdkd's error class, spawning nothing", async ({
    run,
  }) => {
    const a = stageAssembly('../../victim');

    const thrown = await rejectionOf(run(a));

    expect(thrown).toBeInstanceOf(LocalInvokeBuildError);
    expect((thrown as Error).message).toMatch(
      /^Docker image asset has source\.directory=\.\.\/\.\.\/victim which resolves to \S*victim, outside /
    );
    expect(dockerCalls()).toEqual([]);
  });
});

/**
 * These cases would also pass against cdkd's removed copy, whose wording was
 * display-safe too. That the ENGINE is what refuses is pinned by the escape
 * cases above, which match the engine's own subject.
 */
describe('a refusal renders a forging value display-safe (go-to-k/cdk-local#758)', () => {
  const cases = sites.flatMap((site) => FORGES.map((forge) => ({ ...forge, site })));

  it.each(cases)('$site.name keeps $name inside one boundary', async ({ site, value }) => {
    const a = stageAssembly(value);

    const thrown = await rejectionOf(site.run(a));

    expect(thrown).toBeInstanceOf(LocalInvokeBuildError);
    expectDisplaySafe((thrown as Error).message, value, resolve(a.manifestDir, value));
    expect(dockerCalls()).toEqual([]);
  });

  it('escapes the default-ignorable mark as \\u034f rather than dropping it', async () => {
    const value = '../../.ss\u034fh';
    const a = stageAssembly(value);

    const thrown = await rejectionOf(sites[0]!.run(a));

    expect((thrown as Error).message).toContain('source.directory="../../.ss\\u034fh" which ');
  });
});

/**
 * The shapes that differ only in how the engine JOINS the value, driven
 * through the shim over a flat `cdk.out` (manifest directory = bound).
 */
describe('the engine judges the path it opens', () => {
  const build = (cdkOut: string, source: Record<string, unknown>): Promise<string> =>
    buildContainerImage({ source } as never, cdkOut, {
      architecture: 'x86_64',
      assetOutdir: cdkOut,
    });

  function flatAssembly(): { outer: string; cdkOut: string } {
    const outer = tmp();
    const cdkOut = join(outer, 'cdk.out');
    mkdirSync(cdkOut);
    mkdirSync(join(outer, 'victim', 'secret'), { recursive: true });
    return { outer, cdkOut };
  }

  it('refuses an escape before a manifest-chosen source.executable runs', async () => {
    const { outer, cdkOut } = flatAssembly();
    const ran = join(outer, 'ran');
    writeFileSync(join(outer, 'victim', 'build.sh'), `#!/bin/sh\ntouch '${ran}'\necho t\n`);
    chmodSync(join(outer, 'victim', 'build.sh'), 0o755);

    const thrown = await rejectionOf(
      build(cdkOut, { directory: '../victim', executable: ['./build.sh'] })
    );

    expect(thrown).toBeInstanceOf(LocalInvokeBuildError);
    expect((thrown as Error).message).toMatch(/source\.directory=\.\.\/victim which .*victim, outside/);
    expect(existsSync(ran)).toBe(false);
    expect(dockerCalls()).toEqual([]);
  });

  it('folds an ABSOLUTE value under the manifest directory rather than honouring it', async () => {
    const { cdkOut } = flatAssembly();
    mkdirSync(join(cdkOut, 'etc'));
    const engineWarns = captureEngineWarns();

    await build(cdkOut, { directory: '/etc' });

    expect(builds()).toHaveLength(1);
    expect(builds()[0]!.cwd).toBe(join(cdkOut, 'etc'));
    // ...and nothing claims a build from `/etc` itself.
    expect([...cdkdWarns, ...engineWarns]).toEqual([]);
  });

  it('refuses an ABSOLUTE value the fold would carry out through a symlink', async () => {
    const { outer, cdkOut } = flatAssembly();
    symlinkSync(join(outer, 'victim'), join(cdkOut, 'link'));

    const thrown = await rejectionOf(build(cdkOut, { directory: '/link' }));

    expect(thrown).toBeInstanceOf(LocalInvokeBuildError);
    expect((thrown as Error).message).toMatch(/leads through a symbolic link to \S*victim, outside/);
    expect(dockerCalls()).toEqual([]);
  });

  it.each([
    { name: 'a sibling', target: (outer: string) => join(outer, 'victim', 'secret') },
    { name: "the assembly's own parent", target: (outer: string) => join(outer, 'victim') },
  ])(
    'opens `<link>/..` as the lexical path it judged, inside the assembly ($name)',
    async ({ target }) => {
      // The kernel would follow `link` first and then climb from its target —
      // out of the assembly. The engine judges and opens the LEXICAL result,
      // `<cdk.out>/sub`, so the escape is neutralized rather than refused.
      const { outer, cdkOut } = flatAssembly();
      mkdirSync(join(cdkOut, 'sub'));
      symlinkSync(target(outer), join(cdkOut, 'sub', 'link'));

      await build(cdkOut, { directory: 'sub/link/..' });

      expect(builds()).toHaveLength(1);
      expect(builds()[0]!.cwd).toBe(join(cdkOut, 'sub'));
    }
  );

  it.each([
    {
      name: 'the build context',
      source: { directory: '.' },
      sink: 'send that directory to docker build as the context of an image cdkd then runs locally',
    },
    {
      name: "the executable's working directory",
      source: { directory: '.', executable: ['./build.sh'] },
      sink: "run this asset's source.executable with that directory as its working directory",
    },
    {
      // The engine takes the directory arm for `executable: []`.
      name: 'the build context, for an EMPTY source.executable',
      source: { directory: '.', executable: [] },
      sink: 'send that directory to docker build as the context of an image cdkd then runs locally',
    },
  ])('warns, in cdkd branding, that a value naming the assembly itself reaches $name', async ({
    source,
    sink,
  }) => {
    const { cdkOut } = flatAssembly();
    writeFileSync(join(cdkOut, 'build.sh'), '#!/bin/sh\necho built:tag\n');
    chmodSync(join(cdkOut, 'build.sh'), 0o755);
    const engineWarns = captureEngineWarns();

    await build(cdkOut, source);

    const whole = engineWarns.filter((w) => w.includes("naming the assembly's output directory ITSELF"));
    expect(whole).toHaveLength(1);
    expect(whole[0]).toContain(`cdkd will ${sink}`);
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
    const engineWarns = captureEngineWarns();

    await buildContainerImage({ source: { executable: ['./build.sh'] } }, cdkOut, {
      architecture: 'x86_64',
      assetOutdir: cdkOut,
    });

    const announcements = [...cdkdWarns, ...engineWarns].filter((w) =>
      w.includes('source.executable runs a command this asset manifest chose')
    );
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toContain('./build.sh');
    // The engine names cdkd, not itself (go-to-k/cdk-local#759).
    expect(announcements[0]).toContain('cdkd runs it');
    // ...and the build really ran: the engine re-tags the script's image.
    expect(dockerCalls().filter((c) => c.argv.startsWith('tag built:tag '))).toHaveLength(1);
  });
});

/**
 * `cdkd local start-service` / `start-alb` hand the whole run to the engine's
 * `runEcsServiceEmulator`, so they are driven through commander, exactly as
 * the CLI runs them, over a hand-written assembly: one stack `S` with an ECS
 * service whose image is a CDK asset, fronted by an ALB. The engine creates
 * its network and metadata sidecar (and, for `start-alb`, its front door),
 * then judges the image at the replica's build. The fake docker refuses the
 * replica's own `docker run`, so a build the engine ACCEPTS also ends the run,
 * with that error instead of a containment refusal.
 *
 * `start-alb --from-state` is not a row: it reads a state record from S3, which
 * a unit test must not reach, and the flag does not change the image build.
 */
describe('the ECS emulator commands contain their builds through the engine', () => {
  const REPO = 'cdk-hnb659fds-container-assets-111122223333-us-east-1';

  /**
   * `<outer>/cdk.out` holding stack `S`. With `stage`, the stack sits in
   * `cdk.out/assembly-MyStage/` and the parent `manifest.json` declares it, so
   * `--app` names the sub-assembly and the engine climbs to `cdk.out` as its
   * bound, where CDK stages a Stage's image (`../asset.<hash>`).
   */
  function ecsAssembly(
    directory: string,
    opts: { stage?: boolean; outerName?: string } = {}
  ): { outer: string; cdkOut: string; app: string; stagedAsset: string } {
    const outer = opts.outerName === undefined ? tmp() : join(tmp(), opts.outerName);
    const cdkOut = join(outer, 'cdk.out');
    const app = opts.stage === true ? join(cdkOut, 'assembly-MyStage') : cdkOut;
    const stagedAsset = join(cdkOut, `asset.${HASH}`);
    mkdirSync(app, { recursive: true });
    mkdirSync(stagedAsset);
    mkdirSync(join(outer, 'victim'));
    if (opts.stage === true) {
      writeFileSync(
        join(cdkOut, 'manifest.json'),
        JSON.stringify({
          version: '54.0.0',
          artifacts: {
            'assembly-MyStage': {
              type: 'cdk:cloud-assembly',
              properties: { directoryName: 'assembly-MyStage', displayName: 'MyStage' },
            },
          },
        })
      );
    }
    writeFileSync(
      join(app, 'manifest.json'),
      JSON.stringify({
        version: '54.0.0',
        artifacts: {
          'S.assets': { type: 'cdk:asset-manifest', properties: { file: 'S.assets.json' } },
          S: {
            type: 'aws:cloudformation:stack',
            environment: 'aws://111122223333/us-east-1',
            properties: { templateFile: 'S.template.json' },
            dependencies: ['S.assets'],
            displayName: 'S',
          },
        },
      })
    );
    writeFileSync(
      join(app, 'S.assets.json'),
      JSON.stringify({
        version: '54.0.0',
        files: {},
        dockerImages: {
          [HASH]: {
            source: { directory },
            destinations: { d: { repositoryName: REPO, imageTag: HASH } },
          },
        },
      })
    );
    writeFileSync(
      join(app, 'S.template.json'),
      JSON.stringify({
        Resources: {
          TaskDef: {
            Type: 'AWS::ECS::TaskDefinition',
            Properties: {
              ContainerDefinitions: [
                {
                  Name: 'web',
                  Essential: true,
                  // A literal URI: an `Fn::Sub` sends the resolver to STS for
                  // the account id, which a unit test must not reach.
                  Image: `111122223333.dkr.ecr.us-east-1.amazonaws.com/${REPO}:${HASH}`,
                  PortMappings: [{ ContainerPort: 8080 }],
                },
              ],
              Cpu: '256',
              Memory: '512',
              NetworkMode: 'awsvpc',
              RequiresCompatibilities: ['FARGATE'],
            },
          },
          Svc: {
            Type: 'AWS::ECS::Service',
            Properties: {
              TaskDefinition: { Ref: 'TaskDef' },
              DesiredCount: 1,
              LaunchType: 'FARGATE',
              LoadBalancers: [
                { ContainerName: 'web', ContainerPort: 8080, TargetGroupArn: { Ref: 'TG' } },
              ],
            },
          },
          Alb: {
            Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
            Properties: { Type: 'application' },
          },
          Listener: {
            Type: 'AWS::ElasticLoadBalancingV2::Listener',
            Properties: {
              LoadBalancerArn: { Ref: 'Alb' },
              Port: 80,
              Protocol: 'HTTP',
              DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'TG' } }],
            },
          },
          TG: {
            Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
            Properties: { Port: 8080, Protocol: 'HTTP', TargetType: 'ip' },
          },
        },
      })
    );
    return { outer, cdkOut, app, stagedAsset };
  }

  /** A host port nothing listens on now, for the ALB front door. */
  async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((done) => server.close(() => done()));
    return port;
  }

  /**
   * Run `cdkd local <argv>` to its exit 1, returning the error cdkd printed and
   * what the engine warned.
   */
  async function failureOf(argv: string[]): Promise<{ said: string; engineWarns: string[] }> {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const engineWarns = captureEngineWarns();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exited ${code}`);
    }) as never);
    const thrown = await rejectionOf(createLocalCommand().parseAsync(argv, { from: 'user' }));
    expect(thrown).toEqual(new Error('exited 1'));
    expect(cdkdErrors).toHaveLength(1);
    return { said: cdkdErrors[0]!, engineWarns };
  }

  // Not port 80: on macOS an unprivileged process binds it for real.
  const commands = [
    {
      name: 'start-service',
      argv: async (app: string) => ['start-service', 'S:Svc', '-a', app, '--no-pull'],
    },
    {
      name: 'start-service --watch',
      argv: async (app: string) => ['start-service', 'S:Svc', '-a', app, '--no-pull', '--watch'],
    },
    {
      name: 'start-alb',
      argv: async (app: string) => [
        'start-alb',
        'S:Alb',
        '-a',
        app,
        '--no-pull',
        '--lb-port',
        `80=${await freePort()}`,
      ],
    },
  ];

  it.each(commands)('$name refuses an escaping source.directory before any build', async ({
    argv,
  }) => {
    const { app } = ecsAssembly('../victim');

    const { said } = await failureOf(await argv(app));

    expect(said).toMatch(
      /Docker image asset has source\.directory=\.\.\/victim which resolves to \S*victim, outside /
    );
    expect(builds()).toEqual([]);
  }, 30_000);

  it.each(commands.flatMap((command) => FORGES.map((forge) => ({ ...forge, command }))))(
    '$command.name keeps $name inside one boundary',
    async ({ command, value }) => {
      // One level less than the Stage forges: this manifest sits in cdk.out.
      const shallow = value.replace('../../', '../');
      const { app } = ecsAssembly(shallow);

      const { said } = await failureOf(await command.argv(app));

      expectDisplaySafe(said, shallow, resolve(app, shallow));
      expect(builds()).toEqual([]);
    },
    30_000
  );

  it.each(commands)(
    "$name builds a cdk.Stage's ../asset.<hash> when --app names the sub-assembly",
    async ({ argv }) => {
      const { app, stagedAsset } = ecsAssembly(`../asset.${HASH}`, { stage: true });

      const { said } = await failureOf(await argv(app));

      // The build was accepted, from the staged directory; the run then ended
      // at the fake's refusal of the replica's own container.
      expect(builds()).toHaveLength(1);
      expect(builds()[0]!.cwd).toBe(stagedAsset);
      expect(said).toContain('replica run refused by the fake docker');
    },
    30_000
  );

  it.each(commands)('$name still refuses an escape past the climbed root', async ({ argv }) => {
    const { app } = ecsAssembly('../../victim', { stage: true });

    const { said } = await failureOf(await argv(app));

    expect(said).toMatch(/source\.directory=\.\.\/\.\.\/victim which resolves to \S*victim, outside /);
    expect(builds()).toEqual([]);
  }, 30_000);

  it("names both directories of the Stage climb inside their boundaries, in cdkd's branding", async () => {
    const forged = "x'. Contained and healthy. Nothing 'y";
    const { cdkOut, app } = ecsAssembly(`../asset.${HASH}`, { stage: true, outerName: forged });

    const { engineWarns } = await failureOf(await commands[0]!.argv(app));

    const climbed = engineWarns.filter((w) => w.includes('is a cdk.Stage sub-assembly'));
    expect(climbed).toHaveLength(1);
    expect(climbed[0]).toContain(`${literal(app)} is a cdk.Stage sub-assembly, so cdkd is treating`);
    expect(climbed[0]).toContain(`its parent ${literal(cdkOut)} as the assembly root`);
    const rest = [app, cdkOut].reduce((t, v) => t.split(literal(v)).join(''), climbed[0]!);
    expect(rest).not.toContain('Contained and healthy');
  }, 30_000);
});
