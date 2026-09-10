/**
 * `DeployEngine.maskedRecordRemedyFor` — the remedy clause of the masked-attribute
 * refusal, one case per `reads` SHAPE (issue
 * [#2847](https://github.com/go-to-k/cdkd/issues/2847), round-7 review).
 *
 * WHY THIS FILE EXISTS AS A SHAPE TABLE. `ResolverContext.redactedAttributeReads`
 * is heterogeneous — `noteAttributeSecrecy` writes `<LogicalId>.<Attribute>`,
 * `reresolveCrossStackValue` writes three cross-stack forms — and SIX successive
 * review rounds rewrote this remedy as prose that the reader was expected to
 * apply to whichever shape they had. Every rewrite was correct for the shape its
 * author had in mind and wrong for one they had not:
 *
 *  - interpolating the engine's own `logicalId` named the CONSUMER, so the
 *    advised `--force` re-import overwrote an innocent row;
 *  - "the name to the LEFT of the dot" yields `Outputs` for
 *    `nested stack Child Outputs.Foo` — and the charitable reading, `Child`, is
 *    a real template id the import typo guard ACCEPTS, so following it
 *    `--force`-overwrites that row while the mask (in the child's state) stays;
 *  - it yields `Cr.Endpoint` for the dotted attribute path
 *    `Cr.Endpoint.Password`;
 *  - and it has no referent at all for the `Fn::ImportValue` /
 *    `Fn::GetStackOutput` forms, whose only dots are sentence periods.
 *
 * The remedy is now COMPUTED, so the fence is a table over the shapes rather
 * than an assertion about one sentence. A new `reads` shape that this table has
 * no row for is the signal to extend the helper.
 *
 * The private static is reached through a cast rather than by driving a whole
 * deploy: what is under test is the STRING this function derives, and routing it
 * through the engine would let an unrelated failure mask a wrong derivation
 * (this repo's "call the private helper DIRECTLY" rule).
 */
import { describe, it, expect } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';

const remedyFor = (reads: readonly string[]): string =>
  (
    DeployEngine as unknown as {
      maskedRecordRemedyFor(reads: readonly string[]): string;
    }
  ).maskedRecordRemedyFor(reads);

/** The three cross-stack shapes `reresolveCrossStackValue` really writes. */
const IMPORT_VALUE = "Fn::ImportValue 'SharedDbSecret' (producer ProducerStack / us-east-1)";
const GET_STACK_OUTPUT = "Fn::GetStackOutput 'DbSecret' (producer ProducerStack / us-east-1)";
const NESTED_STACK = 'nested stack Child Outputs.Foo';

describe('maskedRecordRemedyFor — one arm per reads shape (issue #2847)', () => {
  it('names the GetAtt TARGET for the local shape, not the consumer', () => {
    const remedy = remedyFor(['Cr.Secret']);

    expect(remedy).toContain("'cdkd import <stack> --resource Cr=<physicalId> --force'");
    // The whole point of the round-6 fix: the consumer must not be advised.
    expect(remedy).not.toContain('Param');
    // And no cross-stack clause when nothing cross-stack is present.
    expect(remedy).not.toContain('ANOTHER stack');
  });

  it('takes the FIRST dot, so a dotted attribute path still yields the resource id', () => {
    // `Cr.Endpoint.Password` is a real pinned entry shape. A right-most read
    // would advise `--resource Cr.Endpoint=`, which is not a logical id.
    const remedy = remedyFor(['Cr.Endpoint.Password']);

    expect(remedy).toContain("--resource Cr=<physicalId>");
    expect(remedy).not.toContain('Cr.Endpoint=');
  });

  it.each([
    ['Fn::ImportValue', IMPORT_VALUE],
    ['Fn::GetStackOutput', GET_STACK_OUTPUT],
    ['nested stack Outputs', NESTED_STACK],
  ])('refuses to advise a local re-import for the %s shape', (_name, read) => {
    const remedy = remedyFor([read]);

    // No command at all — a `--resource` here cannot reach the other stack's
    // record, and advising one is what named a wrong-but-real id before.
    expect(remedy).not.toContain('cdkd import');
    expect(remedy).toContain('ANOTHER stack');
    expect(remedy).toContain('producer stack');
  });

  it('never advises the nested-stack shape as a local id, which the typo guard would ACCEPT', () => {
    // The specific trap: `Child` IS in the template, so a wrong instruction
    // here is executable rather than rejected.
    const remedy = remedyFor([NESTED_STACK]);

    expect(remedy).not.toContain('--resource Child=');
    expect(remedy).not.toContain('--resource Outputs=');
  });

  it('emits BOTH arms when the reads mix local and cross-stack entries', () => {
    const remedy = remedyFor(['Cr.Secret', IMPORT_VALUE]);

    expect(remedy).toContain("--resource Cr=<physicalId>");
    expect(remedy).toContain('ANOTHER stack');
  });

  it('de-duplicates repeated targets and names every distinct one', () => {
    const remedy = remedyFor(['Cr.Secret', 'Cr.Other', 'Db.Password']);

    // Both targets named, each once.
    expect(remedy).toContain('Cr, Db');
    expect(remedy.match(/\bCr\b/g)?.length).toBe(2); // once in the list, once in the command
  });
});
