/**
 * The row shape of `REPLACEMENT_EVIDENCE` (`./evidence.ts`) and the
 * constructors its rows use, split out so a per-service row file
 * (`./evidence-fsx.ts`) shares them without importing `./evidence.ts`.
 */

/** What kind of evidence a row records. */
export type ReplacementEvidenceKind =
  /** A CloudFormation A/B (change set + execution) recorded on `refs`. */
  | 'cfn-measured'
  /** Transcribed from CloudFormation's own resource handler, recorded on `refs`. */
  | 'cfn-handler'
  /** The CloudFormation template reference's "Update requires" line, quoted on `refs`. */
  | 'cfn-docs'
  /** The AWS API cannot apply the change in place (no update member, or it refuses). */
  | 'aws-api'
  /**
   * A Cloud Control update of only this property, recorded on `refs`: it
   * applied in place under the same identifier (`update`), or Cloud Control
   * refused it (`replace`). Cloud Control runs the registry handler
   * CloudFormation runs for the type.
   */
  | 'cc-measured'
  /**
   * Cloud Control refused a change of this array or map member, recorded on
   * `refs` (go-to-k/cdkd#7083). A member cannot be compared per element, so
   * the verdict stays `update`: the deploy fails loudly and loses no data.
   */
  | 'element-refused'
  /**
   * No Cloud Control probe can reach the change, for the reason in
   * `unmeasurable` (go-to-k/cdkd#7083). The verdict stays today's `update`.
   */
  | 'cannot-probe'
  /** A nested create-only path the committed fixture lists under the property. */
  | 'schema-nested'
  /** A deliberate, safer difference from CloudFormation, decided on `refs`. */
  | 'deviation'
  /** The property takes one valid value, so it cannot change. */
  | 'single-value'
  /**
   * cdkd's `update()` refuses the change before any AWS call, naming the
   * remedy, so the diff's "update" never applies a wrong result.
   */
  | 'refused'
  /**
   * A MEASURED difference from CloudFormation that the issue in `refs` fixes;
   * the row changes with that fix.
   */
  | 'open-divergence';

/** The verdict a row vouches for: always replace, never, by a predicate, or by a nested create-only path. */
export type ReplacementVerdict = 'replace' | 'update' | 'conditional' | 'nested';

export interface ReplacementEvidence {
  /**
   * Why a `cfn-docs` or `cannot-probe` row was not measured
   * (go-to-k/cdkd#7048, #7083). Only a `cfn-docs` row may rest on the
   * CloudFormation reference; every other verdict cites an execution, the
   * handler, the AWS API or the schema.
   */
  readonly unmeasurable?: string;
  /**
   * The verdict the evidence supports. The check compares it with cdkd's
   * current verdict, so flipping a verdict (an entry moved between
   * `replacementProperties` and `updateableProperties`) needs new evidence.
   */
  readonly verdict: ReplacementVerdict;
  readonly kind: ReplacementEvidenceKind;
  /** Issues / PRs holding the measurement, quote or decision. */
  readonly refs: readonly number[];
  /**
   * A `cfn-measured` `replace` whose CloudFormation execution went to the
   * create path and FAILED there on this name property, which the replacement
   * keeps (go-to-k/cdkd#7126): CloudFormation replaces on the change only
   * when the name changes too, and otherwise loses no data. The refusal says
   * so instead of claiming the data is lost there as well.
   */
  readonly cfnKeepsName?: string;
}

const row =
  (verdict: ReplacementVerdict) =>
  (kind: ReplacementEvidenceKind, ...refs: number[]): ReplacementEvidence => ({
    verdict,
    kind,
    refs,
  });
/** An `update` verdict resting on the reference because no A/B is possible here. */
export const unmeasurable = (why: string, ...refs: number[]): ReplacementEvidence => ({
  verdict: 'update',
  kind: 'cfn-docs',
  refs: [...refs, 7048],
  unmeasurable: why,
});
/** A candidate no probe can reach (go-to-k/cdkd#7083): today's update stays. */
export const cannotProbe = (why: string, ...refs: number[]): ReplacementEvidence => ({
  verdict: 'update',
  kind: 'cannot-probe',
  refs: [...refs, 7083],
  unmeasurable: why,
});
export const replace = row('replace');
export const update = row('update');
export const conditional = row('conditional');
export const nested = row('nested');
