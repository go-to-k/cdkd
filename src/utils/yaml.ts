/**
 * JSON to YAML rendering (CDK CLI compatible output)
 *
 * Used by `synth` (CloudFormation template) and `list` (long output) for
 * human-friendly YAML rendering.
 *
 * Issue [#2421](https://github.com/go-to-k/cdkd/issues/2421): this was a
 * hand-rolled emitter whose "needs quoting" predicate covered four cases (an
 * embedded newline, a leading `{` / `[` / `"`, and the literals containing
 * `#` / empty / `true` / `false` / `null`). Every other YAML indicator was
 * emitted bare, so `AllowedOrigins: ['*']` rendered as `- *` — an alias node,
 * which a parser rejects with `BAD_ALIAS`. `cdkd synth` writes this output to
 * stdout, so `cdkd synth | yq` failed on the repo's own minimal fixture.
 *
 * The fix is a change of INSTRUMENT rather than a wider predicate: quoting a
 * YAML scalar correctly is a solved problem with an unbounded number of
 * spellings to get wrong one at a time, and the `yaml` package is already a
 * runtime dependency — the same library the AWS CDK CLI does this job with
 * (`@aws-cdk/toolkit-lib/lib/util/yaml-cfn.ts`: `yaml.stringify(obj, {
 * schema: 'yaml-1.1' })` at fold width 0). So "CDK CLI compatible" is now
 * produced by the library CDK CLI uses rather than approximated. The SCHEMA
 * differs from CDK CLI's deliberately; `EMIT_OPTIONS` below carries the
 * measurement and the reason, including the one input class whose rendering
 * that choice does change.
 *
 * Measured consequence on `tests/integration/basic` (2026-09-03): of 182
 * lines, only the defect and its mirror move — `- *` becomes `- "*"`, numbers
 * stop being emitted as strings (`ExpirationInDays: 90`, not `"90"`), numeric
 * STRINGS start being quoted (`schemaVersion: "2.2"`), and the document no
 * longer opens with a blank line. Indentation, key order and sequence style
 * are byte-identical to the hand-rolled output.
 *
 * One further contract change, recorded because it is silent rather than
 * because it is reachable: an `undefined` OBJECT VALUE is now OMITTED
 * (`{ a: undefined, b: 1 }` renders `b: 1`) where the hand-rolled emitter
 * wrote `a: null`. That matches what `JSON.stringify` does, so the YAML and
 * `--json` spellings of `cdkd list` agree, and neither consumer can produce
 * one today — `synth` passes assembly JSON, and `list`'s record is built with
 * `??` defaults.
 *
 * NOT the same job as `src/cli/yaml-cfn.ts`, which emits CFn intrinsics as
 * shorthand tags (`!Ref`) for `cdkd export` / `import`. `cdk synth` prints
 * the long form (`Fn::GetAtt`), and so does this.
 */
import { Document, Scalar, isScalar, parse, stringify, visit } from 'yaml';

/**
 * The emit options, and the READERS the output has to survive.
 *
 * The correctness here comes from `READER_SCHEMAS` — the oracle below quotes
 * anything EITHER reader would hand back changed — and NOT from the emitting
 * schema. That split matters, because neither schema resolves a superset of
 * the other:
 *
 * - 1.2 core added `0o` octal, for which 1.1 has no resolver, so `'0o17'`
 *   emitted bare under 1.1 would come back as the number 15 from a default
 *   reader — the finding that produced this oracle, and the reason the list
 *   is a list. It is currently INERT, because emitting under `core` means the
 *   library has already applied core's own resolvers: measured, dropping
 *   `'core'` from this list reds nothing while dropping `'yaml-1.1'` reds. It
 *   stays because the emit schema has already moved once in this file's
 *   history, and this list is what would keep the guarantee standing if it
 *   moves again;
 * - 1.1 resolves `yes` / `no` / `on` / `off` and timestamps, which 1.2 leaves
 *   alone, so those must be quoted for `yq`'s sake even though a 1.2 reader
 *   would not have re-typed them.
 *
 * Emitting under `core` rather than the CDK CLI's `yaml-1.1` is therefore a
 * deliberate choice and not a drift from parity, because 1.1 carries one tag
 * that DEFEATS the oracle: `<<` is the MERGE key, and its tag's `stringify`
 * returns the literal `<<` while ignoring the node's style, so the
 * `QUOTE_DOUBLE` the oracle sets on that key is silently discarded and
 * `{'<<': 'v'}` still emits `<<: v` — which a 1.1 reader rejects with `Merge
 * sources must be maps`. Under `core` there is no merge tag, the forced
 * quotes survive, and the output is `"<<": v`.
 *
 * Parity is preserved in fact rather than by the option name, and it was
 * MEASURED rather than argued (2026-09-03): with the oracle in place, both
 * this repo's real templates — `tests/integration/basic` and
 * `tests/integration/local-invoke` — render BYTE-IDENTICALLY under the two
 * schemas, as does every probe tried except `<<` itself. What changes is only
 * which layer does the quoting: under `core` the library emits `yes` bare and
 * the oracle quotes it; under 1.1 the library quoted it directly.
 *
 * This was found by a review round, after a first cut had `yaml-1.1` here and
 * a test suite that could not see the difference — the four-position
 * round-trip loop parses under 1.2, where `<<:` is an ordinary key, and the
 * 1.1 arm covered only the map-VALUE position. Both now run all four
 * positions under both readers.
 */
