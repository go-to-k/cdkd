import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { EmulatorStrategy } from './ecs-service-emulator.js';
import { assertCdkLocalDockerContextContained } from '../../assets/docker-build.js';
import { assetPathDirs } from '../../local/lambda-resolver.js';
import type { DockerImageAssetSource } from '../../types/assets.js';
import { renderAssemblyPathEscape, resolveAssemblyPath } from '../../utils/assembly-path.js';
import { displaySafe } from '../../utils/display-safe.js';
import { LocalInvokeBuildError } from '../../utils/error-handler.js';
import { getLogger } from '../../utils/logger.js';

/**
 * The stack fields this check reads. cdk-local's `StackInfo` (what the engine
 * hands `resolveBoots`) and cdkd's both carry them.
 */
interface EmulatorStackAssets {
  stackName: string;
  assetManifestPath?: string | undefined;
  assetOutdir?: string | undefined;
}

/**
 * Decorate an `EmulatorStrategy` so every Docker image asset the bundled
 * engine could build for this run is containment-checked BEFORE it builds one
 * (issue [#3503](https://github.com/go-to-k/cdkd/issues/3503)).
 *
 * `cdkd local start-service` / `start-alb` hand the whole run to cdk-local's
 * `runEcsServiceEmulator`, which reads each stack's asset manifest itself and
 * joins `source.directory` onto the manifest directory raw — for an ECS
 * container image and for an ALB Lambda target's container image alike. No
 * argument reaches that join, so cdkd judges the manifests here instead.
 *
 * `resolveBoots` is the seam because the engine calls it after every synth —
 * at boot, and again on every `--watch` reload — and before any image is
 * built on either path. A refusal at boot fails the command; on a reload the
 * engine logs it and keeps the previous replicas serving, which is the
 * fail-closed outcome.
 *
 * Every stack with a manifest is checked, not only the booted targets' stacks:
 * which stack a target resolves to is decided inside the engine, and the ALB
 * front door builds Lambda images from stacks no ECS boot names. An escaping
 * `source.directory` is never something a real `cdk synth` writes, so
 * refusing one anywhere in the assembly costs a legitimate run nothing, and
 * `cdkd deploy` refuses the same assembly.
 */
export function containEmulatorDockerContexts(strategy: EmulatorStrategy): EmulatorStrategy {
  return {
    ...strategy,
    resolveBoots: (stacks, chosenTargets) => {
      // First, so nothing else is planned from an assembly that is refused.
      assertEmulatorDockerContextsContained(stacks);
      return strategy.resolveBoots(stacks, chosenTargets);
    },
  };
}

/**
 * The check itself, over the manifests the engine will read. Exported for
 * unit testing.
 *
 * It reads the SAME file the engine does — `<manifest dir>/<stackName>.assets.json`,
 * not `assetManifestPath` verbatim — and refuses a `stackName` that would
 * carry that filename out of the manifest directory, as cdkd's own
 * `AssetManifestLoader.loadManifest` does.
 *
 * A manifest that is absent, unreadable or not JSON is skipped: the engine
 * reads it again and reports that failure itself, before building anything.
 */
export function assertEmulatorDockerContextsContained(
  stacks: readonly EmulatorStackAssets[]
): void {
  for (const stack of stacks) {
    if (!stack.assetManifestPath) continue;
    const dirs = assetPathDirs(stack);
    const { manifestDir } = dirs;
    // A present bound takes the engine's own Stage climb; an absent one keeps
    // `assetPathDirs`'s narrowing fallback, exactly as the engine does.
    const assetOutdir =
      stack.assetOutdir === undefined || stack.assetOutdir === ''
        ? dirs.assetOutdir
        : engineAssemblyRoot(stack.assetOutdir);
    const manifestFile = resolveAssemblyPath(manifestDir, `${stack.stackName}.assets.json`);
    if (!manifestFile.contained) {
      throw new LocalInvokeBuildError(
        `Refusing to build container images: the asset manifest for stack ` +
          `'${displaySafe(stack.stackName)}' ${renderAssemblyPathEscape(manifestFile, manifestDir)}`
      );
    }
    const dockerImages = readDockerImages(manifestFile.path);
    for (const [assetId, asset] of Object.entries(dockerImages)) {
      const source = (asset as { source?: unknown } | null)?.source;
      if (source === null || typeof source !== 'object') continue;
      const { directory } = source as { directory?: unknown };
      if (typeof directory !== 'string') continue;
      assertCdkLocalDockerContextContained({
        manifestDir,
        source: source as DockerImageAssetSource,
        assetOutdir,
        wrapError: (message) =>
          new LocalInvokeBuildError(
            `Refusing to build container image asset '${displaySafe(assetId)}' of stack ` +
              `'${displaySafe(stack.stackName)}': ${message}`
          ),
      });
    }
  }
}

/**
 * The containment bound the ENGINE itself uses for a stack it synthesized: its
 * `assetOutdir`, climbed to the parent assembly when `--app` names a
 * `cdk.Stage` sub-assembly. cdk-local enumerates no Stage stacks from an app
 * root, so `--app cdk.out/assembly-<Stage>` is the only way these commands run
 * a Stage, and its assets are staged one level up as `../asset.<hash>`.
 *
 * A copy of cdk-local's `assemblyRootOf` (not exported by the package): climb
 * only while the directory is named `assembly-*` AND its parent's
 * `manifest.json` declares it as a `cdk:cloud-assembly` artifact, and WARN
 * whenever a climb happens, since the predicate is read from the tree being
 * judged. Replace with the upstream export once one exists (go-to-k/cdkd#3597).
 */
export function engineAssemblyRoot(outdir: string): string {
  let dir = resolve(outdir);
  let climbed = false;
  for (;;) {
    if (!basename(dir).startsWith('assembly-')) break;
    const parent = dirname(dir);
    if (parent === dir || !parentDeclaresNestedAssembly(parent, basename(dir))) break;
    dir = parent;
    climbed = true;
  }
  if (!climbed) return outdir;
  if (!warnedDerivedRoots.has(dir)) {
    warnedDerivedRoots.add(dir);
    getLogger().warn(
      `'${displaySafe(outdir)}' is a cdk.Stage sub-assembly, so cdkd is treating its parent ` +
        `'${displaySafe(dir)}' as the assembly root when it checks Docker build contexts — ` +
        "that is where cdk synth stages a Stage's assets. Everything under that parent is now " +
        'inside the containment bound, including siblings of the directory you named.'
    );
  }
  return dir;
}

const warnedDerivedRoots = new Set<string>();

function parentDeclaresNestedAssembly(parent: string, child: string): boolean {
  try {
    const artifacts = (
      JSON.parse(readFileSync(join(parent, 'manifest.json'), 'utf-8')) as { artifacts?: unknown }
    ).artifacts;
    if (artifacts === null || typeof artifacts !== 'object') return false;
    return Object.values(artifacts).some((a) => {
      const art = a as { type?: unknown; properties?: { directoryName?: unknown } } | null;
      return art?.type === 'cdk:cloud-assembly' && art.properties?.directoryName === child;
    });
  } catch {
    return false;
  }
}

function readDockerImages(manifestPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return {};
  }
  const dockerImages = (parsed as { dockerImages?: unknown } | null)?.dockerImages;
  return dockerImages !== null && typeof dockerImages === 'object'
    ? (dockerImages as Record<string, unknown>)
    : {};
}
