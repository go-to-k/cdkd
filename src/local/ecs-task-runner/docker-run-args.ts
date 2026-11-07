import { randomBytes } from 'node:crypto';
import { containsDynamicReference } from 'cdk-local/internal';
import { partitionSensitiveEnv } from '../../utils/docker-cmd.js';
import { defineOwnKey } from '../../utils/own-keys.js';
import { SENSITIVE_ENV_KEYS } from '../docker-runner.js';
import { buildMetadataEnv } from '../ecs-network.js';
import type { ResolvedSecret } from '../ecs-secrets-resolver.js';
import type {
  ResolvedEcsContainer,
  ResolvedEcsTask,
  ResolvedEcsVolume,
} from '../ecs-task-resolver.js';
import type { RunEcsTaskOptions } from './types.js';

export function randHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** Env keys a `--env-vars` override names for this container (a `null` clear included). */
export function overriddenEnvKeys(
  overrides: RunEcsTaskOptions['envOverrides'],
  containerName: string
): string[] {
  if (!overrides) return [];
  // Only the entries `applyOverrideMap` actually APPLIES (a `null` clear or a
  // literal): an object or array value is ignored there, so counting it here
  // would skip the lookup and hand the container the token.
  const applied = (map: Record<string, unknown> | undefined): string[] =>
    Object.entries(map ?? {})
      .filter(
        ([, v]) =>
          v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      )
      .map(([k]) => k);
  return [...applied(overrides['Parameters']), ...applied(overrides[containerName])];
}

/**
 * `Environment` keys whose value holds a dynamic reference that will be
 * resolved (issue #2056). A same-name `Secrets` entry replaces the env value
 * in the container and a `--env-vars` override replaces it at `docker run`,
 * so neither one's token is what the container receives; a value already
 * resolved at the cross-stack boundary is plaintext and never re-scanned.
 */
export function dynamicReferenceEnvKeys(
  container: ResolvedEcsContainer,
  overrides: RunEcsTaskOptions['envOverrides']
): string[] {
  const skip = new Set([
    ...(container.resolvedDynamicReferenceKeys ?? []),
    ...container.secrets.map((s) => s.name),
    ...overriddenEnvKeys(overrides, container.name),
  ]);
  return Object.keys(container.environment).filter(
    (k) => !skip.has(k) && containsDynamicReference(container.environment[k])
  );
}

export function groupSecretsByContainer(
  resolved: ResolvedSecret[]
): Map<string, { name: string; value: string }[]> {
  const out = new Map<string, { name: string; value: string }[]>();
  for (const r of resolved) {
    const arr = out.get(r.containerName) ?? [];
    arr.push({ name: r.name, value: r.value });
    out.set(r.containerName, arr);
  }
  return out;
}