const EMIT_OPTIONS = { schema: 'core', lineWidth: 0, aliasDuplicateObjects: false } as const;
const READER_SCHEMAS = ['yaml-1.1', 'core'] as const;

/**
 * The oracle PARSES, and a parse can warn as well as throw — so the probe
 * reads have to be silenced or the probe becomes an output side effect.
 *
 * Measured: a date-shaped map KEY emits bare under `core`, and probing it
 * under the 1.1 reader resolves it to a `Date`, at which point `yaml` calls
 * `process.emitWarning` (`Keys with collection values will be stringified`).
 * That reached the real stderr — 254 bytes on a GREEN unit run, against this
 * repo's "a green run must print nothing" rule, and on `cdkd synth` for any
 * template carrying such a key. The oracle only ever reads the parsed VALUE,
 * so it has no use for the diagnostics at all.
 */
const READER_OPTIONS = { logLevel: 'silent' } as const;

/**
 * Templates repeat their scalars heavily (`AWS::S3::Bucket`, a region, a
 * logical id), and each miss costs one emit plus one parse per reader. Keyed
 * by the exact string, and the wrapped predicates are pure functions of it.
 */
function memoize(fn: (value: string) => boolean): (value: string) => boolean {
  const cache = new Map<string, boolean>();
  return (value: string): boolean => {
    const hit = cache.get(value);
    if (hit !== undefined) return hit;
    const result = fn(value);
    cache.set(value, result);
    return result;
  };
}

/**
 * Would this string, emitted plain, come back as the same string from EVERY
 * reader above?
 *
 * The library answers it, for both resolvers, rather than a predicate spelled
 * out here. The defect being fixed WAS a hand-written must-quote list missing
 * entries, and a second list with two more entries on it is the same artifact
 * with the same failure mode; asking whether the value survives the trip has
 * no spellings to miss.
 *
 * There are two of these because position decides the question. A string can
 * be special as a KEY while ordinary as a value: `<<` is the merge key under
 * 1.1, so `{'<<': 'v'}` emitted plain makes a 1.1 reader fail with `Merge
 * sources must be maps`, while a bare `<<` in value position is just a
 * string.
 */
const valueRoundTripsPlain = memoize((value: string): boolean => {
  const emitted = stringify(value, EMIT_OPTIONS);
  return READER_SCHEMAS.every((schema) => {
    try {
      return parse(emitted, { schema, ...READER_OPTIONS }) === value;
    } catch {
      // Defensive, and measured as such rather than assumed: no probe has
      // reached it — 0 hits over 461 strings x both readers in review — as the
      // library does not emit a plain VALUE scalar that fails to parse. It
      // stays so that a future library change degrades into quoting rather
      // than into a thrown error, and it is called out because no test can
      // fence it — the KEY oracle's identical-looking catch below is the
      // opposite, and IS fenced.
      return false;
    }
  });
});

const keyRoundTripsPlain = memoize((key: string): boolean => {
  // The probe value is irrelevant to the question but must survive it, so it
  // is a plain string with nothing special in it.
  const probe = 'cdkd-probe';
  const emitted = stringify({ [key]: probe }, EMIT_OPTIONS);
  return READER_SCHEMAS.every((schema) => {
    let back: unknown;
    try {
      back = parse(emitted, { schema, ...READER_OPTIONS });
    } catch {
      // LOAD-BEARING, unlike its twin above: this is the path `<<` takes.
      // Under a 1.1 reader `<<: v` throws `Merge sources must be maps`, and
      // that throw is the whole signal that the key needs quoting. Flipping
      // this to `true` reds the suite.
      return false;
    }
    if (back === null || typeof back !== 'object' || Array.isArray(back)) return false;
    const record = back as Record<string, unknown>;
    const keys = Object.keys(record);
    return keys.length === 1 && keys[0] === key && record[key] === probe;
  });
});

export function toYaml(obj: unknown): string {
  // No `undefined` special case: `new Document(undefined).toString()` already
  // yields `null\n`, which is what the hand-rolled emitter returned. (An
  // earlier revision guarded it, because the flat `stringify` call it then
  // used returns the JS value `undefined` rather than a string. The Document
  // form does not, and the guard was dead.) A function or a symbol THROWS at
  // this point either way; neither consumer can produce one, both passing
  // JSON-sourced data.
  const doc = new Document(obj, EMIT_OPTIONS);

  // Force quotes on the scalars the round-trip oracle rejects, and leave
  // every other scalar the style the library chose — which is what keeps the
  // output CDK-CLI-shaped rather than quoting the whole template.
  visit(doc, {
    Scalar(key, node) {
      // A pair's KEY also arrives here, under the literal key `'key'`; it is
      // handled by the Pair visitor below, which asks the other question.
      // Measured NOT load-bearing (removing it reds nothing; the key oracle's
      // own structural guards below are unprobed in the same way): both oracles
      // only ever ADD quotes, and they disagree on no string in either
      // direction except `<<`, where the Pair visitor is the stricter one and
      // runs anyway. It stays because it expresses which question owns which
      // position, and because it halves the oracle calls on every key.
      if (key === 'key') return;
      if (typeof node.value === 'string' && !valueRoundTripsPlain(node.value)) {
        node.type = Scalar.QUOTE_DOUBLE;
      }
    },
    Pair(_, pair) {
      const { key } = pair;
      if (isScalar(key) && typeof key.value === 'string' && !keyRoundTripsPlain(key.value)) {
        key.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });

  return doc.toString(EMIT_OPTIONS);
}
