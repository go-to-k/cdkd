import type { ContainerLogStream } from '../docker-runner.js';
import type { TaskNetwork } from '../ecs-network.js';

export class EcsTaskRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcsTaskRunnerError';
    Object.setPrototypeOf(this, EcsTaskRunnerError.prototype);
  }
}

export interface RunEcsTaskOptions {
  /** `--cluster <name>`. Surfaced to metadata sidecar and the network prefix. */
  cluster: string;
  /**
   * `--from-state` / `--from-cfn-stack` was given: the `--aws-emulator`
   * state-source hint after the dropped-entry warnings stays quiet.
   */
  stateSourceGiven?: boolean;
  /**
   * AWS Emulator mixed mode (go-to-k/cdkd#6150): the caller's REAL identity
   * (`--profile`, else the default chain) for the containers that keep a
   * `"real-aws"` exception, as env keys; the metadata sidecar
   * (`taskCredentials`) then serves emulator-issued credentials.
   */
  mixedModeRealCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /**
   * Mixed mode with `--assume-task-role` (go-to-k/cdkd#6147): the task role
   * assumed in REAL AWS, given instead of `mixedModeRealCredentials` to an
   * excepting container that also excepts STS.
   */
  mixedModeRealTaskCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /**
   * `--assume-task-role` under `--aws-emulator`, not mixed mode
   * (go-to-k/cdkd#6147): the task role assumed in AWS Emulator. It replaces
   * the emulator's keys in every container, so each runs as the role there.
   */
  emulatorTaskCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** Override container env vars (SAM-style top-level keys are container names; `Parameters` is global). */
  envOverrides?: Record<string, Record<string, string | null> | undefined>;
  /** Host IP to bind published container ports to. Default `127.0.0.1`. */
  containerHost: string;
  /**
   * When true, the runner omits EVERY `-p <hostPort>:<containerPort>`
   * flag from `docker run` (Issue #585). Set by `cdkd local
   * start-service` for multi-replica services: N replicas of one
   * service all map the same container port, so publishing a fixed host
   * port makes the 2nd+ replica fail to boot with `Bind for
   * 127.0.0.1:<port> failed: port is already allocated` — true whether
   * the TaskDefinition declares an explicit `hostPort` or omits it (cdkd
   * defaults the omitted host port to `containerPort`). Peer comms still
   * works via container IP / network alias on the shared docker network
   * (the production-like path — real ECS Service Connect / awsvpc tasks
   * have per-task ENIs and never share a host port), so dropping the
   * host-port publish is the correct local analogue. Single-replica
   * services leave this unset so `curl localhost:<port>` from the host
   * still works.
   */
  skipHostPortPublish?: boolean;
  /** Optional STS-issued temp credentials to expose via the metadata sidecar (`--assume-task-role`). */
  taskCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /**
   * ARN of the task role being assumed. When set, containers get
   * `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/creds` and a runner-created
   * network stays on `169.254.170.0/24` (ignoring {@link subnetOctet}).
   */
  taskRoleArn?: string;
  /** Force a `--platform` (default: inferred from task `RuntimePlatform.CpuArchitecture`). */
  platformOverride?: string;
  /** Skip `docker pull` on every image (sidecar + each container's image). */
  skipPull: boolean;
  /**
   * Optional role ARN to assume before authenticating against ECR for
   * cross-account / centralized registry pulls (#455). Forwarded to
   * `pullEcrImage`'s `ecrRoleArn` option. A same-account pull in ANY region
   * does not need this — `pullEcrImage` builds its ECR client for the image
   * URI's own region (issue #2536).
   */
  ecrRoleArn?: string;
  /** Don't `docker rm -f` containers on task exit; useful for `docker exec` post-mortems. */
  keepRunning: boolean;
  /** Start the containers and return without streaming logs. */
  detach: boolean;
  /** AWS region for secret resolution + metadata sidecar. */
  region?: string;
  /**
   * `--stack-region`: the region the task's stack lives in. A plain-name
   * `{{resolve:...}}` reference in `Environment` resolves there ahead of the
   * synth region and `region` (issue #2056).
   */
  stackRegion?: string;
  /** `--profile`: the credentials a `{{resolve:...}}` lookup is made with. */
  profile?: string;
  /**
   * The region of the `--from-state` / `--from-cfn-stack` record the task's
   * stack was loaded from: first when resolving a plain-name `{{resolve:...}}`.
   */
  stateRecordRegion?: string;
  /**
   * Optional pre-resolved `ImagePlan` map — only used by tests. Production
   * callers leave undefined and let the runner walk every container's
   * Image / docker build / ECR pull path.
   */
  imagePlanByContainer?: Map<string, string>;
  /**
   * Per-container `--image-override` tag map (go-to-k/cdkd#5768): the
   * override engine already built and tagged the image locally, so the runner
   * uses the tag verbatim and skips the pull / build path for that container.
   * Sibling containers without an entry still go through their normal
   * resolution. Distinct from {@link imagePlanByContainer} (a full
   * short-circuit used by tests).
   */
  imageOverrideByContainer?: ReadonlyMap<string, string>;
  /**
   * Optional second-from-last octet of the link-local /24 subnet for this
   * task's docker network (1..254). Default 170 (AWS-documented). Ignored
   * when {@link taskRoleArn} is set: task-role credentials are served only
   * from 169.254.170.2. See `buildEndpointSubnet` in `ecs-network.ts`.
   */
  subnetOctet?: number;
  /**
   * Phase 3 of #262 (Issue #460) — extra `--add-host name:ip` flag
   * pairs the docker-runner injects into EVERY user container's
   * `docker run` invocation. Used by the Cloud Map / Service Connect
   * overlay to map `<discoveryName>.<namespace>` (and bare
   * `<discoveryName>` ClientAlias short forms) to the IP of a peer
   * replica's container on the host's docker bridge.
   *
   * **Shape**: flat array of `['--add-host', 'name:ip', '--add-host', 'name2:ip2', ...]`.
   * The runner appends these to `docker run` verbatim — caller is
   * responsible for filtering out self-host (no point adding a
   * replica's own service to its own resolver) and for building the
   * flag pairs in the order they should be evaluated (docker's
   * resolver hits each entry in order; first match wins). Empty /
   * undefined → no extra flags emitted.
   */
  addHostFlags?: ReadonlyArray<string>;
  /**
   * `host.docker.internal` extra-host mapping(s) to add so this container
   * can reach a server bound on the host (e.g. an `AWS_ENDPOINT_URL_*`
   * local endpoint, or a tunneled VPC resource). Resolved ONCE at command
   * boot via `resolveHostGatewayExtraHosts()` (in `local-run-task.ts`) and
   * threaded down here — merged into the verbatim `--add-host` flag list
   * alongside {@link addHostFlags}. Empty / undefined → no mapping (Docker
   * Desktop resolves `host.docker.internal` natively; Linux native dockerd
   * needs this since 20.10). Distinct from {@link addHostFlags}, which
   * carries the Cloud Map peer-discovery entries. Mirrors cdk-local #483.
   */
  hostGatewayExtraHosts?: ReadonlyArray<{ host: string; ip: string }>;
  /**
   * Pre-existing docker network + sidecar to reuse instead of letting
   * the runner create a fresh per-task one. Originally used by
   * `cdkd local start-service`'s per-replica boot loop to share ONE
   * docker network across every replica (per design doc § 5 Option A —
   * peer services can reach each other by IP without docker
   * `network connect` choreography). With the Part B refactor onto
   * cdk-local's `runEcsServiceEmulator` engine, the live caller has
   * moved into cdk-local's bundled implementation; cdkd's own runner
   * keeps the option for the per-task lifecycle of `cdkd local run-task`
   * (which never sets it — see `local-run-task.ts`) and for any future
   * cdkd-side caller. When supplied, `runEcsTask`:
   *   1. Skips `createTaskNetwork()`.
   *   2. Uses `existingNetwork.networkName` / `sidecarIp` for every
   *      container's `--network` and `ECS_CONTAINER_METADATA_URI_V4`
   *      env injection.
   *   3. Marks `state.network.ownedByCaller = true` so
   *      `cleanupEcsRun()` does NOT teardown the shared lifecycle —
   *      only the caller (CLI) tears down once at the end of the run.
   *
   * When undefined, the pre-existing per-task lifecycle applies (one
   * network per task, created + destroyed with the task).
   */
  existingNetwork?: TaskNetwork;
  /**
   * Extra docker `--network-alias <alias>` values to register against
   * specific containers in the task. Keyed by container name so the
   * runner only attaches the aliases to the matching container's
   * `docker run` invocation — Service Connect aliases belong to the
   * container that declared the matching `PortMappings[].Name`, not
   * to every container in the task.
   *
   * Used by `cdkd local start-service` Option A (shared docker
   * network) so peers can reach this service by its Service Connect
   * `<discoveryName>` short-form / ClientAlias / fqdn via docker's
   * built-in DNS server — without depending on a separate Cloud Map
   * DNS sidecar. Empty / undefined → no extra aliases emitted
   * (network-aliases default to the container's `--name` only).
   */
  networkAliasesByContainer?: ReadonlyMap<string, ReadonlyArray<string>>;
  /**
   * ECS analogue of the Lambda-container fix shipped in PR #670:
   * synthesized AWS shared credentials file (one INI section under
   * `[<profileName>]`) bind-mounted read-only into EVERY user
   * container, plus `AWS_SHARED_CREDENTIALS_FILE` +
   * `AWS_PROFILE` env-var injection. Lets handlers that call
   * `fromIni({ profile: '<name>' })` explicitly resolve to the same
   * `--profile`-resolved creds the metadata sidecar serves, instead
   * of failing with `CredentialsProviderError: Profile <name> could
   * not be found` inside the container.
   *
   * Set by the CLI ONLY when `--profile` is effective AND
   * `--assume-task-role` is NOT (precedence: assume-task-role >
   * profile-file > sidecar). Caller is responsible for the
   * `writeProfileCredentialsFile()` allocation + `dispose()` cleanup
   * in its single-flight chain — the runner just plumbs the mount
   * and env-vars through `buildDockerRunArgs`.
   */
  profileCredentialsFile?: { hostPath: string; containerPath: string; profileName: string };
}

