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
    // Exactly one read in total, so the subject is singular and definite.
    expect(remedy).toContain('The read above resolves');

    // No command at all — a `--resource` here cannot reach the other stack's
    // record, and advising one is what named a wrong-but-real id before.
    expect(remedy).not.toContain('cdkd import');
    expect(remedy).toContain('ANOTHER stack');
    expect(remedy).toContain('producer stack');
  });

  // THREE arms, because two of them were each exact for one case and wrong for
  // another: keyed to the LOCAL arm, two foreign reads rendered "The read
  // above resolves" while the message had just listed both; keyed only to the
  // foreign count, a lone read rendered "One of the reads", which implies a set.
  it('numbers the cross-stack sentence across all three arms', () => {
    // One read in total -> definite singular.
    expect(remedyFor([IMPORT_VALUE])).toContain('The read above resolves through');
    // Several reads, one of them foreign -> partitive singular.
    expect(remedyFor(['Cr.Secret', IMPORT_VALUE])).toContain(
      'One of the reads above resolves through'
    );
    // Several foreign -> plural.
    expect(remedyFor([IMPORT_VALUE, GET_STACK_OUTPUT])).toContain(
      'Some of the reads above resolve through'
    );
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

  // THE SIXTH SHAPE (issue #2847, independent review round): `Ref <LogicalId>
  // (state key <Key>)`, pushed by `IntrinsicFunctionResolver.noteRefStateMask`
  // when the value CloudFormation's `Ref` returns is recovered from a state key
  // rather than from the physical id. The anchored `LOCAL_MASKED_READ` cannot
  // see it (no dot follows the leading word), so without its own regex the
  // partition would call it FOREIGN and withhold the one remedy that reaches
  // the record.
  it('routes the Ref state-key shape to the LOCAL arm and names the right resource', () => {
    const remedy = remedyFor(['Ref MyTable (state key TableName)']);

    expect(remedy).toContain("'cdkd import <stack> --resource MyTable=<physicalId> --force'");
    expect(remedy).not.toContain('ANOTHER stack');
    // The id must be the resource, never the leading literal.
    expect(remedy).not.toContain('--resource Ref=');
  });

  it("corrects the refusal's own 'stop reading it' advice for a Ref entry", () => {
    // The refusal prose ends its Cloud-Control arm telling the user to stop
    // reading the attribute. That is right for an `Fn::GetAtt` naming a
    // non-attribute and WRONG here: CloudFormation defines these types' `Ref`
    // as a state key, so the read is cdkd's own and no template edit removes
    // it. An arm that only re-stated the command would leave the message
    // carrying advice that cannot be followed.
    const remedy = remedyFor(['Ref MyTable (state key TableName)']);

    expect(remedy).toContain("CDKD's own read");
    expect(remedy).toContain('does not apply');
  });

  it('does NOT emit the Ref clause for the ordinary GetAtt shape', () => {
    // The other direction: a clause that always fires says nothing.
    expect(remedyFor(['Cr.Secret'])).not.toContain("CDKD's own read");
  });

  it('emits ONE command for a resource reached by BOTH a Ref and a GetAtt read', () => {
    // De-duplication has to span the two spellings, or the message advises the
    // same `--force` overwrite twice and reads as two separate repairs.
    const remedy = remedyFor(['MyTable.TableARN', 'Ref MyTable (state key TableName)']);

    expect(remedy.match(/cdkd import/g)?.length).toBe(1);
    expect(remedy).toContain('--resource MyTable=<physicalId>');
    // Not just de-duplicated — BOTH reads must be on the local side. Without
    // this line the case passes under a partition that drops the `Ref` spelling
    // to the foreign arm, since the surviving GetAtt read still emits exactly
    // one command.
    expect(remedy).not.toContain('ANOTHER stack');
  });

  it('does not advise a local re-import for a Ref whose target is a NESTED STACK', () => {
    // The nested-stack exclusion is applied by resource TYPE, so it must reach
    // the new spelling too rather than being wired to the dotted one.
    const remedy = remedyFor(['Ref Child (state key TableName)'], nested('Child'));

    expect(remedy).not.toContain('cdkd import');
    expect(remedy).toContain('ANOTHER stack');
  });

  it('refuses a FORGED Ref spelling built out of a logical id, rather than naming an innocent row', () => {
    // Found by the issue #2847 security review. cdkd validates no logical-id
    // charset and never hands the template to CloudFormation, so a resource
    // literally named `Ref Foo (state key X)` is deployable here — and
    // `noteAttributeSecrecy` would push `Ref Foo (state key X).SomeAttr` for
    // it. `LOCAL_MASKED_READ` cannot match that (the space blocks it), so a
    // START-anchored Ref regex captured `Foo` and advised
    // `--force`-overwriting Foo's record, which the import typo guard ACCEPTS.
    // The tail anchor drops it to the foreign arm instead — no command at all.
    const remedy = remedyFor(['Ref Foo (state key X).SomeAttr'], {
      Foo: { resourceType: 'AWS::SQS::Queue' },
    });

    expect(remedy).not.toContain('cdkd import');
    expect(remedy).not.toContain('--resource Foo=');
    expect(remedy).toContain('ANOTHER stack');
    // The forged entry must not pick up the Ref-specific clause either — it is
    // really an Fn::GetAtt, and the clause says the read cannot be rewritten
    // away in the template, which is false for one.
    expect(remedy).not.toContain("CDKD's own read");
  });

  it('does NOT emit the Ref clause for a GetAtt whose ATTRIBUTE merely looks like one', () => {
    // THE FLOOR FOR THE TAIL ANCHOR (issue #2847 round-2 review, T3). The
    // comment on `REF_STATE_MASKED_READ` reasons about anchoring at BOTH ends
    // and only the tail was watched: dropping the `^` stayed green. Un-anchored,
    // `Foo.Ref Bar (state key X)` — an ordinary `Fn::GetAtt` on a resource with
    // an oddly-named attribute — still routes its target via
    // `LOCAL_MASKED_READ` (so the command is right) but makes `hasRefStateRead`
    // true, printing the "cdkd's own read / does not apply" paragraph over a
    // read the template CAN stop making. A cap without a floor rewards the
    // inverse regression.
    const remedy = remedyFor(['Foo.Ref Bar (state key X)'], {
      Foo: { resourceType: 'AWS::SQS::Queue' },
    });

    // The GetAtt arm is unaffected — this is the control half.
    expect(remedy).toContain('--resource Foo=<physicalId>');
    // ...but the Ref-specific advice must not appear.
    expect(remedy).not.toContain("CDKD's own read");
  });

  // THE SEVENTH SHAPE (issue #2847 round-2 review): a LOCAL target whose
  // `import()` can never rewrite the bag. `CustomResourceProvider.import`
  // returns `attributes: {}` unconditionally, and `import.ts` carries the
  // PRIOR attributes forward whenever the physical id matches — which it does,
  // since the advised command supplies that very id. So the emitted command
  // ran cleanly and changed nothing, forever.
  it.each([['Custom::MyThing'], ['AWS::CloudFormation::CustomResource']])(
    'withholds the re-import command for a %s target and says why',
    (resourceType) => {
      const remedy = remedyFor(['Cr.Secret'], { Cr: { resourceType } });

      expect(remedy).not.toContain('cdkd import');
      expect(remedy).toContain('Do NOT re-import Cr');
      // NOT the cross-stack arm: the record IS in this stack, and telling the
      // user to act on a producer stack would be plainly false.
      expect(remedy).not.toContain('ANOTHER stack');
    }
  );

  it('still emits the command for an ordinary type (scope control for the custom-resource arm)', () => {
    // The other direction: an exclusion that swallowed every local target
    // would pass both rows above while removing the only remedy that works.
    const remedy = remedyFor(['Cr.Secret'], { Cr: { resourceType: 'AWS::SSM::Parameter' } });

    expect(remedy).toContain('--resource Cr=<physicalId>');
    expect(remedy).not.toContain('Do NOT re-import');
  });

  it('mixes the arms: a custom resource beside an ordinary local target', () => {
    const remedy = remedyFor(['Cr.Secret', 'Db.Password'], {
      Cr: { resourceType: 'Custom::MyThing' },
      Db: { resourceType: 'AWS::SSM::Parameter' },
    });

    // The ordinary one keeps its command...
    expect(remedy).toContain('--resource Db=<physicalId>');
    // ...the custom resource is named as unclearable, and never as a target.
    expect(remedy).toContain('Do NOT re-import Cr');
    expect(remedy).not.toContain('--resource Cr=');
    expect(remedy.match(/cdkd import/g)?.length).toBe(1);
  });

  it('treats an unrecognised shape as FOREIGN, which never emits a command', () => {
    // Fail-safe direction: a shape the partition does not recognise costs a
    // vaguer message rather than a destructive one. No claim is made that this
    // particular id can reach cdkd — CloudFormation's logical-id grammar is
    // alphanumeric — only that the arm behaves safely for anything unmatched.
    const remedy = remedyFor(['My-Resource.Secret']);

    expect(remedy).not.toContain('cdkd import');
    expect(remedy).toContain('ANOTHER stack');
  });
});
