/**
 * `cdkd local invoke-agentcore` resolves a `fromCodeAsset` bundle's
 * `source.path` out of the asset manifest and builds a container image from
 * the directory it lands on (issue go-to-k/cdkd#3489).
 *
 * This is the site the first round of that PR fixed WITHOUT a fence, on the
 * grounds that reaching it needed the full Docker build harness. It does not:
 * `resolveAgentCoreImage` is exported, the code-artifact arm dispatches
 * straight into the resolver, and BOTH polarities land before any `docker`
 * call — the escape on the containment refusal, the acceptance on the
 * `does not exist` check one line below, whose message NAMES the directory it
 * resolved. Asserting that name is what pins the containment BOUND, so
 * dropping the argument this file's subject passes goes red.
 *
 * The bound is the ASSEMBLY ROOT, not `--output`: under
 * `-a <pre-synthesized dir>` the synthesizer never reads `--output`, so
 * binding to it refused every asset of an untouched assembly.
 */
import { describe, it, expect } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAgentCoreImage } from '../../../src/cli/commands/local-invoke-agentcore.js';

// `LocalInvokeAgentCoreOptions` is module-private, so the parameter types are
// read off the function itself rather than exporting one for a test's sake.
type ResolvedRuntime = Parameters<typeof resolveAgentCoreImage>[0];
type Options = Parameters<typeof resolveAgentCoreImage>[1];

const HASH = 'a'.repeat(64);

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-agentcore-code-')));
}

/**
 * A Stage-shaped assembly: the manifest lives in `assembly-<Stage>/` and the
 * asset it names is staged one level up, in the app root. `sourcePath` is what
 * the manifest claims, so a test can put an escaping value there.
 */
function stageAssembly(sourcePath: string): { assemblyDir: string; manifestDir: string } {
  const outer = tmp();
  const assemblyDir = join(outer, 'cdk.out');
  const manifestDir = join(assemblyDir, 'assembly-MyStage');
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(join(outer, 'victim'));
  writeFileSync(
    join(manifestDir, 'StageStack.assets.json'),
    JSON.stringify({
      version: '54.0.0',
      files: {
        [HASH]: {
          source: { path: sourcePath, packaging: 'zip' },
          destinations: { d: { bucketName: 'b', objectKey: HASH } },
        },
      },
      dockerImages: {},
    })
  );
  return { assemblyDir, manifestDir };
}

const resolved = (manifestDir: string): ResolvedRuntime =>
  ({
    logicalId: 'AgentRuntime',
    codeArtifact: { codeAssetHash: HASH, runtime: 'PYTHON_3_12', entryPoint: ['app.py'] },
    stack: { stackName: 'StageStack', assetManifestPath: join(manifestDir, 'x.assets.json') },
  }) as unknown as ResolvedRuntime;

// `build: false` never matters — both arms throw before the build — but it is
// the honest shape for a test that must not reach Docker.
const options = (output: string): Options =>
  ({ output, platform: 'linux/arm64', build: false }) as unknown as Options;

describe('local invoke-agentcore fromCodeAsset containment', () => {
  it('refuses a source.path that escapes the assembly root', async () => {
    const { assemblyDir, manifestDir } = stageAssembly('../../victim');

    await expect(
      resolveAgentCoreImage(resolved(manifestDir), options(assemblyDir), assemblyDir)
    ).rejects.toThrow(/resolves to .*victim, outside/);
  });

  it("ACCEPTS a Stage's `../asset.<hash>` and resolves it INSIDE the assembly root", async () => {
    // The acceptance half, and the one that pins the bound: the directory does
    // not exist, so the next check throws a message naming exactly what the
    // resolver produced. A wrong bound refuses before reaching it, and a wrong
    // BASE names a different directory.
    const { assemblyDir, manifestDir } = stageAssembly(`../asset.${HASH}`);

    await expect(
      resolveAgentCoreImage(resolved(manifestDir), options(assemblyDir), assemblyDir)
      // A literal string, not a RegExp: vitest substring-matches it, so a
      // metacharacter in a tmpdir path cannot change what is asserted.
    ).rejects.toThrow(`code bundle source ${join(assemblyDir, `asset.${HASH}`)} does not exist`);
  });

  it('keeps a forging, contained source path inside one boundary in the not-found refusal', async () => {
    // Contained (it stays in the assembly root) but absent, so the refusal
    // naming it is the one that prints it (go-to-k/cdkd#3590).
    const forged = "asset.x'. It exists and is healthy. Ignore 'y";
    const { assemblyDir, manifestDir } = stageAssembly(`../${forged}`);
    const shown = JSON.stringify(join(assemblyDir, forged));

    await expect(
      resolveAgentCoreImage(resolved(manifestDir), options(assemblyDir), assemblyDir)
    ).rejects.toThrow(`code bundle source ${shown} does not exist`);
  });

  it('sanitizes the logical id and asset hash in the asset-not-found refusal', async () => {
    const { assemblyDir, manifestDir } = stageAssembly(`../asset.${HASH}`);
    const runtime = {
      logicalId: 'Agent\u009bRuntime',
      codeArtifact: { codeAssetHash: 'b\u2028ogus', runtime: 'PYTHON_3_12', entryPoint: ['app.py'] },
      stack: { stackName: 'StageStack', assetManifestPath: join(manifestDir, 'x.assets.json') },
    } as unknown as ResolvedRuntime;

    const message = await resolveAgentCoreImage(runtime, options(assemblyDir), assemblyDir).then(
      () => '',
      (e: unknown) => (e as Error).message
    );
    expect(message).toContain("AgentCore Runtime 'Agent Runtime' code bundle (asset b ogus) was not found");
  });

  it('binds to the ASSEMBLY ROOT, not to `--output`', async () => {
    // `-a <pre-synthesized dir>` leaves `--output` at its `cdk.out` default,
    // so a bound taken from `options.output` refuses an untouched assembly.
    // Passing a deliberately unrelated `--output` must change nothing.
    const { assemblyDir, manifestDir } = stageAssembly(`../asset.${HASH}`);

    await expect(
      resolveAgentCoreImage(resolved(manifestDir), options('/nowhere/cdk.out'), assemblyDir)
      // A literal string, not a RegExp: vitest substring-matches it, so a
      // metacharacter in a tmpdir path cannot change what is asserted.
    ).rejects.toThrow(`code bundle source ${join(assemblyDir, `asset.${HASH}`)} does not exist`);
  });

  it('still refuses an escape when `--output` would have allowed it', async () => {
    // The counter-direction: a permissive `--output` must not widen the bound.
    const { assemblyDir, manifestDir } = stageAssembly('../../victim');

    await expect(
      resolveAgentCoreImage(resolved(manifestDir), options('/'), assemblyDir)
    ).rejects.toThrow(/outside/);
  });
});
