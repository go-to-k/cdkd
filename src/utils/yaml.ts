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
 * runtime dependency. These are the same options the AWS CDK CLI passes for
 * the same job (`@aws-cdk/toolkit-lib/lib/util/yaml-cfn.ts`:
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
 * NOT the same job as `src/cli/yaml-cfn.ts`, which emits CFn intrinsics as
 * shorthand tags (`!Ref`) for `cdkd export` / `import`. `cdk synth` prints
 * the long form (`Fn::GetAtt`), and so does this.
 */
import { stringify as stringifyYaml } from 'yaml';

export function toYaml(obj: unknown): string {
  const out = stringifyYaml(obj, {
    // CDK CLI parity, and the wider of the two schemas: YAML 1.1 also
    // resolves `yes` / `no` / `on` / `off` and timestamps implicitly, so
    // emitting under it quotes the strings that a 1.1 reader (`yq`) would
    // otherwise hand back as a boolean or a Date. A 1.2 reader sees only
    // extra quotes, never a different value.
    schema: 'yaml-1.1',
    // No folding: a long ARN, a `Fn::Sub` body or the CDK `Analytics` blob
    // stays on one line.
    lineWidth: 0,
    // CFn does not understand YAML anchors, and a template holding the same
    // object twice by identity would otherwise emit `&a` / `*a` — the very
    // alias syntax this issue is about. `src/cli/yaml-cfn.ts` disables it for
    // the same reason.
    aliasDuplicateObjects: false,
  }) as string | undefined;
  // `stringify` returns the JS value `undefined` (not a string) for an input
  // it cannot represent as a document — `undefined` itself, a function, a
  // symbol. The declared return type does not say so. Keep the previous
  // rendering for those.
  return out ?? 'null\n';
}
