import { readFileSync } from 'node:fs';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  describeJsonParseFailure,
  parseFailureDebugDetail,
  utf8ByteLength,
} from '../../../utils/json-parse-failure.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * Read the `--env-vars` JSON file using the same SAM-style shape as
 * `cdkd local invoke --env-vars`: top-level keys are container names, with
 * `Parameters` reserved for global entries.
 */
export function readEnvOverridesFile(
  filePath: string | undefined
): Record<string, Record<string, string | null> | undefined> | undefined {
  if (!filePath) return undefined;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read --env-vars file '${filePath}': ${describeAwsFailure(err).detail}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // V8's `SyntaxError` quotes a window of the file, which holds env values
    // (often secrets), so the message names only the failure's offset and
    // size; V8's text goes to `debug` only (issue #5254).
    getLogger().debug(safeMsg`--env-vars file failed to parse: ${parseFailureDebugDetail(err)}`);
    throw new Error(
      `Failed to parse --env-vars file '${filePath}' as JSON: ${describeJsonParseFailure(err, utf8ByteLength(raw))}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--env-vars file '${filePath}' must contain a JSON object at the top level.`);
  }
  return parsed as Record<string, Record<string, string | null> | undefined>;
}
