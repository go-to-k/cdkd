/**
 * The shared containment helper every assembly-supplied path goes through
 * (issue go-to-k/cdkd#3489).
 *
 * `path.join` folds `..`, so an assembly-supplied `templateFile` /
 * `directoryName` / `file` / `additionalMetadataFile` /
 * `Metadata['aws:asset:path']` of `../../etc/passwd` resolved OUT of the
 * assembly directory and was read. The absolute-path tripwire the nested
 * template sites already carried cannot see that shape, and `join` never lets
 * an absolute value escape in the first place — so the two refusals are
 * separate questions and both are pinned here.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  absoluteAssemblyPathEscape,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
  type ResolvedAssemblyPath,
} from '../../../src/utils/assembly-path.js';

function tmp(): string {
  // realpath: macOS spells the temp dir through a `/var -> /private/var`
  // symlink, and the assertions below compare resolved paths.
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'cdkd-assembly-path-')));
}

function refused(r: ResolvedAssemblyPath): Extract<ResolvedAssemblyPath, { contained: false }> {
  if (r.contained) throw new Error('expected a refusal');
  return r;
}

describe('resolveAssemblyPath', () => {
  it('accepts an ordinary sibling file, returning what path.join would have produced', () => {
    const dir = tmp();

    expect(resolveAssemblyPath(dir, 'MainStack.template.json')).toEqual({
      contained: true,
      path: path.join(dir, 'MainStack.template.json'),
    });
  });

  it('accepts a file in a sub-directory, the shape a Stage assembly uses', () => {
    const dir = tmp();

    expect(resolveAssemblyPath(dir, 'assembly-MyStage/manifest.json')).toEqual({
      contained: true,
      path: path.join(dir, 'assembly-MyStage', 'manifest.json'),
    });
  });

  it('accepts a value that normalises back inside', () => {
    const dir = tmp();

    expect(resolveAssemblyPath(dir, 'a/../template.json')).toEqual({
      contained: true,
      path: path.join(dir, 'template.json'),
    });
  });

  it('accepts a sibling whose name merely BEGINS with two dots', () => {
    // A bare `rel.startsWith('..')` would refuse this; the check is
    // separator-aware for exactly that reason.
    const dir = tmp();

    expect(resolveAssemblyPath(dir, '..hidden.json')).toEqual({
      contained: true,
      path: path.join(dir, '..hidden.json'),
    });
  });

  it('refuses a `..` that leaves the directory', () => {
    const dir = tmp();

    expect(resolveAssemblyPath(dir, '../outside.json')).toEqual({
      contained: false,
      escape: 'lexical',
      path: path.join(path.dirname(dir), 'outside.json'),
    });
  });

  it('refuses a `..` chain that leaves it far above', () => {
    const dir = tmp();

    const result = refused(resolveAssemblyPath(dir, '../../../../../../../../etc/passwd'));

    expect(result.escape).toBe('lexical');
    expect(result.path).toBe(path.resolve('/etc/passwd'));
  });

  it('refuses the directory itself, which is never a file to read', () => {
    const dir = tmp();

    for (const candidate of ['.', './', 'sub/..']) {
      const r = refused(resolveAssemblyPath(dir, candidate));
      expect(r.escape).toBe('lexical');
      expect(r.path).toBe(dir);
      // ...and says so, rather than the false "outside '<dir>'" clause the
      // generic wording would print about a path that IS the directory.
      const text = renderAssemblyPathEscape(r, dir);
      expect(text).toContain(`names the directory '${dir}' itself rather than a file inside it`);
      expect(text).not.toContain('outside');
    }
  });

  it('keeps an ABSOLUTE value contained, exactly as path.join does', () => {
    // Not an oversight: `join('/tmp/cdk.out', '/abs/foo')` is
    // `/tmp/cdk.out/abs/foo`, so an absolute value never escapes and remains
    // the ABSOLUTE tripwire's business at the sites that carry one. Were this
    // to change to a `resolve`-style verdict, those sites' two refusals would
    // stop being distinguishable.
    const dir = tmp();

    expect(resolveAssemblyPath(dir, '/etc/passwd')).toEqual({
      contained: true,
      path: path.join(dir, 'etc', 'passwd'),
    });
  });

  it('keeps a Windows drive-letter shape contained on a POSIX host', () => {
    // On POSIX this is an ordinary filename component that no read can follow
    // out of the directory. On Windows `path.win32.join` DOES honour it, so
    // `path.relative` answers an absolute path and containment refuses. Either
    // way the shape stays the absolute tripwire's business at the sites that
    // carry one.
    const dir = tmp();

    expect(resolveAssemblyPath(dir, 'C:\\Windows\\win.ini').contained).toBe(
      process.platform !== 'win32'
    );
  });

  it('keeps a UNC shape contained on BOTH platforms', () => {
    // Measured on Node 24: `path.win32.join('C:\\out', '\\\\server\\share\\x')` is
    // `C:\\out\\server\\share\\x` -- `join` does not honour a UNC root any more
    // than it honours a leading separator, so this never escapes and the
    // verdict is the same on POSIX and on Windows. Asserted as a literal
    // rather than as `platform !== 'win32'`, which was wrong here.
    const dir = tmp();

    expect(resolveAssemblyPath(dir, '\\\\server\\share\\x').contained).toBe(true);
  });

  it('refuses a lexically contained path that leads out through a symbolic link', () => {
    // The hole a lexical check alone leaves: `cdk.out/link -> <outside>` plus a
    // candidate of `link/outside.json` is lexically inside and still reads a
    // file from outside the assembly.
    const outer = tmp();
    const dir = path.join(outer, 'cdk.out');
    mkdirSync(dir);
    writeFileSync(path.join(outer, 'outside.json'), '{}');
    symlinkSync(outer, path.join(dir, 'link'), 'dir');

    expect(resolveAssemblyPath(dir, 'link/outside.json')).toEqual({
      contained: false,
      escape: 'symlink',
      path: path.join(dir, 'link', 'outside.json'),
      realPath: path.join(outer, 'outside.json'),
    });
  });

  it('accepts a symbolic link that stays inside the directory', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'sub', 'real.json'), '{}');
    symlinkSync(path.join('sub', 'real.json'), path.join(dir, 'alias.json'), 'file');

    expect(resolveAssemblyPath(dir, 'alias.json')).toEqual({
      contained: true,
      path: path.join(dir, 'alias.json'),
    });
  });

  it('accepts an assembly directory REACHED through a symbolic link', () => {
    // Both sides are realpath'd, so a user who symlinks `cdk.out` — or macOS
    // spelling `/tmp` as `/private/tmp` — is unaffected.
    const outer = tmp();
    const real = path.join(outer, 'real-out');
    mkdirSync(real);
    writeFileSync(path.join(real, 'MainStack.template.json'), '{}');
    const link = path.join(outer, 'cdk.out');
    symlinkSync(real, link, 'dir');

    expect(resolveAssemblyPath(link, 'MainStack.template.json')).toEqual({
      contained: true,
      path: path.join(link, 'MainStack.template.json'),
    });
  });

  it('accepts a path that does not exist yet, inside a real directory', () => {
    // `cdkd synth --verbose` resolves a file it is about to CREATE.
    const dir = tmp();

    expect(resolveAssemblyPath(dir, 'never-written.json')).toEqual({
      contained: true,
      path: path.join(dir, 'never-written.json'),
    });
  });

  it('refuses a NOT-YET-EXISTING path whose PARENT is a symlink leading out', () => {
    // The write-site case: realpathing only the full candidate leaves
    // `cdk.out/link -> <outside>` plus `link/new.json` lexically contained,
    // and the create lands outside. A link cannot be followed past an absent
    // component, so the deepest EXISTING prefix is what decides.
    const outer = tmp();
    const dir = path.join(outer, 'cdk.out');
    mkdirSync(dir);
    mkdirSync(path.join(outer, 'elsewhere'));
    symlinkSync(path.join(outer, 'elsewhere'), path.join(dir, 'link'), 'dir');

    expect(resolveAssemblyPath(dir, 'link/new.json')).toEqual({
      contained: false,
      escape: 'symlink',
      path: path.join(dir, 'link', 'new.json'),
      realPath: path.join(outer, 'elsewhere', 'new.json'),
    });
  });

  it('accepts a not-yet-existing path under a symlinked directory that stays inside', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'real'));
    symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'dir');

    expect(resolveAssemblyPath(dir, 'link/new.json')).toEqual({
      contained: true,
      path: path.join(dir, 'link', 'new.json'),
    });
  });

  it('accepts a path whose parent does not exist either', () => {
    // Nothing to resolve and nothing that can be opened or created there; the
    // caller's own failure is the better message.
    const dir = tmp();

    expect(resolveAssemblyPath(dir, 'no/such/dir/x.json')).toEqual({
      contained: true,
      path: path.join(dir, 'no', 'such', 'dir', 'x.json'),
    });
  });

  it('refuses a DANGLING symbolic link, which a write follows and creates outside', () => {
    // `fs.realpathSync` throws ENOENT for a dangling link exactly as it does
    // for an absent file, so a realpath-only check calls this contained —
    // while `writeFileSync` follows the link and creates the victim file.
    // Measured before the fix: `cdkd synth --verbose` created it.
    const outer = tmp();
    const dir = path.join(outer, 'cdk.out');
    mkdirSync(dir);
    mkdirSync(path.join(outer, 'victim'));
    symlinkSync(
      path.join(outer, 'victim', 'authorized_keys'),
      path.join(dir, 'Foo.template.json'),
      'file'
    );

    expect(resolveAssemblyPath(dir, 'Foo.template.json')).toEqual({
      contained: false,
      escape: 'symlink',
      path: path.join(dir, 'Foo.template.json'),
      realPath: path.join(outer, 'victim', 'authorized_keys'),
    });
  });

  it('accepts a dangling link whose target stays inside', () => {
    const dir = tmp();
    symlinkSync(path.join(dir, 'not-there-yet.json'), path.join(dir, 'alias.json'), 'file');

    expect(resolveAssemblyPath(dir, 'alias.json')).toEqual({
      contained: true,
      path: path.join(dir, 'alias.json'),
    });
  });

  it('follows a CHAIN of dangling links out of the directory', () => {
    const outer = tmp();
    const dir = path.join(outer, 'cdk.out');
    mkdirSync(dir);
    symlinkSync(path.join(dir, 'b.json'), path.join(dir, 'a.json'), 'file');
    symlinkSync(path.join(outer, 'escaped.json'), path.join(dir, 'b.json'), 'file');

    expect(resolveAssemblyPath(dir, 'a.json')).toMatchObject({
      contained: false,
      escape: 'symlink',
      realPath: path.join(outer, 'escaped.json'),
    });
  });

  it('refuses a missing path SEVERAL levels under an escaping symlinked directory', () => {
    // The climb is not one level: with `sub` absent too, resolving only the
    // immediate parent would leave this contained.
    const outer = tmp();
    const dir = path.join(outer, 'cdk.out');
    mkdirSync(dir);
    mkdirSync(path.join(outer, 'elsewhere'));
    symlinkSync(path.join(outer, 'elsewhere'), path.join(dir, 'link'), 'dir');

    expect(resolveAssemblyPath(dir, 'link/sub/new.json')).toEqual({
      contained: false,
      escape: 'symlink',
      path: path.join(dir, 'link', 'sub', 'new.json'),
      realPath: path.join(outer, 'elsewhere', 'sub', 'new.json'),
    });
  });

  it('refuses a RELATIVE dangling target, resolved against the link\'s real directory', () => {
    // Every other dangling case uses an ABSOLUTE target, for which
    // `path.resolve(realParent, link)` discards `realParent` — so without this
    // the one thing the resolver newly does is exercised by nothing, and
    // replacing `realParent` with the lexical parent passes the suite while
    // accepting a real escape.
    const outer = tmp();
    const dir = path.join(outer, 'cdk.out');
    mkdirSync(dir);
    mkdirSync(path.join(outer, 'outside'));
    symlinkSync(path.join(outer, 'outside'), path.join(dir, 'd'), 'dir');
    symlinkSync('./victim', path.join(outer, 'outside', 'Foo.template.json'), 'file');

    expect(resolveAssemblyPath(dir, 'd/Foo.template.json')).toMatchObject({
      contained: false,
      escape: 'symlink',
      realPath: path.join(outer, 'outside', 'victim'),
    });
  });

  it("resolves a relative dangling target's LEADING `..` against the link's REAL directory", () => {
    // The case that makes `realParent` load-bearing rather than cosmetic. A
    // leading `..` folds against the directory the link REALLY lives in; fold
    // it against the lexical parent instead and this reads as contained, and
    // the write lands outside. Measured both ways.
    const outer = tmp();
    const dir = path.join(outer, 'cdk.out');
    mkdirSync(dir);
    mkdirSync(path.join(outer, 'sub'), { recursive: true });
    symlinkSync(path.join(outer, 'sub'), path.join(dir, 'd'), 'dir');
    symlinkSync('../x.json', path.join(outer, 'sub', 'L.template.json'), 'file');

    expect(resolveAssemblyPath(dir, 'd/L.template.json')).toMatchObject({
      contained: false,
      escape: 'symlink',
      realPath: path.join(outer, 'x.json'),
    });
  });

  it('accepts a relative dangling target that stays inside', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'sub'));
    symlinkSync('./not-there-yet.json', path.join(dir, 'sub', 'alias.json'), 'file');

    expect(resolveAssemblyPath(dir, 'sub/alias.json').contained).toBe(true);
  });

  it('accepts a dangling CHAIN that lands back inside', () => {
    const dir = tmp();
    symlinkSync(path.join(dir, 'b.json'), path.join(dir, 'a.json'), 'file');
    symlinkSync(path.join(dir, 'c.json'), path.join(dir, 'b.json'), 'file');

    expect(resolveAssemblyPath(dir, 'a.json').contained).toBe(true);
  });

  it('refuses a link to the directory ITSELF without the false "outside" clause', () => {
    const dir = tmp();
    symlinkSync(dir, path.join(dir, 'alias.json'), 'dir');

    const r = refused(resolveAssemblyPath(dir, 'alias.json'));
    const text = renderAssemblyPathEscape(r, dir);
    expect(text).toContain(`a symbolic link to the directory '${dir}' itself`);
    expect(text).not.toContain(`outside '${dir}'`);
  });

  it('still decides when the directory itself does not exist yet', () => {
    // The base used to be `realpath`ed alone, so an absent or link-reached
    // directory silenced the WHOLE symlink arm and left only the lexical one.
    const outer = tmp();
    const dir = path.join(outer, 'not-created-yet');

    expect(refused(resolveAssemblyPath(dir, '../escaped.json')).escape).toBe('lexical');
    expect(resolveAssemblyPath(dir, 'x.json').contained).toBe(true);
  });

  it('does not spend its link budget on a deep path of ABSENT components', () => {
    // The hop cap bounds the LINK chain. Charging the climb too made a deep
    // enough absent path exhaust it and silence the arm.
    const outer = tmp();
    const dir = path.join(outer, 'cdk.out');
    mkdirSync(dir);
    mkdirSync(path.join(outer, 'elsewhere'));
    symlinkSync(path.join(outer, 'elsewhere'), path.join(dir, 'link'), 'dir');
    const deep = ['link', ...Array.from({ length: 60 }, () => 'a'), 'x.json'].join('/');

    expect(resolveAssemblyPath(dir, deep).contained).toBe(false);
  });

  it('refuses TWO live links whose target carries a `..` after a symlinked component', () => {
    // The shape that reopened go-to-k/cdkd#3489 through the guard meant to
    // close it. Nothing here is dangling and nothing at the manifest level
    // says `..`: both links are live, and `fs.realpathSync` — a JS walker
    // that folds `..` lexically — answered ENOENT, so the verdict fell
    // through to the model, which folded the same way and called it
    // contained while `readFileSync` returned the file OUTSIDE. Measured:
    // the read produced the secret. `fs.realpathSync.native` is the kernel
    // and resolves it correctly.
    const outer = tmp();
    const dir = path.join(outer, 'cdk.out');
    mkdirSync(dir);
    mkdirSync(path.join(outer, 'outside', 'sub'), { recursive: true });
    writeFileSync(path.join(outer, 'outside', 'c.json'), 'SECRET');
    symlinkSync(path.join(outer, 'outside', 'sub'), path.join(dir, 'a'), 'dir');
    symlinkSync('a/../c.json', path.join(dir, 'LINK.json'), 'file');

    const result = resolveAssemblyPath(dir, 'LINK.json');

    expect(result).toMatchObject({
      contained: false,
      escape: 'symlink',
      realPath: path.join(outer, 'outside', 'c.json'),
    });
    // The verdict must match what a read would actually get.
    expect(readFileSync(path.join(dir, 'LINK.json'), 'utf8')).toBe('SECRET');
  });

  it('RETURNS on the shape that makes the JS realpath walker spin', () => {
    // Same two-link shape with the lexical fold landing on the link itself,
    // which on a case-insensitive filesystem (APFS by default) sent
    // `fs.realpathSync` into an endless loop — uncatchable by `try`/`catch`,
    // so a hand-modified assembly HUNG the commands this guard protects.
    // READ THIS BEFORE DEBUGGING A STUCK SUITE: vitest cannot preempt a
    // SYNCHRONOUS spin, so the `5_000` below does not save the run — a
    // regression to the JS walker HANGS here rather than failing (measured:
    // it burned ten minutes at 99% CPU). The fast fence for the same
    // primitive is the case above, which fails on a wrong ANSWER in
    // milliseconds. This one is kept because the shape is also an escape and
    // deserves to be written down, not because it fails well.
    const outer = tmp();
    const dir = path.join(outer, 'cdk.out');
    mkdirSync(dir);
    mkdirSync(path.join(outer, 'outside', 'sub'), { recursive: true });
    writeFileSync(path.join(outer, 'outside', 'c.json'), 'SECRET');
    symlinkSync(path.join(outer, 'outside', 'sub'), path.join(dir, 'a'), 'dir');
    symlinkSync('a/../c.json', path.join(dir, 'C.json'), 'file');

    expect(resolveAssemblyPath(dir, 'C.json').contained).toBe(false);
  }, 5_000);

  it('gives up on an absurdly deep path instead of overflowing the stack', () => {
    // The climb recurses once per unresolvable component. 20 000 components
    // raised an uncaught `RangeError` — and one thrown inside `tryRealpath`'s
    // own `try` would be swallowed by its `catch` — so a hostile `templateFile`
    // crashed the CLI with a non-actionable trace instead of the refusal.
    // The assertion that matters is that this RETURNS a verdict.
    const dir = tmp();
    const deep = Array.from({ length: 20_000 }, () => 'a').join('/') + '/x.json';

    expect(resolveAssemblyPath(dir, deep).contained).toBe(true);
    // ...and the lexical arm still refuses an escape at the same depth.
    expect(refused(resolveAssemblyPath(dir, `../${deep}`)).escape).toBe('lexical');
  }, 10_000);

  it('terminates on a circular symbolic link instead of recursing forever', () => {
    const dir = tmp();
    symlinkSync(path.join(dir, 'b.json'), path.join(dir, 'a.json'), 'file');
    symlinkSync(path.join(dir, 'a.json'), path.join(dir, 'b.json'), 'file');

    // The OS answers ELOOP, so nothing resolves and the arm stays silent; the
    // caller's own open fails with its own message. The assertion that matters
    // is that this RETURNS.
    expect(resolveAssemblyPath(dir, 'a.json').contained).toBe(true);
  });

  it('resolves a RELATIVE assembly directory against the cwd before judging', () => {
    // `cdkd deploy -a cdk.out` hands the reader a relative directory.
    const rel = path.relative(process.cwd(), tmp());

    expect(resolveAssemblyPath(rel, 'x.json')).toEqual({
      contained: true,
      path: path.resolve(rel, 'x.json'),
    });
    expect(refused(resolveAssemblyPath(rel, '../x.json')).escape).toBe('lexical');
  });
});

describe('renderAssemblyPathEscape', () => {
  it('names the resolved path, the directory it left, and why that is refused', () => {
    const text = renderAssemblyPathEscape(
      { contained: false, escape: 'lexical', path: '/etc/passwd' },
      '/tmp/cdk.out'
    );

    expect(text).toContain("resolves to '/etc/passwd'");
    expect(text).toContain("outside '/tmp/cdk.out'");
    expect(text).toContain('hand-modified or generated by a non-CDK toolchain');
    expect(text).toContain('Refusing to load.');
    // Distinguishable from the absolute tripwire, which the sites keep.
    expect(text).not.toContain('is absolute');
  });

  it('names the symbolic link target on the symlink arm', () => {
    const text = renderAssemblyPathEscape(
      {
        contained: false,
        escape: 'symlink',
        path: '/tmp/cdk.out/link/x.json',
        realPath: '/etc/x.json',
      },
      '/tmp/cdk.out'
    );

    expect(text).toContain("resolves to '/tmp/cdk.out/link/x.json'");
    expect(text).toContain("leads through a symbolic link to '/etc/x.json'");
    expect(text).toContain("outside '/tmp/cdk.out'");
  });

  it('completes "Refusing to ..." with the caller-supplied action', () => {
    const text = renderAssemblyPathEscape(
      { contained: false, escape: 'lexical', path: '/etc/passwd' },
      '/tmp/cdk.out',
      'deploy'
    );

    expect(text).toContain('Refusing to deploy.');
  });

  it('strips terminal-forging characters from every interpolation', () => {
    // This text exists FOR a hand-modified assembly, so the resolved path, the
    // link target and the directory (below a Stage it derives from a manifest
    // `directoryName`) are all attacker-chosen, and `formatError` sanitizes
    // only an error's `cause` (go-to-k/cdkd#3277).
    const text = renderAssemblyPathEscape(
      {
        contained: false,
        escape: 'symlink',
        path: '/tmp/out/p\u009bath',
        realPath: '/etc/re\u202eal',
      },
      '/tmp/d\u0085ir'
    );

    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    expect(text).toContain('p ath');
    expect(text).toContain('re al');
    expect(text).toContain('d ir');
  });

  it('resolves a relative directory for display', () => {
    const text = renderAssemblyPathEscape(
      { contained: false, escape: 'lexical', path: '/etc/passwd' },
      'cdk.out'
    );

    expect(text).toContain(`outside '${path.resolve('cdk.out')}'`);
  });
});

/**
 * `absoluteAssemblyPathEscape` — the sibling for a site that HONOURS an
 * absolute value (go-to-k/cdkd#3494).
 *
 * It lives here rather than only in the local-emulation suite because that is
 * where its twin's cases live, and because it was reachable ONLY through that
 * suite: a predicate whose every case arrives through one caller is a predicate
 * nobody can see the edges of.
 *
 * `resolveAssemblyPath` cannot answer this question at all — its lexical arm
 * uses `path.join`, which folds an absolute candidate INTO the directory, so it
 * reports a path no caller will open.
 */
