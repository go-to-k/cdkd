/**
 * `Handler` is template-supplied, and `materializeInlineCode` turns it into a
 * FILENAME inside a temp directory, then `mkdirSync(dirname, {recursive:true})`
 * + `writeFileSync` (issue go-to-k/cdkd#3489).
 *
 * So `Handler: '../../victim/evil.handler'` wrote the assembly's own
 * `Code.ZipFile` body to an arbitrary host path. Measured before the guard:
 * the file was created outside the temp directory. That is an arbitrary WRITE
 * of attacker-chosen content, a different and larger thing than the
 * "cdkd runs their handler in a container" trade the local commands already
 * accept — the container cannot write outside its mounts, this could.
 *
 * `cdkd local invoke` and `cdkd local start-api` each carry their own
 * `materializeInlineCode`; both route through the one guard, so a fix to one
 * twin cannot leave the other open.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  materializeInlineCode as materializeForInvoke,
  resolveInlineCodeFilePath,
} from '../../../src/cli/commands/local-invoke.js';
import { materializeInlineCode as materializeForStartApi } from '../../../src/cli/commands/local-start-api.js';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-inline-code-')));
}

/** What both `materializeInlineCode`s compute before calling the guard. */
function modulePathOf(handler: string): string {
  return handler.substring(0, handler.lastIndexOf('.'));
}

const CONTAINMENT = /resolves to .*, outside .*\./;

