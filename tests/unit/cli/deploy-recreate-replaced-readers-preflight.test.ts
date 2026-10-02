/**
 * go-to-k/cdkd#4383 review: `cdkd deploy`'s pre-lock `--recreate-via-*` check
 * names, in its confirmation prompt, the same-stack resources the recreate
 * would REPLACE. The REFUSAL of a stateful one is the engine's, pinned
 * behaviourally through `DeployEngine.deploy` in
 * `tests/unit/deployment/deploy-engine-recreate-target-dependents.test.ts`
 * (no provider call happens first); the finder in
 * `tests/unit/deployment/recreate-target-readers.test.ts`; the rendering in
 * `tests/unit/cli/commands/recreate-confirm-prompt.test.ts`.
 *
 * What is left is the CLI wiring of the list, and `runStackInner` is too deep
 * to drive (it synthesizes a CDK app, resolves a state bucket and builds an
 * engine), so this reads the SOURCE, the precedent
 * `deploy-recreate-malformed-state-refusal.test.ts` set for the same block.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../../../src/cli/commands/deploy.ts'), 'utf8');

describe('deploy.ts names the replaced readers of a recreate target in its prompt (go-to-k/cdkd#4383)', () => {
  const errorsAt = source.indexOf("throw new CdkdError(errorBlock, 'RECREATE_TARGETS_INVALID');");
  const findAt = source.indexOf('await findReplacedReadersOfRecreateTargets({', errorsAt);
  const promptAt = source.indexOf('await promptRecreateConfirm({', findAt);

  it('reads them after the target validation and before the prompt', () => {
    expect(errorsAt, 'the recreate-target refusal was renamed').toBeGreaterThan(-1);
    expect(findAt, 'the finder no longer follows it').toBeGreaterThan(errorsAt);
    expect(promptAt, 'the prompt no longer follows the finder').toBeGreaterThan(findAt);
  });

  it('for the validated targets, and hands the result to the prompt', () => {
    const call = source.slice(findAt, source.indexOf('});', findAt));
    expect(call).toContain('targetIds: validation.targets.map((t) => t.logicalId)');
    expect(call).toContain('template: stackInfo.template');
    expect(source.slice(findAt - 60, findAt)).toContain('const replacedReaders =');
    const prompt = source.slice(promptAt, source.indexOf('});', promptAt));
    expect(prompt).toMatch(/\breplacedReaders,/);
  });
});
