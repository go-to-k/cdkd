import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { describeDockerFailure, getDockerCmd } from '../../utils/docker-cmd.js';
import { isPasteableIdent, safeMsg } from '../../utils/display-safe.js';
import { getLogger } from '../../utils/logger.js';
import { CONTAINER_LOG_DRAIN_TIMEOUT_MS, removeContainer } from '../docker-runner.js';
import { destroyTaskNetwork } from '../ecs-network.js';
import { quotedOrDescribed } from '../../utils/pasteable-command.js';
import {
  EcsTaskInterruptedError,
  IN_FLIGHT_STEP_TIMEOUT_MS,
  type EcsRunState,
  type InFlightDockerStep,
} from './types.js';

const execFileAsync = promisify(execFile);

async function runAfterContainersStopped(
  hook: (() => Promise<void>) | undefined,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  if (!hook) return;
  try {
    await hook();
  } catch (err) {
    logger.debug(safeMsg`afterContainersStopped hook failed: ${describeAwsFailure(err).detail}`);
  }
}

/**
 * Wait for {@link EcsRunState.inFlight}, so what it creates is in the state
 * before the teardown reads it; past {@link IN_FLIGHT_STEP_TIMEOUT_MS}, remove
 * it by name instead.
 */
async function settleInFlightStep(
  state: EcsRunState,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const step = state.inFlight;
  if (!step) return;
  logger.info('Waiting for the in-flight docker command so what it creates can be removed...');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    step.settled.then(() => true),
    new Promise<false>((r) => {
      timer = setTimeout(() => r(false), IN_FLIGHT_STEP_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (settled) return;
  step.abandoned = true;
  try {
    await step.abandon();
  } catch (err) {
    logger.debug(safeMsg`in-flight step removal failed: ${describeAwsFailure(err).detail}`);
  }
  logger.warn(
    safeMsg`The in-flight docker command did not finish within ${IN_FLIGHT_STEP_TIMEOUT_MS / 1000}s; removed ${step.subject.what} if it existed, but a docker command that completes later can still create it -- run '${step.subject.remedy}' if it appears.`
  );
}

/**
 * Run one docker step that creates something {@link cleanupEcsRun} must
 * remove (issue #4495). It starts nothing once cleanup has begun, and while it
 * runs it is {@link EcsRunState.inFlight}: `record` puts its result in the
 * state before cleanup's wait on it ends. A step that completes under a
 * closing run throws, so the task goes no further.
 *
 * Under a closing run, a step that FAILS still runs `abandon` before it
 * settles: a terminal ^C signals the `docker` CLI too, which can abort
 * `docker run -d` after the container was created, and nothing would record
 * that container. `abandon` removes by a name unique to this run with high
 * probability (24 random bits or more), so it is safe when nothing was created.
 */
export async function runDockerStep<T>(
  state: EcsRunState,
  step: () => Promise<T>,
  record: (result: T) => void,
  abandon: () => Promise<void>,
  subject: InFlightDockerStep['subject']
): Promise<T> {
  if (state.closing) throw interruptedError();
  const run = step();
  const removeByName = (): Promise<void> => abandon().catch(() => undefined);
  // Registered before the `await` below, so `record` runs first.
  const settled = run.then(
    async (result) => {
      if (entry.abandoned) await removeByName();
      else record(result);
    },
    async () => {
      if (state.closing) await removeByName();
    }
  );
  const entry: InFlightDockerStep = { settled, abandon, subject };
  state.inFlight = entry;
  let result: T;
  try {
    result = await run;
  } finally {
    if (state.inFlight === entry) state.inFlight = undefined;
  }
  if (state.closing) throw interruptedError();
  return result;
}

/**
 * The warning's subject for docker objects removed by name: each name quoted
 * when it is a plain identifier, and each kind's unfiltered listing
 * (`docker ps -a` / `docker volume ls` / `docker network ls`) as the remedy when
 * one is not (a name never reaches a pasteable command unvetted).
 */
export function namedSubject(
  kinds: readonly { kind: string; name: string; rm: string; list: string }[]
): InFlightDockerStep['subject'] {
  const what = kinds
    .map((k) => `${k.kind} ${quotedOrDescribed(k.name, `${k.kind} name`)}`)
    .join(' and ');
  // A name that is not a plain identifier never reaches a pasteable command:
  // list that kind instead, unfiltered, since `--cluster` sets the prefix.
  const remedy = kinds.every((k) => isPasteableIdent(k.name))
    ? kinds.map((k) => `${k.rm} ${k.name}`).join('; ')
    : kinds.map((k) => k.list).join('; ');
  return { what, remedy };
}

export function interruptedError(): EcsTaskInterruptedError {
  return new EcsTaskInterruptedError();
}

/**
 * Cleanup the resources tracked in `state`. Idempotent and safe to call
 * from both the outer `finally` AND the SIGINT handler. Errors per-step
 * are logged at debug so cleanup never masks a real handler error.
 */
export async function cleanupEcsRun(
  state: EcsRunState,
  options: {
    keepRunning: boolean;
    /**
     * Runs once the containers no longer need what the caller mounted into
     * them — after `docker stop` (or, under `keepRunning`, after the followers
     * stop), BEFORE the bounded log drain — so a second ^C during the drain
     * cannot strand it (issue #4480). Errors are logged at debug.
     */
    afterContainersStopped?: () => Promise<void>;
  }
): Promise<void> {
  const logger = getLogger().child('ecs-runner');
  state.closing = true;
  await settleInFlightStep(state, logger);
  const logStreams = state.logStreams;
  state.logStreams = [];

  if (options.keepRunning) {
    // The containers stay up, so their followers would never end on their own.
    for (const { stream } of logStreams) {
      try {
        stream.stop();
      } catch (err) {
        logger.debug(`log stream stop failed: ${describeAwsFailure(err).detail}`);
      }
    }
    await runAfterContainersStopped(options.afterContainersStopped, logger);
  } else {
    // Both callees swallow their own errors today, so these handlers are
    // defensive. They still pass the REAL argv rather than a plausible-looking
    // one: the composer's contract is "the argv you redact with is the argv
    // you spawned", and a fabricated array quietly breaks it the day a callee
    // starts propagating.
    for (const c of state.startedContainers) {
      const stopArgs = dockerStopArgs(c.id, CLEANUP_STOP_GRACE_SECONDS);
      try {
        await stopContainer(c.id, CLEANUP_STOP_GRACE_SECONDS);
      } catch (err) {
        logger.debug(`docker stop ${c.id} failed: ${describeDockerFailure(err, stopArgs)}`);
      }
    }
    await runAfterContainersStopped(options.afterContainersStopped, logger);
    // Every container is stopped, so each follower ends once it has relayed
    // its container's last lines; remove the containers only after that.
    await Promise.all(
      logStreams.map(async ({ stream }) => {
        try {
          await stream.drain(CONTAINER_LOG_DRAIN_TIMEOUT_MS);
        } catch (err) {
          logger.debug(safeMsg`log stream drain failed: ${describeAwsFailure(err).detail}`);
        }
      })
    );
    for (const c of state.startedContainers) {
      try {
        await removeContainer(c.id);
      } catch (err) {
        logger.debug(
          `docker rm -f ${c.id} failed: ${describeDockerFailure(err, ['rm', '-f', c.id])}`
        );
      }
    }
    state.startedContainers = [];
  }

  // Sidecar + network teardown runs unconditionally for runner-owned
  // networks (the docs spell out that `--keep-running` only spares
  // user containers — the network + sidecar would otherwise leak
  // across runs). Caller-owned (shared) networks survive per-task
  // cleanup — `cdkd local start-service` tears down ONCE at the end
  // of the run after every replica has been cleaned up.
  if (state.network && !state.network.ownedByCaller) {
    await destroyTaskNetwork(state.network);
  }
  state.network = undefined;

  for (const v of state.dockerVolumeNames) {
    const rmArgs = ['volume', 'rm', v];
    try {
      await execFileAsync(getDockerCmd(), rmArgs);
      logger.debug(`Removed docker volume ${v}`);
    } catch (err) {
      logger.debug(`docker volume rm ${v} failed: ${describeDockerFailure(err, rmArgs)}`);
    }
  }
  state.dockerVolumeNames = [];
}

/** Seconds `cleanupEcsRun` gives a container to stop before `docker rm -f`. */
const CLEANUP_STOP_GRACE_SECONDS = 10;

/** The exact `docker stop` argv, so callers redact with the argv actually spawned. */
function dockerStopArgs(containerId: string, graceSeconds: number): string[] {
  return ['stop', '-t', String(graceSeconds), containerId];
}

async function stopContainer(containerId: string, graceSeconds: number): Promise<void> {
  try {
    await execFileAsync(getDockerCmd(), dockerStopArgs(containerId, graceSeconds));
  } catch {
    // Ignore — the subsequent `docker rm -f` covers stuck containers.
  }
}