interface BuildDockerRunArgs {
  task: ResolvedEcsTask;
  container: ResolvedEcsContainer;
  image: string;
  network: string;
  volumeByName: Map<string, ResolvedEcsVolume & { dockerVolumeName?: string }>;
  secrets: { name: string; value: string }[];
  /**
   * `environment` keys holding a resolved CloudFormation dynamic reference
   * (issue #2056): passed value-less like a resolved secret, off the argv.
   */
  plaintextEnvKeys?: readonly string[];
  envOverrides: Record<string, Record<string, string | null> | undefined> | undefined;
  containerHost: string;
  roleArn: string | undefined;
  platformOverride: string | undefined;
  region: string | undefined;
  /**
   * Optional sidecar IP for the metadata-endpoints sidecar on this
   * task's docker network. Defaults to `169.254.170.2`; `cdkd local
   * start-service` overrides per replica so each replica's containers
   * point at their own sidecar instance.
   */
  sidecarIp?: string;
  /**
   * Issue #585 — when true, omit EVERY `-p <hostPort>:<containerPort>`
   * flag. Set by `cdkd local start-service` for multi-replica services
   * so the 2nd+ replica does not collide on a shared host port (see the
   * matching field on {@link RunEcsTaskOptions} for the full rationale).
   */
  skipHostPortPublish?: boolean;
  /**
   * Issue #460 — extra `--add-host name:ip` flag pairs forwarded
   * verbatim to `docker run`. Used by the Cloud Map overlay so
   * `<discoveryName>.<namespace>` (and bare ClientAlias short forms)
   * resolve inside this container. Caller is responsible for the
   * flag-pair shape (`['--add-host', 'name:ip', ...]`).
   */
  addHostFlags?: ReadonlyArray<string>;
  /**
   * Issue #460 / design § 5 Option A — extra `--network-alias <alias>`
   * values the runner adds to the `docker run` invocation. Used by
   * `cdkd local start-service` shared-network mode so peers can reach
   * this container by its Service Connect discoveryName / ClientAlias
   * / fqdn via docker's built-in DNS server. The container's
   * `--name`-derived alias is ALWAYS added (line 813); these are
   * additional aliases registered alongside it.
   */
  networkAliases?: ReadonlyArray<string>;
  /**
   * ECS analogue of the Lambda-container fix in PR #670 — bind-mounts
   * a host-side AWS shared credentials file (one `[<profileName>]`
   * INI section) read-only into the container and sets
   * `AWS_SHARED_CREDENTIALS_FILE` + `AWS_PROFILE` env vars so handler
   * code calling `fromIni({ profile })` resolves to the same creds
   * the metadata sidecar serves. When undefined (the default), no
   * mount / env vars are emitted — `--profile` is forwarded to the
   * sidecar only.
   */
  profileCredentialsFile?: { hostPath: string; containerPath: string; profileName: string };
}

/**
 * Build the full `docker run -d` argument list for one container.
 * Exported (no-leading-underscore) so the unit tests can assert against
 * the shape directly without spawning a process.
 */
