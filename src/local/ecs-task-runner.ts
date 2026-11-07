import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  containsDynamicReference,
  firstUsableRegion,
  resolveDynamicReferencesInEnv,
} from 'cdk-local/internal';
import { createCallerDynamicReferenceResolver } from './dynamic-reference.js';
import {
  dockerSpawnEnvWithSensitive,
  getDockerCmd,
  describeDockerFailure,
  finchSecretArgvRefusal,
  isDockerClientEnvKey,
  isMalformedEnvKey,
  warnFinchArgvExposure,
} from '../utils/docker-cmd.js';
import { displayIdent, safeMsg } from '../utils/display-safe.js';
import { getLogger } from '../utils/logger.js';
import {
  CONTAINER_LOG_DRAIN_TIMEOUT_MS,
  DockerRunnerError,
  pullImage,
  removeContainer,
} from './docker-runner.js';
import {
  METADATA_ENDPOINT_IMAGE,
  createTaskNetwork,
  destroyTaskNetwork,
  newTaskNetworkName,
  taskSidecarName,
} from './ecs-network.js';
import { resolveEcsSecrets } from './ecs-secrets-resolver.js';
import type { ResolvedEcsContainer, ResolvedEcsTask } from './ecs-task-resolver.js';
import {
  EcsTaskRunnerError,
  type EcsRunState,
  type RunEcsTaskOptions,
  type RunEcsTaskResult,
} from './ecs-task-runner/types.js';
import { interruptedError, namedSubject, runDockerStep } from './ecs-task-runner/cleanup.js';
import {
  awaitDependencies,
  buildDependencyGraph,
  streamContainerLogs,
  topoSort,
  waitForContainerExit,
} from './ecs-task-runner/containers.js';
import { prepareImages, realizeDockerVolumes } from './ecs-task-runner/images.js';
import {
  buildDockerRunArgs,
  dynamicReferenceEnvKeys,
  groupSecretsByContainer,
  overriddenEnvKeys,
} from './ecs-task-runner/docker-run-args.js';

export {
  EcsTaskRunnerError,
  EcsTaskInterruptedError,
  IN_FLIGHT_STEP_TIMEOUT_MS,
  createEcsRunState,
} from './ecs-task-runner/types.js';
export type {
  RunEcsTaskOptions,
  EcsRunState,
  InFlightDockerStep,
  RunEcsTaskResult,
} from './ecs-task-runner/types.js';
export { cleanupEcsRun } from './ecs-task-runner/cleanup.js';
export { buildDependencyGraph, topoSort } from './ecs-task-runner/containers.js';
export { buildDockerRunArgs } from './ecs-task-runner/docker-run-args.js';

const execFileAsync = promisify(execFile);

/**
 * Top-level orchestrator for `cdkd local run-task`. Coordinates image
 * preparation, secret resolution, docker-network bring-up, container
 * boot in `dependsOn` order, log streaming, exit propagation, and
 * teardown. Designed to be called from the CLI with an idempotent
 * `cleanup()` hook hoisted in the caller so SIGINT and the outer finally
 * share teardown semantics with `cdkd local invoke`.
 */

/**
 * Merge the Cloud Map peer-discovery `--add-host` flag pairs
 * ({@link RunEcsTaskOptions.addHostFlags}) with the boot-resolved
 * `host.docker.internal` host-gateway mapping(s)
 * ({@link RunEcsTaskOptions.hostGatewayExtraHosts}) into one verbatim
 * `['--add-host', 'name:ip', ...]` list for `docker run`. The host-gateway
 * entry uses a distinct name, so its position relative to the peer entries is
 * irrelevant (docker's resolver matches by name). Pure — exported for the
 * site-level merge test. Mirrors cdk-local #483.
 */
export function mergeHostGatewayAddHostFlags(
  addHostFlags: ReadonlyArray<string> | undefined,
  hostGatewayExtraHosts: ReadonlyArray<{ host: string; ip: string }> | undefined
): string[] {
  return [
    ...(addHostFlags ?? []),
    ...(hostGatewayExtraHosts ?? []).flatMap((h) => ['--add-host', `${h.host}:${h.ip}`]),
  ];
}

