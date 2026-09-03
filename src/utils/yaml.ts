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
 * runtime dependency. The emit options are the ones the AWS CDK CLI passes
 * for the same job (`@aws-cdk/toolkit-lib/lib/util/yaml-cfn.ts`:
 * `yaml.stringify(obj, { schema: 'yaml-1.1' })` with the fold width at 0), so
 * "CDK CLI compatible" is now produced by the library CDK CLI uses rather
 * than approximated.
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
 * The emit options, and the readers the output has to survive.
 *
 * `yaml-1.1` is what the AWS CDK CLI emits under, and it is the wider
 * resolver of the two: it also resolves `yes` / `no` / `on` / `off` and
 * timestamps, so emitting under it quotes the strings a 1.1 reader (`yq`)
 * would otherwise hand back as a boolean or a Date.
 *
 * It is NOT a superset of 1.2 core, which is why both are listed rather than
 * only the emitting one. 1.2 added `0o` octal, for which 1.1 has no resolver
 * — so `'0o17'` emits BARE under 1.1 and the default (1.2 core) reader hands
 * back the number 15. That was found by review rather than by enumeration,
 * which is exactly why the decision below is delegated to the library instead
 * of written out as a rule.
 *
 * Which makes the emitting schema NOT load-bearing for correctness, and it is
 * described that way rather than as a guarantee: the oracle already forces
 * quotes on anything EITHER reader would re-type, so the schema only decides
 * which of the two does the quoting. Measured 2026-09-03 — emitting the
 * `tests/integration/basic` template under `core` instead produces a
 * BYTE-IDENTICAL document, as do all 16 targeted probes (`yes` / `on` /
 * `2026-09-03` / `0o17` / `<<` / `012` / `0x1f` / `.inf` / ...), and the unit
 * suite stays 69/69 green. It is kept for parity with the CDK CLI's own
 * choice, and because it keeps the guarantee standing if the reader list is
 * ever narrowed.
 */
const EMIT_OPTIONS = { schema: 'yaml-1.1', lineWidth: 0, aliasDuplicateObjects: false } as const;
const READER_SCHEMAS = ['yaml-1.1', 'core'] as const;

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
      return parse(emitted, { schema }) === value;
    } catch {
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
      back = parse(emitted, { schema });
    } catch {
      return false;
    }
    if (back === null || typeof back !== 'object' || Array.isArray(back)) return false;
    const record = back as Record<string, unknown>;
    const keys = Object.keys(record);
    return keys.length === 1 && keys[0] === key && record[key] === probe;
  });
});

export function toYaml(obj: unknown): string {
  // `stringify` returns the JS value `undefined` — not a string — for an
  // input with no YAML representation, which among the inputs these two
  // consumers can produce means `undefined` itself. Keep the previous
  // rendering for it. (A function or a symbol THROWS instead of returning
  // undefined, so the fallback would not catch one; neither consumer can
  // produce either, both passing JSON-sourced data.)
  if (obj === undefined) return 'null\n';

  const doc = new Document(obj, EMIT_OPTIONS);

  // Force quotes on the scalars the round-trip oracle rejects, and leave
  // every other scalar the style the library chose — which is what keeps the
  // output CDK-CLI-shaped rather than quoting the whole template.
  visit(doc, {
    Scalar(key, node) {
      // A pair's KEY also arrives here, under the literal key `'key'`; it is
      // handled by the Pair visitor below, which asks the other question.
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
