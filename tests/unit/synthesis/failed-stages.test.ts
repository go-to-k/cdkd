/**
 * The two halves of issue go-to-k/cdkd#3482 that are pure functions: the
 * sentence a stack-selection failure appends when a Stage failed to load, and
 * the re-raise that names the Stage a refusal came from.
 *
 * `AssemblyReader`'s own behaviour — which failures propagate and which stay
 * tolerated — is driven through the real reader in
 * `assembly-stage-refusal.test.ts`.
 */
import { describe, it, expect } from 'vite-plus/test';

import { failedStageNote, stageScopedError } from '../../../src/synthesis/failed-stages.js';
import { SynthesisError } from '../../../src/utils/error-handler.js';

const MY_STAGE = { stagePath: 'MyStage', reason: 'ENOENT: no such file or directory' };
const OTHER_STAGE = { stagePath: 'Other', reason: 'Unexpected token }' };
const INNER_STAGE = { stagePath: 'MyStage/Inner', reason: 'ENOENT' };

describe('failedStageNote', () => {
  it('appends nothing when no stage failed — the ordinary run', () => {
    expect(failedStageNote(['MyStage/Api'], [])).toBe('');
    expect(failedStageNote(['MyStage/Api'], undefined)).toBe('');
  });

  it('names the stage a display-path pattern targets, without the hedging lead-in', () => {
    const note = failedStageNote(['MyStage/Api'], [MY_STAGE]);

    expect(note).toContain(
      "Stage 'MyStage' failed to load, so stacks under it are missing from this list " +
        'rather than missing from the app: ENOENT: no such file or directory'
    );
    expect(note).not.toContain('Possibly unrelated');
    // Appended to a head that ends in a stack list, so it opens its own sentence.
    expect(note.startsWith('. ')).toBe(true);
  });

  it('targets a stage through a wildcard segment and through a deeper path', () => {
    expect(failedStageNote(['MyStage/*'], [MY_STAGE])).not.toContain('Possibly unrelated');
    expect(failedStageNote(['My*/Api'], [MY_STAGE])).not.toContain('Possibly unrelated');
    // A pattern naming something under a NESTED stage.
    expect(failedStageNote(['MyStage/Inner/Api'], [INNER_STAGE])).not.toContain(
      'Possibly unrelated'
    );
    // The stage path itself, with no stack under it.
    expect(failedStageNote(['MyStage'], [MY_STAGE])).toContain('Possibly unrelated');
  });

  it('hedges when the pattern is a PHYSICAL stack name, which carries no stage path', () => {
    // `MyStage-Api` is what `cdkd deploy MyStage-Api` matches against, and a
    // stack may override its own stackName — the link cannot be proven.
    const note = failedStageNote(['MyStage-Api'], [MY_STAGE]);

    expect(note).toContain("Possibly unrelated: Stage 'MyStage' failed to load");
  });

  it('hedges when the pattern targets a DIFFERENT stage', () => {
    expect(failedStageNote(['Other/Api'], [MY_STAGE])).toContain(
      "Possibly unrelated: Stage 'MyStage'"
    );
  });

  it('lists every failed stage when none is targeted, and only the targeted ones when some are', () => {
    const all = failedStageNote([], [MY_STAGE, OTHER_STAGE]);
    expect(all).toContain("Stage 'MyStage'");
    expect(all).toContain("Stage 'Other'");

    const targeted = failedStageNote(['MyStage/Api'], [MY_STAGE, OTHER_STAGE]);
    expect(targeted).toContain("Stage 'MyStage'");
    expect(targeted).not.toContain("Stage 'Other'");
  });
});

describe('stageScopedError', () => {
  it('re-raises a refusal with the stage named, keeping the original as the cause', () => {
    const original = new SynthesisError("Stack 'MyStage-Api' has no templateFile property");

    const scoped = stageScopedError('MyStage', original);

    expect(scoped).toBeInstanceOf(SynthesisError);
    expect((scoped as Error).message).toBe(
      "Stage 'MyStage': Stack 'MyStage-Api' has no templateFile property"
    );
    expect((scoped as SynthesisError).cause).toBe(original);
  });

  it('leaves an already-scoped error alone, so the INNERMOST stage is the one named', () => {
    const inner = stageScopedError('MyStage/Inner', new Error('boom'));

    const outer = stageScopedError('MyStage', inner);

    expect(outer).toBe(inner);
    expect((outer as Error).message).toBe("Stage 'MyStage/Inner': boom");
  });

  it('scopes a non-Error throw too', () => {
    expect((stageScopedError('MyStage', 'boom') as Error).message).toBe("Stage 'MyStage': boom");
  });
});