export function buildDockerRunArgs(opts: BuildDockerRunArgs): {
  args: string[];
  /** The `--name` the container gets, known before `docker run` returns its id. */
  dockerName: string;
  sensitiveEnv: Record<string, string>;
  /** Secret names dropped because they name a docker-client var (issue #2183). */
  collisions: string[];
} {
  const { task, container, image, network, volumeByName, secrets, containerHost, roleArn } = opts;
  const args: string[] = ['run', '-d'];

  // Stable name so siblings can reach this container via DNS.
  const dockerName = `cdkd-local-${task.family}-${container.name}-${randHex(3)}`;
  args.push('--name', dockerName);
  args.push('--network', network);
  args.push('--network-alias', container.name);

  // Issue #460 / design § 5 Option A — extra `--network-alias` for
  // every Service Connect discoveryName / ClientAlias short-form /
  // fqdn this container should be reachable as. With a shared docker
  // network across all services in the CLI run, peers resolve any
  // alias via docker's built-in DNS server — no extra DNS sidecar
  // needed. De-duplicated against the `container.name` alias above.
  if (opts.networkAliases && opts.networkAliases.length > 0) {
    const seen = new Set<string>([container.name]);
    for (const a of opts.networkAliases) {
      if (!seen.has(a)) {
        args.push('--network-alias', a);
        seen.add(a);
      }
    }
  }

  // Issue #460 — Cloud Map / Service Connect overlay. The
  // `--add-host` flags here come from the in-process CloudMapRegistry
  // populated by the service runner after each peer replica boots.
  // Multi-replica routing is approximated as "first registered
  // endpoint per fqdn" — full multi-instance DNS rotation requires
  // the deferred DNS-sidecar option (§6 of the design).
  if (opts.addHostFlags && opts.addHostFlags.length > 0) {
    for (const f of opts.addHostFlags) args.push(f);
  }

  if (opts.platformOverride) {
    args.push('--platform', opts.platformOverride);
  } else if (task.runtimePlatform) {
    args.push(
      '--platform',
      task.runtimePlatform.cpuArchitecture === 'ARM64' ? 'linux/arm64' : 'linux/amd64'
    );
  }

  // Issue #585 — multi-replica services skip the host-port publish.
  // N replicas of one service all map the same container port; binding
  // a fixed host port makes the 2nd+ replica fail with `port is already
  // allocated`. Peer comms still works via container IP / network alias
  // on the shared docker network (production-like — real ECS Service
  // Connect tasks have per-task ENIs and never share a host port).
  if (!opts.skipHostPortPublish) {
    for (const pm of container.portMappings) {
      const hostPort = pm.hostPort ?? pm.containerPort;
      args.push('-p', `${containerHost}:${hostPort}:${pm.containerPort}/${pm.protocol}`);
    }
  }

  // PR #670 follow-up — bind-mount the host-side profile credentials
  // file read-only at the fixed in-container path so `fromIni({
  // profile })` handlers resolve to the same creds the sidecar
  // serves. The `:ro` flag is load-bearing: a compromised handler
  // must not be able to tamper with the host-side temp file. Set
  // BEFORE the user's own `MountPoints` so a (malformed) user mount
  // that targets `/cdkd-aws/credentials` doesn't shadow the creds
  // file — docker honors mount-order by container path uniqueness;
  // a later mount at the same target would fail or shadow.
  if (opts.profileCredentialsFile) {
    args.push(
      '-v',
      `${opts.profileCredentialsFile.hostPath}:${opts.profileCredentialsFile.containerPath}:ro`
    );
  }

  // Mounts: walk the container's `MountPoints` and look up the matching
  // volume to decide bind-mount vs docker volume.
  for (const mp of container.mountPoints) {
    const v = volumeByName.get(mp.sourceVolume);
    if (!v) continue;
    if (v.kind === 'host') {
      if (v.hostPath) {
        const ro = mp.readOnly ? ':ro' : '';
        args.push('-v', `${v.hostPath}:${mp.containerPath}${ro}`);
      } else {
        // Anonymous: only the container path, docker manages the volume.
        args.push('-v', mp.containerPath);
      }
    } else {
      const name = v.dockerVolumeName ?? v.name;
      const ro = mp.readOnly ? ':ro' : '';
      args.push('-v', `${name}:${mp.containerPath}${ro}`);
    }
  }

  // Env precedence (highest wins):
  //   1. function-specific `--env-vars` entry
  //   2. global `Parameters` `--env-vars` entry
  //   3. resolved secrets
  //   4. template literal env
  //   5. profile credentials file env (AWS_SHARED_CREDENTIALS_FILE / AWS_PROFILE)
  //   6. metadata sidecar env (sidecar URL / role URL)
  const finalEnv: Record<string, string> = {};
  const metaEnv = buildMetadataEnv({
    containerName: container.name,
    ...(roleArn !== undefined && { roleArn }),
    ...(opts.region !== undefined && { region: opts.region }),
    ...(opts.sidecarIp !== undefined && { sidecarIp: opts.sidecarIp }),
  });
  Object.assign(finalEnv, metaEnv);
  // PR #670 follow-up — point the container's SDK chain at the bind-
  // mounted credentials file so `fromIni({ profile })` calls inside
  // the handler resolve to the same creds. `AWS_PROFILE` makes
  // `fromIni()` (no explicit arg) ALSO use this profile. Sits ABOVE
  // template / secret / --env-vars overrides so a user template that
  // sets its own `AWS_PROFILE` (e.g. for a different in-container
  // chain) still wins.
  if (opts.profileCredentialsFile) {
    finalEnv['AWS_SHARED_CREDENTIALS_FILE'] = opts.profileCredentialsFile.containerPath;
    finalEnv['AWS_PROFILE'] = opts.profileCredentialsFile.profileName;
  }
  // Own-key defines, not `Object.assign` / `finalEnv[k] = v` (issue #3515):
  // these keys come from the template, and a `[[Set]]` of an own `__proto__`
  // key runs Object.prototype's setter, so the variable never reached the
  // container. The metadata / profile keys above are constants. A secret
  // named `__proto__` then travels value-less on the argv and through
  // `partitionSensitiveEnv`'s `sensitiveEnv`, which defines it as an own key.
  for (const [k, v] of Object.entries(container.environment)) defineOwnKey(finalEnv, k, v);
  for (const s of secrets) defineOwnKey(finalEnv, s.name, s.value);

  const overrides = opts.envOverrides;
  if (overrides) {
    applyOverrideMap(finalEnv, overrides['Parameters']);
    applyOverrideMap(finalEnv, overrides[container.name]);
  }

  // Split the resolved env into `-e` flags plus the values that must travel
  // through the spawn env (see `partitionSensitiveEnv`): a sensitive key — the
  // AWS credential set plus each resolved secret name — becomes a value-less
  // `-e KEY` (its value carried in `sensitiveEnv`, off the argv /
  // `/proc/<pid>/cmdline`), unless it NAMES a docker-client var or is a
  // MALFORMED env name (`isMalformedEnvKey` — empty, or containing `=` / NUL;
  // the environ NAME the OS parses would differ from the key the denylist
  // checked — #2186 rounds 4-5), in which case it gets no flag at all and is
  // reported in `collisions`. Mirrors `runDetached` in `docker-runner.ts`.
  const sensitiveKeys = new Set<string>([
    ...SENSITIVE_ENV_KEYS,
    ...secrets.map((s) => s.name),
    // A declared secret that `--env-vars` overrode was never fetched
    // (go-to-k/cdkd#5756), so it is absent from `secrets`; the value the
    // override supplies for it is still treated as a secret and kept off the argv.
    ...container.secrets.map((s) => s.name),
    // Same for a declared secret the resolver dropped (intrinsic ValueFrom, no
    // state source): an `--env-vars` value for it is still a secret.
    ...(container.droppedSecretNames ?? []),
    ...(opts.plaintextEnvKeys ?? []),
  ]);
  // `subject` names the container in the win32 letter-case warning (#2190).
  const { flags, sensitiveEnv, collisions } = partitionSensitiveEnv(finalEnv, sensitiveKeys, {
    subject: `Container '${container.name}'`,
  });
  args.push(...flags);

  if (container.user) args.push('--user', container.user);
  if (container.privileged) args.push('--privileged');
  if (container.readonlyRootFilesystem) args.push('--read-only');
  if (container.workingDirectory) args.push('--workdir', container.workingDirectory);
  for (const u of container.ulimits) {
    args.push('--ulimit', `${u.name}=${u.softLimit}:${u.hardLimit}`);
  }
  for (const link of container.links) args.push('--link', link);

  if (container.healthCheck) {
    args.push('--health-cmd', shellJoin(container.healthCheck.command));
    if (container.healthCheck.interval !== undefined) {
      args.push('--health-interval', `${container.healthCheck.interval}s`);
    }
    if (container.healthCheck.timeout !== undefined) {
      args.push('--health-timeout', `${container.healthCheck.timeout}s`);
    }
    if (container.healthCheck.retries !== undefined) {
      args.push('--health-retries', String(container.healthCheck.retries));
    }
    if (container.healthCheck.startPeriod !== undefined) {
      args.push('--health-start-period', `${container.healthCheck.startPeriod}s`);
    }
  }

  // EntryPoint maps the same way as docker — first item to --entrypoint,
  // the rest become positional args before CMD.
  let entryPointTail: string[] = [];
  if (container.entryPoint && container.entryPoint.length > 0) {
    args.push('--entrypoint', container.entryPoint[0]!);
    entryPointTail = container.entryPoint.slice(1);
  }

  args.push(image, ...entryPointTail, ...(container.command ?? []));
  return { args, dockerName, sensitiveEnv, collisions };
}

function applyOverrideMap(
  acc: Record<string, string>,
  map: Record<string, string | null> | undefined
): void {
  if (!map) return;
  for (const [k, v] of Object.entries(map)) {
    if (v === null) delete acc[k];
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      defineOwnKey(acc, k, String(v));
    }
  }
}

/**
 * Quote each arg for `docker --health-cmd`. Docker's healthcheck takes
 * a single string which is passed to `/bin/sh -c`, so multi-word commands
 * need to be space-joined. We escape single quotes / `$` characters to
 * avoid shell injection from CFn-supplied values.
 */
function shellJoin(parts: string[]): string {
  return parts
    .map((p) => {
      if (/^[A-Za-z0-9_\-./=:]+$/.test(p)) return p;
      return `'${p.replace(/'/g, "'\\''")}'`;
    })
    .join(' ');
}
