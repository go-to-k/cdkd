import type { RecordedSecretValues } from '../pairs.js';
import type { CrossStackAssociations } from '../cross-stack.js';

/**
 * The `AWS::CloudFormation::Stack` type string, named once because the recorder
 * below gates on it and the tests assert against the same population.
 *
 * DUPLICATED, deliberately: `intrinsic-resolver/context.ts` declares the same
 * literal under the same name (for the `Outputs.<Name>` re-resolution of issue
 * #2055). This family is a LEAF by design -- see the header of
 * `secret-redaction.ts`, it imports nothing outside `secret-redaction/`,
 * because both the resolver and the deploy engine consume it -- so
 * importing that spelling would close a cycle, and exporting this one for the
 * resolver to import would make the leaf a source of values rather than of
 * pure functions. The two cannot drift into DISAGREEMENT in any way that
 * matters: an AWS resource type string is fixed by AWS, and a typo in either
 * copy makes that copy's gate simply never fire (no-op), never fire wrongly.
 */
export const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';

/**
 * What a PARENT stack's resolution proved about each `Parameters` entry of an
 * `AWS::CloudFormation::Stack` row it is about to provision, keyed by the
 * child's PARAMETER NAME (issue
 * [#2291](https://github.com/go-to-k/cdkd/issues/2291)).
 *
 * WHY A THIRD STORE, when `crossStackAssociations` already holds
 * per-leaf associations. This one is OUTBOUND: it is written against the
 * PARENT's bag and describes leaves of the CHILD's template, so it has to be
 * transported across the engine boundary before any reader can use it. The
 * child's per-resource bag then receives those entries as ORDINARY
 * `crossStackAssociations` rows (see
 * `inheritNestedStackParameterAssociations`), which is what lets the
 * existing three-condition reader answer for them with no new arm.
 *
 * KEEPING THE TWO TABLES SEPARATE IS LOAD-BEARING, not tidiness. A child engine
 * that itself owns a grandchild `AWS::CloudFormation::Stack` row records the
 * GRANDCHILD's parameter names against the CHILD's bag — the same bag that
 * already carries the child's own INBOUND `Ref` associations. Writing both into
 * one table means a grandchild parameter sharing a NAME with a child parameter
 * poisons the child's entry (two expressions under one key), so a leaf that was
 * being certified correctly falls back to the value scan the moment a
 * same-named parameter appears one level down. Two tables make the collision
 * impossible rather than unlikely.
 *
 * A `WeakMap` keyed by the parent pass's own bag, for the reason
 * `crossStackAssociations` gives: the entries hold PLAINTEXT, and they
 * must not outlive the pass that fetched them.
 */
export const nestedStackParameterExpressions = new WeakMap<
  RecordedSecretValues,
  CrossStackAssociations
>();

/**
 * The parent's LITERAL spelling of each `Parameters` entry whose resolved value
 * EMBEDS its tokens -- `postgres://{{U}}:{{A}}@host` -- keyed by the pass's bag,
 * then by the child's parameter name (issue
 * [#4644](https://github.com/go-to-k/cdkd/issues/4644)).
 *
 * A separate table from {@link nestedStackParameterExpressions} because its
 * reader asks a different question: that table certifies a value that IS a
 * recorded plaintext (or the sub-floor carry's entry), this one a value that
 * merely CONTAINS plaintexts, by re-rendering the spelling
 * (`rendersLiteralTo`). It is never inherited into the child's
 * `crossStackAssociations`, whose readers require a whole plaintext; it is
 * read only through `renderedParameterSpelling`: by
 * `inheritedParameterExpression` (the diff side, a `{Ref}` leaf, the
 * carry) and by `inheritedRenderedSpan` (a child leaf EMBEDDING the
 * parameter, which the diff side renders from that same binding). A name
 * recorded twice against a different entry is POISONED rather than
 * overwritten.
 */
export const renderedParameterSpellings = new WeakMap<
  RecordedSecretValues,
  Map<string, { readonly spelling: string; readonly value: string } | null>
>();

/**
 * Condition (iv)'s key (see `recordNestedStackParameterExpressions`) for
 * a `Parameters` spelling that is not a single-span literal frame of its
 * resolved value carrying this pass's pair for its token: an object source, a
 * plain literal, a two-span literal, a bag equal to its source, and a frame
 * whose token this pass never resolved to the middle (a PUBLIC sibling).
 */
export const UNFRAMED_SPELLING: unique symbol = Symbol('cdkd.nested-parameter.unframed-spelling');
