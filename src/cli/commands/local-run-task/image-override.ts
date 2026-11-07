import {
  canonicalizeImageOverrideKeys,
  enforceImageOverrideOrphans,
  parseImageOverrideFlags,
  resolveImageOverrides,
  runImageOverrideBuilds,
} from 'cdk-local/internal';
import { CdkdError } from '../../../utils/error-handler.js';
import type { ResolvedEcsTask } from '../../../local/ecs-task-resolver.js';
import type { LocalRunTaskOptions } from './types.js';

/** The outcome of {@link resolveRunTaskImageOverride}. */
export interface RunTaskImageOverrideResult {
  /**
   * The per-container override map threaded into `runEcsTask` as
   * `imageOverrideByContainer` — present only when an override image was
   * built. Keyed by the representative (essential) container's name.
   */
  imageOverrideByContainer?: Map<string, string>;
  /**
   * True when the representative image is a deployed-registry pin no
   * override covered, so the caller warns that local edits will not apply.
   */
  pinnedUncovered?: boolean;
}

/**
 * The names `--image-override <key>=<dockerfile>` accepts for the task besides
 * the target string itself: the task definition's logical id, its
 * stack-qualified `Stack:LogicalId`, and its construct id (the last
 * `aws:cdk:path` segment that is not `Service` / `Resource` / `Default`). Mirrors
 * cdk-local's `runTaskOverrideKeyAliases`.
 */
function runTaskOverrideKeyAliases(task: ResolvedEcsTask): string[] {
  const id = task.taskDefinitionLogicalId;
  const out = new Set<string>([id, `${task.stack.stackName}:${id}`]);
  const metadata = task.resource.Metadata as Record<string, unknown> | undefined;
  const cdkPath = typeof metadata?.['aws:cdk:path'] === 'string' ? metadata['aws:cdk:path'] : '';
  if (cdkPath.length > 0) {
    const segments = cdkPath.split('/');
    while (
      segments.length > 1 &&
      ['Service', 'Resource', 'Default'].includes(segments[segments.length - 1]!)
    ) {
      segments.pop();
    }
    const tail = segments[segments.length - 1];
    if (tail) out.add(tail);
  }
  out.delete('');
  return [...out];
}

/**
 * Resolve and build a `--image-override` for `cdkd local run-task`
 * (go-to-k/cdkd#5768), over cdk-local's override engine — the same
 * primitives `start-service` / `start-alb` use, and a port of cdk-local's own
 * `resolveRunTaskImageOverride`. A task definition has exactly ONE override
 * target, its representative container (the first essential one, else the
 * first): it is pinned when its image is not a local CDK asset, so the
 * picker and boot-prompt forms map to that single target.
 *
 * Returns early when nothing is pinned AND no override flag was passed, so the
 * common local-asset run pays nothing. Throws when `--strict-overrides` is set
 * and the pinned image stays uncovered, or when a per-service build-input flag
 * is orphaned (`enforceImageOverrideOrphans`).
 */
export async function resolveRunTaskImageOverride(args: {
  task: ResolvedEcsTask;
  target: string;
  options: Pick<
    LocalRunTaskOptions,
    | 'imageOverride'
    | 'imageBuildArg'
    | 'imageBuildSecret'
    | 'imageTarget'
    | 'imageContext'
    | 'interactiveOverrides'
    | 'strictOverrides'
  >;
  cwd?: string;
}): Promise<RunTaskImageOverrideResult> {
  const { task, target, options, cwd } = args;
  const essential = task.containers.find((c) => c.essential) ?? task.containers[0];
  const pinned = essential !== undefined && essential.image.kind !== 'cdk-asset';
  const pinnedTargets = pinned ? [target] : [];
  const pinnedLabels = new Map<string, string>();
  if (pinned) pinnedLabels.set(target, `${task.stack.stackName}/${task.taskDefinitionLogicalId}`);

  const pinnedAliases = new Map<string, string[]>();
  if (pinned) pinnedAliases.set(target, runTaskOverrideKeyAliases(task));
  const rawFlags = canonicalizeImageOverrideKeys(
    parseImageOverrideFlags({
      ...(options.imageOverride && { imageOverride: options.imageOverride }),
      ...(options.imageBuildArg && { imageBuildArg: options.imageBuildArg }),
      ...(options.imageBuildSecret && { imageBuildSecret: options.imageBuildSecret }),
      ...(options.imageTarget && { imageTarget: options.imageTarget }),
      ...(options.imageContext && { imageContext: options.imageContext }),
    }),
    pinnedAliases,
    [target]
  );

  // Nothing pinned AND no override flag => no-op. Per-service build-input
  // flags are not eligible, so the orphan check still names a forgotten
  // `--image-override`.
  if (
    pinnedTargets.length === 0 &&
    rawFlags.explicit.size === 0 &&
    rawFlags.pickerPaths.length === 0 &&
    rawFlags.perService.size === 0
  ) {
    return {};
  }

  const overrides = await resolveImageOverrides({
    rawFlags,
    pinnedTargets,
    pinnedLabels,
    interactiveBootPrompt: true,
    noInteractive: options.interactiveOverrides === false,
    ...(cwd !== undefined ? { cwd } : {}),
  });
  enforceImageOverrideOrphans(rawFlags, overrides);

  const uncovered = pinnedTargets.filter((t) => !overrides.has(t));
  if (options.strictOverrides === true && uncovered.length > 0) {
    throw new CdkdError(
      '--strict-overrides set, but the task definition image is pinned to a deployed registry and ' +
        'no --image-override covered it. Pass --image-override <dockerfile> to rebuild it from local ' +
        'source, or drop --strict-overrides to run the pinned image as-is.',
      'LOCAL_RUN_TASK_STRICT_OVERRIDES'
    );
  }

  if (overrides.size === 0) return { pinnedUncovered: pinned };

  const tags = await runImageOverrideBuilds(overrides);
  const tag = tags.get(target);
  if (tag !== undefined && essential !== undefined) {
    return { imageOverrideByContainer: new Map([[essential.name, tag]]) };
  }
  // Overrides built but none for THIS target (every one named another key):
  // the target stays uncovered, so the caller warns.
  return { pinnedUncovered: pinned && uncovered.length > 0 };
}
