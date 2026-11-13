import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import {
  describeDockerFailure,
  getDockerCmd,
  redactDockerArgvValues,
  redactedDockerCause,
  runDockerStreaming,
} from '../../utils/docker-cmd.js';
import { displayIdent, displaySafe, safeMsg } from '../../utils/display-safe.js';
import { displayAssemblyPath } from '../../utils/assembly-path.js';
import { getLogger } from '../../utils/logger.js';
import { DockerRunnerError, pullImage } from '../docker-runner.js';
import { buildDockerImage } from '../../assets/docker-build.js';
import { pullEcrImage } from '../ecr-puller.js';
import { LocalInvokeBuildError } from '../../utils/error-handler.js';
import { AssetManifestLoader } from '../../assets/asset-manifest-loader.js';
import {
  checkVolumeHostPath,
  type ResolvedEcsContainer,
  type ResolvedEcsImage,
  type ResolvedEcsTask,
  type ResolvedEcsVolume,
} from '../ecs-task-resolver.js';
import { quotedOrDescribed } from '../../utils/pasteable-command.js';
import { EcsTaskRunnerError, type EcsRunState, type RunEcsTaskOptions } from './types.js';
import { namedSubject, runDockerStep } from './cleanup.js';
import { randHex } from './docker-run-args.js';

const execFileAsync = promisify(execFile);

/**
 * Resolve every container's `Image` to a tag the runner can pass to
 * `docker run`. The map is keyed by container name; entries are
 * populated in parallel up to the asset-manifest bound (single
 * `docker build` for shared assets is left to docker's own cache).
 */
export async function prepareImages(
  task: ResolvedEcsTask,
  out: Map<string, string>,
  options: RunEcsTaskOptions
): Promise<void> {
  const logger = getLogger().child('ecs-runner');
  // Sequential is fine — most tasks have 1–3 containers and each
  // `docker build` / pull would saturate IO anyway.
  for (const container of task.containers) {
    // A local-only `--image-override` tag exists in no registry: never pull it.
    const overrideTag = options.imageOverrideByContainer?.get(container.name);
    if (overrideTag !== undefined) {
      out.set(container.name, overrideTag);
      logger.debug(
        safeMsg`Container ${displayIdent(container.name)} image=${displayIdent(overrideTag)} (--image-override)`
      );
      continue;
    }
    const image = await prepareOneImage(task, container, options);
    out.set(container.name, image);
    logger.debug(`Container '${container.name}' image=${image}`);
  }
}

async function prepareOneImage(
  task: ResolvedEcsTask,
  container: ResolvedEcsContainer,
  options: RunEcsTaskOptions
): Promise<string> {
  const image: ResolvedEcsImage = container.image;
  switch (image.kind) {
    case 'same-stack-ecr':
      // No URI to pull. The CLI refuses this before any resource exists
      // (`assertEcsTaskImagesResolvable`); this covers a direct runner caller.
      throw new EcsTaskRunnerError(image.unresolvedReason);
    case 'public': {
      await pullImage(image.uri, options.skipPull);
      return image.uri;
    }
    case 'ecr': {
      return pullEcrImage(image.uri, {
        // Mixed mode: real ECR only when THIS container excepts ECR (#6179).
        workload: { containerName: container.name },
        skipPull: options.skipPull,
        ...(options.region !== undefined && { region: options.region }),
        ...(options.ecrRoleArn !== undefined && { ecrRoleArn: options.ecrRoleArn }),
      });
    }
    case 'cdk-asset': {
      const cdkOutDir = task.stack.assetManifestPath
        ? dirname(task.stack.assetManifestPath)
        : undefined;
      if (!cdkOutDir) {
        throw new EcsTaskRunnerError(
          `Container ${quotedOrDescribed(container.name, 'container name')} uses a CDK asset image but the stack has no asset manifest. ` +
            "Re-synthesize the app (without `--output '<stale-dir>'`) and retry."
        );
      }
      const loader = new AssetManifestLoader();
      const manifest = await loader.loadStackManifest(task.stack, cdkOutDir);
      if (!manifest) {
        throw new EcsTaskRunnerError(
          `No asset manifest at ${task.stack.assetManifestPath} for stack ${task.stack.stackName}.`
        );
      }
      const dockerImages = manifest.dockerImages ?? {};
      const entries = Object.entries(dockerImages);
      let asset: { source: import('../../types/assets.js').DockerImageAssetSource } | undefined;
      if (image.assetHash && dockerImages[image.assetHash]) {
        asset = dockerImages[image.assetHash];
      } else if (entries.length === 1) {
        asset = entries[0]![1];
      }
      if (!asset) {
        throw new EcsTaskRunnerError(
          `Container '${container.name}' references a CDK asset image but no matching entry was found in cdk.out. ` +
            'Re-synthesize the CDK app and retry.'
        );
      }
      const tag = `cdkd-local-run-task-${(image.assetHash ?? 'single').slice(0, 16)}`;
      const actualTag = await buildDockerImage(asset, cdkOutDir, {
        tag,
        // `cdkOutDir` is the MANIFEST's directory, which for a stack inside a
        // `cdk.Stage` is `cdk.out/assembly-<Stage>/` while the asset itself is
        // staged in the app root — so the containment bound is the app outdir,
        // or a Stage's legitimate `../asset.<hash>` is refused
        // (issue go-to-k/cdkd#3489). `task.stack` is cdkd's own `StackInfo`,
        // which carries it. Absent on a hand-built record, and then
        // `resolveDockerContextDirectory` falls back to `cdkOutDir`, the
        // correct bound for a top-level stack.
        ...(task.stack.assetOutdir !== undefined && { assetOutdir: task.stack.assetOutdir }),
        ...(options.platformOverride !== undefined && { platform: options.platformOverride }),
        wrapError: (stderr: string) =>
          new LocalInvokeBuildError(
            // The `executable` branch renders a user-supplied command line, so
            // it is redacted like every other argv this repo displays
            // (issue #2623). The `directory` branch is a path, not an argv.
            // Every operand sanitized, not just the new one: `container.name`
            // is a template key and `stderr` is docker's free-form output, so
            // a guard on one neighbour is defeated by the other
            // (go-to-k/cdkd#3277). NOT fenced by
            // `local-profile-display-population.test.ts` — that test derives
            // its population from identifiers matching `/profile/i` and does
            // not reach these two statements; it only flagged them once
            // `displaySafe` appeared in this file. Keeping them sanitized is
            // a rule followed by hand. Names and tags render through
            // `displayIdent`, never inside cdkd's own quotes, which a `'` in
            // either would close (go-to-k/cdkd#3617).
            `docker build failed for ECS container ${displayIdent(container.name)} (${
              asset.source.directory !== undefined
                ? // `source.directory` is an assembly-supplied path and the
                  // containment refusal (go-to-k/cdkd#3489) is raised BEFORE
                  // docker runs, so this wrapper renders an attacker-chosen
                  // path; `displayAssemblyPath` bounds it (go-to-k/cdkd#3590).
                  displayAssemblyPath(asset.source.directory)
                : asset.source.executable
                  ? redactDockerArgvValues(asset.source.executable).join(' ')
                  : undefined
            }): ${displaySafe(stderr)}`
          ),
      });
      if (actualTag !== tag) {
        const tagArgs = ['tag', actualTag, tag];
        // `executable` source mode returns the script's own tag — re-tag
        // to the deterministic `tag` so the downstream `docker run` finds
        // the image under the expected name. Routed through the shared
        // `runDockerStreaming` helper for consistency with publisher /
        // local-invoke.
        try {
          await runDockerStreaming(tagArgs);
        } catch (err) {
          throw new LocalInvokeBuildError(
            // `actualTag` is the `executable` build script's own STDOUT, so
            // it is the least trusted value on this line; `container.name` is
            // a template key. Both sanitized beside the composed docker text.
            `docker tag failed re-tagging ${displayIdent(actualTag)} → ${displayIdent(tag)} ` +
              `for ECS container ${displayIdent(container.name)}: ${displaySafe(describeDockerFailure(err, tagArgs))}`,
            redactedDockerCause(err, tagArgs)
          );
        }
      }
      return tag;
    }
  }
}

