import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { getDockerCmd } from '../utils/docker-cmd.js';
import { getLogger } from '../utils/logger.js';
import { DockerRunnerError, pullImage, removeContainer } from './docker-runner.js';

const execFileAsync = promisify(execFile);

/**
 * Docker network + AWS-published metadata-endpoints sidecar lifecycle for
 * `cdkd local run-task`. The sidecar (a small Go binary maintained by
 * awslabs) is started at `169.254.170.2` on the per-task docker network so
 * containers can hit `http://169.254.170.2/v4/<container-id>` for task
 * metadata AND `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/role/<role-arn>`
 * for IAM task-role credentials. cdkd does NOT re-implement the sidecar
 * — pulling the AWS-published image keeps cdkd in lock-step with whatever
 * ECS-Agent fidelity AWS chooses to provide.
 */

/** AWS-published sidecar image (latest tag). amd64 is the only image AWS ships. */
export const METADATA_ENDPOINT_IMAGE = 'amazon/amazon-ecs-local-container-endpoints:latest-amd64';

/**
 * Default well-known IP for the ECS local-container-endpoints sidecar —
 * matches the documented AWS task-metadata endpoint address. Containers
 * inject `ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/<id>`
 * to reach it. `cdkd local run-task` keeps this verbatim; `cdkd local
 * start-service` allocates a per-replica subnet (via `subnetOctet`) so
 * concurrent replicas don't collide on a single docker network range.
 */
export const METADATA_ENDPOINT_IP = '169.254.170.2';

/** Default subnet — used when no `subnetOctet` override is supplied. */
const DEFAULT_METADATA_ENDPOINT_SUBNET = '169.254.170.0/24';

/**
 * Pure-functional subnet allocator. `cdkd local run-task` uses the
 * default subnet; `cdkd local start-service` walks `subnetOctet=170,
 * 171, 172, ...` (one per replica) to keep parallel docker networks
 * from clashing. The link-local 169.254.0.0/16 space is reserved AWS-
 * wide for cloud metadata so collisions with user workloads are
 * unlikely, but each replica still gets its own /24 to ensure
 * docker's `--subnet` allocator does not reject "Pool overlaps".
 *
 * `subnetOctet` is the second-from-last byte of the network: 170 →
 * 169.254.170.0/24 (default), 171 → 169.254.171.0/24, etc. Valid
 * range is 1..254; the runner clamps to `(170 + replicaIndex) % 84`
 * + 170 in practice (rolling window) — exported here so the runner
 * keeps the allocation logic in one place.
 */
export function buildEndpointSubnet(subnetOctet: number): {
  cidr: string;
  sidecarIp: string;
} {
  if (subnetOctet < 1 || subnetOctet > 254 || !Number.isInteger(subnetOctet)) {
    throw new Error(
      `buildEndpointSubnet: subnetOctet must be an integer in 1..254 (got ${subnetOctet}).`
    );
  }
  return {
    cidr: `169.254.${subnetOctet}.0/24`,
    sidecarIp: `169.254.${subnetOctet}.2`,
  };
}

export interface TaskNetwork {
  /** Generated docker network name (`<prefix>-task-<rand>`). */
  networkName: string;
  /** Container id of the metadata-endpoints sidecar. Cleaned up at teardown. */
  sidecarContainerId: string;
  /**
   * Resolved sidecar IP for THIS network instance. `cdkd local run-task`
   * sees 169.254.170.2 (the default); `cdkd local start-service` sees
   * a per-replica IP. Containers' `ECS_CONTAINER_METADATA_URI_V4` is
   * derived from this so each replica's containers hit their own
   * sidecar regardless of which subnet was allocated.
   */
  sidecarIp: string;
}

export interface CreateTaskNetworkOptions {
  /**
   * Docker network name prefix. Default `cdkd-local`; the runner injects
   * the CLI's `--cluster <name>`. The full name is `<prefix>-task-<rand>`.
   */
  prefix?: string;
  /**
   * When set, the sidecar receives `AWS_ACCESS_KEY_ID` /
   * `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` env vars so its
   * `/role/<role-arn>` endpoint serves these creds to the user
   * containers. When unset, the sidecar falls back to its default
   * credential chain (typically empty — the user containers will get
   * 4xx from the credentials endpoint, mimicking IAM-misconfigured prod).
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** `--cluster <name>` value. Forwarded to the sidecar's `CLUSTER` env. */
  cluster?: string;
  /** Skip `docker pull <sidecar>`. */
  skipPull?: boolean;
  /**
   * Optional second-from-last octet of the link-local /24 subnet
   * (1..254). Default 170 (the AWS-documented metadata-endpoint subnet).
   * `cdkd local start-service` walks this value per replica so
   * concurrent docker networks don't collide on the same /24 range.
   */
  subnetOctet?: number;
}

/**
 * Create the per-task docker network + start the metadata-endpoints
 * sidecar. The sidecar must come up at the well-known address BEFORE any
 * user container starts so the `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`
 * lookup at container start doesn't race.
 */
