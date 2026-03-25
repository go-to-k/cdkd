/**
 * JSON Patch Generator for Cloud Control API
 *
 * Generates RFC 6902 compliant JSON Patch documents by comparing
 * previous and desired resource properties.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6902
 */

import { getLogger } from '../utils/logger.js';

/**
 * JSON Patch operation types
 */
export type PatchOperation = 'add' | 'remove' | 'replace' | 'test';

/**
 * JSON Patch operation
 */
export interface JsonPatchOp {
  op: PatchOperation;
  path: string;
  value?: unknown;
}

/**
 * JSON Patch Generator
 *
 * Creates minimal patch documents for Cloud Control API updates.
 */
export class JsonPatchGenerator {
  private logger = getLogger().child('JsonPatchGenerator');

  /**
   * Generate JSON Patch from property differences
   *
   * @param previousProperties - Previous resource properties
   * @param desiredProperties - Desired resource properties
   * @returns Array of JSON Patch operations
   */
  generatePatch(
    previousProperties: Record<string, unknown>,
    desiredProperties: Record<string, unknown>
  ): JsonPatchOp[] {
    const patches: JsonPatchOp[] = [];

    // Find added or changed properties
    for (const [key, value] of Object.entries(desiredProperties)) {
      const previousValue = previousProperties[key];

      if (previousValue === undefined) {
        // Property added
        patches.push({
          op: 'add',
          path: `/${this.escapeJsonPointer(key)}`,
          value,
        });
      } else if (!this.deepEqual(previousValue, value)) {
        // Property changed
        patches.push({
          op: 'replace',
          path: `/${this.escapeJsonPointer(key)}`,
          value,
        });
      }
      // else: no change, skip
    }

    // Find removed properties
    for (const key of Object.keys(previousProperties)) {
      if (!(key in desiredProperties)) {
        patches.push({
          op: 'remove',
          path: `/${this.escapeJsonPointer(key)}`,
        });
      }
    }

    this.logger.debug(`Generated ${patches.length} patch operations`);

    return patches;
  }

  /**
   * Generate a full replacement patch
   *
   * This is used as a fallback when property-level patching is not feasible.
   *
   * @param properties - Desired resource properties
   * @returns Single replace operation at root
   */
  generateFullReplacementPatch(properties: Record<string, unknown>): JsonPatchOp[] {
    return [
      {
        op: 'replace',
        path: '/',
        value: properties,
      },
    ];
  }

  /**
   * Escape JSON Pointer special characters
   *
   * Per RFC 6901, '~' and '/' must be escaped in JSON Pointer paths.
   *
   * @see https://datatracker.ietf.org/doc/html/rfc6901
   */
  private escapeJsonPointer(str: string): string {
    return str.replace(/~/g, '~0').replace(/\//g, '~1');
  }

  /**
   * Deep equality check for values
   *
   * Handles objects, arrays, primitives, null, and undefined.
   */
  private deepEqual(a: unknown, b: unknown): boolean {
    // Same reference or both null/undefined
    if (a === b) return true;

    // Different types
    if (typeof a !== typeof b) return false;

    // null comparison
    if (a === null || b === null) return false;

    // Array comparison
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, index) => this.deepEqual(item, b[index]));
    }

    // Object comparison
    if (typeof a === 'object' && typeof b === 'object') {
      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;

      const aKeys = Object.keys(aObj);
      const bKeys = Object.keys(bObj);

      if (aKeys.length !== bKeys.length) return false;

      return aKeys.every((key) => this.deepEqual(aObj[key], bObj[key]));
    }

    // Primitive comparison (already handled by a === b above, but for clarity)
    return false;
  }
}
