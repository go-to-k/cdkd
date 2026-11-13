import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  awaitLoopbackForwarderStatus,
  buildNamespaceOwnerForwarderDockerArgs,
  describeForwarderFailure,
  loopbackForwarderPlan,
  type LoopbackForwarderNamespace,
  type LoopbackForwarderResult,
  type WorkloadAwsWiring,
} from 'cdk-local/internal';
import { describeDockerFailure, getDockerCmd } from '../../utils/docker-cmd.js';
import { CdkdError } from '../../utils/error-handler.js';
import { getLogger } from '../../utils/logger.js';
import { DockerRunnerError, removeContainer } from '../docker-runner.js';
import { prepareLocalLoopbackForwarder } from '../local-aws-wiring.js';
import { interruptedError, namedSubject, runDockerStep } from './cleanup.js';
import type { EcsRunState } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Start the loopback forwarder that OWNS a task container's network namespace
 * (go-to-k/cdkd#6142), before the container itself: on the task network, with
 * the container's network aliases, port publishes, host mappings and links,
 * which Docker refuses on a `--network container:` joiner. Resolves `true`
 * once it reports READY; the caller then starts the container in its
 * namespace, so the app's first AWS call cannot race the forwarder.
 *
 * The forwarder is recorded in {@link EcsRunState.forwarders} as soon as its
 * `docker run` returns, so a ^C during the readiness wait removes it too.
 * It shares no PID namespace with the container (the app keeps PID 1), so it
 * outlives the container and `cleanupEcsRun` removes it after the containers.
 *
 * When the forwarder's `docker run` itself fails, the cause is the container's
 * own network identity as often as the endpoint (a host port in use moved to
 * the forwarder with `-p`), so under `--aws-emulator` it throws the same
 * `docker run failed for container` error the container's own start would.
 * Under `forward` it is warned about like any forwarder failure, and the
 * container's own start reports a port clash under its own name.
 *
 * When the forwarder runs but reports FAIL, or never reports, it is removed.
 * Under `--aws-emulator`, and in mixed mode for a container that uses the
 * re-signing sidecar, that throws (nothing of the container has started
 * yet); under `forward` it is a warning (once per port per run for a FAIL
 * report, once per container for a start failure) and resolves
 * `false`: the caller starts the container on its own network endpoint,
 * without a forwarder, as before.
 */
export async function startNamespaceForwarder(
  state: EcsRunState,
  forwarder: { name: string; container: string; namespace: LoopbackForwarderNamespace },
  containerName: string,
  ports: readonly number[],
  wiring: WorkloadAwsWiring
): Promise<boolean> {
  const label =
    wiring.mode === 'emulator'
      ? `--aws-emulator ${wiring.emulatorEndpoint?.url ?? ''}`
      : wiring.mixed
        ? `--aws-emulator ${wiring.mixed.emulatorEndpoint.url} (mixed mode)`
        : 'The AWS endpoint override (AWS_ENDPOINT_URL*)';
  // AWS Emulator mixed mode (go-to-k/cdkd#6150): the re-signing sidecar's
  // port is served by the sidecar, not the TCP forwarder, and a container
  // that uses it asked for the emulator, so a failure is fatal there as under
  // `--aws-emulator`.
  const plan = loopbackForwarderPlan(wiring, ports);
  const fatal = wiring.mode === 'emulator' || plan.resignConfigHostPath !== undefined;
  // Pull the image first, outside the tracked step: a pull creates nothing.
  await prepareLocalLoopbackForwarder(wiring);
  const { name } = forwarder;
  const args = buildNamespaceOwnerForwarderDockerArgs({
    name,
    namespace: forwarder.namespace,
    ports: plan.ports,
    probe: wiring.probeHealth ? 'health' : 'tcp',
    ...(wiring.caHostPath ? { caHostPath: wiring.caHostPath } : {}),
    ...(wiring.skipPull ? { skipPull: true } : {}),
    ...(plan.resignConfigHostPath ? { resignConfigHostPath: plan.resignConfigHostPath } : {}),
  });
  getLogger()
    .child('ecs-runner')
    .debug(`Starting loopback forwarder ${name} for ports ${ports.join(',')}`);

  try {
    await runDockerStep(
      state,
      () => runForwarderContainer(args, containerName),
      (id) => {
        state.forwarders.push({ name, id, container: forwarder.container, joined: false });
      },
      () => removeContainer(name),
      namedSubject([{ kind: 'container', name, rm: 'docker rm -f', list: 'docker ps -a' }])
    );
  } catch (err) {
    if (state.closing) throw interruptedError();
    // A failed `docker run -d` can still have created the container.
    await removeNamespaceForwarder(state, name);
    if (fatal) throw err;
    // `forward`: the container starts on its own endpoint as before. A host
    // port clash then fails ITS `docker run`, under its own name.
    return failed(state, fatal, `start:${containerName}`, `${label}: ${(err as Error).message}`);
  }
  let result: LoopbackForwarderResult;
  try {
    result = await awaitLoopbackForwarderStatus(name);
  } catch (err) {
    if (state.closing) throw interruptedError();
    // The forwarder exited before reporting, or never reported.
    await removeNamespaceForwarder(state, name);
    return failed(state, fatal, `start:${containerName}`, `${label}: ${(err as Error).message}`);
  }
  if (state.closing) throw interruptedError();
  if (result.ok) return true;
  await removeNamespaceForwarder(state, name);
  return failed(
    state,
    fatal,
    String(result.failedPort ?? 0),
    describeForwarderFailure(result, label)
  );
}

/** `docker run -d` the forwarder; the failure text never carries the argv. */
async function runForwarderContainer(args: string[], containerName: string): Promise<string> {
  try {
    return (await execFileAsync(getDockerCmd(), args)).stdout.trim();
  } catch (err) {
    throw new DockerRunnerError(
      `docker run failed for container '${containerName}' (its loopback AWS forwarder, which holds the container's network aliases and published ports): ${describeDockerFailure(err, args)}`
    );
  }
}

/**
 * Remove the forwarder `name` and forget it: one that failed, or whose
 * container never started, owns a namespace nothing joins (it would hold the
 * container's published ports, even under `--keep-running`).
 */
export async function removeNamespaceForwarder(state: EcsRunState, name: string): Promise<void> {
  await removeContainer(name);
  state.forwarders = state.forwarders.filter((f) => f.name !== name);
}

function failed(state: EcsRunState, fatal: boolean, key: string, message: string): false {
  if (fatal) {
    throw new CdkdError(message, 'LOCAL_AWS_EMULATOR_FORWARDER_FAILED');
  }
  state.forwarderWarnings ??= new Set<string>();
  if (!state.forwarderWarnings.has(key)) {
    state.forwarderWarnings.add(key);
    getLogger().warn(message);
  }
  return false;
}
