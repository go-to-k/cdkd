/**
 * `--tags KEY=VALUE` on `cdkd deploy` / `cdkd diff` (AWS CDK CLI parity,
 * go-to-k/cdkd#6886), and on `cdkd import` / `cdkd export`, which resolve the
 * stack tags as a deploy does (go-to-k/cdkd#6909).
 *
 * The AWS CDK CLI's `cdk deploy --tags` (alias `-t`, repeatable, marked
 * deprecated in its help: tags belong in the cloud assembly) REPLACES the
 * stack's own tags for every selected stack when at least one tag is given:
 * toolkit-lib passes `options.tags?.length ? options.tags : tagsForStack(stack)`.
 * Its value also comes from the top-level `"tags"` key of cdk.json, a
 * `[{Key, Value}]` list, the flag winning. Its parser splits each argument at
 * the first `=` and warns about (and drops) one without `=`; empty strings
 * are ignored, and a flag given only empty strings keeps each stack's own
 * tags without falling back to cdk.json. Each `-t` takes ONE value
 * (yargs `nargs: 1`), so `-t A=1 MyStack` still selects `MyStack`.
 *
 * CloudFormation refuses an empty tag key or value (`Member must have length
 * greater than or equal to 1`, measured 2026-11-24), so cdkd refuses them up
 * front; for a repeated key the LAST value is the one CloudFormation keeps
 * (measured the same day), as here.
 *
 * `cdkd diff` takes the same flag (the CDK CLI's diff has none) so its
 * preview shows the tags `cdkd deploy --tags` would apply.
 */
import { Option } from 'commander';
import { CdkdError } from '../../utils/error-handler.js';
import { displayIdent } from '../../utils/display-safe.js';
import { defineOwnKey, nullPrototypeRecord } from '../../utils/own-keys.js';
import { loadCdkJson } from '../config-loader.js';
import { collectRepeated } from '../options.js';

export const stackTagsOption = new Option(
  '-t, --tags <key=value>',
  'Tags to add to the stack (KEY=VALUE, can be specified multiple times), overriding the ' +
    'stack tags from the cloud assembly (StackProps.tags) for every selected stack. ' +
    'Deprecated in the AWS CDK CLI: set StackProps.tags instead. Also read from "tags" in cdk.json.'
).argParser(collectRepeated);

function invalid(message: string): CdkdError {
  return new CdkdError(message, 'INVALID_TAGS');
}

function checkPair(key: string, value: string, source: string): void {
  if (key === '' || value === '') {
    throw invalid(
      `${source}: a tag needs a non-empty key and value (CloudFormation refuses an empty one), got ${displayIdent(`${key}=${value}`)}`
    );
  }
}

/**
 * The tags `--tags` arguments name: `undefined` when they name none (no flag,
 * or only non-assignments), so cdk.json's `"tags"` applies; an EMPTY map when
 * the flag held only empty strings, which keeps each stack's own tags (the
 * CDK CLI's `[]`). An argument without `=` is passed to `warn` and dropped,
 * as the CDK CLI does.
 */
export function parseTagsArgs(
  args: readonly string[] | undefined,
  warn: (line: string) => void
): Record<string, string> | undefined {
  if (args === undefined || args.length === 0) return undefined;
  const tags = nullPrototypeRecord<string>();
  if (args.every((arg) => arg === '')) return tags;
  let count = 0;
  for (const arg of args) {
    if (arg === '') continue;
    const eq = arg.indexOf('=');
    if (eq < 0) {
      warn(`Tags argument is not an assignment (key=value): ${displayIdent(arg)}`);
      continue;
    }
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    checkPair(key, value, '--tags');
    defineOwnKey(tags, key, value);
    count++;
  }
  return count > 0 ? tags : undefined;
}

/** cdk.json's top-level `"tags"` (`[{Key, Value}]`), or `undefined` when absent or empty. */
function cdkJsonTags(configured: unknown): Record<string, string> | undefined {
  if (configured === undefined) return undefined;
  if (!Array.isArray(configured)) {
    throw invalid(
      `cdk.json "tags" must be a list of {"Key": ..., "Value": ...}, got: ${displayIdent(JSON.stringify(configured))}`
    );
  }
  const tags = nullPrototypeRecord<string>();
  for (const entry of configured as unknown[]) {
    const key = (entry as { Key?: unknown } | null)?.Key;
    const value = (entry as { Value?: unknown } | null)?.Value;
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw invalid(
        `cdk.json "tags" entries must be {"Key": string, "Value": string}, got: ${displayIdent(JSON.stringify(entry))}`
      );
    }
    checkPair(key, value, 'cdk.json "tags"');
    defineOwnKey(tags, key, value);
  }
  return configured.length > 0 ? tags : undefined;
}

/**
 * The stack tags this run sets in place of each stack's own: the `--tags`
 * flag, else cdk.json's `"tags"`, else `undefined` (each stack keeps its
 * cloud-assembly tags, as it does for an empty answer:
 * `tags?.length ? tags : tagsForStack(stack)`).
 */
export function resolveStackTagsOverride(
  cliArgs: readonly string[] | undefined,
  warn: (line: string) => void,
  cdkJson: { tags?: unknown } | null = loadCdkJson()
): Record<string, string> | undefined {
  const tags = parseTagsArgs(cliArgs, warn) ?? cdkJsonTags(cdkJson?.tags);
  return tags !== undefined && Object.keys(tags).length > 0 ? tags : undefined;
}
