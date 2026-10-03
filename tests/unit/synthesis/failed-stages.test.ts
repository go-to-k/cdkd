/**
 * The pure functions behind a Stage's errors: the error a Stage whose own
 * manifest cannot be read raises (issue go-to-k/cdkd#3507), and the re-raise
 * that names the Stage a refusal came from (issue go-to-k/cdkd#3482).
 *
 * `AssemblyReader`'s own behaviour is driven through the real reader in
 * `assembly-stage-refusal.test.ts`.
 */
import { describe, it, expect } from 'vite-plus/test';

import { stageLoadError, stageScopedError } from '../../../src/synthesis/failed-stages.js';
import { SynthesisError } from '../../../src/utils/error-handler.js';


describe('stageLoadError (go-to-k/cdkd#3507)', () => {
  it('names the Stage and the reason, and says why the run stops', () => {
    const error = stageLoadError('MyStage', 'ENOENT reading assembly-MyStage/manifest.json');

    expect(error).toBeInstanceOf(SynthesisError);
    expect(error.message).toBe(
      'Stage MyStage failed to load: ENOENT reading assembly-MyStage/manifest.json. ' +
        'Every stack under it is missing from the cloud assembly, so cdkd will not act on the app. ' +
        'Re-synthesize the app so the Stage is written, or point --app at a complete cloud assembly.'
    );
  });

  it('renders a deep hierarchical path in FULL, past displayIdent default cap', () => {
    // Stages nest, so a legitimate path is longer than the 255-code-point
    // default. A cut would print `[cut: N more characters withheld]` in place
    // of the name the user has to act on -- the class
    // `STACK_REF_MAX_CODE_POINTS` exists for.
    const deep = Array.from({ length: 6 }, (_, i) => `Stage${i}${'x'.repeat(50)}`).join('/');
    expect(deep.length).toBeGreaterThan(255);

    const error = stageLoadError(deep, 'ENOENT');

    expect(error.message).toContain(`Stage ${deep} failed to load`);
    expect(error.message).not.toContain('withheld');
  });

  it('quotes a forging Stage path rather than letting it read as a cdkd clause', () => {
    const forging = 'Prod. All stacks deployed successfully';

    expect(stageLoadError(forging, 'ENOENT').message).toMatch(
      new RegExp(`^Stage ${JSON.stringify(forging).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failed`)
    );
  });

  it('is already stage-scoped, so an OUTER Stage re-raising it adds no second name', () => {
    const inner = stageLoadError('Outer/Inner', 'ENOENT');

    expect(stageScopedError('Outer', inner)).toBe(inner);
  });
});

describe('stageScopedError', () => {
  it('re-raises a refusal with the stage named, and carries NO cause', () => {
    const original = new SynthesisError("Stack 'MyStage-Api' has no templateFile property");

    const scoped = stageScopedError('MyStage', original);

    expect(scoped).toBeInstanceOf(SynthesisError);
    expect((scoped as Error).message).toBe(
      "Stage MyStage: Stack 'MyStage-Api' has no templateFile property"
    );
    // The message already embeds the original in full, and `formatError`
    // renders a cause as a `Caused by:` line — which would print the same
    // sentence twice.
    expect((scoped as SynthesisError).cause).toBeUndefined();
  });

  it("carries the ORIGIN's frames, so --verbose points at the refusal not the re-raise", () => {
    // `handleError` logs `error.stack` at debug. Building a fresh error would
    // point that trace at this module instead of at the throw that fired,
    // which is the one thing the trace is for.
    const origin = new SynthesisError('boom');
    const originFrame = (origin.stack ?? '').split('\n')[1];
    expect(originFrame).toBeDefined();

    const scoped = stageScopedError('MyStage', origin) as Error;

    // Header line is this error's own, so it matches the message shown...
    expect((scoped.stack ?? '').split('\n')[0]).toBe('SynthesisError: Stage MyStage: boom');
    // ...and the frames below it are the origin's.
    expect(scoped.stack).toContain(originFrame!);
  });

  it('leaves an already-scoped error alone, so the INNERMOST stage is the one named', () => {
    const inner = stageScopedError('MyStage/Inner', new Error('boom'));

    const outer = stageScopedError('MyStage', inner);

    expect(outer).toBe(inner);
    expect((outer as Error).message).toBe("Stage MyStage/Inner: boom");
  });

  it('scopes a non-Error throw too', () => {
    expect((stageScopedError('MyStage', 'boom') as Error).message).toBe("Stage MyStage: boom");
  });
});
