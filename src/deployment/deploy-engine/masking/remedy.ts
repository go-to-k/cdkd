/** See `deploy-engine.ts`: an inline type-only alias, for the `vi.mock` reason stated there. */
type RedactedAttributeRead = import('../../intrinsic-function-resolver.js').RedactedAttributeRead;
import { displayIdent, isPasteableIdent } from '../../../utils/display-safe.js';
import { commandHole, pasteableCommand, shellQuote } from '../../../utils/pasteable-command.js';

/**
 * The remedy clause of `refuseRedactedAttributeReads`'s import arm,
 * derived from the `reads` entries rather than described in prose.
 *
 * `ResolverContext.redactedAttributeReads` is HETEROGENEOUS, and the split
 * that matters is NOT which function pushed the entry — it is whether the
 * masked record lives in THIS stack's state, because only then can a
 * `--resource` re-import here reach it. FOUR populations reach the bag, and
 * each entry now says which it is IN ITS OWN FIELDS
 * ({@link RedactedAttributeRead}) rather than in a rendered string this
 * function re-parses:
 *
 *  - `kind: 'attribute'` with a `logicalId` — `noteAttributeSecrecy`, a
 *    resource in this stack. LOCAL.
 *  - `kind: 'attribute'` whose `logicalId` names an
 *    `AWS::CloudFormation::Stack` — ALSO `noteAttributeSecrecy`, and the
 *    reason `kind` alone cannot partition. A nested stack's output attribute
 *    reaches the cross-stack re-resolution arm only when it
 *    `carriesDynamicReference`, and a value that is already `SECRET_MASK`
 *    does NOT (that predicate tests for `{{resolve:`), so a masked child
 *    output falls through to `noteAttributeSecrecy` and is pushed as an
 *    ordinary local attribute read. Its record is the CHILD's
 *    `state.outputs`, from which the parent's attributes are rebuilt every
 *    deploy, so no `--resource` in THIS stack clears it:
 *    `NestedStackProvider` implements no `import()` at all, so the command
 *    would report `skipped-no-impl` and change nothing. FOREIGN, despite
 *    being local by kind.
 *  - `kind: 'cross-stack'` — `reresolveCrossStackValue`'s `Fn::ImportValue` /
 *    `Fn::GetStackOutput` / `nested stack <Child> Outputs.<Key>` forms. It
 *    carries NO `logicalId`, because there is no id in THIS stack to name.
 *    FOREIGN.
 *  - `kind: 'ref-state-key'` — `noteRefStateMask`, a resource in this stack
 *    whose CFn `Ref` value is recovered from a state key rather than from the
 *    physical id. LOCAL, and it earns a sentence of its own: the read is
 *    cdkd's, not the template's, so the `Fn::GetAtt` remedy "stop reading it"
 *    does not apply.
 *
 * Successive review rounds tried to express this as an instruction the reader
 * applies ("the name to the left of the dot"), and each phrasing was wrong
 * for a shape it had not considered — twice naming a REAL-but-wrong logical
 * id that the import typo guard ACCEPTS, so following it would
 * `--force`-overwrite an innocent row. Partitioning here makes each arm say
 * only what is true of its own shape, and makes a new shape a change to THIS
 * function rather than a silent widening of a sentence.
 *
 * **AND THE PARTITION READS FIELDS, NEVER A REGEX OVER `display`** (round-4
 * review). Two revisions parsed the rendering back into structure and each
 * shipped a defect: a hand-spelled pattern that a producer rename disarms,
 * then an `[A-Za-z0-9]+` id class that a HYPHENATED logical id falls out of —
 * and cdkd accepts one, because it validates no logical-id charset and never
 * hands the template to CloudFormation. Here falling out cost a re-import
 * command withheld; at `resolveOutputs`' guard the same miss cost the REFUSAL
 * itself. One rendering serving two consumers whose safe directions are
 * OPPOSITE is not a pattern to tune, so the structure moved into the data.
 *
 * The nested-stack case is excluded BY RESOURCE TYPE, not by an `Outputs.`
 * spelling. Keying on the segment over-reaches: a local
 * `AWS::ServiceCatalog::CloudFormationProvisionedProduct` documents
 * `Outputs.<Key>` as a real `Fn::GetAtt` attribute, so a masked one would be
 * misrouted to the foreign arm and the reachable remedy withheld. `resources`
 * is on the context already, so the type is available and exact.
 *
 * A LOCAL target whose type cannot be repaired by `cdkd import` at all gets
 * a THIRD arm since the issue #2847 round-2 review — a `Custom::*` /
 * `AWS::CloudFormation::CustomResource`, whose provider records no
 * attributes, so the import's same-physical-id carry-over restores the
 * masked bag and the refusal repeats forever. It is NOT simply excluded from
 * `isLocal`: that would route it to the FOREIGN arm, which asserts the record
 * lives in another stack, and for a custom resource in this very template
 * that is false. Its arm names the resource and withholds the command.
 *
 * An entry carrying NO `logicalId` is treated as foreign, which is both
 * correct (`cross-stack` is the only kind that omits it) and the safe
 * direction for a kind nobody has added yet: the foreign arm names no
 * command, so an unrecognised shape costs a vaguer message rather than a
 * destructive one.
 *
 * A logical id spelled `Ref Foo (state key X)`, or `My-Table`, or anything
 * else cdkd accepts, now routes on the FIELD and cannot be misread as another
 * row — the misparse the pre-round-4 regexes had to be anchored against.
 */