/**
 * Single struct that carries everything the orchestrator must tear down,
 * regardless of which step failed. Designed so the caller can hoist a
 * single `cleanup(state)` call in both the outer finally and the SIGINT
 * handler.
 */
export interface EcsRunState {
  network: TaskNetwork | undefined;
  /** Resolved docker volume names (`docker volume rm` on teardown). */
  dockerVolumeNames: string[];
  /** Container name → docker id, in start order. */
  startedContainers: { name: string; id: string }[];
  /**
   * Loopback forwarders that own a task container's network namespace
   * (go-to-k/cdkd#6142), by docker name and id. Each outlives its container,
   * so teardown removes them after the containers, and `--keep-running`
   * keeps them with the containers. `joined` turns true once the container
   * started in the forwarder's namespace; an unjoined forwarder is removed
   * even under `--keep-running` (it holds the container's published ports).
   */
  forwarders: {
    name: string;
    id: string;
    /** The docker name of the task container that joins (or would join) it. */
    container: string;
    joined: boolean;
  }[];
  /** Forwarder failure keys already warned about in this run (once per port). */
  forwarderWarnings?: Set<string>;
  /**
   * Active `docker logs -f` followers, by container id. Teardown drains each
   * once its container has stopped, so the container's last lines are not
   * lost to the daemon's relay lag (issue #4480).
   */
  logStreams: { containerId: string; stream: ContainerLogStream }[];
  /**
   * Set once `cleanupEcsRun` begins: from then on `runEcsTask` creates
   * nothing more (issue #4495).
   */
  closing?: boolean;
  /**
   * The docker step creating something cleanup must remove — the network and
   * its sidecar, a volume, or a container — while it is in flight, so a ^C
   * landing inside it neither misses what it creates nor exits first (issue
   * #4495). See {@link InFlightDockerStep}.
   */
  inFlight?: InFlightDockerStep | undefined;
}

