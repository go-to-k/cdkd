import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { getLogger } from '../../../utils/logger.js';
import { LocalMigrateError } from '../../../utils/error-handler.js';

/**
 * Input options for {@link spawnCdkMigrate}.
 *
 * The two stack names are intentionally distinct:
 *   - `stackName`     — the OUTPUT stack name baked into the generated
 *     CDK app (`--stack-name` to `cdk migrate`). Becomes the cdkd
 *     stack name post-migration.
 *   - `fromStackName` — the SOURCE CloudFormation stack name to adopt
 *     (`--from-stack --stack-name <name>` to `cdk migrate`, where the
 *     same `--stack-name` flag does double duty — name of the source
 *     when `--from-stack` is set, name of the output otherwise).
 *
 * Empirically (verified 2026-05-22 against cdk@2.1112.0) `cdk migrate
 * --from-stack` takes ONE `--stack-name` flag that serves as both the
 * source CFn stack name AND the output stack name. We re-use the same
 * value for both in PR A, but keep them separate in the options struct
 * because PR B may surface a `--output-stack-name` override.
 */
export interface CdkMigrateSpawnOptions {
  /** Name baked into the generated CDK app (the new stack identifier). */
  stackName: string;
  /** Source CloudFormation stack name to adopt. */
  fromStackName: string;
  /** Parent directory under which `cdk migrate` writes `<output>/<stackName>`. */
  outputPath: string;
  /** Generated-app language. v1 ships with TypeScript only. */
  language?: 'typescript';
  /** AWS region for the source CFn stack. Defaults to the SDK chain. */
  region?: string;
  /** AWS account id (forwarded to `cdk migrate --account`). Optional — `cdk` auto-detects. */
  account?: string;
  /** `--filter Key=Value` entries (repeatable). v1 surfaces as a pass-through. */
  filters?: string[];
  /** AWS profile name (forwarded as an env var so every later SDK client picks it up). */
  profile?: string;
  /** Path to the `cdk` binary. Defaults to `'cdk'` (PATH lookup). */
  cdkBinPath?: string;
  /**
   * Extra environment variables to merge into the subprocess env. Used to
   * thread STS-assumed credentials (the same `AWS_ACCESS_KEY_ID` /
   * `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` trio that PR B's
   * `--role-arn` flag will set) into the `cdk migrate` subprocess.
   */
  extraEnv?: NodeJS.ProcessEnv;
}

/**
 * Result of a successful {@link spawnCdkMigrate} invocation.
 *
 * `outputDir` is `<outputPath>/<stackName>` — the directory `cdk
 * migrate` actually populated. Captured stdout / stderr are returned
 * so PR B's orchestrator can re-emit them under a debug flag if
 * needed; the live-streaming behavior already routes the chunks
 * through cdkd's logger at info / warn for human-readable output.
 */
export interface CdkMigrateSpawnResult {
  outputDir: string;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `cdk migrate --from-stack` as a subprocess and stream its
 * output through cdkd's logger.
 *
 * Why subprocess (not Node module import): the upstream `cdk` CLI is
 * a bundled CommonJS app with no stable public API; pinning a
 * runtime-injected `aws-cdk-lib` from cdkd is impractical. Subprocess
 * isolation also gives us a clean failure boundary — non-zero exit
 * surfaces as {@link LocalMigrateError} with the captured streams
 * folded into the error message.
 *
 * Streaming is preferred over a buffered `execFile` because `cdk
 * migrate` emits progress lines (downloading the resource schema,
 * synthesizing the L1 code for each resource) that users expect to
 * see in real time. Captured streams are still returned for caller
 * inspection.
 */
export async function spawnCdkMigrate(
  opts: CdkMigrateSpawnOptions
): Promise<CdkMigrateSpawnResult> {
  const logger = getLogger();
  const cdkBin = opts.cdkBinPath ?? 'cdk';
  const language = opts.language ?? 'typescript';
  const outputDir = resolve(opts.outputPath, opts.stackName);

  const args: string[] = [
    'migrate',
    '--from-stack',
    '--stack-name',
    opts.fromStackName,
    '--output-path',
    opts.outputPath,
    '--language',
    language,
  ];
  if (opts.region) args.push('--region', opts.region);
  if (opts.account) args.push('--account', opts.account);
  if (opts.profile) args.push('--profile', opts.profile);
  for (const filter of opts.filters ?? []) {
    args.push('--filter', filter);
  }

  // Merge env in a deterministic order so explicit `extraEnv` wins.
  // Inherit the current process env (PATH, HOME, AWS_* defaults) and
  // overlay the caller's STS-assumed creds last.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(opts.extraEnv ?? {}),
  };

  logger.info(`[cdk-migrate] ${cdkBin} ${args.join(' ')}`);

  return await new Promise<CdkMigrateSpawnResult>((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';

    let child;
    try {
      child = spawn(cdkBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // `spawn` itself can fail synchronously when the binary is
      // missing (Node throws ENOENT). The verifyCdkCliAvailable
      // pre-flight should catch this earlier, but a defense-in-depth
      // typed rejection keeps the error path clean.
      const detail = err instanceof Error ? err.message : String(err);
      rejectPromise(
        new LocalMigrateError(
          `Failed to spawn '${cdkBin} migrate': ${detail}`,
          err instanceof Error ? err : undefined
        )
      );
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdout += text;
      // Strip trailing newlines so the logger does not double-space.
      const trimmed = text.replace(/\n$/, '');
      if (trimmed) logger.info(`[cdk-migrate] ${trimmed}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      const trimmed = text.replace(/\n$/, '');
      // `cdk migrate` writes progress notes to stderr; route them at
      // warn so they stay visible in compact output.
      if (trimmed) logger.warn(`[cdk-migrate] ${trimmed}`);
    });

    child.on('error', (err) => {
      rejectPromise(
        new LocalMigrateError(`'${cdkBin} migrate' subprocess error: ${err.message}`, err)
      );
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolvePromise({ outputDir, stdout, stderr });
        return;
      }
      const exitDetail =
        signal !== null ? `killed by signal ${signal}` : `exited with code ${code}`;
      rejectPromise(
        new LocalMigrateError(
          `'${cdkBin} migrate' ${exitDetail}.\n` +
            `--- stdout ---\n${stdout || '(empty)'}\n` +
            `--- stderr ---\n${stderr || '(empty)'}\n`
        )
      );
    });
  });
}
