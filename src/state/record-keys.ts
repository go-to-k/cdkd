/**
 * The ONE encoding anything that identifies a producer-side thing by a pair of
 * runtime strings goes through — a warned-once `Set`, a dedupe `Set`, a
 * memoization `Map`, a tree's node index.
 *
 * An import-free LEAF, the same shape as `src/utils/display-safe.ts` and
 * `src/utils/parameter-types.ts`, and that is load-bearing rather than tidy:
 * the consumers span the `cli`, `state` and `deployment` layers, and one of
 * them — `src/cli/commands/state-list-tree.ts` — is deliberately kept with NO
 * imports at all so the tree-building logic is unit-testable without mocking
 * anything. These functions previously lived in `malformed-resources-bag.ts`,
 * which reaches `error-handler` / `display-safe` / `lock-contention-message`,
 * and that module still RE-EXPORTS them so no existing importer moved.
 *
 * ENCODED, not separated. Issue
 * [#3308](https://github.com/go-to-k/cdkd/issues/3308) is the measurement
 * behind that and issue [#3323](https://github.com/go-to-k/cdkd/issues/3323)
 * is the one that found how far the class ran. Both halves of every key here
 * are attacker-influenced, and a separator only NARROWS a collision: with a
 * NUL separator, stack `Evil<NUL>us-east-1` in `ap-northeast-1` and stack
 * `Evil` in region `us-east-1<NUL>ap-northeast-1` produce the SAME key.
 *
 * `JSON.stringify` of a two-element array is injective over string pairs: the
 * quoting escapes anything that could imitate the separator, so no planted
 * value can produce another pair's key.
 *
 * **What a collision COSTS is per SITE, not a property of the key, and a note
 * here once claimed otherwise** — "one dropped warning LINE, never a wrong
 * resolution". That held for the two warned-once sets it was written for and
 * is false at three `cdkd scrub` sites, where a collision is a wrong ANSWER
 * feeding the pre-pass that decides whether a producer still holds plaintext.
 * Do not restore the narrower sentence: it reads as a licence to leave a
 * separator at a site nobody has re-checked.
 *
 * **Whether a separator was EVER injective is also per site**, because it
 * depends on each half's PROVENANCE. A half read out of an S3 key segment
 * cannot carry a NUL — measured on go-to-k/cdkd#3323, S3 refuses to store such
 * a key — so a key whose LEFT half is a segment splits uniquely at the FIRST
 * NUL. **The rule is two-sided and the dual is easy to miss**: a NUL-free
 * RIGHT half splits uniquely at the LAST one, which is what actually held at
 * one of the sites here. A half read out of a TEMPLATE or a state body is
 * gated by neither.
 *
 * Do not settle a site by asking whether the SEPARATOR is storable. That
 * question was asked twice on go-to-k/cdkd#3323 and gave the wrong answer both
 * times, in opposite directions. Encoding removes the need to ask at all,
 * which is why it is the fix rather than a wider separator.
 */

/** The ONE spelling of the encoding, private so no caller can re-derive it. */
function injectivePairKey(first: string, second: string): string {
  return JSON.stringify([first, second]);
}

/**
 * The same rule for a key of MORE than two parts.
 *
 * The named wrappers above stay, because a `(stack, region)` record and a
 * `(stack, export)` coordinate are things worth naming. This one is for the
 * keys that are just a tuple — an idempotency-token memo key, a resource-pair
 * edge — where a name would add nothing and a positional list is the honest
 * shape. It is exported rather than private for the same reason the two are:
 * so a call site can adopt the rule without re-spelling the encoding
 * (go-to-k/cdkd#3496).
 *
 * `number` is accepted because several of these tuples carry one, and
 * stringifying at the call site would put the coercion back where a caller can
 * get it wrong. `JSON.stringify` distinguishes `1` from `"1"`, so a mixed
 * tuple stays injective across the two.
 *
 * KNOWN HOLE in that, recorded rather than guarded: `NaN`, `Infinity` and
 * `-Infinity` all stringify to `null`, so those three collapse onto one key
 * and onto a literal `null`. No call site passes one — every numeric argument
 * today is a literal bound (`64`, `32`) — and a runtime refusal would turn a
 * key builder into a throwing path for a value that cannot arrive. Check this
 * note before passing a COMPUTED number.
 *
 * Note what this does to a DIGEST that hashes the result: the encoded string
 * carries no raw control character at all — `JSON.stringify` escapes a NUL to
 * the six-character text `\u0000` — so a hash input that separates this key
 * from its neighbours with a NUL is injective too, without the separator
 * having to be chosen carefully.
 */
export function injectiveKey(...parts: ReadonlyArray<string | number>): string {
  return JSON.stringify(parts);
}

/**
 * The key for a state RECORD: the `(stackName, region)` pair that names one
 * `state.json`.
 */
export function producerRecordKey(stackName: string, region: string): string {
  return injectivePairKey(stackName, region);
}

/**
 * The key for a producer COORDINATE: a `(stack, export-or-output name)` pair,
 * used by `cdkd scrub`'s re-export chain walk and its per-coordinate verdict
 * cache.
 *
 * A separate NAME because the subject is a different thing — a coordinate is
 * not a record, and a call site reading `producerRecordKey(stack, exportName)`
 * would say something false. ONE implementation, though, which is the property
 * the "one spelling" rule is actually about: two names over one implementation
 * cannot drift, two implementations can.
 *
 * An `exportName` is REDACTED on the way into state
 * (`StateImportEntry`'s JSDoc), so this half may hold any string at all.
 */
export function producerCoordinateKey(stackName: string, exportOrOutputName: string): string {
  return injectivePairKey(stackName, exportOrOutputName);
}
