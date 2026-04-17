import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLogger } from '../utils/logger.js';

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

    try {
      const content = readFileSync(filePath, 'utf-8');
      const context = JSON.parse(content) as Record<string, unknown>;
      this.logger.debug(`Loaded ${Object.keys(context).length} context value(s) from cdk.context.json`);
      return context;
    } catch (error) {
      this.logger.warn(
        `Failed to parse cdk.context.json: ${error instanceof Error ? error.message : String(error)}`
      );
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
      existing[key] = value;
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
