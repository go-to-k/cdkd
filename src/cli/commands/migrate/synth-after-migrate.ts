import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LocalMigrateError } from '../../../utils/error-handler.js';
import { getLogger } from '../../../utils/logger.js';

/**
 * Options for {@link installGeneratedAppDeps}.
 */
export interface InstallGeneratedAppDepsOptions {
  /** Skip the `npm install` step entirely (CI with a pre-populated cache). */
  skipInstall?: boolean;
}

/**
 * Options for {@link synthGeneratedApp}.
 */
export interface SynthGeneratedAppOptions {
  /**
   * Skip the `cdk synth` step. When set, the function still returns
   * the expected assembly directory path so the caller's downstream
   * pipeline has a stable shape, but `templateBody` is `null` because
   * no synthesis ran.
   */
  skipSynth?: boolean;
  /** Path to the `cdk` binary. Defaults to `'cdk'` (PATH lookup). */
  cdkBinPath?: string;
  /**
   * Extra env vars merged into the subprocess env. Used to thread
   * STS-assumed credentials and `AWS_REGION` into the `cdk synth`
   * subprocess so context providers that hit AWS resolve under the
   * same identity as the rest of the migration.
   */
  extraEnv?: NodeJS.ProcessEnv;
}

/**
 * Result of {@link synthGeneratedApp}.
 *
 * `assemblyDir` is the conventional `<outputDir>/cdk.out` path; it is
 * returned regardless of `skipSynth` so callers can pass it straight
 * to the import phase (PR B) without branching on whether synth ran.
 *
 * `templateBody` is the parsed root-stack template (the
 * `<outputDir>/cdk.out/<StackName>.template.json` blob); `null` when
 * `skipSynth: true` or when synth ran but no matching template was
 * produced (the latter is a defensive fallback — `cdk synth` always
 * emits one).
 */
export interface SynthGeneratedAppResult {
  assemblyDir: string;
  templateBody: unknown;
}

/**
 * Run `npm install` inside the generated CDK app directory so the
 * `cdk synth` step (which dynamically loads `aws-cdk-lib`) has its
 * dependencies in place.
 *
 * Skippable via `skipInstall: true` — CI users with a pre-populated
 * node_modules cache can save the ~30s `npm install` round-trip.
 *
 * Streams stdout / stderr through cdkd's logger so users see progress
 * for the often-slow npm step. Non-zero exit surfaces as a typed
 * {@link LocalMigrateError} with the captured streams folded into
 * the error message.
 */
export async function installGeneratedAppDeps(
  outputDir: string,
  opts: InstallGeneratedAppDepsOptions
): Promise<void> {
  const logger = getLogger();
  if (opts.skipInstall) {
    logger.info(`[cdk-migrate] Skipping 'npm install' (--skip-install).`);
    return;
  }

  // Guard the path — surfacing a typed error is friendlier than the
  // raw ENOENT spawn rejection.
  const absDir = resolve(outputDir);
  if (!existsSync(absDir)) {
    throw new LocalMigrateError(
      `Generated app directory '${absDir}' does not exist; cannot run 'npm install'.`
    );
  }

  logger.info(`[cdk-migrate] Running 'npm install' in ${absDir}...`);
  await runStreamingCommand('npm', ['install'], absDir, undefined, "'npm install'");
}

/**
 * Run `cdk synth --quiet` inside the generated CDK app directory and
 * return both the assembly dir path and the parsed root-stack
 * template.
 *
 * `--quiet` suppresses the noisy template echo that `cdk synth`
 * defaults to on stdout — we read the template from disk
 * (`cdk.out/<StackName>.template.json`) instead.
 *
 * Skippable via `skipSynth: true` — useful when PR B's orchestrator
 * needs the codegen output without running synth (e.g. preview /
 * dry-run modes).
 */
export async function synthGeneratedApp(
  outputDir: string,
  opts: SynthGeneratedAppOptions
): Promise<SynthGeneratedAppResult> {
  const logger = getLogger();
  const absDir = resolve(outputDir);
  const assemblyDir = join(absDir, 'cdk.out');

  if (opts.skipSynth) {
    logger.info(`[cdk-migrate] Skipping 'cdk synth' (--skip-synth).`);
    return { assemblyDir, templateBody: null };
  }

  if (!existsSync(absDir)) {
    throw new LocalMigrateError(
      `Generated app directory '${absDir}' does not exist; cannot run 'cdk synth'.`
    );
  }

  const cdkBin = opts.cdkBinPath ?? 'cdk';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(opts.extraEnv ?? {}),
  };

  logger.info(`[cdk-migrate] Running '${cdkBin} synth --quiet' in ${absDir}...`);
  await runStreamingCommand(cdkBin, ['synth', '--quiet'], absDir, env, `'${cdkBin} synth'`);

  // Locate the root-stack template. `cdk synth` writes
  // `<StackName>.template.json` under `cdk.out/`. There may be
  // additional sibling assets / nested-assembly subdirs; the
  // root-stack template is identified by the `.template.json`
  // extension at the top level of `cdk.out/`.
  if (!existsSync(assemblyDir)) {
    throw new LocalMigrateError(
      `'cdk synth' completed but produced no '${assemblyDir}' directory.`
    );
  }
  const templates = readdirSync(assemblyDir).filter((f) => f.endsWith('.template.json'));
  if (templates.length === 0) {
    // Defensive fallback — `cdk synth` always emits at least one
    // template, but we don't want the migration to hard-fail on a
    // missing artifact when the caller's flow can still use the
    // assembly dir.
    return { assemblyDir, templateBody: null };
  }

  // Prefer the largest template (root stack is typically the largest;
  // nested-assembly templates are smaller manifests). The migration
  // command operates on a single source CFn stack so there is exactly
  // one top-level template in practice.
  const templatePath = join(assemblyDir, templates[0]!);
  let templateBody: unknown;
  try {
    const raw = readFileSync(templatePath, 'utf-8');
    templateBody = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LocalMigrateError(
      `Failed to parse generated template '${templatePath}': ${detail}`,
      err instanceof Error ? err : undefined
    );
  }

  return { assemblyDir, templateBody };
}

/**
 * Helper — spawn a subprocess in the given working directory, stream
 * its output through cdkd's logger, and reject with a typed
 * {@link LocalMigrateError} on non-zero exit.
 *
 * Factored out so the `npm install` and `cdk synth` call sites use the
 * same shape; both expose progress to the user and surface failures
 * with the captured streams.
 */
async function runStreamingCommand(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  label: string
): Promise<void> {
  const logger = getLogger();
  return await new Promise<void>((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';

    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      rejectPromise(
        new LocalMigrateError(
          `Failed to spawn ${label}: ${detail}`,
          err instanceof Error ? err : undefined
        )
      );
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdout += text;
      const trimmed = text.replace(/\n$/, '');
      if (trimmed) logger.info(`[${label}] ${trimmed}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      const trimmed = text.replace(/\n$/, '');
      if (trimmed) logger.warn(`[${label}] ${trimmed}`);
    });

    child.on('error', (err) => {
      rejectPromise(new LocalMigrateError(`${label} subprocess error: ${err.message}`, err));
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const exitDetail =
        signal !== null ? `killed by signal ${signal}` : `exited with code ${code}`;
      rejectPromise(
        new LocalMigrateError(
          `${label} ${exitDetail}.\n` +
            `--- stdout ---\n${stdout || '(empty)'}\n` +
            `--- stderr ---\n${stderr || '(empty)'}\n`
        )
      );
    });
  });
}
