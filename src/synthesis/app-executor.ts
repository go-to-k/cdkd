import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getLogger } from '../utils/logger.js';
import { SynthesisError } from '../utils/error-handler.js';

/**
 * Options for CDK app execution
 */
export interface AppExecutorOptions {
  /** CDK app command (e.g., "npx ts-node app.ts") */
  app: string;

  /** Output directory for cloud assembly (default: "cdk.out") */
  outputDir: string;

  /** Context key-value pairs to pass to the app */
  context: Record<string, unknown>;

  /** AWS region */
  region?: string;

  /** AWS account ID */
  accountId?: string;
}

/** Cloud assembly schema version compatible with CDK v2 */
const CDK_ASM_VERSION = '38.0.0';

/** Maximum context size before overflow to temp file (32KB) */
const CONTEXT_OVERFLOW_LIMIT = 32 * 1024;

/**
 * Executes CDK app as subprocess to produce a cloud assembly
 */
export class AppExecutor {
  private logger = getLogger().child('AppExecutor');

  /**
   * Execute CDK app and produce cloud assembly in outputDir
   */
  async execute(options: AppExecutorOptions): Promise<void> {
    const { app, outputDir, context, region, accountId } = options;

    this.logger.debug('Executing CDK app:', app);
    this.logger.debug('Output directory:', outputDir);

    // Build environment variables
    const env: Record<string, string> = {
      ...process.env,
      CDK_OUTDIR: outputDir,
    };

    if (region) {
      env['CDK_DEFAULT_REGION'] = region;
    }
    if (accountId) {
      env['CDK_DEFAULT_ACCOUNT'] = accountId;
    }

    // Cloud assembly version and CLI version for compatibility
    env['CDK_CLI_ASM_VERSION'] = CDK_ASM_VERSION;
    env['CDK_CLI_VERSION'] = '2.1000.0';

    // Pass context via environment variable or temp file
    let contextTempDir: string | undefined;
    const contextJson = JSON.stringify(context);

    if (Buffer.byteLength(contextJson, 'utf-8') > CONTEXT_OVERFLOW_LIMIT) {
      // Context too large: write to temp file
      contextTempDir = mkdtempSync(join(tmpdir(), 'cdkd-context-'));
      const contextFile = join(contextTempDir, 'context.json');
      writeFileSync(contextFile, contextJson, 'utf-8');
      env['CONTEXT_OVERFLOW_LOCATION_ENV'] = contextFile;
      this.logger.debug('Context overflow: written to temp file');
    } else {
      env['CDK_CONTEXT_JSON'] = contextJson;
    }

    // Determine executable
    const commandLine = this.guessExecutable(app);
    this.logger.debug('Command line:', commandLine);

    try {
      await this.spawn(commandLine, env);
      this.logger.debug('CDK app execution completed');
    } finally {
      // Clean up temp context file
      if (contextTempDir) {
        try {
          rmSync(contextTempDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Determine how to execute the app command
   * - If it's a .js file, prepend node
   * - Otherwise execute as shell command
   */
  private guessExecutable(app: string): string {
    const trimmed = app.trim();

    // If it ends with .js, prepend the current node executable
    if (trimmed.endsWith('.js') || trimmed.split(/\s+/)[0]?.endsWith('.js')) {
      const parts = trimmed.split(/\s+/);
      parts[0] = `"${process.execPath}" "${parts[0]}"`;
      return parts.join(' ');
    }

    return trimmed;
  }

  /**
   * Spawn subprocess and wait for completion
   */
  private spawn(commandLine: string, env: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(commandLine, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        env,
        cwd: process.cwd(),
      });

      const stderrChunks: string[] = [];

      proc.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          this.logger.debug('[app stdout]', line);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          stderrChunks.push(line);
          // CDK bundling progress and warnings come through stderr
          this.logger.info(line);
        }
      });

      proc.on('error', (error) => {
        reject(new SynthesisError(`Failed to execute CDK app: ${error.message}`, error));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const stderr = stderrChunks.join('\n');
          reject(
            new SynthesisError(
              `CDK app exited with code ${code}${stderr ? `\n\nstderr:\n${stderr}` : ''}`
            )
          );
        }
      });
    });
  }
}
