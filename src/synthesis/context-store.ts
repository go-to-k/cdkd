import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLogger } from '../utils/logger.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import {
  describeJsonParseFailure,
  jsonParseFailureDebugDetail,
  utf8ByteLength,
} from '../utils/json-parse-failure.js';
import { safeMsg } from '../utils/display-safe.js';
import { defineOwnKey } from '../utils/own-keys.js';

const CDK_CONTEXT_FILE = 'cdk.context.json';

/**
 * Manages reading and writing of cdk.context.json
 *
 * Context values resolved by context providers are persisted here
 * so they don't need to be re-fetched on subsequent synthesis runs.
 * Format is compatible with CDK CLI.
 */
export class ContextStore {
  private logger = getLogger().child('ContextStore');

  /**
   * Load context values from cdk.context.json
   *
   * @param cwd Working directory (default: process.cwd())
   * @returns Context key-value map, or empty object if file doesn't exist
   */
  load(cwd?: string): Record<string, unknown> {
    const filePath = resolve(cwd || process.cwd(), CDK_CONTEXT_FILE);

    if (!existsSync(filePath)) {
      this.logger.debug('No cdk.context.json found');
      return {};
    }

    let content: string | undefined;
    try {
      content = readFileSync(filePath, 'utf-8');
      const context = JSON.parse(content) as Record<string, unknown>;
      this.logger.debug(
        `Loaded ${Object.keys(context).length} context value(s) from cdk.context.json`
      );
      return context;
    } catch (error) {
      // V8's `SyntaxError` quotes a window of the file, so the warning names
      // only the failure's offset and size; V8's text goes to `debug` (issue
      // #5254). `content` is set exactly when the read succeeded.
      if (error instanceof SyntaxError && content !== undefined) {
        this.logger.debug(
          safeMsg`cdk.context.json failed to parse: ${jsonParseFailureDebugDetail(error)}`
        );
        this.logger.warn(
          safeMsg`Failed to parse cdk.context.json: ${describeJsonParseFailure(error, utf8ByteLength(content))}`
        );
        return {};
      }
      this.logger.warn(`Failed to parse cdk.context.json: ${describeAwsFailure(error).detail}`);
      return {};
    }
  }

  /**
   * Save resolved context values to cdk.context.json
   *
   * Merges with existing values. Transient values (errors) are excluded.
   *
   * @param updates Key-value pairs to save
   * @param cwd Working directory (default: process.cwd())
   */
  save(updates: Record<string, unknown>, cwd?: string): void {
    const filePath = resolve(cwd || process.cwd(), CDK_CONTEXT_FILE);

    // Load existing values
    const existing = this.load(cwd);

    // Merge, excluding transient values (provider errors)
    for (const [key, value] of Object.entries(updates)) {
      if (this.isTransient(value)) {
        this.logger.debug(`Skipping transient context value for key: ${key}`);
        continue;
      }
      // `defineOwnKey`, not `existing[key] = value`: `existing` is the parsed
      // file (or a `{}` literal), and a key named `__proto__` — ordinary in
      // the `JSON.parse`d manifest it came from — would otherwise replace the
      // record's prototype and vanish from the write (issue
      // [#3522](https://github.com/go-to-k/cdkd/issues/3522)).
      defineOwnKey(existing, key, value);
    }

    // Write back
    writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    this.logger.debug(`Saved ${Object.keys(updates).length} context value(s) to cdk.context.json`);
  }

  /**
   * Check if a context value is transient (should not be persisted)
   *
   * CDK CLI marks provider errors with $dontSaveContext: true
   */
  private isTransient(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    return (value as Record<string, unknown>)['$dontSaveContext'] === true;
  }
}
