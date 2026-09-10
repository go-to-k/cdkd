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
 *    `nested stack Child Outputs.Foo`, and the charitable reading `Child` sends
 *    the user at a record that is not there (the mask is in the CHILD's state,
 *    and `NestedStackProvider` implements no `import()` at all);
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

const remedyFor = (
  reads: readonly string[],
  resources: Record<string, { resourceType?: string }> = {}
): string =>
  (
    DeployEngine as unknown as {
      maskedRecordRemedyFor(
        reads: readonly string[],
        resources: Record<string, { resourceType?: string }>
      ): string;
    }
  ).maskedRecordRemedyFor(reads, resources);

/** A state map in which `<id>` is a nested stack. */
const nested = (id: string) => ({ [id]: { resourceType: 'AWS::CloudFormation::Stack' } });

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
    expect(remedy).toContain('One of the reads above resolves');

    // No command at all — a `--resource` here cannot reach the other stack's
    // record, and advising one is what named a wrong-but-real id before.
    expect(remedy).not.toContain('cdkd import');
    expect(remedy).toContain('ANOTHER stack');
    expect(remedy).toContain('producer stack');
  });

  it('numbers the cross-stack sentence by the FOREIGN count, not the local one', () => {
    // Keyed to the local arm, two foreign reads rendered "The read above
    // resolves" while the message had just listed both.
    expect(remedyFor([IMPORT_VALUE, GET_STACK_OUTPUT])).toContain(
      'Some of the reads above resolve through'
    );
    expect(remedyFor([IMPORT_VALUE])).toContain('One of the reads above resolves through');
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

    expect(remedy).toContain('--resource Cr=<physicalId>');
    expect(remedy).toContain('ANOTHER stack');
  });

  it('de-duplicates repeated targets and emits ONE COMMAND PER distinct target', () => {
    const remedy = remedyFor(['Cr.Secret', 'Cr.Other', 'Db.Password']);

    // A single command beside a list of names reads as though it covered them
    // all, so each target gets its own copy-pasteable command.
    expect(remedy).toContain("'cdkd import <stack> --resource Cr=<physicalId> --force'");
    expect(remedy).toContain("'cdkd import <stack> --resource Db=<physicalId> --force'");
    expect(remedy.match(/cdkd import/g)?.length).toBe(2);
  });

  // THE FIFTH SHAPE, and the one the anchored match alone got wrong. A nested
  // stack's output attribute reaches the cross-stack re-resolution arm only
  // when it `carriesDynamicReference`, and `'***'` does not (that predicate
  // tests for `{{resolve:`) — so a MASKED child output falls through to
  // `noteAttributeSecrecy` and is pushed in the LOCAL spelling `Child.Outputs.X`.
  // The record is the CHILD's `state.outputs`, from which the parent's
  // attributes are rebuilt every deploy, so no `--resource` here clears it:
  // `NestedStackProvider` implements no `import()`, so the command would report
  // `skipped-no-impl` and change nothing.
  it('routes a MASKED nested-stack output to the cross-stack arm despite its local-looking spelling', () => {
    const remedy = remedyFor(['Child.Outputs.DbPassword'], nested('Child'));

    expect(remedy).not.toContain('cdkd import');
    expect(remedy).not.toContain('--resource Child=');
    expect(remedy).toContain('ANOTHER stack');
  });

  it('still treats an ordinary dotted attribute as LOCAL', () => {
    const remedy = remedyFor(['Cr.Endpoint.Address']);

    expect(remedy).toContain('--resource Cr=<physicalId>');
    expect(remedy).not.toContain('ANOTHER stack');
  });

  // The discriminator is the resource TYPE, not the `Outputs.` segment. Keying
  // on the segment over-reaches: `AWS::ServiceCatalog::CloudFormationProvisionedProduct`
  // documents `Outputs.<Key>` as a real Fn::GetAtt attribute, so a masked one
  // would be misrouted to the foreign arm and its reachable remedy withheld.
  it('treats an Outputs.* attribute on a NON-nested-stack resource as LOCAL', () => {
    const remedy = remedyFor(
      ['Pp.Outputs.DbEndpoint'],
      { Pp: { resourceType: 'AWS::ServiceCatalog::CloudFormationProvisionedProduct' } }
    );

    expect(remedy).toContain('--resource Pp=<physicalId>');
    expect(remedy).not.toContain('ANOTHER stack');
  });

  it('treats an unrecognised shape as FOREIGN, which never emits a command', () => {
    // Fail-safe direction: an id cdkd did not expect (a hand-written template
    // can carry a non-alphanumeric logical id) costs a vaguer message rather
    // than a destructive one.
    const remedy = remedyFor(['My-Resource.Secret']);

    expect(remedy).not.toContain('cdkd import');
    expect(remedy).toContain('ANOTHER stack');
  });
});