/**
 * Top-level entry point. Mutates `state` as it makes progress so the
 * caller's `cleanup(state)` can roll back partial side effects on any
 * thrown error.
 */
export async function runEcsTask(
  task: ResolvedEcsTask,
  options: RunEcsTaskOptions,
  state: EcsRunState
): Promise<RunEcsTaskResult> {
  const logger = getLogger();

  if (task.containers.length === 0) {
    throw new EcsTaskRunnerError(
      `Task '${task.taskDefinitionLogicalId}' has no containers — nothing to run.`
    );
  }

  for (const w of task.warnings) logger.warn(w);

  // Build the dependency DAG up front so cyclic configs fail before we
  // touch docker.
  const dag = buildDependencyGraph(task.containers);
  const startOrder = topoSort(dag, task.containers);

  // Under finch's Lima VM a value-less `-e KEY` lands on the limactl argv as
  // `-e KEY=<value>` (#3600). Refuse BEFORE any image is prepared, any secret
  // fetched or any resource created, unless the operator opted in. A name that would be
  // dropped anyway (`partitionSensitiveEnv`'s collision path) never leaves, so
  // it does not trigger the refusal.
  // Every container is checked before throwing, so one run names them all.
  const finchRefusals: string[] = [];
  for (const c of task.containers) {
    // A dynamic-reference env var (#2056) becomes plaintext before boot, so it
    // counts here too. A same-stack one is decided from the token's syntax,
    // before its fetch; a cross-stack one was fetched at the run-task boundary,
    // but is still refused before anything boots.
    const refusal = finchSecretArgvRefusal(
      [
        ...c.secrets.map((s) => s.name),
        // A dropped secret reaches the container only through an override.
        ...(c.droppedSecretNames ?? []).filter((n) =>
          overriddenEnvKeys(options.envOverrides, c.name).includes(n)
        ),
        ...(c.resolvedDynamicReferenceKeys ?? []),
        ...dynamicReferenceEnvKeys(c, options.envOverrides),
      ].filter((n) => !isMalformedEnvKey(n) && !isDockerClientEnvKey(n)),
      `Container ${displayIdent(c.name)}`
    );
    if (refusal !== undefined) finchRefusals.push(refusal);
  }
  if (finchRefusals.length > 0) throw new EcsTaskRunnerError(finchRefusals.join('\n'));

  // A dynamic reference in `Command` / `EntryPoint` / a health-check command
  // would have to be resolved ONTO the `docker run` argv, where any local
  // process can read it. Refuse instead of resolving it there or handing the
  // container the token (issue #2056, mirroring go-to-k/cdk-local#784).
  const argvRefusals: string[] = [];
  for (const c of task.containers) {
    const fields: Array<[string, string[] | undefined]> = [
      ['Command', c.command],
      ['EntryPoint', c.entryPoint],
      ['HealthCheck.Command', c.healthCheck?.command],
    ];
    for (const [field, argv] of fields) {
      if (argv?.some((a) => containsDynamicReference(a))) {
        // cdkd-raw-beside-safe: `field` is one of the three literal labels above.
        argvRefusals.push(
          `Container ${displayIdent(c.name)}: ${field} carries a CloudFormation dynamic reference ({{resolve:...}}). ` +
            'cdkd resolves dynamic references only in Environment, because resolving one here would put the secret on the docker run argv. ' +
            'Move the value into an Environment variable or a Secrets entry.'
        );
      }
    }
  }
  if (argvRefusals.length > 0) throw new EcsTaskRunnerError(argvRefusals.join('\n'));

  // Resolve every container's image. Production callers leave
  // `imagePlanByContainer` undefined — the resolver below walks the asset
  // manifest / ECR / public-image path per image.
  const imagePlan = options.imagePlanByContainer ?? new Map<string, string>();
  if (!options.imagePlanByContainer) {
    await prepareImages(task, imagePlan, options);
  }

  // Resolve every container's secrets in parallel BEFORE network /
  // container boot — any failure short-circuits the whole task. Mirrors
  // the ECS Agent's "fail-fast on missing secret" UX.
  //
  // A secret whose env key `--env-vars` names for this container (or under
  // `Parameters`; a `null` clear included) is NOT fetched (go-to-k/cdkd#5756,
  // mirroring go-to-k/cdk-local#848): the override replaces the value in the
  // container anyway, so the AWS call buys nothing and fails the boot when the
  // caller holds no credentials for the secret's account. The key stays off
  // the `docker run` argv — see `buildDockerRunArgs`.
  const allSecrets: { containerName: string; name: string; valueFrom: string }[] = [];
  for (const c of task.containers) {
    const overridden = new Set(overriddenEnvKeys(options.envOverrides, c.name));
    for (const s of c.secrets) {
      if (overridden.has(s.name)) {
        logger.debug(
          safeMsg`Secret ${displayIdent(c.name)}.${displayIdent(s.name)} not fetched: --env-vars gives this key.`
        );
        continue;
      }
      allSecrets.push({ containerName: c.name, name: s.name, valueFrom: s.valueFrom });
    }
  }
  const resolvedSecrets = await resolveEcsSecrets(allSecrets, {
    ...(options.region !== undefined && { region: options.region }),
  });
  const secretsByContainer = groupSecretsByContainer(resolvedSecrets);

  // CloudFormation dynamic references (`{{resolve:...}}`) in container
  // `Environment` values (issue #2056), fail-fast before any network /
  // container exists, like the Secrets above. Region: the stack owning the
  // task definition. A key a `--env-vars` override names, or a same-name
  // Secret replaces, is never what the container receives, so it is skipped.
  const dynamicEnvByContainer = new Map<
    string,
    { env: Record<string, string>; resolvedKeys: string[] }
  >();
  const dynamicRefs = createCallerDynamicReferenceResolver(options.profile);
  try {
    for (const c of task.containers) {
      const tokenKeys = new Set(dynamicReferenceEnvKeys(c, options.envOverrides));
      if (tokenKeys.size === 0) continue;
      dynamicEnvByContainer.set(
        c.name,
        await resolveDynamicReferencesInEnv(c.environment, {
          region: firstUsableRegion(
            options.stateRecordRegion,
            options.stackRegion,
            task.stack.region,
            options.region
          ),
          label: `Container ${c.name}`,
          skipKeys: new Set(Object.keys(c.environment).filter((k) => !tokenKeys.has(k))),
          resolver: dynamicRefs,
        })
      );
    }
  } finally {
    dynamicRefs.dispose();
  }

  // Bring the network + sidecar up. From this point on the cleanup
  // path is non-trivial — any failure must `destroyTaskNetwork(state.network)`
  // for runner-owned networks, but caller-owned (shared) networks survive
  // per-task cleanup.
  if (options.existingNetwork) {
    // Option A (design § 5) — `cdkd local start-service` creates one
    // shared network at the start of the run; every replica reuses it.
    // The runner marks the state's network as caller-owned so
    // `cleanupEcsRun()` skips teardown (only the CLI tears down once).
    state.network = { ...options.existingNetwork, ownedByCaller: true };
  } else {
    const networkName = newTaskNetworkName(options.cluster);
    // Pulled outside the tracked step: a pull creates nothing a ^C has to
    // wait for.
    await pullImage(METADATA_ENDPOINT_IMAGE, options.skipPull);
    const netCreateOpts: Parameters<typeof createTaskNetwork>[0] = {
      prefix: options.cluster,
      networkName,
      skipPull: true,
    };
    if (options.taskCredentials) netCreateOpts.credentials = options.taskCredentials;
    if (options.cluster) netCreateOpts.cluster = options.cluster;
    // A task role pins the AWS-documented 169.254.170.0/24 (the default, no
    // octet): SDKs read `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` only from
    // 169.254.170.2 (go-to-k/cdkd#5763).
    if (options.subnetOctet !== undefined && !options.taskRoleArn) {
      netCreateOpts.subnetOctet = options.subnetOctet;
    }
    await runDockerStep(
      state,
      () => createTaskNetwork(netCreateOpts),
      (net) => {
        state.network = net;
      },
      () =>
        destroyTaskNetwork({
          networkName,
          sidecarContainerId: taskSidecarName(networkName),
          sidecarIp: '',
        }),
      namedSubject([
        {
          kind: 'container',
          name: taskSidecarName(networkName),
          rm: 'docker rm -f',
          list: 'docker ps -a',
        },
        { kind: 'network', name: networkName, rm: 'docker network rm', list: 'docker network ls' },
      ])
    );
  }
  if (!state.network) throw interruptedError();

  // Realize docker volumes (per-task `Scope: 'task'` are torn down at
  // cleanup; `Scope: 'shared'` would survive but the docs explicitly
  // pin v1 to per-task semantics).
  const volumeByName = await realizeDockerVolumes(task.volumes, state);
  if (state.closing) throw interruptedError();

  // Merge the Cloud Map peer-discovery `--add-host` flags with the
  // boot-resolved `host.docker.internal:host-gateway` mapping so every
  // container can also reach a server on the host (an `AWS_ENDPOINT_URL_*`
  // local endpoint / tunneled VPC resource). Both are verbatim
  // `['--add-host', 'name:ip', ...]` pairs; the host-gateway entry uses a
  // distinct name so its order vs the peer entries is irrelevant.
  const mergedAddHostFlags = mergeHostGatewayAddHostFlags(
    options.addHostFlags,
    options.hostGatewayExtraHosts
  );

  // Pre-compute every container's CMD args so the start loop only does
  // docker calls.
  const dockerCmds = new Map<string, string[]>();
  const dockerNames = new Map<string, string>();
  // Sensitive env values kept OUT of argv (see `buildDockerRunArgs`), keyed by
  // container name and forwarded to each `docker run` via the spawn `env`.
  // (`collisions` is consumed in the build loop below, not stored — the start
  // loop reads only the sensitive env.)
  const dockerEnvs = new Map<string, Record<string, string>>();
  for (const container of task.containers) {
    const image = imagePlan.get(container.name);
    if (!image) {
      throw new EcsTaskRunnerError(
        `Internal: no resolved image for container '${container.name}'.`
      );
    }
    const dynamic = dynamicEnvByContainer.get(container.name);
    const built = buildDockerRunArgs({
      task,
      container: dynamic ? { ...container, environment: dynamic.env } : container,
      plaintextEnvKeys: [
        ...(container.resolvedDynamicReferenceKeys ?? []),
        ...(dynamic?.resolvedKeys ?? []),
      ],
      image,
      network: state.network.networkName,
      volumeByName,
      secrets: secretsByContainer.get(container.name) ?? [],
      envOverrides: options.envOverrides,
      containerHost: options.containerHost,
      roleArn: options.taskRoleArn,
      platformOverride: options.platformOverride,
      region: options.region,
      sidecarIp: state.network.sidecarIp,
      ...(options.skipHostPortPublish ? { skipHostPortPublish: true } : {}),
      ...(mergedAddHostFlags.length > 0 ? { addHostFlags: mergedAddHostFlags } : {}),
      ...((options.networkAliasesByContainer?.get(container.name)?.length ?? 0) > 0
        ? { networkAliases: options.networkAliasesByContainer!.get(container.name)! }
        : {}),
      ...(options.profileCredentialsFile && {
        profileCredentialsFile: options.profileCredentialsFile,
      }),
    });
    dockerCmds.set(container.name, built.args);
    dockerNames.set(container.name, built.dockerName);
    dockerEnvs.set(container.name, built.sensitiveEnv);
    // A resolved secret whose NAME collides with a var the docker CLIENT reads
    // — or is a MALFORMED env name (`isMalformedEnvKey`: empty, or containing
    // `=` / NUL) — reaches neither the argv nor the spawn env (it would hijack
    // the client, and a value-less `-e KEY` would hand the container the HOST's
    // value — see `partitionSensitiveEnv`). Warn HERE, in the build loop: every container's
    // drop is reported regardless of whether an earlier container's `docker run`
    // fails, and outside the start loop's try/catch that relabels errors as
    // "docker run failed" (issue #2183 review).
    if (built.collisions.length > 0) {
      logger.warn(
        `Container '${container.name}': secret(s) ${built.collisions.map((k) => JSON.stringify(k)).join(', ')} share a name with a variable the container client reads (docker, or the CDK_DOCKER binary) or have a malformed name (empty, or containing '=' / NUL), and were NOT passed to the container at all (a colliding name would hijack that client; a malformed name cannot form a valid environment variable). Rename the secret if the container needs it.`
      );
    }
  }

  // Boot containers in dependency order. Each container's `dependsOn`
  // gates its start: START condition needs `docker run` to have
  // returned; COMPLETE / SUCCESS / HEALTHY each wait for the dependency
  // container's lifecycle to reach the matching state. The DAG's
  // `startOrder` is the dependency-respecting topological order; any
  // remaining condition gating fires inside the per-container
  // `awaitDependencies` step.
  const startedByName = new Map<string, { id: string; container: ResolvedEcsContainer }>();
  for (const containerName of startOrder) {
    const container = task.containers.find((c) => c.name === containerName)!;
    await awaitDependencies(container, startedByName);
    if (state.closing) throw interruptedError();

    const args = dockerCmds.get(container.name)!;
    const dockerName = dockerNames.get(container.name)!;
    logger.info(`Starting container '${container.name}' (image=${imagePlan.get(container.name)})`);
    const sensitiveEnv = dockerEnvs.get(container.name)!;
    warnFinchArgvExposure(Object.keys(sensitiveEnv));
    // A ^C while this `docker run` is in flight waits for it, so the container
    // it starts is recorded and removed (issue #4495).
    const id = await runDockerStep(
      state,
      async () => {
        try {
          const { stdout } = await execFileAsync(getDockerCmd(), args, {
            maxBuffer: 10 * 1024 * 1024,
            // The `-e KEY` (value-less) flags read their values from here, so
            // secrets / credentials never reach the `docker run` argv.
            env: dockerSpawnEnvWithSensitive(sensitiveEnv),
          });
          return stdout.trim();
        } catch (err) {
          // `execFile` folds the whole `docker run` command line into
          // `err.message` (and into `String(err)`), so an unredacted fallback
          // echoes every `-e KEY=value` pair -- the container's resolved
          // `Environment` plus any `--env-vars` override (issue #2440).
          throw new DockerRunnerError(
            `docker run failed for container '${container.name}': ${describeDockerFailure(err, args)}`
          );
        }
      },
      (startedId) => {
        state.startedContainers.push({ name: container.name, id: startedId });
      },
      () => removeContainer(dockerName),
      namedSubject([
        { kind: 'container', name: dockerName, rm: 'docker rm -f', list: 'docker ps -a' },
      ])
    );
    startedByName.set(container.name, { id, container });

    if (!options.detach) {
      state.logStreams.push({ containerId: id, stream: streamContainerLogs(container.name, id) });
    }
  }

  if (options.detach) {
    return { exitCode: 0, state };
  }

  // Wait for the essential container to exit. AWS-side ECS treats the
  // first `essential: true` container as the task-driving one; cdkd
  // mirrors that. When no container declares `essential: false`, every
  // container is essential — we use `containers[0]` as the
  // task-driving one.
  const essential = task.containers.find((c) => c.essential) ?? task.containers[0]!;
  const essentialId = startedByName.get(essential.name)?.id;
  if (!essentialId) {
    throw new EcsTaskRunnerError(`Essential container '${essential.name}' did not start.`);
  }
  const exitCode = await waitForContainerExit(essentialId);
  // The essential container has exited, so its follower ends on its own once
  // it has relayed the container's last lines (issue #4480). Drained here
  // rather than at teardown so `--keep-running`, which leaves the OTHER
  // containers up and stops their followers, still shows all of it.
  const essentialLogs = state.logStreams.find((l) => l.containerId === essentialId);
  if (essentialLogs) await essentialLogs.stream.drain(CONTAINER_LOG_DRAIN_TIMEOUT_MS);
  return { exitCode, essentialContainerName: essential.name, state };
}
