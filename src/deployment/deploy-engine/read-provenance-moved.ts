/**
 * The deploy engine's READ-PROVENANCE skip term (state schema v12,
 * go-to-k/cdkd#4852): which top-level properties of an UPDATE row MOVED
 * although their redacted value equals the record.
 *
 * A `{{resolve:` token does not say which value it stood for, so a reader
 * served a NEWER generation of a value it reads (a queue replaced under a
 * rotated secret in an earlier, interrupted run) compares equal to its record
 * and would be skipped, keeping the deleted resource's id. A path is moved
 * when it holds a token at a READ-DERIVED leaf and this run's read-route
 * versions for that token are not a subset of the record's `readVersions`.
 *
 * - A literal-only leaf is exempt (a rotation alone sends nothing, as in
 *   CloudFormation): a path holds the token at a read-derived leaf when its
 *   redacted value holds it MORE often than its template spells it.
 * - A token served unresolved, or only on the literal route, has no read
 *   version this run: no verdict.
 * - A record with no field, or no `readVersions` for the token, gives no
 *   verdict: the go-to-k/cdkd#4851 rule decides alone.
 */
import { referenceProvenanceOf } from '../reference-provenance-record.js';
import { passReadVersionsFor } from '../secret-redaction/reference-provenance.js';
import type { RecordedSecretValues } from '../secret-redaction/pairs.js';

/** How often `token` occurs across `value`'s string leaves. */
function occurrences(value: unknown, token: string): number {
  if (typeof value === 'string') {
    return value.includes(token) ? value.split(token).length - 1 : 0;
  }
  if (Array.isArray(value)) {
    let n = 0;
    for (const item of value) n += occurrences(item, token);
    return n;
  }
  if (value !== null && typeof value === 'object') {
    let n = 0;
    for (const item of Object.values(value as Record<string, unknown>)) {
      n += occurrences(item, token);
    }
    return n;
  }
  return 0;
}

/** The moved paths, and the tokens that moved them (for the deploy's info line). */
export interface ReadProvenanceMoved {
  paths: Set<string>;
  tokens: string[];
}

export function readProvenanceMovedPaths(args: {
  /** The record as loaded. */
  record: unknown;
  /** The template's (unresolved) properties. */
  templateProperties: Record<string, unknown>;
  /** The resolved bag, redacted the way the skip check compares it. */
  desiredRedacted: Record<string, unknown>;
  /** This resolution's bag, whose pass provenance holds the read-route versions. */
  secrets: RecordedSecretValues | undefined;
}): ReadProvenanceMoved {
  const paths = new Set<string>();
  const tokens: string[] = [];
  const field = referenceProvenanceOf(args.record);
  if (field === undefined) return { paths, tokens };
  for (const [token, entry] of Object.entries(field)) {
    const recorded = entry.readVersions;
    if (recorded === undefined || recorded.length === 0) continue;
    const served = passReadVersionsFor(args.secrets, token);
    if (served === undefined) continue;
    if ([...served].every((version) => recorded.includes(version))) continue;
    let moved = false;
    for (const key of Object.keys(args.desiredRedacted)) {
      const held = occurrences(args.desiredRedacted[key], token);
      if (held === 0) continue;
      const spelled = Object.hasOwn(args.templateProperties, key)
        ? occurrences(args.templateProperties[key], token)
        : 0;
      if (held > spelled) {
        paths.add(key);
        moved = true;
      }
    }
    if (moved) tokens.push(token);
  }
  return { paths, tokens };
}
