import type { TemplateOutput } from '../../types/resource.js';

/**
 * Does CloudFormation suppress this output on this deploy?
 *
 * CFn does not create an output whose `Condition` evaluates false, and
 * `resolveOutputs` mirrors that (issue #1028). Unknown condition names are
 * KEPT, matching `filterResourcesByCondition` on the resource side — a
 * condition cdkd could not evaluate must not silently delete an output.
 *
 * DEPLOY-SIDE ONLY. `cdkd scrub` deliberately does not use this: see
 * {@link collectDeclaredOutputNames}.
 */
export function isOutputSuppressedByCondition(
  output: TemplateOutput,
  conditions?: Record<string, boolean>
): boolean {
  return output.Condition !== undefined && conditions?.[output.Condition] === false;
}

/**
 * The output NAMES this deploy actually publishes — every declared output minus
 * the condition-suppressed ones.
 *
 * This is the set that owns keys in BOTH bags, and the reason the answer is
 * "published" rather than "declared": a suppressed output writes no value, so
 * it must not write a position source either, and its name is free for an
 * export alias to use. Reserving names for suppressed outputs would drop a
 * WORKING export the moment an unrelated condition went false.
 *
 * Sound at deploy time because these are the SAME condition values the deploy
 * itself acted on. Not sound in scrub — see {@link collectDeclaredOutputNames}.
 */
export function collectPublishedOutputNames(
  outputs: Record<string, TemplateOutput>,
  conditions?: Record<string, boolean>
): Set<string> {
  const names = new Set<string>();
  for (const [name, output] of Object.entries(outputs)) {
    if (!isOutputSuppressedByCondition(output, conditions)) names.add(name);
  }
  return names;
}

/**
 * Every DECLARED output name, conditions ignored — the set `cdkd scrub` tests
 * collisions against.
 *
 * Scrub must be a SUPERSET here, and the asymmetry with the deploy engine is
 * forced by what scrub can know. Its condition values are re-evaluated
 * best-effort, from template defaults only (the command takes no
 * `--parameters`), and `evaluateConditions` assumes FALSE on any evaluation
 * failure. So "suppressed" is both easy to hit spuriously and impossible to
 * confirm against the deploy that actually wrote the state.
 *
 * The two error directions are not symmetric, which is what settles the rule:
 *
 * - Judging a colliding output suppressed when the DEPLOY published it (the
 *   spurious-false case above) makes scrub miss the collision, write the
 *   exporting output's expression over the colliding key, and persist a
 *   reference naming a DIFFERENT secret — the #1919 corruption, produced by
 *   the remediation command itself.
 * - Judging it published when the deploy suppressed it costs one spurious
 *   warning and one key redacted by VALUE match instead of by position. State
 *   exactly what that costs, since an earlier revision understated it: the
 *   value map is keyed by PLAINTEXT, so when two DISTINCT secrets resolve to
 *   one value it keeps only the last, and that key can be persisted holding a
 *   reference naming the OTHER secret. It is a smaller blast radius than the
 *   first case (one key, and only when two secrets coincide, versus every
 *   collision) but it is the same KIND of error, not a mere loss of precision.
 *
 * A wrong reference beats a lost precision bound, so scrub over-approximates.
 */
export function collectDeclaredOutputNames(outputs: Record<string, TemplateOutput>): Set<string> {
  return new Set(Object.keys(outputs));
}

/**
 * Would aliasing `exportName` land on a key another output owns?
 *
 * An output exporting under its OWN name is not a collision: the alias rewrites
 * the identical key with the identical value, and both bags then carry the same
 * source.
 *
 * Deliberately NOT extended to two outputs sharing one `Export.Name` with no
 * output of that name. Both bags stay consistent there (one iteration writes
 * both the value and its source), so it is not this issue's class — see
 * `docs/cross-stack-references.md`.
 */
export function isExportAliasCollision(
  exportName: string,
  outputKey: string,
  ownedOutputNames: ReadonlySet<string>
): boolean {
  return exportName !== outputKey && ownedOutputNames.has(exportName);
}
