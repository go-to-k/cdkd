import { runDockerStreaming } from '../utils/docker-cmd.js';

/**
 * Lower bound for `--add-host=<name>:host-gateway` support. The
 * `host-gateway` magic alias was introduced in Docker 20.10 (October
 * 2020) and is the load-bearing primitive cdkd uses to let Lambda
 * containers reach the host's `cdkd local start-api` server on Linux
 * native dockerd. Without it, the AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI
 * override fails with `ENOTFOUND host.docker.internal` at SDK-call time.
 *
 * Docker Desktop (macOS / Windows) ships `host.docker.internal` as
 * a built-in alias regardless of the engine version, but the probe
 * still fires there to keep the error path uniform — the `host-gateway`
 * flag itself is harmless on Docker Desktop.
 *
 * Issue #527 M2.
 */
export const HOST_GATEWAY_MIN_VERSION: ParsedDockerVersion = { major: 20, minor: 10, patch: 0 };

export interface ParsedDockerVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a Docker server version string (`20.10.21` / `24.0.7-rd` /
 * `27.3.1+podman` etc.) into a comparable `{major, minor, patch}` tuple.
 * Returns `null` on any unparseable input — the caller treats that as
 * "version unknown, skip the comparison and let the user proceed with
 * a warn" rather than hard-failing on a Docker-compatible CLI binary
 * that doesn't follow Docker's version-string conventions
 * (e.g. podman / finch).
 */
export function parseDockerVersion(raw: string): ParsedDockerVersion | null {
  const trimmed = raw.trim();
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(trimmed);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] !== undefined ? Number(match[3]) : 0,
  };
}

/**
 * Compare two `ParsedDockerVersion` tuples. Returns negative when `a <
 * b`, zero when equal, positive when `a > b`. Patch-level differences
 * are part of the ordering so a future bump (e.g. 20.10.0 -> 20.10.5
 * to fix a CVE-related regression) can be expressed if needed.
 */
export function compareDockerVersions(a: ParsedDockerVersion, b: ParsedDockerVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export interface HostGatewayProbeResult {
  /** Reported Docker server version string ("20.10.21" / "27.3.1" / etc.). */
  rawVersion: string;
  /** Parsed tuple, `null` when the raw string didn't match `<int>.<int>(.<int>)?`. */
  parsed: ParsedDockerVersion | null;
  /**
   * `true` when the parsed version is ≥ {@link HOST_GATEWAY_MIN_VERSION}
   * (or `null` parsed — see {@link parseDockerVersion} for the
   * unknown-version policy: defer to the warn path rather than hard-fail).
   */
  supported: boolean;
}

/**
 * Probe the Docker server's version to gate the `--add-host=...:host-gateway`
 * mapping that WebSocket Lambda containers need to reach the host
 * server. Issued ONCE per `cdkd local start-api` invocation at WebSocket
 * attach time — HTTP-only / REST-only sessions skip the probe entirely.
 *
 * Throws when:
 *   1. The docker subprocess itself fails (binary missing, daemon down,
 *      permission error) — the caller's catch surfaces the original
 *      error so the user knows to install / start Docker.
 *   2. The probe succeeds but the parsed version is < the supported
 *      minimum — caller decides whether to error or warn (the WebSocket
 *      attach loop errors; HTTP-only sessions never call this).
 *
 * Implementation: `docker version --format '{{.Server.Version}}'`
 * returns the daemon's version (not the client's) so a brand-new
 * client against an old daemon is still caught.
 */
export async function probeHostGatewaySupport(): Promise<HostGatewayProbeResult> {
  const result = await runDockerStreaming(['version', '--format', '{{.Server.Version}}'], {
    streamLive: false,
  });
  const rawVersion = result.stdout.trim();
  const parsed = parseDockerVersion(rawVersion);
  // Treat unparseable versions as "supported" — podman / finch /
  // nerdctl emit version strings cdkd can't always compare against
  // Docker's. Defer to the warn path rather than refuse the boot.
  const supported = parsed === null || compareDockerVersions(parsed, HOST_GATEWAY_MIN_VERSION) >= 0;
  return { rawVersion, parsed, supported };
}
