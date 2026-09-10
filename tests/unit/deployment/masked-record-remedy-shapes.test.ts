/**
 * `DeployEngine.maskedRecordRemedyFor` — the remedy clause of the masked-attribute
 * refusal, one case per `reads` SHAPE (issue
 * [#2847](https://github.com/go-to-k/cdkd/issues/2847), round-7 review; re-aimed
 * by the round-4 review of the security fix).
 *
 * WHY THIS FILE EXISTS AS A SHAPE TABLE. `ResolverContext.redactedAttributeReads`
 * is heterogeneous — `noteAttributeSecrecy` writes an ATTRIBUTE read,
 * `noteRefStateMask` a REF-STATE-KEY one, `reresolveCrossStackValue` three
 * CROSS-STACK forms — and SIX successive review rounds rewrote this remedy as
 * prose that the reader was expected to apply to whichever shape they had. Every
 * rewrite was correct for the shape its author had in mind and wrong for one
 * they had not:
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
 * THE STRUCTURE NOW TRAVELS WITH THE ENTRY, which is round 4's change and the
 * reason several rows below now assert the OPPOSITE of what they used to. The
 * partition ran on two regexes over the rendered text until a second defect of
 * the same class landed: the id class `[A-Za-z0-9]+` cannot match a HYPHENATED
 * logical id, which cdkd accepts (it validates no charset and never hands the
 * template to CloudFormation). Falling out of that pattern cost a vaguer message
 * here and cost the REFUSAL ITSELF at `resolveOutputs`' guard, which shared it —
 * one rendering serving two consumers whose safe directions are opposite. So
 * `kind` / `logicalId` are carried in the entry and both consumers ask a field.
 *
 * The builders below spell the DISPLAY rendering, which is a literal this file
 * owns; the producer/consumer pair is driven end to end, with no literal, by
 * `ref-state-mask-spelling-coupling.test.ts`. What is fenced HERE is the
 * partition, per shape.
 *
 * The private static is reached through a cast rather than by driving a whole
 * deploy: what is under test is the STRING this function derives, and routing it
 * through the engine would let an unrelated failure mask a wrong derivation
 * (this repo's "call the private helper DIRECTLY" rule).
 */
import { describe, it, expect } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { RedactedAttributeRead } from '../../../src/deployment/intrinsic-function-resolver.js';

const remedyFor = (
  reads: readonly RedactedAttributeRead[],
  resources: Record<string, { resourceType?: string }> = {}
): string =>
  (
    DeployEngine as unknown as {
      maskedRecordRemedyFor(
        reads: readonly RedactedAttributeRead[],
        resources: Record<string, { resourceType?: string }>
      ): string;
    }
  ).maskedRecordRemedyFor(reads, resources);

/** What `noteAttributeSecrecy` pushes for a masked `Fn::GetAtt`. */
const attr = (logicalId: string, attributeName: string): RedactedAttributeRead => ({
  kind: 'attribute',
  logicalId,
  key: attributeName,
  display: `${logicalId}.${attributeName}`,
});

/** What `noteRefStateMask` pushes for a masked `Ref` state key. */
const refKey = (logicalId: string, key: string): RedactedAttributeRead => ({
  kind: 'ref-state-key',
  logicalId,
  key,
  display: `Ref ${logicalId} (state key ${key})`,
});

/** What `reresolveCrossStackValue` pushes — no `logicalId`, by construction. */
const crossStack = (display: string): RedactedAttributeRead => ({ kind: 'cross-stack', display });

/** A state map in which `<id>` is a nested stack. */
const nested = (id: string) => ({ [id]: { resourceType: 'AWS::CloudFormation::Stack' } });

/** The three cross-stack shapes `reresolveCrossStackValue` really writes. */
const IMPORT_VALUE = crossStack(
  "Fn::ImportValue 'SharedDbSecret' (producer ProducerStack / us-east-1)"
);
const GET_STACK_OUTPUT = crossStack(
  "Fn::GetStackOutput 'DbSecret' (producer ProducerStack / us-east-1)"
);
const NESTED_STACK = crossStack('nested stack Child Outputs.Foo');