export function maskedRecordRemedyFor(
  reads: readonly RedactedAttributeRead[],
  resources: Record<string, { readonly resourceType?: string }>,
  /**
   * True only from `refuseRedactedAttributeReads`, whose message numbers
   * its causes: the re-import lead-ins then say they are for cause (3), and
   * the custom-resource arm points back at cause (1). `refuseMaskedOutputReads`
   * lists no causes and reaches only `ref-state-key` reads, where a re-import
   * IS the remedy, so it keeps the unconditional lead-ins (issue #2881).
   */
  causeScoped = false
): string {
  // Spelled locally rather than imported: the only copy exported to other
  // modules lives in `src/cli/commands/retire-cfn-stack.ts`, and a CLI -> deployment import
  // edge for one string literal is the wrong trade.
  // Several modules keep their own copy for that same reason; no count is
  // given, following `recreate-targets/validate.ts`'s own note that an unfenced number
  // in a comment is one that goes stale. Theirs sit at module scope, this one
  // is function-local because this is its only reader.
  const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';
  /**
   * Types whose `import()` can NEVER clear a mask, so advising a re-import
   * for them is a guaranteed no-op (issue #2847 round-2 review).
   *
   * TRACED, not assumed. `CustomResourceProvider.import` returns
   * `{ physicalId, attributes: {} }` unconditionally; `import.ts`'s
   * `reimportedAttributes` CARRIES FORWARD the prior record's attributes
   * for an empty bag whenever the physical id matches — which it does,
   * since the command is run with that very id. So the masked bag is copied
   * back verbatim (the import now warns that it was) and the refusal
   * repeats, forever.
   *
   * This is the NoEcho population — arm (1) of the refusal's own message —
   * which already has the right remedy there (force the custom resource to
   * update so its handler runs again). It gets its OWN arm rather than being
   * excluded from `isLocal`: excluding it would route the read to the FOREIGN
   * arm, which says the record lives in ANOTHER stack, and for a custom
   * resource sitting in this very template that is simply false. Narrower
   * than issue #2927, which is about a re-import whose `GetResource` merely
   * came back empty; here the provider cannot produce attributes at all.
   */
  const importCannotClearMask = (type: string | undefined): boolean =>
    type === 'AWS::CloudFormation::CustomResource' || (type?.startsWith('Custom::') ?? false);

  // THE ROUTING KEY IS THE FIELD, not a capture group. `resources` is read
  // with `Object.hasOwn` for the same reason `resolveRef` does (issue #2767):
  // `logicalId` is template-controlled, and a bare property read walks the
  // prototype chain, so an id of `constructor` answers with the `Object`
  // function rather than missing. It is HYGIENE here, not a fix — round-5
  // review measured that `resources['constructor']?.resourceType` is
  // `undefined` either way, so both spellings route the entry LOCAL and no
  // test can tell them apart. The guard is kept because the next field read
  // added here may not be so lucky.
  const typeOf = (read: RedactedAttributeRead): string | undefined =>
    read.logicalId !== undefined && Object.hasOwn(resources, read.logicalId)
      ? resources[read.logicalId]?.resourceType
      : undefined;
  const isLocal = (read: RedactedAttributeRead): boolean => {
    if (read.logicalId === undefined) return false;
    // A masked NESTED-STACK output is pushed as an ordinary attribute read
    // but its record is the child's; no `--resource` here reaches it.
    return typeOf(read) !== NESTED_STACK_RESOURCE_TYPE;
  };
  /** LOCAL, but no `cdkd import` can rewrite it — see above. */
  const isUnclearableLocal = (read: RedactedAttributeRead): boolean =>
    isLocal(read) && importCannotClearMask(typeOf(read));
  const targetOf = (read: RedactedAttributeRead): string | undefined => read.logicalId;

  const localTargets = [
    ...new Set(
      reads
        .filter((read) => isLocal(read) && !isUnclearableLocal(read))
        .map(targetOf)
        .filter((id): id is string => id !== undefined)
    ),
  ];
  const unclearableTargets = [
    ...new Set(
      reads
        .filter(isUnclearableLocal)
        .map(targetOf)
        .filter((id): id is string => id !== undefined)
    ),
  ];
  const foreignReads = reads.filter((read) => !isLocal(read));
  const hasRefStateRead = reads.some((read) => read.kind === 'ref-state-key' && isLocal(read));

  /**
   * A logical id rendered as a NAME rather than as a command argument
   * (go-to-k/cdkd#3435 security round).
   *
   * Every sentence below is joined into a `ProvisioningError` message that
   * `handleError` prints at DEFAULT verbosity, and neither `formatError` nor
   * the logger sanitizes `error.message` — they cover a `cause` and the extra
   * ARGS respectively. So a `Resources` KEY carrying `ESC[2K` + CR reached the
   * terminal raw, which is the same class this PR closed at 18 resolver
   * renders and missed one module out.
   */
  const shown = (id: string): string => displayIdent(id);

  /** CloudFormation's own logical-id length bound. */
  const CFN_LOGICAL_ID_MAX_LENGTH = 255;

  const parts: string[] = [];
  /** Pasteable commands, emitted LAST and one per line (go-to-k/cdkd#3436). */
  const commandLines: string[] = [];
  if (localTargets.length > 0) {
    // ONE COMMAND PER TARGET: naming several ids beside a single command
    // reads as though the one command covers them all.
    //
    // AND THE COMMAND IS WITHHELD FOR AN ID THAT IS NOT PASTEABLE
    // (go-to-k/cdkd#3435). Sanitizing the id in place is the WRONG remedy
    // here and was rejected for the reason this function's own header already
    // records about its round-4 regexes: a stripped id names a DIFFERENT,
    // possibly innocent row, and `cdkd import --force` accepts it. So the two
    // arms differ in kind — a pasteable id gets the runnable command, and
    // anything else gets its rendered NAME plus a sentence saying why the
    // command is not given. Same SPLIT `rollback-executor.ts` makes for
    // `cdkd rollback --orphan <id>`, through a stricter predicate — that
    // site takes CloudFormation's own `[A-Za-z0-9]` charset, and this one
    // must not, because cdkd validates no logical-id charset and a HYPHENATED
    // id is exactly the round-4 blocker this function's header records. A
    // `[A-Za-z0-9]` rule here was written first and MEASURED: it withheld the
    // command for `My-Table`, reddening four existing cases that pin the
    // hyphenated id reaching the LOCAL arm. `isPasteableIdent` is the rule
    // calibrated for cdkd's own id space (medial `~` / `_` / `.` / `-`
    // admitted, a LEADING one refused because that is where the option and
    // tilde-expansion shapes live).
    // The CAP is tightened at this call site (go-to-k/cdkd#3435 security
    // round 2). `isPasteableIdent` admits up to `STACK_REF_MAX_CODE_POINTS`,
    // which is right for its home population -- a cdkd state-record stack
    // name is minted recursively as `${parent}~${logicalId}` and is not
    // bounded by CloudFormation's 128. A LOGICAL ID has no such recursion, so
    // a thousand-character one is a payload on a default-verbosity line
    // rather than a legitimate value. No injection either way (the charset is
    // plain), so this is a bound, not a guard -- and it is applied HERE
    // rather than by loosening a shared security predicate's signature.
    const pasteableHere = (id: string): boolean =>
      isPasteableIdent(id) && id.length <= CFN_LOGICAL_ID_MAX_LENGTH;
    const pasteable = localTargets.filter(pasteableHere);
    const withheld = localTargets.filter((id) => !pasteableHere(id));
    if (pasteable.length > 0) {
      // The SENTENCE joins the prose; the commands go to `commandLines`, which
      // is emitted after every sentence (go-to-k/cdkd#3436). Pushing them here
      // put later prose on the same line as a command, which is the layout the
      // rule exists to prevent — and `parts` is space-joined, so a `\n` inside
      // one part does not make the command last.
      // SCOPED TO CAUSE (3) when the caller numbers its causes (issue
      // #2881): a re-import cannot clear a NoEcho or `Fn::Base64` mask on a
      // local non-custom-resource record — the SSM provider's `import()`
      // records `Value` only for a plain literal, and `reimportedAttributes`
      // carries the masked one forward. See `causeScoped`.
      parts.push(
        causeScoped
          ? `If cause (3) applies, re-import the record that HOLDS the mask (command(s) below); ` +
              `a re-import does not clear a cause (1) or (2) mask.`
          : `Re-import the record that HOLDS the mask (command(s) below).`
      );
      for (const id of pasteable) {
        // The old form wrapped the whole command in prose quotes AND left
        // `<stack>` / `<physicalId>` bare, which pasted as two redirections.
        // A LITERAL, not a gated value (go-to-k/cdkd#4205): the gate would
        // withhold `Tbl=<physicalId>` whole for the `<` and `>` of the hole
        // cdkd itself wrote into it (a mid-word `=` it admits), and the
        // command would no longer name the record. The only untrusted part is `id`, which `pasteableHere`
        // already held to `isPasteableIdent`, inert with no quotes at all.
        commandLines.push(
          `Re-import with: ${
            pasteableCommand('cdkd import', [
              { hole: 'stack' },
              { literal: `--resource ${shellQuote(`${id}=<physicalId>`)}` },
              { literal: '--force' },
            ]).command
          }`
        );
      }
    }
    if (withheld.length > 0) {
      parts.push(
        // NO backtick wrapper around the command. Pasted WITH its wrapper a
        // backtick span is command SUBSTITUTION -- a worse wrapper than
        // `'...'`, and one the source fence could not see until
        // go-to-k/cdkd#3613's M8 named it. Every placeholder here is a hole,
        // so nothing untrusted ran, but the shape is the one this class is
        // about and it should not be modelled in a message that exists to
        // explain the class. The command is DESCRIBED rather than offered,
        // because this arm's whole point is that it is withheld.
        `${causeScoped ? 'If cause (3) applies, re-import' : 'Re-import'} the record that ` +
          `HOLDS the mask for ${withheld.map(shown).join(', ')}, but ` +
          `the command is withheld: that is not a plain CloudFormation logical id, so a ` +
          `pasted cdkd import line could be reshaped by the shell or name a different ` +
          `resource. Read the id from 'cdkd state show' and quote it yourself, in ` +
          `cdkd import ${commandHole('stack')} --resource ` +
          `${commandHole('id')}=${commandHole('physicalId')} --force.`
      );
    }
  }
  if (unclearableTargets.length > 0) {
    // NAMES THE RESOURCE AND WITHHOLDS THE COMMAND. `CustomResourceProvider.import`
    // returns no attributes, and the import's same-physical-id carry-over
    // then restores the masked bag, so the re-import above would run cleanly
    // and change nothing.
    //
    // This arm names ids and NEVER pastes one, so it takes `shown`
    // unconditionally rather than the pasteable split above.
    parts.push(
      `Do NOT re-import ${unclearableTargets.map(shown).join(', ')}: a custom resource's ` +
        `import records no attributes, so the masked bag is carried forward unchanged and the ` +
        `refusal repeats.` +
        (causeScoped ? ` Cause (1) above is the one that applies to it.` : '')
    );
  }
  if (foreignReads.length > 0) {
    // THREE arms, because two of them were each exact for one case and wrong
    // for another. The subject is the FOREIGN reads, so the number follows
    // their count (keying it to the local arm rendered "The read above
    // resolves" over two of them) — but "One of the reads" implies a set, so
    // it is wrong when the message listed exactly one read in total.
    const subject =
      reads.length === 1
        ? 'The read above resolves'
        : foreignReads.length === 1
          ? 'One of the reads above resolves'
          : 'Some of the reads above resolve';
    parts.push(
      `${subject} through ` +
        `ANOTHER stack (an Fn::ImportValue, an Fn::GetStackOutput, or a nested stack's ` +
        `Outputs), whose masked record lives in that stack's state — re-importing anything in ` +
        `this stack cannot clear it; act on the producer stack instead.`
    );
  }
  if (hasRefStateRead) {
    // The one arm that CORRECTS an instruction the refusal's own prose gives.
    // That prose ends its Cloud-Control arm with "stop reading it", which is
    // right for an `Fn::GetAtt` naming a non-attribute and wrong for a
    // `Ref`: CloudFormation defines these types' `Ref` as a state key rather
    // than the physical id, so cdkd issues the read on the template's behalf
    // and no template edit removes it.
    parts.push(
      `A 'Ref <LogicalId> (state key <Key>)' entry above is CDKD's own read, not one the ` +
        `template can stop making: CloudFormation defines that resource type's Ref value as ` +
        `that state key rather than the physical id, so the record must be repaired (re-import ` +
        `it, or let a deploy create or update the resource) — the "stop reading it" remedy does ` +
        `not apply to such an entry.`
    );
  }
  return [parts.join(' '), ...commandLines].join('\n');
}