/**
 * One in-flight docker step of `runEcsTask`. `settled` never rejects, and
 * settles only once what the step created is recorded in the state, where
 * cleanup finds it. `abandon` removes it by its docker name, for a step that
 * does not settle within {@link IN_FLIGHT_STEP_TIMEOUT_MS}.
 */
export interface InFlightDockerStep {
  settled: Promise<void>;
  abandon: () => Promise<void>;
  /**
   * What `abandon` removes and the command that removes it, for the warning:
   * a `docker` command still running past the bound can create it after the
   * removal (its CLI child outlives cdkd's exit).
   */
  subject: { what: string; remedy: string };
  /**
   * Set when cleanup stopped waiting and removed the step by name: a step that
   * completes afterwards removes what it created rather than recording it into
   * a state cleanup has already read.
   */
  abandoned?: boolean;
}

/**
 * How long `cleanupEcsRun` waits for an in-flight docker step before
 * removing what it creates by name. `docker run` has no timeout of its own and
 * a terminal ^C does not interrupt it, so a hung daemon would otherwise hold
 * the ^C forever.
 */
export const IN_FLIGHT_STEP_TIMEOUT_MS = 20_000;

export interface RunEcsTaskResult {
  /** Exit code of the essential container (0 by default when `--keep-running` and no exit awaited). */
  exitCode: number;
  /** Name of the essential container whose exit drove the result. */
  essentialContainerName?: string;
  state: EcsRunState;
}

/**
 * Build a fresh, empty `EcsRunState`. Surfaces a single allocation point
 * so the CLI's `cleanup()` closure doesn't have to reach into runner
 * internals.
 */
export function createEcsRunState(): EcsRunState {
  return {
    network: undefined,
    dockerVolumeNames: [],
    startedContainers: [],
    forwarders: [],
    logStreams: [],
    closing: false,
    inFlight: undefined,
  };
}

/**
 * `runEcsTask` stopped because `cleanupEcsRun` began while it ran
 * (a ^C). The caller's cleanup owns the exit; this is not a failure to report.
 */
export class EcsTaskInterruptedError extends EcsTaskRunnerError {
  constructor() {
    super('Interrupted; the task is being torn down.');
    this.name = 'EcsTaskInterruptedError';
    Object.setPrototypeOf(this, EcsTaskInterruptedError.prototype);
  }
}
