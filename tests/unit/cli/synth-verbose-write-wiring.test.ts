/**
 * `cdkd synth --verbose` is the ONLY site in issue go-to-k/cdkd#3489's class
 * that WRITES, and its guard had nine cases while its WIRING had none —
 * reverting the call site to `join(options.output, ...)` left the whole suite
 * green.
 *
 * This drives `synthCommand` itself, so the assertion is about the command,
 * not the helper: a hostile `stackName` must abort the run and create no file
 * outside `--output`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const synthesize = vi.fn();
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize })),
  synthesisStatusMessage: () => 'synthesizing',
}));
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node bin/app.js',
}));
vi.mock('../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: async () => {} }));

import { synthCommand } from '../../../src/cli/commands/synth.js';

function outdir(): { out: string; outer: string } {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-synth-wiring-')));
  const out = join(outer, 'cdk.out');
  mkdirSync(out);
  return { out, outer };
}

/** The one stack `synthesize` hands back, with a caller-chosen name. */
function stack(stackName: string): unknown {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template: { Resources: {} },
    dependencyNames: [],
    messages: [],
  };
}

// No `as never` on the options object. The cast this replaced hid a SIGNATURE
// change: `synthCommand` gained a leading `stackPatterns` parameter
// (go-to-k/cdkd#3550) and this call kept passing options first, so the object
// landed in `stackPatterns`, `options` was `undefined`, and three cases failed
// with `Cannot read properties of undefined` instead of a type error. A cast
// that silences the compiler silences it for the next change too.
const run = (out: string, stackName: string): Promise<void> =>
  synthCommand([], { app: 'node bin/app.js', output: out, verbose: true });

describe('cdkd synth --verbose write wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes an ordinary stack template inside --output', async () => {
    const { out } = outdir();
    synthesize.mockResolvedValue({ stacks: [stack('MainStack')], assemblyDir: out });

    await run(out, 'MainStack');

    expect(readdirSync(out)).toContain('MainStack.template.json');
  });

  it('REFUSES an escaping stackName and writes nothing outside --output', async () => {
    // Reverting the call site to `join(options.output, ...)` makes this pass
    // the write and fail the assertion below — which is the point.
    const { out, outer } = outdir();
    synthesize.mockResolvedValue({ stacks: [stack('../../escaped')], assemblyDir: out });

    await expect(run(out, '../../escaped')).rejects.toThrow(
      /would write its template to a path that resolves to '.*escaped\.template\.json', outside/
    );

    expect(existsSync(join(dirname(outer), 'escaped.template.json'))).toBe(false);
    expect(readdirSync(out)).toEqual([]);
  });

  it('REFUSES a stackName that only escapes one level, from the command', async () => {
    const { out, outer } = outdir();
    synthesize.mockResolvedValue({ stacks: [stack('../sibling')], assemblyDir: out });

    await expect(run(out, '../sibling')).rejects.toThrow(/outside/);

    expect(existsSync(join(outer, 'sibling.template.json'))).toBe(false);
  });
});
