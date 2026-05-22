import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MissingCdkCliError } from '../../../utils/error-handler.js';

const execFileAsync = promisify(execFile);

/**
 * Minimum aws-cdk CLI version where `cdk migrate --from-stack` is
 * considered stable (per the design doc at docs/design/465-cfn-migrate.md
 * §4 — "Version requirement"). Below this we WARN but do not block,
 * because users may have a working older release and a hard rejection
 * would be more disruptive than a warning.
 */
const RECOMMENDED_MIN_VERSION = '2.124.0';

/**
 * Result of {@link verifyCdkCliAvailable}.
 *
 * On success returns the parsed version string. When the version is
 * below the recommended minimum, `warn` is populated with a
 * human-readable hint so the caller can log it; the function never
 * hard-fails on an outdated-but-working CLI.
 */
export interface VerifyCdkCliResult {
  /** Version string returned by `cdk --version` (semver `MAJOR.MINOR.PATCH`). */
  version: string;
  /**
   * Set when the resolved version is older than the recommended minimum
   * ({@link RECOMMENDED_MIN_VERSION}). Empty / undefined when the version
   * meets or exceeds the floor.
   */
  warn?: string;
}

/**
 * Verify that the upstream `cdk` CLI is available on PATH (or at the
 * override path passed via `--cdk-bin`) and report its version.
 *
 * Hard-errors with {@link MissingCdkCliError} when `cdk` cannot be
 * spawned (ENOENT, permission denied, etc.). Emits a `warn` field on
 * the result when the version string is below the recommended minimum
 * — the caller decides how to surface it.
 *
 * `cdk --version` output format empirically (verified 2026-05-22
 * against cdk@2.1112.0): `<MAJOR.MINOR.PATCH> (build <id>)`. The
 * version is the first whitespace-separated token; the trailing
 * `(build <id>)` is informational and ignored.
 *
 * @param cdkBinPath - Path to the `cdk` binary. Defaults to `'cdk'`
 *   which uses the system PATH for resolution.
 */
export async function verifyCdkCliAvailable(cdkBinPath = 'cdk'): Promise<VerifyCdkCliResult> {
  let stdout: string;
  try {
    const result = await execFileAsync(cdkBinPath, ['--version']);
    stdout = result.stdout ?? '';
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MissingCdkCliError(
      `Failed to run '${cdkBinPath} --version': ${detail}`,
      err instanceof Error ? err : undefined
    );
  }

  const version = parseCdkVersion(stdout);
  if (!version) {
    throw new MissingCdkCliError(
      `'${cdkBinPath} --version' produced unexpected output: ${JSON.stringify(stdout.trim())}`
    );
  }

  if (compareSemver(version, RECOMMENDED_MIN_VERSION) < 0) {
    return {
      version,
      warn:
        `cdk CLI version ${version} is older than the recommended minimum ${RECOMMENDED_MIN_VERSION}. ` +
        `'cdkd migrate' relies on the stabilized 'cdk migrate --from-stack' flag; ` +
        `upgrade with 'npm install -g aws-cdk@latest' if you hit codegen issues.`,
    };
  }

  return { version };
}

/**
 * Parse the first semver-shaped token (`<MAJOR>.<MINOR>.<PATCH>`) out of
 * `cdk --version` stdout. Tolerates a trailing `(build <id>)` suffix.
 *
 * Returns `undefined` when no semver-shaped token is present so the
 * caller can surface the raw stdout in the error message.
 */
export function parseCdkVersion(stdout: string): string | undefined {
  const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/**
 * Compare two semver strings (`MAJOR.MINOR.PATCH`). Returns a negative
 * number when `a < b`, zero when `a === b`, positive when `a > b`.
 *
 * Strictly numeric comparison per component — no pre-release / build
 * suffix handling needed for this use case (`cdk --version` always
 * emits a stable `X.Y.Z` triple).
 */
function compareSemver(a: string, b: string): number {
  const aParts = a.split('.').map((n) => Number.parseInt(n, 10));
  const bParts = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const aN = aParts[i] ?? 0;
    const bN = bParts[i] ?? 0;
    if (aN !== bN) return aN - bN;
  }
  return 0;
}
