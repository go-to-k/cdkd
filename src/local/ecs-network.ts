import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
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
 * Well-known IP for the ECS local-container-endpoints sidecar — matches
 * the documented AWS task-metadata endpoint address. Containers inject
 * `ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/<container-id>`
 * to reach it.
 */
export const METADATA_ENDPOINT_IP = '169.254.170.2';

/** Subnet handed to `docker network create` so the well-known IP is routable. */
const METADATA_ENDPOINT_SUBNET = '169.254.170.0/24';

export interface TaskNetwork {
  /** Generated docker network name (`<prefix>-task-<rand>`). */
  networkName: string;
  /** Container id of the metadata-endpoints sidecar. Cleaned up at teardown. */
  sidecarContainerId: string;
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

  await pullImage(METADATA_ENDPOINT_IMAGE, options.skipPull ?? false);

  logger.info(`Creating docker network ${networkName} (subnet ${METADATA_ENDPOINT_SUBNET})...`);
  try {
    await execFileAsync('docker', [
      'network',
      'create',
      '--driver',
      'bridge',
      '--subnet',
      METADATA_ENDPOINT_SUBNET,
      networkName,
    ]);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new DockerRunnerError(
      `docker network create failed: ${e.stderr?.trim() || e.message || String(err)}. ` +
        `Hint: another cdkd run-task on the same host may already own subnet ${METADATA_ENDPOINT_SUBNET}; ` +
        'wait for it to finish, or remove the leftover network with `docker network ls` + `docker network rm`.'
    );
  }

  // Start the sidecar on the well-known IP. AWS docs say the image
  // honors `AWS_*` env vars for IAM-role emulation; cluster + region
  // mirror the live ECS metadata shape.
  const sidecarArgs: string[] = [
    'run',
    '-d',
    '--rm',
    '--name',
    `${networkName}-metadata`,
    '--network',
    networkName,
    '--ip',
    METADATA_ENDPOINT_IP,
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

  logger.info('Starting ECS local-container-endpoints sidecar at 169.254.170.2...');
  let sidecarContainerId: string;
  try {
    const { stdout } = await execFileAsync('docker', sidecarArgs, {
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

  return { networkName, sidecarContainerId };
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
}): Record<string, string> {
  const env: Record<string, string> = {
    ECS_CONTAINER_METADATA_URI_V4: `http://${METADATA_ENDPOINT_IP}/v4/${opts.containerName}`,
    ECS_CONTAINER_METADATA_URI: `http://${METADATA_ENDPOINT_IP}/v3/${opts.containerName}`,
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
    await execFileAsync('docker', ['network', 'rm', networkName]);
    logger.debug(`Removed docker network ${networkName}`);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    logger.debug(
      `docker network rm ${networkName} failed: ${e.stderr || e.message || String(err)}`
    );
  }
}