export async function createTaskNetwork(
  options: CreateTaskNetworkOptions = {}
): Promise<TaskNetwork> {
  const logger = getLogger().child('ecs-network');
  const prefix = options.prefix ?? 'cdkd-local';
  const suffix = randomBytes(4).toString('hex');
  const networkName = `${prefix}-task-${suffix}`;
  const subnetOctet = options.subnetOctet ?? 170;
  const { cidr, sidecarIp } =
    options.subnetOctet === undefined
      ? { cidr: DEFAULT_METADATA_ENDPOINT_SUBNET, sidecarIp: METADATA_ENDPOINT_IP }
      : buildEndpointSubnet(subnetOctet);

  await pullImage(METADATA_ENDPOINT_IMAGE, options.skipPull ?? false);

  logger.info(`Creating docker network ${networkName} (subnet ${cidr})...`);
  try {
    await execFileAsync(getDockerCmd(), [
      'network',
      'create',
      '--driver',
      'bridge',
      '--subnet',
      cidr,
      networkName,
    ]);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new DockerRunnerError(
      `docker network create failed: ${e.stderr?.trim() || e.message || String(err)}. ` +
        `Hint: another cdkd run-task on the same host may already own subnet ${cidr}; ` +
        'wait for it to finish, or remove the leftover network with `docker network ls` + `docker network rm`. ' +
        '`cdkd local start-service` walks subnetOctet per replica to avoid this; bare `cdkd local run-task` ' +
        'uses the default subnet so only one run can be active at a time.'
    );
  }

  // Start the sidecar on the resolved IP for this network. AWS docs
  // say the image honors `AWS_*` env vars for IAM-role emulation;
  // cluster + region mirror the live ECS metadata shape.
  const sidecarArgs: string[] = [
    'run',
    '-d',
    '--rm',
    '--name',
    `${networkName}-metadata`,
    '--network',
    networkName,
    '--ip',
    sidecarIp,
  ];
  const sidecarEnv: Record<string, string> = {};
  if (options.credentials) {
    sidecarEnv['AWS_ACCESS_KEY_ID'] = options.credentials.accessKeyId;
    sidecarEnv['AWS_SECRET_ACCESS_KEY'] = options.credentials.secretAccessKey;
    if (options.credentials.sessionToken) {
      sidecarEnv['AWS_SESSION_TOKEN'] = options.credentials.sessionToken;
    }
  }
  if (options.cluster) sidecarEnv['CLUSTER'] = options.cluster;
  for (const [k, v] of Object.entries(sidecarEnv)) {
    sidecarArgs.push('-e', `${k}=${v}`);
  }
  sidecarArgs.push(METADATA_ENDPOINT_IMAGE);

  logger.info(`Starting ECS local-container-endpoints sidecar at ${sidecarIp}...`);
  let sidecarContainerId: string;
  try {
    const { stdout } = await execFileAsync(getDockerCmd(), sidecarArgs, {
      maxBuffer: 10 * 1024 * 1024,
    });
    sidecarContainerId = stdout.trim();
  } catch (err) {
    // Tear down the freshly-created network so we don't leak it.
    await destroyNetworkOnly(networkName);
    const e = err as { stderr?: string; message?: string };
    throw new DockerRunnerError(
      `Failed to start metadata-endpoints sidecar: ${e.stderr?.trim() || e.message || String(err)}`
    );
  }

  return { networkName, sidecarContainerId, sidecarIp };
}

/**
 * Build the env var entries every user container needs so its AWS SDK
 * picks up the sidecar. `<container-id>` is replaced by the actual docker
 * id post-`run` — at this point we use the container name as a stable
 * proxy since the metadata endpoint accepts a name lookup.
 *
 * `roleArn` is the optional task role ARN. When set, the credentials
 * endpoint path bakes it in so AWS SDK clients pull the assumed creds
 * automatically; when unset, the path is omitted (containers fall back
 * to whichever credentials AWS SDK chains find).
 */
export function buildMetadataEnv(opts: {
  containerName: string;
  roleArn?: string;
  region?: string;
  /**
   * Sidecar IP for this task's network. Defaults to the AWS-documented
   * `169.254.170.2` so `cdkd local run-task` keeps the canonical shape.
   * `cdkd local start-service` passes the per-replica IP allocated by
   * `buildEndpointSubnet(subnetOctet)` so each replica's containers
   * resolve their own sidecar (not a sibling replica's).
   */
  sidecarIp?: string;
}): Record<string, string> {
  const ip = opts.sidecarIp ?? METADATA_ENDPOINT_IP;
  const env: Record<string, string> = {
    ECS_CONTAINER_METADATA_URI_V4: `http://${ip}/v4/${opts.containerName}`,
    ECS_CONTAINER_METADATA_URI: `http://${ip}/v3/${opts.containerName}`,
  };
  if (opts.roleArn) {
    env['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'] = `/role/${encodeURIComponent(opts.roleArn)}`;
  }
  if (opts.region) env['AWS_REGION'] = opts.region;
  return env;
}

/**
 * Tear down the metadata-endpoints sidecar + the docker network. Idempotent
 * — `docker rm -f` and `docker network rm` both swallow not-found errors
 * by design, and the function logs at debug instead of throwing.
 */
export async function destroyTaskNetwork(net: TaskNetwork | undefined): Promise<void> {
  if (!net) return;
  await removeContainer(net.sidecarContainerId);
  await destroyNetworkOnly(net.networkName);
}

async function destroyNetworkOnly(networkName: string): Promise<void> {
  if (!networkName) return;
  const logger = getLogger().child('ecs-network');
  try {
    await execFileAsync(getDockerCmd(), ['network', 'rm', networkName]);
    logger.debug(`Removed docker network ${networkName}`);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    logger.debug(
      `docker network rm ${networkName} failed: ${e.stderr || e.message || String(err)}`
    );
  }
}