/**
 * `docker volume create` for every `DockerVolumeConfiguration` entry.
 * Anonymous + host-path volumes need no create call — they're realized
 * at `docker run` time via `-v <hostPath>:<containerPath>`.
 */
export async function realizeDockerVolumes(
  volumes: ResolvedEcsVolume[],
  state: EcsRunState
): Promise<Map<string, ResolvedEcsVolume & { dockerVolumeName?: string }>> {
  const logger = getLogger().child('ecs-runner');
  const out = new Map<string, ResolvedEcsVolume & { dockerVolumeName?: string }>();
  for (const v of volumes) {
    if (v.kind === 'host') {
      if (v.hostPath && !checkVolumeHostPath(v.hostPath)) {
        logger.warn(
          `Volume '${v.name}': host path '${v.hostPath}' does not exist or is not a directory. ` +
            'Docker will create an anonymous bind mount; create the host path before run-task if you expected to bind-mount it.'
        );
      }
      out.set(v.name, v);
      continue;
    }
    const cfg = v.dockerVolumeConfig;
    const args: string[] = ['volume', 'create'];
    if (cfg?.driver) args.push('--driver', cfg.driver);
    if (cfg?.driverOpts) {
      for (const [k, val] of Object.entries(cfg.driverOpts)) args.push('--opt', `${k}=${val}`);
    }
    if (cfg?.labels) {
      for (const [k, val] of Object.entries(cfg.labels)) args.push('--label', `${k}=${val}`);
    }
    const dockerVolumeName = `cdkd-local-${v.name}-${randHex(4)}`;
    args.push(dockerVolumeName);
    await runDockerStep(
      state,
      async () => {
        try {
          await execFileAsync(getDockerCmd(), args);
        } catch (err) {
          // `--opt` carries `DockerVolumeConfiguration.DriverOpts`, which for the
          // `local` driver holds mount options (`o=addr=...,username=...,password=...`).
          // `execFile` puts the whole command line in `err.message` (issue #2440).
          throw new DockerRunnerError(
            `docker volume create failed for '${v.name}': ${describeDockerFailure(err, args)}`
          );
        }
      },
      () => {
        state.dockerVolumeNames.push(dockerVolumeName);
        logger.debug(`Created docker volume ${dockerVolumeName} for task volume '${v.name}'`);
      },
      async () => {
        await execFileAsync(getDockerCmd(), ['volume', 'rm', '-f', dockerVolumeName]).catch(
          () => undefined
        );
      },
      namedSubject([
        {
          kind: 'volume',
          name: dockerVolumeName,
          rm: 'docker volume rm -f',
          list: 'docker volume ls',
        },
      ])
    );
    out.set(v.name, { ...v, dockerVolumeName });
  }
  return out;
}