describe('maskedRecordRemedyFor — one arm per reads shape (issue #2847)', () => {
  it('names the GetAtt TARGET for the local shape, not the consumer', () => {
    const remedy = remedyFor([attr('Cr', 'Secret')]);

    expect(remedy).toContain("'cdkd import <stack> --resource Cr=<physicalId> --force'");
    // And no cross-stack clause when nothing cross-stack is present.
    expect(remedy).not.toContain('ANOTHER stack');
    // A `not.toContain('Param')` stood here — the round-6 fix's "do not advise
    // the CONSUMER" claim. It was UNFALSIFIABLE by construction and removed in
    // round 5: this helper is not handed the consumer's logical id at all, so
    // no mutation of it can print one. The live check is
    // `deploy-engine-noecho-custom-resource.test.ts`'s end-to-end refusal,
    // which drives the real engine and asserts the target id in the thrown
    // message.
  });

  it('names the RESOURCE for a dotted attribute path, not a prefix of the path', () => {
    // `Cr.Endpoint.Password` is a real pinned entry shape. The retired
    // first-dot capture was one reading of that rendering among several, each
    // wrong for some shape; the entry now carries `Cr` outright, so no reading
    // is involved and `--resource Cr.Endpoint=` — not a logical id — cannot be
    // produced by any rendering.
    const remedy = remedyFor([attr('Cr', 'Endpoint.Password')]);

    expect(remedy).toContain('--resource Cr=<physicalId>');
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
    expect(remedyFor([attr('Cr', 'Secret'), IMPORT_VALUE])).toContain(
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

    // ASSERTED ON THE ARM, not on two absent strings. The pair that stood here
    // (`--resource Child=` / `--resource Outputs=`) was UNFALSIFIABLE and was
    // removed in round 5: a `cross-stack` entry carries no `logicalId`, so no
    // mutation of the partition can make this helper print a `--resource` for
    // it — including flipping the missing-`logicalId` arm to LOCAL, since the
    // target list then filters the `undefined` straight back out. What a
    // mutation CAN change is which arm fires, so that is what is asserted.
    // The falsifiable form of the `--resource Child=` claim lives one case
    // down, where the entry is a local ATTRIBUTE read on a nested-stack type
    // and the resource-TYPE check is the only thing withholding the command.
    expect(remedy).toContain('ANOTHER stack');
  });

  it('emits BOTH arms when the reads mix local and cross-stack entries', () => {
    const remedy = remedyFor([attr('Cr', 'Secret'), IMPORT_VALUE]);

    expect(remedy).toContain('--resource Cr=<physicalId>');
    expect(remedy).toContain('ANOTHER stack');
  });

  it('de-duplicates repeated targets and emits ONE COMMAND PER distinct target', () => {
    const remedy = remedyFor([attr('Cr', 'Secret'), attr('Cr', 'Other'), attr('Db', 'Password')]);

    // A single command beside a list of names reads as though it covered them
    // all, so each target gets its own copy-pasteable command.
    expect(remedy).toContain("'cdkd import <stack> --resource Cr=<physicalId> --force'");
    expect(remedy).toContain("'cdkd import <stack> --resource Db=<physicalId> --force'");
    expect(remedy.match(/cdkd import/g)?.length).toBe(2);
  });

  // A nested stack's output attribute reaches the cross-stack re-resolution arm
  // only when it `carriesDynamicReference`, and `'***'` does not (that predicate
  // tests for `{{resolve:`) — so a MASKED child output falls through to
  // `noteAttributeSecrecy` and is pushed as an ordinary ATTRIBUTE read on the
  // child's own logical id. The record is the CHILD's `state.outputs`, from
  // which the parent's attributes are rebuilt every deploy, so no `--resource`
  // here clears it: `NestedStackProvider` implements no `import()`, so the
  // command would report `skipped-no-impl` and change nothing. This is why
  // `kind` alone cannot partition — the resource TYPE has to be consulted.
  it('routes a MASKED nested-stack output to the cross-stack arm despite its local KIND', () => {
    const remedy = remedyFor([attr('Child', 'Outputs.DbPassword')], nested('Child'));

    expect(remedy).not.toContain('cdkd import');
    expect(remedy).not.toContain('--resource Child=');
    expect(remedy).toContain('ANOTHER stack');
  });

  it('still treats an ordinary dotted attribute as LOCAL', () => {
    const remedy = remedyFor([attr('Cr', 'Endpoint.Address')]);

    expect(remedy).toContain('--resource Cr=<physicalId>');
    expect(remedy).not.toContain('ANOTHER stack');
  });

  // The discriminator is the resource TYPE, not the `Outputs.` segment. Keying
  // on the segment over-reaches: `AWS::ServiceCatalog::CloudFormationProvisionedProduct`
  // documents `Outputs.<Key>` as a real Fn::GetAtt attribute, so a masked one
  // would be misrouted to the foreign arm and its reachable remedy withheld.
  it('treats an Outputs.* attribute on a NON-nested-stack resource as LOCAL', () => {
    const remedy = remedyFor([attr('Pp', 'Outputs.DbEndpoint')], {
      Pp: { resourceType: 'AWS::ServiceCatalog::CloudFormationProvisionedProduct' },
    });

    expect(remedy).toContain('--resource Pp=<physicalId>');
    expect(remedy).not.toContain('ANOTHER stack');
  });

  // THE REF-STATE-KEY KIND (issue #2847, independent review round), pushed by
  // `IntrinsicFunctionResolver.noteRefStateMask` when the value
  // CloudFormation's `Ref` returns is recovered from a state key rather than
  // from the physical id.
  it('routes the Ref state-key kind to the LOCAL arm and names the right resource', () => {
    const remedy = remedyFor([refKey('MyTable', 'TableName')]);

    expect(remedy).toContain("'cdkd import <stack> --resource MyTable=<physicalId> --force'");
    expect(remedy).not.toContain('ANOTHER stack');
    // The id must be the resource, never the leading literal of the rendering.
    expect(remedy).not.toContain('--resource Ref=');
  });

  it("corrects the refusal's own 'stop reading it' advice for a Ref entry", () => {
    // The refusal prose ends its Cloud-Control arm telling the user to stop
    // reading the attribute. That is right for an `Fn::GetAtt` naming a
    // non-attribute and WRONG here: CloudFormation defines these types' `Ref`
    // as a state key, so the read is cdkd's own and no template edit removes
    // it. An arm that only re-stated the command would leave the message
    // carrying advice that cannot be followed.
    const remedy = remedyFor([refKey('MyTable', 'TableName')]);

    expect(remedy).toContain("CDKD's own read");
    expect(remedy).toContain('does not apply');
  });

  it('does NOT emit the Ref clause for the ordinary GetAtt shape', () => {
    // The other direction: a clause that always fires says nothing.
    expect(remedyFor([attr('Cr', 'Secret')])).not.toContain("CDKD's own read");
  });

  it('emits ONE command for a resource reached by BOTH a Ref and a GetAtt read', () => {
    // De-duplication has to span the two kinds, or the message advises the
    // same `--force` overwrite twice and reads as two separate repairs.
    const remedy = remedyFor([attr('MyTable', 'TableARN'), refKey('MyTable', 'TableName')]);

    expect(remedy.match(/cdkd import/g)?.length).toBe(1);
    expect(remedy).toContain('--resource MyTable=<physicalId>');
    // Not just de-duplicated — BOTH reads must be on the local side. Without
    // this line the case passes under a partition that drops the `Ref` kind
    // to the foreign arm, since the surviving GetAtt read still emits exactly
    // one command.
    expect(remedy).not.toContain('ANOTHER stack');
  });

  it('does not advise a local re-import for a Ref whose target is a NESTED STACK', () => {
    // The nested-stack exclusion is applied by resource TYPE, so it must reach
    // the Ref kind too rather than being wired to the attribute one.
    const remedy = remedyFor([refKey('Child', 'TableName')], nested('Child'));

    expect(remedy).not.toContain('cdkd import');
    expect(remedy).toContain('ANOTHER stack');
  });

  it('names the REAL record for a logical id that mimics the Ref rendering', () => {
    // Found by the issue #2847 security review, and this row now asserts the
    // OPPOSITE of what it did. cdkd validates no logical-id charset and never
    // hands the template to CloudFormation, so a resource literally named
    // `Ref Foo (state key X)` is deployable here, and `noteAttributeSecrecy`
    // pushes an ATTRIBUTE read whose `display` is
    // `Ref Foo (state key X).SomeAttr`. A START-anchored Ref regex captured
    // `Foo` out of that and advised `--force`-overwriting Foo's record, which
    // the import typo guard ACCEPTS; the tail anchor then dropped the entry to
    // the FOREIGN arm, which was safe but told the user to act on a producer
    // stack about a resource in their own.
    //
    // Routing on `logicalId` makes both outcomes unreachable: the entry names
    // the record that really holds the mask, which is the repair the user
    // needs, and `Foo` is never mentioned.
    const remedy = remedyFor([attr('Ref Foo (state key X)', 'SomeAttr')], {
      Foo: { resourceType: 'AWS::SQS::Queue' },
      'Ref Foo (state key X)': { resourceType: 'AWS::SQS::Queue' },
    });

    expect(remedy).toContain('--resource Ref Foo (state key X)=<physicalId>');
    expect(remedy).not.toContain('--resource Foo=');
    // It is an `Fn::GetAtt`, so the Ref-specific clause — which says the read
    // cannot be rewritten away in the template — must still not appear.
    expect(remedy).not.toContain("CDKD's own read");
  });

  it('does NOT emit the Ref clause for a GetAtt whose ATTRIBUTE merely mimics one', () => {
    // THE FLOOR FOR THE OLD TAIL ANCHOR (issue #2847 round-2 review, T3), kept
    // because the proposition it pins is still the one that matters: an
    // ordinary `Fn::GetAtt` on a resource with an oddly-named attribute must
    // take the attribute arm's advice, not the Ref arm's. It is now decided by
    // `kind` rather than by where a regex anchors.
    const remedy = remedyFor([attr('Foo', 'Ref Bar (state key X)')], {
      Foo: { resourceType: 'AWS::SQS::Queue' },
    });

    // The GetAtt arm is unaffected — this is the control half.
    expect(remedy).toContain('--resource Foo=<physicalId>');
    // ...but the Ref-specific advice must not appear.
    expect(remedy).not.toContain("CDKD's own read");
  });

  // THE UNCLEARABLE-LOCAL ARM (issue #2847 round-2 review): a LOCAL target whose
  // `import()` can never rewrite the bag. `CustomResourceProvider.import`
  // returns `attributes: {}` unconditionally, and `import.ts` carries the
  // PRIOR attributes forward whenever the physical id matches — which it does,
  // since the advised command supplies that very id. So the emitted command
  // ran cleanly and changed nothing, forever.
  it.each([['Custom::MyThing'], ['AWS::CloudFormation::CustomResource']])(
    'withholds the re-import command for a %s target and says why',
    (resourceType) => {
      const remedy = remedyFor([attr('Cr', 'Secret')], { Cr: { resourceType } });

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
    const remedy = remedyFor([attr('Cr', 'Secret')], { Cr: { resourceType: 'AWS::SSM::Parameter' } });

    expect(remedy).toContain('--resource Cr=<physicalId>');
    expect(remedy).not.toContain('Do NOT re-import');
  });

  it('mixes the arms: a custom resource beside an ordinary local target', () => {
    const remedy = remedyFor([attr('Cr', 'Secret'), attr('Db', 'Password')], {
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

  it('treats an entry carrying NO logicalId as FOREIGN, which never emits a command', () => {
    // Fail-safe direction, and now a property of the DATA rather than of a
    // pattern: `cross-stack` is the only kind that omits `logicalId` today, and
    // a kind added later without one falls here rather than into a command.
    const remedy = remedyFor([crossStack('some future shape nobody has written yet')]);

    expect(remedy).not.toContain('cdkd import');
    expect(remedy).toContain('ANOTHER stack');
  });

  it('escapes a single quote in the logical id, so the pasted command still parses', () => {
    // cdkd validates no logical-id charset, and this line is meant to be
    // copy-pasted into a shell: an unescaped `'` closes the display quoting
    // early and the rest of the command reparses as something else. POSIX
    // escaping is close-escape-reopen (issue #2847 round-5 review, nit).
    const remedy = remedyFor([attr("Bob's-Table", 'Arn')], {
      "Bob's-Table": { resourceType: 'AWS::SQS::Queue' },
    });

    expect(remedy).toContain(`--resource Bob'\\''s-Table=<physicalId>`);
    // NEGATIVE, paired with the positive so it cannot pass by absence: the RAW
    // id must not survive, since that is the spelling that breaks the paste.
    expect(remedy).not.toContain(`--resource Bob's-Table=`);
  });

  it('routes a HYPHENATED logical id to the LOCAL arm — the round-4 blocker, remedy side', () => {
    // The retired regexes' id class was `[A-Za-z0-9]+`, so `My-Table` matched
    // NEITHER and the entry took the foreign arm: the user was told to act on a
    // producer stack about a resource in their own, and the one command that
    // repairs the record was withheld. cdkd accepts such an id
    // (`overrideLogicalId`, a `--migrate-from-cloudformation` template), so this
    // is a reachable case rather than a hypothetical.
    //
    // The GUARD half of the same blocker — where falling out of the pattern
    // cost the REFUSAL rather than a sentence — is fenced in
    // `deploy-engine-outputs-masked-ref-refusal.test.ts`.
    const attrRemedy = remedyFor([attr('My-Table', 'Arn')], {
      'My-Table': { resourceType: 'AWS::SQS::Queue' },
    });
    expect(attrRemedy).toContain('--resource My-Table=<physicalId>');
    expect(attrRemedy).not.toContain('ANOTHER stack');

    const refRemedy = remedyFor([refKey('My-Table', 'TableName')], {
      'My-Table': { resourceType: 'AWS::S3Tables::Table' },
    });
    expect(refRemedy).toContain('--resource My-Table=<physicalId>');
    expect(refRemedy).toContain("CDKD's own read");
    expect(refRemedy).not.toContain('ANOTHER stack');
  });
});
