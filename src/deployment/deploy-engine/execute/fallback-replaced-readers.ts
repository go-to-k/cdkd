import { DiffCalculator } from '../../../analyzer/diff-calculator.js';
import { dropSupersededProviderReplacements } from '../../../analyzer/diff-calculator/provider-replacement.js';
import { TemplateParser } from '../../../analyzer/template-parser.js';
import type { ResourceChange } from '../../../types/state.js';
import { safeMsg } from '../../../utils/display-safe.js';
import type { DagExecutor } from '../../dag-executor.js';
import { addPromotedNodes } from './lost-children.js';
import type { DeployRun } from './run.js';

/**
 * go-to-k/cdkd#7081: the update-failure fallback replaced `replacedId` with a
 * resource that is not the old one under its id. The diff saw an in-place
 * UPDATE row, so it promoted none of its readers: a `NO_CHANGE` reader would
 * keep the deleted id, in AWS and in state. Run the diff's own replacement
 * passes now, seeded with `replacedId` as a forced replacement and scoped to
 * the rows that transitively read it, exactly as a planned replacement's
 * readers are promoted: an in-place update where the referencing property is
 * mutable, a replacement where it is create-only (whose own readers follow),
 * and the in-place attribute pass after it. A promoted replacement goes
 * through the replacement arm, so the stateful guard
 * (`--force-stateful-recreation`) applies to it there.
 *
 * Called when the replacement's node completes, before the executor can
 * dispatch any reader: every reader depends on it, so none has started, and
 * a row the passes mutate is a pending node or a `NO_CHANGE` row. The latter
 * are added to the running executor. Speculative promotion is safe for the
 * reason it is in the diff: the engine re-resolves a promoted row and sends
 * nothing (or lowers a create-only ceiling) when its value did not move.
 */
export async function enqueueReadersOfFallbackReplacement(
  run: DeployRun,
  executor: DagExecutor<ResourceChange>,
  replacedId: string
): Promise<void> {
  const { engine, changes, template, progress } = run;
  const replaced = changes.get(replacedId);
  if (replaced === undefined) return;
  const resources = template.Resources ?? {};
  const diff = engine.diffCalculator;
  const parser = new TemplateParser();

  // The reference edges the diff walks: `Ref` / `Fn::GetAtt` / `Fn::Sub` and
  // the intrinsics nesting them, plus the raw `Fn::GetAtt` reads.
  const rawGetAttRefs = new Map<string, Map<string, Map<string, Set<string>>>>();
  const readersOf = new Map<string, Set<string>>();
  const addEdge = (referencedId: string, readerId: string): void => {
    if (referencedId === readerId) return;
    let readers = readersOf.get(referencedId);
    if (readers === undefined) {
      readers = new Set();
      readersOf.set(referencedId, readers);
    }
    readers.add(readerId);
  };
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    const perProp = new Map<string, Map<string, Set<string>>>();
    for (const [propKey, propValue] of Object.entries(resource.Properties ?? {})) {
      for (const referencedId of parser.extractReferences(propValue)) {
        addEdge(referencedId, logicalId);
      }
      const refs = DiffCalculator.extractGetAttRefs(propValue);
      if (refs.size > 0) perProp.set(propKey, refs);
      for (const referencedId of refs.keys()) addEdge(referencedId, logicalId);
    }
    if (perProp.size > 0) rawGetAttRefs.set(logicalId, perProp);
  }

  const reached = new Set<string>();
  const queue = [replacedId];
  while (queue.length > 0) {
    for (const readerId of readersOf.get(queue.shift()!) ?? []) {
      if (readerId === replacedId || reached.has(readerId)) continue;
      reached.add(readerId);
      queue.push(readerId);
    }
  }
  if (reached.size === 0) return;

  // Only the readers (and the seed): the passes seed from every replacing
  // row they are given, and the rest of the plan was promoted already.
  const readers = new Map<string, ResourceChange>();
  for (const id of reached) {
    const change = changes.get(id);
    if (change !== undefined) readers.set(id, change);
  }
  const scope = new Map<string, ResourceChange>([[replacedId, replaced], ...readers]);
  const forced: ReadonlySet<string> = new Set([replacedId]);

  const syntheticCreateOnlyPaths = await diff.loadSyntheticCreateOnlyPaths(
    scope,
    template,
    rawGetAttRefs,
    undefined,
    forced
  );
  // Taken after the await, with the passes below in the same synchronous
  // stretch: another completion running meanwhile (a second fallback, a lost
  // child) may have promoted a shared reader, which is then not added twice.
  const before = new Map([...readers].map(([id, change]) => [id, change.changeType]));
  // A row already in the plan as an in-place UPDATE that these passes turn
  // into a replacement is named too, so its `Replacing` line has a cause.
  const replacingBefore = new Set(
    [...readers]
      .filter(([, change]) => (change.propertyChanges ?? []).some((pc) => pc.requiresReplacement))
      .map(([id]) => id)
  );
  // The in-place attribute pass reads the replaced row's own (in-place)
  // property changes as an in-place upstream; the replacement pass already
  // promoted every reader of it, so the pass sees only its readers.
  do {
    diff.promoteReplacementDependents(scope, template, syntheticCreateOnlyPaths, forced);
  } while (
    diff.promoteInPlaceAttributeDependents(
      readers,
      template,
      rawGetAttRefs,
      syntheticCreateOnlyPaths
    )
  );
  // As the diff does after its passes: a resource replaced anyway carries no
  // provider-replacement mark.
  dropSupersededProviderReplacements(readers);

  const promoted: string[] = [];
  for (const [id, change] of readers) {
    if (change.changeType !== 'UPDATE') continue;
    const replacing = (change.propertyChanges ?? []).some((pc) => pc.requiresReplacement);
    if (before.get(id) !== 'NO_CHANGE') {
      if (replacing && !replacingBefore.has(id)) {
        engine.logger.info(
          safeMsg`  ${id} reads ${replacedId}, which the update-failure fallback replaced: replacing it instead of updating it in place (a create-only property holds the reference)`
        );
      }
      continue;
    }
    promoted.push(id);
    engine.logger.info(
      replacing
        ? safeMsg`  ${id} reads ${replacedId}, which the update-failure fallback replaced: replacing it too (a create-only property holds the reference)`
        : safeMsg`  ${id} reads ${replacedId}, which the update-failure fallback replaced: updating it`
    );
  }
  if (promoted.length === 0) return;
  if (progress) progress.total += promoted.length;
  addPromotedNodes(run, executor, promoted);
}
