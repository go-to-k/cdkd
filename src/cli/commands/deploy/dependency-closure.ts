import { inferCrossStackDepsByStack } from '../../../analyzer/cross-stack-deps.js';
import type { CrossStackScanStack } from '../../../analyzer/cross-stack-deps.js';
import { stacksForDependency } from '../../stack-matcher.js';
import type { StackLike } from '../../stack-matcher.js';

/** A stack of the app, as far as the dependency walk reads it. */
type ClosureStack = CrossStackScanStack &
  StackLike & {
    region?: string | undefined;
    stagePath?: string | undefined;
    dependencyNames: readonly string[];
  };

/**
 * The stacks `cdkd deploy` (without `-e`) deploys for `selected`: each one and,
 * recursively, every stack it depends on (CDK CLI compatible). Moved out of
 * `deploy/command.ts` so `cdkd diff --replace-resource` checks its targets over
 * the deploy's own set (go-to-k/cdkd#7089).
 *
 * STRONG edges only: the CDK manifest dependencies and `Fn::ImportValue`.
 * `Fn::GetStackOutput` is a WEAK reference (read from cdkd state when there),
 * so it never pulls an unselected producer in (issue #751). By stack OBJECT,
 * not name: a dependency name two Stages share resolves to the producer in
 * the dependent's own Stage (#5176). `selected` is returned first, in order,
 * then each added stack in discovery order.
 */
export function withDependencyStacks<T extends ClosureStack>(
  selected: readonly T[],
  allStacks: readonly T[],
  onAdd?: (dependency: T, requiredBy: T) => void
): T[] {
  const inferred = inferCrossStackDepsByStack(allStacks, { kinds: ['ImportValue'] });
  const inApp = new Set(allStacks);
  const out = [...selected];
  const included = new Set(selected);
  const add = (stack: T): void => {
    const deps = new Set<T>();
    for (const depName of stack.dependencyNames) {
      for (const dep of stacksForDependency(depName, stack, allStacks)) deps.add(dep);
    }
    for (const producer of inferred.get(stack) ?? []) {
      if (producer !== stack && inApp.has(producer)) deps.add(producer);
    }
    for (const dep of deps) {
      if (included.has(dep)) continue;
      included.add(dep);
      out.push(dep);
      onAdd?.(dep, stack);
      add(dep);
    }
  };
  for (const stack of selected) add(stack);
  return out;
}