describe('absoluteAssemblyPathEscape', () => {
  function dirs(): { bound: string; outer: string } {
    const outer = realpathSync(mkdtempSync(path.join(tmpdir(), 'cdkd-abs-escape-')));
    const bound = path.join(outer, 'cdk.out');
    mkdirSync(bound);
    return { bound, outer };
  }

  it('reports no escape for a path inside the bound', () => {
    const { bound } = dirs();
    mkdirSync(path.join(bound, 'asset.abc'));

    expect(absoluteAssemblyPathEscape(bound, path.join(bound, 'asset.abc'))).toBeUndefined();
  });

  it('reports a lexical escape for a path outside the bound', () => {
    const { bound, outer } = dirs();
    const victim = path.join(outer, 'outside');
    mkdirSync(victim);

    expect(absoluteAssemblyPathEscape(bound, victim)).toEqual({
      contained: false,
      escape: 'lexical',
      path: victim,
    });
  });

  it('is SEPARATOR-AWARE, so a sibling sharing a prefix still escapes', () => {
    const { outer } = dirs();
    const bound = path.join(outer, 'a');
    mkdirSync(bound);
    const sibling = path.join(outer, 'ab');
    mkdirSync(sibling);

    expect(absoluteAssemblyPathEscape(bound, sibling)).toMatchObject({ escape: 'lexical' });
  });

  it('treats the BOUND ITSELF as inside, unlike resolveAssemblyPath', () => {
    // The documented divergence. `resolveAssemblyPath` refuses an empty
    // `path.relative` because a directory is never a FILE to read; this
    // predicate's callers mount a DIRECTORY, so the same value is legitimate.
    const { bound } = dirs();

    expect(absoluteAssemblyPathEscape(bound, bound)).toBeUndefined();
    // ...and a trailing separator is the same directory.
    expect(absoluteAssemblyPathEscape(bound, `${bound}${path.sep}`)).toBeUndefined();
    // The sibling still refuses it, which is why both spellings exist.
    expect(resolveAssemblyPath(bound, '.').contained).toBe(false);
  });

  it('reports a symlink escape for a path that is lexically inside', () => {
    const { bound, outer } = dirs();
    const victim = path.join(outer, 'outside');
    mkdirSync(victim);
    const link = path.join(bound, 'link');
    symlinkSync(victim, link, 'dir');

    expect(absoluteAssemblyPathEscape(bound, link)).toEqual({
      contained: false,
      escape: 'symlink',
      path: link,
      realPath: victim,
    });
  });

  it('reports NO escape for a link that leads back to the bound itself', () => {
    const { bound } = dirs();
    const selfLink = path.join(bound, 'self');
    symlinkSync(bound, selfLink, 'dir');

    expect(absoluteAssemblyPathEscape(bound, selfLink)).toBeUndefined();
  });

  it('falls back to the lexical verdict when nothing resolves', () => {
    const { bound } = dirs();

    // Neither operand exists below here, so the symlink arm is silent and the
    // lexical verdict stands — the same fail-quiet `resolveAssemblyPath` has.
    expect(absoluteAssemblyPathEscape(bound, path.join(bound, 'absent', 'deeper'))).toBeUndefined();
  });
});
