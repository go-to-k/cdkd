/**
 * `cdkd deploy --outputs-file` (AWS CDK CLI parity, go-to-k/cdkd#5819).
 *
 * The path is resolved here (CLI flag, then `outputsFile` in cdk.json); the
 * deploy command collects each stack's Outputs and calls
 * `writeStackOutputsFile` once every stack has finished. Values are the
 * DeployResult bag the console prints, which the engine has already redacted,
 * so the file carries no value the console would not show.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Option } from 'commander';
import { displayIdent } from '../../utils/display-safe.js';
import { CdkdError } from '../../utils/error-handler.js';
import { getLogger } from '../../utils/logger.js';
import { loadCdkJson } from '../config-loader.js';

export const outputsFileOption = new Option(
  '-O, --outputs-file <path>',
  'Path to a file where stack outputs will be written as JSON, keyed by stack name. Also read from "outputsFile" in cdk.json.'
);

/** Physical stack name → Output key → value. */
export type StackOutputsByStack = Record<string, Record<string, string>>;

/**
 * The path for this run: the flag, else cdk.json's top-level `outputsFile`
 * (where the AWS CDK CLI reads it), else none.
 */
export function resolveOutputsFile(
  cliValue: string | undefined,
  cdkJson: { outputsFile?: unknown } | null = loadCdkJson()
): string | undefined {
  if (cliValue !== undefined) return cliValue;
  const configured = cdkJson?.outputsFile;
  if (configured === undefined) return undefined;
  if (typeof configured === 'string' && configured !== '') return configured;
  throw new CdkdError(
    `cdk.json "outputsFile" must be a non-empty string, got: ${displayIdent(JSON.stringify(configured))}`,
    'INVALID_OUTPUTS_FILE'
  );
}

/**
 * CloudFormation reports every Output value as a string; the console prints
 * `String(value)`. A list joins with commas (a CommaDelimitedList's spelling)
 * and any other object is JSON, rather than `[object Object]`.
 */
export function toOutputValueString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => toOutputValueString(v)).join(',');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

/**
 * Writes the collected outputs, creating parent directories and replacing any
 * existing file. When the deploy itself failed (`deployFailed`), a write error
 * is only warned about so it does not mask the deploy's own error; the outputs
 * of the stacks that did deploy are still written, as the AWS CDK CLI intends.
 */
export function writeStackOutputsFile(
  path: string,
  outputs: StackOutputsByStack,
  options: { deployFailed: boolean }
): void {
  const target = resolve(path);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(outputs, null, 2)}\n`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Failed to write stack outputs to ${displayIdent(target)}: ${detail}`;
    if (options.deployFailed) {
      getLogger().warn(message);
      return;
    }
    throw new CdkdError(message, 'OUTPUTS_FILE_WRITE_FAILED');
  }
}
