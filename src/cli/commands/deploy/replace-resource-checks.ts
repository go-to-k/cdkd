import { safeMsg } from '../../../utils/display-safe.js';
import { CdkdError } from '../../../utils/error-handler.js';
import type { DeployCommandOptions } from './types.js';

/** A stack of this run, as far as the `--replace-resource` checks read it. */
interface TargetStack {
  stackName: string;
  template: { Resources?: Record<string, unknown> };
}

/**
 * go-to-k/cdkd#7079: the run-level `--replace-resource` checks, before any
 * stack deploys. A logical id is unique only within one template, and the
 * flag replaces what it names, so it must name exactly one resource of the
 * run: an id no stack declares is a typo, and one two stacks declare (a
 * stage deployed per environment) would replace both. An id also named by
 * `--recreate-via-*` is two requests for one resource.
 */
export function checkReplaceResourceOptions(
  options: Pick<
    DeployCommandOptions,
    'replaceResource' | 'recreateViaCcApi' | 'recreateViaSdkProvider'
  >,
  targetStacks: readonly TargetStack[]
): void {
  const ids = options.replaceResource ?? [];
  if (ids.length === 0) return;
  const problems: string[] = [];
  const recreate = new Set(
    [options.recreateViaCcApi ?? [], options.recreateViaSdkProvider ?? []].flat()
  );
  for (const id of new Set(ids)) {
    const declaring = targetStacks
      .filter((stack) => Object.hasOwn(stack.template.Resources ?? {}, id))
      .map((stack) => stack.stackName);
    if (declaring.length === 0) {
      problems.push(
        safeMsg`  - ${id}: no stack of this deploy declares it (the flag reaches a top-level stack's resources only, not a nested stack's)`
      );
    } else if (declaring.length > 1) {
      problems.push(
        safeMsg`  - ${id}: declared by ${declaring.join(', ')}; deploy one of them alone to replace it there`
      );
    }
    if (recreate.has(id)) {
      problems.push(
        safeMsg`  - ${id}: also named by --recreate-via-*, which destroys and recreates it already; pass one`
      );
    }
  }
  if (problems.length === 0) return;
  throw new CdkdError(
    `--replace-resource must name exactly one resource of this deploy:\n${problems.join('\n')}`,
    'REPLACE_RESOURCE_INVALID'
  );
}

/**
 * The `--replace-resource` ids `template` declares, for its own stack's engine
 * (`DeployEngineOptions.replaceResources`); `undefined` when it declares none.
 */
export function replaceResourcesForStack(
  ids: readonly string[] | undefined,
  stackName: string,
  template: { Resources?: Record<string, unknown> }
): { stackName: string; logicalIds: ReadonlySet<string> } | undefined {
  const own = (ids ?? []).filter((id) => Object.hasOwn(template.Resources ?? {}, id));
  return own.length > 0 ? { stackName, logicalIds: new Set(own) } : undefined;
}
