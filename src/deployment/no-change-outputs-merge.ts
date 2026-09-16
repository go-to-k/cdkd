/**
 * What the no-change deploy path persists for the `Outputs` bag when one or
 * more outputs did NOT resolve (issue
 * [#2771](https://github.com/go-to-k/cdkd/issues/2771)).
 *
 * The path used to make an all-or-nothing choice: any unresolved output kept
 * the PREVIOUS bag whole (the issue #875 guard against overwriting good values
 * with a partial map). That guard also blocked every sibling that DID resolve,
 * so an output added beside a persistently failing one never landed, and
 * `cdkd diff --fail` showed a real `ADD` for it on every run. The merge below
 * keeps the guard's intent and drops its collateral, with three rules:
 *
 * 1. A key that RESOLVED this pass writes this pass's value.
 * 2. A key that FAILED this pass keeps its stored value when it has one and
 *    stays absent otherwise. A failed key never writes, so a good stored value
 *    is never overwritten with nothing, which is all the #875 guard asked for.
 *    An output's literal `Export.Name` alias is carried with it, but only when
 *    the previous record already published that alias.
 * 3. A key this pass did not produce at all is REMOVED: an output deleted from
 *    the template, or suppressed by a false condition. The changed-resources
 *    path drops such a key too, and carrying it would turn a deletion into a
 *    `REMOVE` row the diff shows forever.
 *
 * Two shapes REFUSE the merge and keep the whole previous bag, exactly as
 * before this module existed, because the merge cannot be done safely there:
 *
 * - **An unresolved output with a stored value declares an INTRINSIC
 *   `Export.Name`.** The alias key it published last time cannot be named
 *   without resolving the name, and the alias pass never resolves the name of an
 *   output whose value failed. Rule 3 would then remove a live export a consumer
 *   may still import. An output with NO stored value never resolved, so it never
 *   published an alias, and it does not refuse.
 * - **The merged bag would mix generations the diff cannot tell apart.**
 *   `computeOutputsDiff` exonerates a stored key it cannot account for when any
 *   stored value is a secret-bearing `{{resolve:...}}` expression, reading that
 *   one expression as proof every value in the bag is redacted. A bag written
 *   whole by one resolution earns that reading; a bag kept whole inherits what
 *   its previous write left, EXCEPT that the save's value scan can still give it
 *   a first expression beside a value no needle names — a residual this module
 *   does not close and `computeOutputsDiff` documents.
 *   A merge that carries a previous value beside a NEWLY written expression
 *   does not, when the previous bag held no expression: the carried value may
 *   be plaintext a pre-GHSA binary stored, and the new expression would
 *   exonerate it. So a merge that carries any value into such a bag is
 *   refused, checked again on the bag as the save redacts it. What this
 *   refusal guarantees is narrower than the reading the exoneration takes: the
 *   MERGE never creates a bag whose first secret-bearing expression sits beside
 *   a carried value. It does not make "one stored expression means no stored
 *   plaintext" true of every bag — a kept-whole save can still create that
 *   shape through its value scan, the residual `computeOutputsDiff` documents.
 *
 * The exoneration is not per-key because nothing in the record says which keys
 * a deploy carried rather than rewrote. `StackState.skippedOutputs` does name
 * them on the deploy that carried them, but every command that rebuilds state
 * outside a deploy drops that field while keeping the bag, so a per-key reading
 * would lose its evidence on the first `cdkd import` or `cdkd drift --accept`.
 * The refusal instead works on the bag itself, which every such command carries
 * verbatim.
 *
 * A LEAF module: it imports only a type. `src/analyzer/outputs-diff.ts` reads
 * the secret-expression predicate from here, so the deploy side's refusal and
 * the diff side's exoneration cannot disagree about what an expression is.
 * `computeStackDiff` (`src/cli/commands/diff-recursive.ts`) calls
 * {@link mergeNoChangeOutputs} itself to preview this merge on a stack with no
 * resource change (issue #3101), so the preview and the persist share the
 * rules rather than a copy of them.
 */

import type { TemplateOutput } from '../types/resource.js';

/**
 * True when `value` is a string carrying a SECRET-BEARING CloudFormation
 * dynamic reference: `{{resolve:secretsmanager:` or `{{resolve:ssm-secure:`,
 * the two spellings that are secret regardless of what they point at.
 *
 * A plain `{{resolve:ssm:...}}` is deliberately excluded. Per issue #1901 it is
 * classified by the parameter's TYPE, and a `String` / `StringList` parameter is
 * PUBLIC and legitimately persisted RESOLVED. Treating it as a signal would fire
 * on a perfectly ordinary record, and since `cdkd diff`'s legacy verdict is
 * record-WIDE, that would withhold every previous value in the stack and tell
 * the user to run `cdkd scrub`, which would find nothing to fix. The residual is
 * a pre-#1901 SecureString `ssm:` record, a strictly narrower gap than the false
 * positive this exclusion removes.
 */
export function isSecretBearingReferenceString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.includes('{{resolve:secretsmanager:') || value.includes('{{resolve:ssm-secure:');
}

/**
 * True when any TOP-LEVEL value of `bag` is itself a secret-bearing expression
 * string. Leaf granularity on purpose: a container holding an expression next
 * to a plaintext leaf is exactly the partially redacted residue `cdkd scrub`
 * admits it can leave, and it must not earn the exoneration. `null` is admitted
 * because a hand-edited state record can hold one where the type says a bag.
 */
