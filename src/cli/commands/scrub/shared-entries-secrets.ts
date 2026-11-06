import type { RecordedSecretValues } from '../../../deployment/secret-redaction.js';

/**
 * A secrets map with its OWN identity whose entries ARE `target`'s (issue
 * #2531): every read and write goes to `target`; nothing is stored here.
 *
 * The outputs pass resolves each `Export.Name` through one of these rather
 * than through the pass map itself. The resolver records the uncollapsed
 * `expression -> plaintext` PAIR beside each entry, keyed by the map INSTANCE
 * (`recordResolvedPair`), and a second write of one expression with a
 * different plaintext marks that pair conflicting — so a name's resolution
 * recording straight into the pass map could conflict the pair a literal
 * Output embedding the same token needs. Pairs recorded through this view
 * hang off THIS instance and are discarded with it (a name never positions a
 * leaf); the entries are the pass map's, live, in both directions.
 *
 * Live sharing rather than a private map with a copy: the resolver records
 * as it goes and `Fn::Join` resolves its parts concurrently, so a part that
 * rejects while a secret part is still pending ends the name's block before
 * that part records — a copy at the end of the block misses the late entry,
 * and a private map SEEDED from the pass map is a snapshot that a LATER
 * name's resolution would not see the late entry through either. Every
 * reader in the block (the cross-region pin, the cross-stack pre-pass, the
 * resolver, the masking of their messages) needs exactly what the pass map
 * holds at the moment it reads, which is what a view gives. (The deploy
 * engine's sibling block keeps its end-of-block copy and so still has the
 * late-entry hole — issue #2563.)
 *
 * TWO RESIDUALS of discarding what the view recorded, both bounded to the
 * choice of EXPRESSION and neither reaching a plaintext:
 *
 * - The pairs. A value leaf re-using the token records its own pair at the
 *   seam, which is what positions it — PROVIDED its own resolution succeeds.
 *   A value whose read through the PRIMARY resolver fails after the name's
 *   succeeded (that call sits in the value loop's best-effort catch) has no
 *   pair of its own and no name-recorded one to fall back on, so its leaf
 *   drops to the value scan (the #2485 shape, a sibling's spelling for a
 *   same-plaintext pair); the entry the name recorded is still a needle, so
 *   the plaintext is scrubbed either way — whole, at any length, when the
 *   leaf IS the plaintext (`redactSecretsForState`'s whole-value arm is
 *   unbounded and this pass hands it the raw pass map), and by the substring
 *   arm at `MIN_NEEDLE_LENGTH` or longer when the plaintext is EMBEDDED in a
 *   larger leaf; a shorter embedded one is the #2516 residual, which has
 *   nothing to do with the name loop. A failed read through the cross-region PIN
 *   is not a fallback at all: `unresolvableForeignScrubSecretError` refuses
 *   the whole scrub (`SCRUB_CROSS_REGION_SECRET_UNRESOLVED`), name loop or
 *   value loop.
 * - The cross-stack associations the pre-pass records
 *   (`recordCrossStackExpression`), keyed by instance the same way. They are
 *   recorded only for a plaintext ALREADY in the map (the resolver gates on
 *   `recordedSecretValues.has(...)`), so losing one degrades the expression a
 *   later leaf is positioned by, never whether the plaintext is found. No
 *   case pins this arm on its own.
 *
 * Every member of `Map.prototype` that reads or writes entries is overridden,
 * and a unit fence (`scrub-shared-entries-secrets.test.ts`) asserts that set
 * against the runtime's `Map.prototype` so a future addition (the stage-3
 * `getOrInsert` / `getOrInsertComputed`) cannot land on the permanently empty
 * backing store unnoticed — a needle inserted there would never reach the
 * pass map. `structuredClone` reads the internal slots the same way and is
 * equally unreachable from this file; a clone of a view would be an empty
 * `Map`.
 */
export class SharedEntriesSecrets extends Map<string, string> {
  private readonly target: RecordedSecretValues;

  constructor(target: RecordedSecretValues) {
    super();
    this.target = target;
  }

  override get size(): number {
    return this.target.size;
  }

  override get(plaintext: string): string | undefined {
    return this.target.get(plaintext);
  }

  override has(plaintext: string): boolean {
    return this.target.has(plaintext);
  }

  override set(plaintext: string, expression: string): this {
    this.target.set(plaintext, expression);
    return this;
  }

  override delete(plaintext: string): boolean {
    return this.target.delete(plaintext);
  }

  override clear(): void {
    this.target.clear();
  }

  override keys(): MapIterator<string> {
    return this.target.keys();
  }

  override values(): MapIterator<string> {
    return this.target.values();
  }

  override entries(): MapIterator<[string, string]> {
    return this.target.entries();
  }

  override forEach(
    callback: (value: string, key: string, map: Map<string, string>) => void,
    thisArg?: unknown
  ): void {
    this.target.forEach((value, key) => callback.call(thisArg, value, key, this));
  }

  override [Symbol.iterator](): MapIterator<[string, string]> {
    return this.target[Symbol.iterator]();
  }
}
