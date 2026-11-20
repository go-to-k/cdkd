/**
 * Route 53 record-name comparison, an import-free LEAF: the provider and
 * `cdkd diff`'s provider-replacement mark (go-to-k/cdkd#6656) compare a
 * record's name through the same canonicalizer.
 */

/**
 * Octal escapes that must NOT be decoded, because decoding them is not
 * injective — two genuinely different names would compare EQUAL:
 *
 * - `056` is a period INSIDE a label. Route 53 reports the single-label
 *   record `a.b` (period escaped) as `a\\056b.example.com.`, which decodes to
 *   `a.b.example.com.` — identical to the different, two-label record
 *   `a.b.example.com`.
 * - `134` is a literal backslash, which would re-introduce escape ambiguity.
 *
 * A false MATCH is far worse than a false miss here: the compare drives which
 * record `readCurrentState` reports and which hosted zone `create` picks, so
 * collapsing two records would target the wrong one.
 */
export const UNDECODABLE_OCTAL_ESCAPES = new Set(['056', '134']);

/**
 * Canonicalize a record name for comparison.
 *
 * Two AWS-side spellings have to be absorbed, and missing either one makes
 * `readCurrentState` return `undefined` — which reads as "drift unknown"
 * rather than as an error:
 *
 * - Route 53 reports every name fully qualified with a TRAILING DOT, while a
 *   template may declare it either way.
 * - Special characters come back OCTAL-ESCAPED: `*.example.com` is reported as
 *   `\\052.example.com.`. That affects every wildcard record, including ones
 *   cdkd created itself, so decoding it here fixes drift for the whole
 *   population rather than only the imported ones.
 *
 * Known bound: Route 53 escapes per BYTE, so a non-ASCII name decodes to
 * latin-1 mojibake and will not match its template spelling. That is a false
 * MISS (drift unknown), never a false match, and CDK emits punycode for
 * internationalized names in practice.
 */
export function normalizeRecordName(name: string): string {
  // `\\ddd` -> the character it encodes. Strictly octal digits, and never the
  // structure-significant escapes above.
  const decoded = name.replace(/\\([0-7]{3})/g, (match, oct: string) =>
    UNDECODABLE_OCTAL_ESCAPES.has(oct) ? match : String.fromCharCode(parseInt(oct, 8))
  );
  // DNS is case-insensitive and AWS lowercases what it returns, so compare
  // lowercased. Without this a template spelling `Example.com` fails to match
  // the zone AWS reports as `example.com.` — which, on the delete path, now
  // resolves to "zone is gone" and would DROP the state row while leaving the
  // record live in AWS.
  const lowered = decoded.toLowerCase();
  return lowered.endsWith('.') ? lowered : `${lowered}.`;
}