export function bagHoldsSecretExpression(bag: Record<string, unknown> | null | undefined): boolean {
  if (bag === undefined || bag === null) return false;
  return Object.values(bag).some((value) => isSecretBearingReferenceString(value));
}

/** Why {@link mergeNoChangeOutputs} kept the whole previous bag. */
export type NoChangeOutputsKeptReason = 'intrinsic-export-name' | 'mixed-generation';

export type NoChangeOutputsMerge =
  | {
      kind: 'merged';
      /** The bag to persist. Null-prototype, like the bag it is built from. */
      outputs: Record<string, unknown>;
      /** The export set that describes {@link outputs}. */
      exportNames: string[];
      /** Keys whose stored value was carried rather than rewritten. */
      carriedKeys: string[];
    }
  | { kind: 'kept'; reason: NoChangeOutputsKeptReason };

export interface NoChangeOutputsMergeInput {
  /** The bag currently in state. */
  persisted: Record<string, unknown>;
  /**
   * This pass's bag as `resolveOutputs` returned it, already redacted. An
   * unresolved output is present with the value `undefined`; a
   * condition-suppressed output and a deleted one are absent.
   */
  resolved: Record<string, unknown>;
  /** The template's `Outputs`, read for each failed output's `Export.Name`. */
  declaredOutputs: Record<string, TemplateOutput> | undefined;
  /** `importableOutputKeys(currentState)`: what the previous record exported. */
  previousExportNames: ReadonlySet<string>;
  /** The export aliases this pass wrote, in the order it wrote them. */
  resolvedExportNames: readonly string[];
}

function hasOwn(bag: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(bag, key);
}

/**
 * Decide the bag the no-change path persists when `resolved` holds at least
 * one unresolved output. See the module doc for the three rules and the two
 * refusals.
 */
export function mergeNoChangeOutputs(input: NoChangeOutputsMergeInput): NoChangeOutputsMerge {
  const { persisted, resolved, declaredOutputs, previousExportNames, resolvedExportNames } = input;
  const failedKeys = Object.keys(resolved).filter((key) => resolved[key] === undefined);

  const exportNameOf = (outputKey: string): unknown =>
    declaredOutputs !== undefined && hasOwn(declaredOutputs, outputKey)
      ? (declaredOutputs[outputKey]?.Export?.Name as unknown)
      : undefined;

  // Only an INTRINSIC name (an object) can hide a published alias, and only on
  // an output that has a stored value: the alias pass skips an output whose
  // value failed, so one that never resolved never published an alias to lose.
  // A `null` / number `Export.Name` publishes nothing either (the alias pass
  // skips a falsy name and a non-string resolution).
  for (const outputKey of failedKeys) {
    const exportName = exportNameOf(outputKey);
    if (exportName !== null && typeof exportName === 'object' && hasOwn(persisted, outputKey)) {
      return { kind: 'kept', reason: 'intrinsic-export-name' };
    }
  }

  // Rules 1 and 3 at once: only what this pass resolved is copied in.
  const outputs = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(resolved)) {
    if (value !== undefined) outputs[key] = value;
  }

  // Rule 2.
  const carriedKeys: string[] = [];
  const exportNames = [...resolvedExportNames];
  // No de-duplication: this pass never publishes a failed output's name or
  // alias, and the carry below adds each name at most once.
  const addExport = (name: string): void => {
    exportNames.push(name);
  };
  for (const outputKey of failedKeys) {
    const exportName = exportNameOf(outputKey);
    // A failed key is never already in `outputs`: nothing above wrote it, and
    // the alias carry below cannot write a name `resolved` holds.
    if (hasOwn(persisted, outputKey)) {
      outputs[outputKey] = persisted[outputKey];
      carriedKeys.push(outputKey);
      // A self-named export stays exported only if the template still says so
      // AND the previous record already served it.
      if (exportName === outputKey && previousExportNames.has(outputKey)) addExport(outputKey);
    }
    // A self-named name needs no case of its own below: it is a key `resolved`
    // holds, which the collision gate already refuses.
    // Type narrowing only: `previousExportNames` holds strings, so a
    // non-string name could never pass the gate below anyway.
    if (typeof exportName !== 'string') continue;
    // A literal alias is carried only as the alias the previous record
    // published. `resolved` holds every published output NAME, so an alias
    // that collides with one is the collision the alias pass refuses, and it
    // is not carried either.
    if (
      previousExportNames.has(exportName) &&
      hasOwn(persisted, exportName) &&
      !hasOwn(resolved, exportName) &&
      !hasOwn(outputs, exportName)
    ) {
      outputs[exportName] = persisted[exportName];
      carriedKeys.push(exportName);
      addExport(exportName);
    }
  }

  if (
    carriedKeys.length > 0 &&
    bagHoldsSecretExpression(outputs) &&
    !bagHoldsSecretExpression(persisted)
  ) {
    return { kind: 'kept', reason: 'mixed-generation' };
  }

  return { kind: 'merged', outputs, exportNames, carriedKeys };
}

/**
 * The sentence naming a keep-whole reason: the deploy engine appends it to its
 * keep-whole warning, and `cdkd diff` to the suppression warning it prints.
 */
export function keptWholeReasonText(reason: NoChangeOutputsKeptReason): string {
  switch (reason) {
    case 'intrinsic-export-name':
      return (
        'An unresolved output declares an intrinsic Export.Name, so the export key it ' +
        'published before cannot be identified and carried.'
      );
    case 'mixed-generation':
      return (
        'Persisting only the outputs that resolved would put a redacted secret reference ' +
        'beside a carried value in a bag that held none, which would make that value read ' +
        'as redacted.'
      );
  }
}
