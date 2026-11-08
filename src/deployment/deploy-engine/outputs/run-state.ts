import type { Logger } from '../../../types/config.js';
import type { DeployEngineOptions } from '../options.js';
import type { BuildResolverContextFn } from '../resolver-context.js';
import type { NoEchoPositionSourcesFn } from '../noecho.js';
import type { IntrinsicFunctionResolver } from '../../intrinsic-function-resolver.js';
import type { RecordedSecretValues } from '../../secret-redaction.js';

/**
 * What {@link resolveOutputs} / {@link handleOutputResolutionFailure} read
 * from the engine beyond {@link OutputsRunState} — the live engine members,
 * built at each call site as `DeployEngine.outputsDeps()` so a forwarded METHOD
 * (`buildResolverContext`, `noEchoPositionSources`) stays bound to the
 * calling engine rather than a snapshot taken at `deps` construction time.
 */
export interface OutputsDeps {
  options: Pick<DeployEngineOptions, 'strictGetAtt' | 'inheritedSecrets' | 'parameters'>;
  logger: Pick<Logger, 'warn' | 'debug'>;
  resolver: Pick<IntrinsicFunctionResolver, 'resolve'>;
  buildResolverContext: BuildResolverContextFn;
  noEchoPositionSources: NoEchoPositionSourcesFn;
}

/**
 * One deploy's Outputs-pass state: the ten fields {@link resolveOutputs}, the
 * no-change merge (`deploy-flow.ts`), the exports-redaction fold
 * (`masking.ts`), the `NoEcho` position scan (`noecho.ts`) and the
 * nested-pending-parent journal snapshot (`rollback.ts`) read and write
 * across one deploy.
 *
 * Replaced, not cleared in place, by `deploy()`'s per-run reset — like
 * `AttributeHealer` / `ProvenanceCapture` / `ObservedCapture`. ENGINE-instance
 * state, never module-global: one engine deploys one stack, and
 * `--stack-concurrency` runs several at once.
 */
export class OutputsRunState {
  /**
   * Resolved secrets recorded while resolving the stack OUTPUTS (a
   * `CfnOutput` whose Value resolves a `{{resolve:...}}` reference). Separate
   * from the per-resource maps for the same anti-cross-contamination reason.
   */
  outputSecrets: RecordedSecretValues = new Map();
  /**
   * The outputs pass's own recording map(s), one per `resolveOutputs` call
   * this deploy, so every redaction of the outputs bag re-reads them rather
   * than trusting the copy taken when the pass ended (issue
   * [#2814](https://github.com/go-to-k/cdkd/issues/2814)): a part the drain
   * cap stopped waiting for records into its pass map LATE, and the final
   * save, the exports index and the deploy summary all run after that copy.
   */
  outputsPassSecretMaps: RecordedSecretValues[] = [];
  /**
   * UNRESOLVED template `Outputs` values, keyed by output name (issue #1910) —
   * the outputs' POSITION source, the sibling of `perResourceTemplateProps` for
   * the bag `resolveOutputs` produces. Without it two outputs resolving one
   * secret collapse onto whichever expression was recorded last, exactly as two
   * resource properties did before #1904. Captured in `resolveOutputs` at the
   * same point `outputSecrets` is accumulated.
   *
   * Null-prototype for the same reason as the outputs bag `resolveOutputs`
   * builds two lines away: both are keyed by TEMPLATE-CONTROLLED output names,
   * so an output called `__proto__` would replace this bag's prototype and a
   * later lookup of a name it never stored would inherit from it. This
   * initializer IS the reset: `deploy()` replaces the whole
   * {@link OutputsRunState} before anything writes to it, so there is no
   * second place this could drift out of sync with.
   */
  outputsTemplateSource: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  /**
   * The export aliases the last `resolveOutputs` pass WROTE into its bag
   * (issue #2193) — exactly the keys `outputs[exportName] = value` landed on,
   * so an alias the pass refused (secret-bearing name, collision with a
   * published output name) or skipped (unresolved value, condition-suppressed
   * output) is not in it. Persisted as `StackState.exportNames` by the saves
   * that persist that bag, and the set the exports index is fed from. Reset
   * at the top of every `resolveOutputs`, so it is only meaningful right
   * after that call returns — read it there, not later.
   */
  resolvedExportNames: string[] = [];
  /**
   * The last `resolveOutputs` pass's verdict over an export alias the
   * no-change merge would CARRY from state rather than resolve
   * (go-to-k/cdkd#4657): the refusal warning, or `undefined` to carry it.
   * Same lifetime rule as `resolvedExportNames`; `undefined` until a
   * `resolveOutputs` pass has run (with or without `Outputs`: a pass with
   * none decides from the `NoEcho` seed alone, go-to-k/cdkd#4043 Phase C).
   */
  carriedExportAliasRefusal:
    | ((outputKey: string, exportName: string) => string | undefined)
    | undefined;
  /**
   * The outputs the last `resolveOutputs` pass could NOT resolve and SKIPPED
   * (the resolver threw under the default arm of
   * `handleOutputResolutionFailure`, or returned `undefined` outright without
   * `--strict-getatt` — see
   * `collectSkippedOutputs`), each mapped to the
   * digest `cdkd diff` compares against (issue #2740, `StackState.
   * skippedOutputs`). `undefined` when nothing was skipped, so the saves that
   * persist the resolved bag spread it as-is and the field stays omitted.
   *
   * Issue #2740, same reuse hazard as `ReplacementRunState.retainedOldOnReplacement`:
   * `resolveOutputs` recomputes this field at the END of a pass, but
   * early-returns for a template with no `Outputs` without touching it, so a
   * STALE value from a previous deploy of a reused engine would otherwise
   * carry into a run whose pass takes that early return. This field's own
   * initializer (`undefined`) is the only reset that guards it: `deploy()`
   * replaces the whole {@link OutputsRunState}, so a fresh instance is what
   * clears it — a second reset inside `resolveOutputs` would mask this one,
   * and neither could then be pinned.
   */
  skippedOutputs: Record<string, string> | undefined;
  /**
   * Whether {@link outputsTemplateSource} may be used to POSITION the outputs
   * redaction. False once an outputs pass threw partway: the post-loop
   * name pass never ran, so the bag holds only the alias keys written before
   * the throw — a partial source built from THIS template, while the bag the
   * failure path then redacts is the PREVIOUS deploy's.
   */
  outputsSourceUsable = true;
  /**
   * State schema v12: each output's OWN provenance sink, keyed by outputs-bag
   * key (an `Export.Name` alias shares its output's).
   */
  outputProvenanceSinks = new Map<string, RecordedSecretValues>();
  /**
   * State schema v12: the outputs bags THIS deploy resolved, and their
   * redacted copies, so the persist writer can tell this pass's bag from a
   * carried or merged one.
   */
  outputsResolvedThisRun = new WeakSet<object>();
  /**
   * State schema v12: the outputs bag this deploy's outputs pass resolved
   * (unredacted), for the no-change path's outputs share of the migration.
   */
  resolvedOutputsBag: Record<string, unknown> | undefined = undefined;
}
