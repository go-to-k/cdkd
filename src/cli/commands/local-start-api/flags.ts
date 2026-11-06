import { getLogger } from '../../../utils/logger.js';
import { readMtlsMaterialsFromDisk, type MtlsServerConfig } from '../../../local/http-server.js';
import type { LocalStartApiOptions } from './types.js';

/**
 * Parse / clamp the `--per-lambda-concurrency` flag. Above-cap values
 * are clamped to 4 with a warn line (per the spec doc's risk-mitigation
 * row).
 */
export function parsePerLambdaConcurrency(raw: string): number {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--per-lambda-concurrency must be a positive integer (got '${raw}')`);
  }
  if (parsed > 4) {
    getLogger().warn(
      `--per-lambda-concurrency ${parsed} exceeds the v1 cap of 4; clamping to 4. (Raise this in a follow-up PR if your workload needs more.)`
    );
    return 4;
  }
  return parsed;
}

/** Validate `--debug-port-base`. */
export function parseDebugPort(raw: string): number {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`--debug-port-base must be 1..65535 (got '${raw}')`);
  }
  return parsed;
}

/**
 * Resolve the mTLS configuration from CLI options. Returns `undefined`
 * when none of the three `--mtls-*` flags is set (the server stays
 * plain-HTTP). When any of the three is set, ALL THREE must be set —
 * partial configurations are rejected at parse time so the server
 * never boots in a half-configured state.
 *
 * Exported for unit testing.
 */
export function resolveMtlsConfig(
  options: Pick<LocalStartApiOptions, 'mtlsTruststore' | 'mtlsCert' | 'mtlsKey'>
): MtlsServerConfig | undefined {
  const present: string[] = [];
  const absent: string[] = [];
  if (options.mtlsTruststore !== undefined && options.mtlsTruststore !== '') {
    present.push('--mtls-truststore');
  } else {
    absent.push('--mtls-truststore');
  }
  if (options.mtlsCert !== undefined && options.mtlsCert !== '') {
    present.push('--mtls-cert');
  } else {
    absent.push('--mtls-cert');
  }
  if (options.mtlsKey !== undefined && options.mtlsKey !== '') {
    present.push('--mtls-key');
  } else {
    absent.push('--mtls-key');
  }
  if (present.length === 0) return undefined;
  if (absent.length > 0) {
    throw new Error(
      `mTLS configuration is incomplete: ${present.join(', ')} set but ${absent.join(', ')} missing. ` +
        'All three of --mtls-truststore, --mtls-cert, and --mtls-key must be set together to enable mTLS, ' +
        'or all three left unset for plain HTTP.'
    );
  }
  // All three set — read the PEM materials from disk. Failures surface
  // a clear error naming the offending flag + path before the server
  // starts.
  return readMtlsMaterialsFromDisk({
    truststorePath: options.mtlsTruststore!,
    certPath: options.mtlsCert!,
    keyPath: options.mtlsKey!,
  });
}
