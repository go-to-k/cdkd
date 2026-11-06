import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  describeJsonParseFailure,
  parseFailureDebugDetail,
  utf8ByteLength,
} from '../../../utils/json-parse-failure.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import type { EnvOverrideFile } from '../../../local/env-resolver.js';
import { resolveInlineCodeFilePath } from '../local-invoke.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  applyCallerIdentityCredentials,
  AWS_CREDENTIAL_ENV_KEYS,
} from '../../../utils/caller-credentials.js';

/**
 * Materialize an inline Lambda body (`Code.ZipFile`) to a tmpdir and
 * return the directory the container should mount at /var/task.
 * Mirrors `cdkd local invoke`'s implementation; the only divergence is
 * the long-running-server lifecycle: every tmpdir created here is
 * recorded in `tmpDirsOut` so the caller's shutdown path can `rmSync`
 * them. (`cdkd local invoke` runs once and `--rm` is the right model;
 * `cdkd local start-api` lives across requests, so leaks compound.)
 */
export function materializeInlineCode(
  handler: string,
  source: string,
  fileExtension: string,
  tmpDirsOut: Set<string>
): string {
  const lastDot = handler.lastIndexOf('.');
  if (lastDot <= 0) {
    throw new Error(`Handler '${handler}' is malformed: expected '<modulePath>.<exportName>'.`);
  }
  const modulePath = handler.substring(0, lastDot);
  const dir = mkdtempSync(path.join(tmpdir(), 'cdkd-local-start-api-'));
  tmpDirsOut.add(dir);
  const filePath = resolveInlineCodeFilePath(dir, modulePath, fileExtension, handler);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, 'utf-8');
  return dir;
}

/** Pull `Properties.Environment.Variables` (when present). */
export function getTemplateEnv(resource: {
  Properties?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const props = resource.Properties ?? {};
  const env = props['Environment'];
  if (!env || typeof env !== 'object') return undefined;
  const vars = (env as Record<string, unknown>)['Variables'];
  if (!vars || typeof vars !== 'object') return undefined;
  return vars as Record<string, unknown>;
}

/** Read the SAM-shape `--env-vars` JSON file. */
export function readEnvOverridesFile(filePath: string | undefined): EnvOverrideFile | undefined {
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
  return parsed as EnvOverrideFile;
}

/**
 * Forward the developer's AWS credentials into the container so the
 * handler's AWS SDK calls can authenticate. Used when --assume-role is
 * NOT set for that Lambda — SAM-compatible default.
 *
 * Issue [#1843](https://github.com/go-to-k/cdkd/issues/1843): the two REGION
 * entries are folded through `canonicalizeRegion` on the way in and the
 * credentials are copied verbatim (an access key id is case-sensitive) — the
 * twin of `local-invoke.ts`'s `forwardAwsEnv`. The value becomes the
 * container's own `AWS_REGION`, and SDK endpoint resolution is case-sensitive.
 * Folded here as well as at the handler entry because this helper is exported
 * and must not depend on its caller having folded `process.env`.
 *
 * Exported for unit-test isolation (`local-container-caller-identity.test.ts`),
 * which drives the `--role-arn` cases without booting the API server.
 */
export function forwardAwsEnv(env: Record<string, string>): void {
  // The credential triple comes from `AWS_CREDENTIAL_ENV_KEYS` rather than a
  // local copy so this site and the fence that watches it cannot disagree about
  // the population (issue #3250 item 4 — the constant documented that guarantee
  // while nothing imported it). The two region keys are this command's own
  // concern and stay here.
  const passThrough = [...AWS_CREDENTIAL_ENV_KEYS, 'AWS_REGION', 'AWS_DEFAULT_REGION'] as const;
  const regionKeys = new Set<string>(['AWS_REGION', 'AWS_DEFAULT_REGION']);
  for (const key of passThrough) {
    const value = process.env[key];
    if (value === undefined) continue;
    env[key] = regionKeys.has(key) ? canonicalizeRegion(value) : value;
  }
  // Issue #3130: `applyRoleArnIfSet` OVERWRITES the three credential variables
  // above with a `--role-arn` assumed role's, so the copy that just ran would
  // hand every emulated handler cdkd's deploy role. Put the caller's own
  // identity back (or strip the triple when there was none to restore). A no-op
  // when no role was assumed.
  applyCallerIdentityCredentials(env);
}