describe('resolveInlineCodeFilePath', () => {
  it('refuses a Handler whose module path escapes, and creates nothing', () => {
    const dir = tmp();
    const handler = '../../victim/evil.handler';

    expect(() => resolveInlineCodeFilePath(dir, modulePathOf(handler), '.js', handler)).toThrow(
      /Handler \.\.\/\.\.\/victim\/evil\.handler names a module path that resolves to/
    );
    expect(existsSync(join(dirname(dirname(dir)), 'victim'))).toBe(false);
  });

  it('says it is refusing to MATERIALIZE, with provenance true of a Handler', () => {
    // The generic "CDK emits assembly paths ..." sentence is false here twice
    // over: a Handler is not an assembly path, and the directory is one cdkd
    // just created.
    const dir = tmp();

    let message = '';
    try {
      resolveInlineCodeFilePath(dir, '../x', '.js', '../x.handler');
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toMatch(CONTAINMENT);
    expect(message).toContain("A Handler's module path names a file inside");
    expect(message).toContain('Refusing to materialize it.');
    expect(message).not.toContain('CDK emits assembly paths');
  });

  it('still materializes an ordinary Handler', () => {
    const dir = tmp();

    expect(resolveInlineCodeFilePath(dir, 'index', '.js', 'index.handler')).toBe(
      join(dir, 'index.js')
    );
    expect(resolveInlineCodeFilePath(dir, 'index', '.py', 'index.handler')).toBe(
      join(dir, 'index.py')
    );
  });

  it('still materializes a nested Handler, which CDK emits for a sub-directory module', () => {
    const dir = tmp();

    expect(resolveInlineCodeFilePath(dir, 'lib/handler', '.js', 'lib/handler.main')).toBe(
      join(dir, 'lib', 'handler.js')
    );
  });

  it('still materializes a module path that normalises back inside', () => {
    const dir = tmp();

    expect(resolveInlineCodeFilePath(dir, 'sub/../index', '.js', 'sub/../index.handler')).toBe(
      join(dir, 'index.js')
    );
  });

  it('accepts a module path whose own name begins with dots', () => {
    // `Handler: '...x'` gives a module path of `..`, but the extension is
    // appended before the join, so the component is `...js` — a filename, not
    // a traversal. A bare `startsWith('..')` check would refuse it.
    const dir = tmp();

    expect(resolveInlineCodeFilePath(dir, '..', '.js', '...x')).toBe(join(dir, '...js'));
  });

  it('is unaffected by a base REACHED THROUGH a symbolic link', () => {
    // macOS puts every `mkdtemp` under `/var -> /private/var`, so the real
    // base and the spelled base differ there — the one thing that could have
    // made this guard wrong over a temp-dir base. The helper realpaths both
    // sides, so it is a no-op rather than a false refusal.
    //
    // The link is CONSTRUCTED rather than assumed: `/tmp` is a real directory
    // on Linux, so asserting `realpathSync(tmpdir()) !== tmpdir()` passes on
    // macOS and fails in CI. Build the condition the test is about.
    const outer = tmp();
    const real = join(outer, 'real-base');
    mkdirSync(real);
    const viaLink = join(outer, 'linked-base');
    symlinkSync(real, viaLink, 'dir');
    expect(realpathSync(viaLink)).not.toBe(viaLink);

    expect(resolveInlineCodeFilePath(viaLink, 'index', '.js', 'index.handler')).toBe(
      join(viaLink, 'index.js')
    );
    // ...and an escape through that same base is still refused.
    expect(() => resolveInlineCodeFilePath(viaLink, '../x', '.js', '../x.handler')).toThrow(
      CONTAINMENT
    );
  });
});

describe('both materializeInlineCode twins route through the guard', () => {
  // The two commands keep separate `materializeInlineCode`s (their tmpdir
  // lifecycles differ), so the guard is what must be shared. Asserted
  // BEHAVIOURALLY through each command's own materializer rather than by
  // reading the source: a text check is satisfied by the call appearing in a
  // comment, is blind to any other spelling, and has no negative half.
  const EVIL = '../../victim/evil.handler';

  it('cdkd local invoke refuses an escaping Handler, creates nothing, and leaves no tmpdir', () => {
    const before = new Set(readdirSync(realpathSync(tmpdir())));

    expect(() => materializeForInvoke(EVIL, 'exports.handler = 1;', '.js')).toThrow(
      /names a module path that resolves to/
    );
    expect(existsSync(join(dirname(realpathSync(tmpdir())), 'victim'))).toBe(false);
    // This twin returns its directory rather than registering it with a
    // caller's cleanup set, so a refusal that kept it would leak it for the
    // life of the machine.
    // A bare `startsWith('cdkd-local-invoke-')` also matches the
    // `cdkd-local-invoke-layers-<x>` directories `materializeLambdaLayers`
    // creates, which a parallel vitest worker can land between the snapshot
    // and this read -- reddening the case for an unrelated reason. Excluded by
    // NAME rather than by anchoring on `mkdtemp`'s suffix alphabet: an anchor
    // that stops matching goes FALSE GREEN, which is the worse failure.
    const leaked = readdirSync(realpathSync(tmpdir())).filter(
      (e) =>
        !before.has(e) &&
        e.startsWith('cdkd-local-invoke-') &&
        !e.startsWith('cdkd-local-invoke-layers-')
    );
    expect(leaked).toEqual([]);
  });

  it('leaves no tmpdir when a CONTAINED module path fails the write itself', () => {
    // The other arm of the same `try`. A >255-byte component passes
    // containment -- `resolveAssemblyPath` answers about location, not about
    // what a filesystem will accept -- and then throws ENAMETOOLONG at
    // `mkdirSync` / `writeFileSync`. Same template-supplied `Handler`, same
    // leak if the cleanup covered only the guard.
    const before = new Set(readdirSync(realpathSync(tmpdir())));

    expect(() =>
      materializeForInvoke(`${'a'.repeat(300)}.handler`, 'exports.handler = 1;', '.js')
    ).toThrow();

    const leaked = readdirSync(realpathSync(tmpdir())).filter(
      (e) =>
        !before.has(e) &&
        e.startsWith('cdkd-local-invoke-') &&
        !e.startsWith('cdkd-local-invoke-layers-')
    );
    expect(leaked).toEqual([]);
  });

  it('cdkd local start-api refuses the same Handler, and its tmpdir IS registered for cleanup', () => {
    // The MIRROR of the case above, not a copy of it: `start-api` adds the
    // directory to `tmpDirsOut` BEFORE the guard runs, so its caller's
    // teardown removes it. Registering it is therefore correct, and the
    // assertion is that it happened -- not that it did not.
    const tmpDirs = new Set<string>();

    expect(() => materializeForStartApi(EVIL, 'exports.handler = 1;', '.js', tmpDirs)).toThrow(
      /names a module path that resolves to/
    );
    expect(tmpDirs.size).toBe(1);
    expect([...tmpDirs][0]).toContain('cdkd-local-start-api-');
  });

  it('both still materialize an ordinary Handler, writing inside their own tmpdir', () => {
    const tmpDirs = new Set<string>();

    const invokeDir = materializeForInvoke('index.handler', 'exports.handler = 1;', '.js');
    const apiDir = materializeForStartApi('index.handler', 'exports.handler = 1;', '.js', tmpDirs);

    expect(existsSync(join(invokeDir, 'index.js'))).toBe(true);
    expect(existsSync(join(apiDir, 'index.js'))).toBe(true);
    expect(tmpDirs.has(apiDir)).toBe(true);
  });
});
