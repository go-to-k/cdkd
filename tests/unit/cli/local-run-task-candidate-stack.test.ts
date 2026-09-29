/**
 * `cdkd local run-task`'s state-source candidate follows the SAME stack rule
 * the task resolver does (issue [#3953](https://github.com/go-to-k/cdkd/issues/3953)).
 *
 * The candidate picks the stack whose state feeds `--from-state` /
 * `--from-cfn-stack`. It matched the target's FIRST segment on its own, so
 * once the resolver learned to reach a Stage stack, a Stage target resolved
 * the task while the candidate (the Stage id) matched nothing -- and the run
 * went ahead with no state source and no image context, silently.
 */
import { describe, expect, it } from 'vite-plus/test';
import { pickCandidateStack } from '../../../src/cli/commands/local-run-task.js';
import { parseEcsTarget } from '../../../src/local/ecs-task-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const stack = (stackName: string, displayName: string): StackInfo =>
  ({ stackName, displayName, template: { Resources: {} } }) as unknown as StackInfo;

const candidate = (target: string, stacks: StackInfo[]): StackInfo | undefined =>
  pickCandidateStack(parseEcsTarget(target), target, stacks);

describe('pickCandidateStack (go-to-k/cdkd#3953)', () => {
  const api = stack('MyStage-Api', 'MyStage/Api');
  const v2 = stack('MyStage-ApiV2', 'MyStage/ApiV2');
  const inner = stack('Outer-Inner-Api', 'Outer/Inner/Api');
  const top = stack('Top', 'Top');

  it('picks the Stage stack for a path-form target, as the resolver does', () => {
    expect(candidate('MyStage/Api/TaskDef', [top, api, v2])).toBe(api);
    expect(candidate('MyStage/ApiV2/TaskDef', [top, api, v2])).toBe(v2);
    expect(candidate('Outer/Inner/Api/TaskDef', [top, inner])).toBe(inner);
  });

  it('keeps the stack a colon form names', () => {
    expect(candidate('MyStage-Api:TaskDef', [top, api])).toBe(api);
    expect(candidate('Top:MyStage/Api/TaskDef', [top, api])).toBe(top);
  });

  it('still routes a head no stack path prefixes through the stack matcher', () => {
    expect(candidate('To*/TaskDef', [api, top])).toBe(top);
  });

  it('keeps single-stack auto-detection for a bare id', () => {
    expect(candidate('TaskDef', [api])).toBe(api);
    expect(candidate('TaskDef', [api, top])).toBeUndefined();
  });
});
