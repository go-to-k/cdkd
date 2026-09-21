/**
 * `cdkd synth --verbose` writes `<output>/<stackName>.template.json`, and
 * `stackName` is the assembly manifest's own `properties.stackName` (falling
 * back to the artifact id) — assembly-supplied, like every other value issue
 * go-to-k/cdkd#3489 covers.
 *
 * This is the ONE site in that issue's class that WRITES rather than reads: a
 * name of `../../../../home/<user>/.aws/config` put attacker-chosen JSON at
 * `~/.aws/config.template.json`, clobbering whatever `<name>.template.json`
 * sibling it could reach. The filename suffix constrains the damage but does
 * not contain the path.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveVerboseTemplatePath } from '../../../src/cli/commands/synth.js';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-synth-outdir-')));
}

function outdir(): { out: string; outer: string } {
  const outer = tmp();
  const out = join(outer, 'cdk.out');
  mkdirSync(out);
  return { out, outer };
}

describe('resolveVerboseTemplatePath', () => {
  it('refuses a stack name that escapes the output directory', () => {
    const { out } = outdir();

    expect(() => resolveVerboseTemplatePath(out, '../../evil')).toThrow(
      /Stack '\.\.\/\.\.\/evil' would write its template to a path that resolves to '.*evil\.template\.json', outside/
    );
  });

  it('says it is refusing to WRITE, not to load', () => {
    const { out } = outdir();

    expect(() => resolveVerboseTemplatePath(out, '../evil')).toThrow(/Refusing to write it\./);
  });

  it('refuses a name that stays inside lexically but leads out through a symlink', () => {
    const { out, outer } = outdir();
    mkdirSync(join(outer, 'elsewhere'));
    symlinkSync(join(outer, 'elsewhere'), join(out, 'link'), 'dir');

    expect(() => resolveVerboseTemplatePath(out, 'link/Stack')).toThrow(
      /leads through a symbolic link to '.*elsewhere\/Stack\.template\.json', outside/
    );
  });

  it('refuses a DANGLING symbolic link at the template path itself', () => {
    // The shape this site is uniquely exposed to: the file it writes does not
    // exist yet, so `realpathSync` throws ENOENT for a link that DOES exist,
    // and a realpath-only check called it contained while `writeFileSync`
    // followed the link and created the victim file. Measured before the fix.
    const { out, outer } = outdir();
    mkdirSync(join(outer, 'victim'));
    symlinkSync(join(outer, 'victim', 'authorized_keys'), join(out, 'Foo.template.json'), 'file');

    expect(() => resolveVerboseTemplatePath(out, 'Foo')).toThrow(
      /leads through a symbolic link to '.*victim\/authorized_keys', outside/
    );
  });

  it('does not create the victim file when it refuses', () => {
    // The refusal is only worth anything if it precedes the write; this pins
    // that `resolveVerboseTemplatePath` is consulted for the PATH and throws
    // rather than returning one the caller then writes.
    const { out, outer } = outdir();
    mkdirSync(join(outer, 'victim'));
    symlinkSync(join(outer, 'victim', 'authorized_keys'), join(out, 'Foo.template.json'), 'file');

    expect(() => resolveVerboseTemplatePath(out, 'Foo')).toThrow();
    expect(existsSync(join(outer, 'victim', 'authorized_keys'))).toBe(false);
  });

  it('refuses ANY symbolic link at the template path, whatever it points at', () => {
    // The kernel check, not the path model. `resolveAssemblyPath` is a model
    // for a path that does not exist yet, and its known edge is `..` INSIDE an
    // unresolvable link's target: with `cdk.out/a -> <outside>/sub` and
    // `C.template.json -> a/../c.json`, the model folds lexically and answers
    // contained while the kernel lands the write on `<outside>/c.json`.
    // Measured before this guard: the victim file was created. `lstat` does
    // not follow the link, so the shape does not have to be enumerated.
    const { out, outer } = outdir();
    mkdirSync(join(outer, 'sub'), { recursive: true });
    symlinkSync(join(outer, 'sub'), join(out, 'a'), 'dir');
    symlinkSync('a/../c.json', join(out, 'C.template.json'), 'file');

    expect(() => resolveVerboseTemplatePath(out, 'C')).toThrow(
      /would write its template over a symbolic link at '.*C\.template\.json'/
    );
    expect(existsSync(join(outer, 'c.json'))).toBe(false);
  });

  it('refuses a symbolic link even when it points back INSIDE the output directory', () => {
    // Deliberately stricter than containment: cdkd writes a regular file here,
    // so a link is a signal about the assembly regardless of its target, and a
    // rule with no exceptions is one nothing has to reason around.
    const { out } = outdir();
    writeFileSync(join(out, 'real.json'), '{}');
    symlinkSync(join(out, 'real.json'), join(out, 'Inside.template.json'), 'file');

    expect(() => resolveVerboseTemplatePath(out, 'Inside')).toThrow(/over a symbolic link/);
  });

  it('still writes over an ordinary REGULAR file, so a re-run is unaffected', () => {
    const { out } = outdir();
    writeFileSync(join(out, 'MainStack.template.json'), '{"old":true}');

    expect(resolveVerboseTemplatePath(out, 'MainStack')).toBe(
      join(out, 'MainStack.template.json')
    );
  });

  it('still writes an ordinary stack name beside the assembly', () => {
    const { out } = outdir();

    expect(resolveVerboseTemplatePath(out, 'MainStack')).toBe(
      join(out, 'MainStack.template.json')
    );
  });

  it('still allows a hierarchical name that stays inside', () => {
    // A Stage stack's physical name has no `/`, but an artifact id used as the
    // fallback can carry a sub-path; it must keep working while it stays in.
    const { out } = outdir();

    expect(resolveVerboseTemplatePath(out, 'sub/../MainStack')).toBe(
      join(out, 'MainStack.template.json')
    );
  });
});
