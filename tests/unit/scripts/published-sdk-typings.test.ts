/**
 * `scripts/published-sdk-typings.ts` — the published-version SDK typings the
 * refresh job re-asks a nested-key finding against (issue go-to-k/cdkd#2819).
 *
 * Every case runs OFFLINE. The one thing that must not be faked is the index
 * builder: the module's whole claim is that it re-asks the checker's question
 * with the checker's own reader, so `publishedSdkInterfaces` is exercised
 * against real `.d.ts` text on disk and only the DOWNLOAD is injected. A test
 * that stubbed `collectSdkInterfaces` too would pass while the module returned
 * an index shaped unlike the one the checker builds — which is exactly the
 * disagreement the design exists to rule out.
 *
 * `publishedModelsDir`'s arms are all failure-shaped for the same reason: the
 * safe direction on any download problem is `undefined` (escalate the finding),
 * and each way it can go wrong is a separate early return.
 */
import { describe, it, expect } from 'vite-plus/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  publishedModelsDir,
  publishedSdkInterfaces,
} from '../../../scripts/published-sdk-typings.ts';
import type { CommandRunner } from '../../../scripts/published-sdk-typings.ts';

const withTempDir = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-pst-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** The models tree a published `@aws-sdk/client-*` tarball unpacks to. */
const MODELS_IN_ARCHIVE = ['package', 'dist-types', 'models'];

/**
 * A runner that behaves like a successful `npm pack` + `tar`: the pack writes a
 * tarball into the destination, the extract creates the models tree with one
 * `.d.ts`. Both steps are driven off the ACTUAL argv the module passes, so an
 * argument the module stops sending breaks the simulation rather than being
 * silently tolerated.
 */
const succeedingRunner = (declaration: string): { run: CommandRunner; calls: string[][] } => {
  const calls: string[][] = [];
  const run: CommandRunner = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'npm') {
      const dest = args[args.indexOf('--pack-destination') + 1];
      writeFileSync(join(dest, 'aws-sdk-client-glue-9.9.9.tgz'), 'not-really-a-tarball');
      return;
    }
    if (command === 'tar') {
      const dest = args[args.indexOf('-C') + 1];
      const models = join(dest, ...MODELS_IN_ARCHIVE);
      mkdirSync(models, { recursive: true });
      writeFileSync(join(models, 'models_0.d.ts'), declaration);
      return;
    }
    throw new Error(`unexpected command ${command}`);
  };
  return { run, calls };
};

const GLUE_DECLARATION = `
export interface AuthenticationConfiguration {
  AuthenticationType?: string;
  BasicAuthenticationCredentials?: string;
}
export interface OAuth2Properties {
  OAuth2GrantType?: string;
}
`;

describe('publishedModelsDir', () => {
  it('packs without scripts, extracts only the models path, and returns it', () => {
    withTempDir((dir) => {
      const { run, calls } = succeedingRunner(GLUE_DECLARATION);
      const result = publishedModelsDir('@aws-sdk/client-glue', '9.9.9', dir, run);

      expect(result).toBe(join(dir, ...MODELS_IN_ARCHIVE));
      expect(existsSync(result!)).toBe(true);

      const [pack, extract] = calls;
      // The spec is version-PINNED. Resolving `@latest` here instead would ask
      // a different question from the one `sdkVersionLag` reported, so the
      // report could name a version it never read.
      expect(pack).toEqual([
        'npm',
        'pack',
        '@aws-sdk/client-glue@9.9.9',
        '--ignore-scripts',
        '--pack-destination',
        dir,
      ]);
      // Scoped extract: nothing outside the models path may be written, so a
      // malformed archive cannot spill into the work directory.
      expect(extract).toEqual([
        'tar',
        '-xzf',
        join(dir, 'aws-sdk-client-glue-9.9.9.tgz'),
        '-C',
        dir,
        'package/dist-types/models',
      ]);
    });
  });

  it('refuses anything that is not a first-party client at a plain version', () => {
    // The module header states "first-party `@aws-sdk/*`" as a property of what
    // it downloads. Until this test the only thing making that true was a regex
    // in a DIFFERENT file, so a widened matcher or a second caller would have
    // turned an unattended `contents: write` job into arbitrary-package fetch.
    // The anchors are also what makes a leading `-` unrepresentable, so neither
    // operand can be read as a flag by npm.
    withTempDir((dir) => {
      // The runner SUCCEEDS. A throwing one made every case pass for the wrong
      // reason — with the guard deleted the throw was caught and the function
      // returned `undefined` anyway, so the assertions held over no guard at
      // all (measured; the mutation survived). With a succeeding runner, a
      // deleted guard produces a models directory and the case fails.
      const { run, calls } = succeedingRunner(GLUE_DECLARATION);
      for (const [client, version] of [
        ['express', '9.9.9'],
        ['@aws-sdk/client-glue-evil/../../x', '9.9.9'],
        ['@aws-sdk/CLIENT-glue', '9.9.9'],
        ['-rf', '9.9.9'],
        ['@evil/client-glue', '9.9.9'],
        ['@aws-sdk/client-glue', '--registry=http://evil'],
        ['@aws-sdk/client-glue', '-9.9.9'],
        ['@aws-sdk/client-glue', 'latest'],
      ] as const) {
        expect(
          publishedModelsDir(client, version, dir, run),
          `accepted ${client}@${version}`
        ).toBeUndefined();
      }
      // Refused BEFORE any process starts, which is the property that matters:
      // the guard exists so an unattended job never spawns npm against a spec
      // nobody vetted, not merely so the return value is empty afterwards.
      expect(calls, 'a refused spec still spawned a process').toEqual([]);

      // And the shape it exists to allow still passes — otherwise every case
      // above would hold with the guard set to refuse everything.
      expect(publishedModelsDir('@aws-sdk/client-glue', '3.1127.0', dir, run)).toBeDefined();
      expect(calls.map((c) => c[0])).toEqual(['npm', 'tar']);
    });
  });

  it('returns undefined when the pack fails', () => {
    withTempDir((dir) => {
      const run: CommandRunner = (command) => {
        if (command === 'npm') throw new Error('E404 Not Found');
        throw new Error('tar must not run after a failed pack');
      };
      expect(publishedModelsDir('@aws-sdk/client-nope', '9.9.9', dir, run)).toBeUndefined();
    });
  });

  it('returns undefined when the pack produced no tarball', () => {
    withTempDir((dir) => {
      // Exits 0 and writes nothing — the shape a future npm flag change could
      // produce. Without the listing check the module would extract a path it
      // never downloaded.
      const run: CommandRunner = (command) => {
        if (command === 'npm') return;
        throw new Error('tar must not run with no tarball');
      };
      expect(publishedModelsDir('@aws-sdk/client-glue', '9.9.9', dir, run)).toBeUndefined();
    });
  });

  it('returns undefined when the archive has no models path', () => {
    withTempDir((dir) => {
      const run: CommandRunner = (command, args) => {
        if (command === 'npm') {
          const dest = args[args.indexOf('--pack-destination') + 1];
          writeFileSync(join(dest, 'x.tgz'), '');
          return;
        }
        throw new Error('tar: package/dist-types/models: Not found in archive');
      };
      expect(publishedModelsDir('@aws-sdk/client-glue', '9.9.9', dir, run)).toBeUndefined();
    });
  });

  it('returns undefined when tar exits 0 without creating the directory', () => {
    withTempDir((dir) => {
      // bsdtar warns and exits 0 on some malformed archives. Trusting the exit
      // code alone would hand `collectSdkInterfaces` a path whose `readdirSync`
      // THROWS, turning "could not read" into a crash of the whole report.
      const run: CommandRunner = (command, args) => {
        if (command === 'npm') {
          const dest = args[args.indexOf('--pack-destination') + 1];
          writeFileSync(join(dest, 'x.tgz'), '');
        }
      };
      expect(publishedModelsDir('@aws-sdk/client-glue', '9.9.9', dir, run)).toBeUndefined();
    });
  });
});

describe('publishedSdkInterfaces', () => {
  it('builds the checker’s own interface index from the unpacked typings', () => {
    const { run } = succeedingRunner(GLUE_DECLARATION);
    const interfaces = publishedSdkInterfaces('@aws-sdk/client-glue', '9.9.9', (c, v, workDir) =>
      publishedModelsDir(c, v, workDir, run)
    );

    // The interface-scoped question, which is the only one this module exists
    // to answer.
    expect(interfaces?.get('AuthenticationConfiguration')?.has('BasicAuthenticationCredentials')).toBe(
      true
    );
    // Anti-vacuity in the direction that matters: a member the typings do NOT
    // declare must read absent, or every finding would settle.
    expect(interfaces?.get('AuthenticationConfiguration')?.has('CustomAuthenticationCredentials')).toBe(
      false
    );
    // And the name existing on ANOTHER interface must not answer for this one —
    // the exact confusion a name-level search makes.
    expect(interfaces?.get('OAuth2Properties')?.has('BasicAuthenticationCredentials')).toBe(false);
  });

  it('returns undefined when the typings could not be materialized', () => {
    expect(publishedSdkInterfaces('@aws-sdk/client-glue', '9.9.9', () => undefined)).toBeUndefined();
  });

  it('returns undefined rather than throwing when materialization throws', () => {
    expect(
      publishedSdkInterfaces('@aws-sdk/client-glue', '9.9.9', () => {
        throw new Error('network is unreachable');
      })
    ).toBeUndefined();
  });

  it('still returns an index when the work directory cannot be removed', () => {
    // The cleanup lives in a `finally`, which runs AFTER the `catch` — so a
    // throwing remove would escape this module's "every failure degrades to
    // undefined" contract entirely, abort the diagnosis, and replace the PR body
    // with one sentence. A leaked temp directory is the smaller failure.
    //
    // The failure is INJECTED. An earlier version of this case deleted the work
    // directory from inside `materialize` and expected the module's own cleanup
    // to fail on the missing path — but `rmSync(..., { force: true })` does not
    // throw on ENOENT (measured), so the case named the swallow without ever
    // entering it and stayed green with the `catch` deleted.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-pst-locked-'));
    // Captured so the test can clean up what the refusing remover left: the
    // injected failure means the module's own `mkdtemp` directory survives, and
    // a suite that leaks one per run is the thing the sibling case exists to
    // catch. Declared OUTSIDE the `try` and removed in the `finally` — inside,
    // a red assertion throws past the cleanup and leaks it in exactly the state
    // where the suite gets re-run most.
    let leaked: string | undefined;
    try {
      const models = join(dir, ...MODELS_IN_ARCHIVE);
      mkdirSync(models, { recursive: true });
      writeFileSync(join(models, 'models_0.d.ts'), GLUE_DECLARATION);
      let attempted = 0;
      const interfaces = publishedSdkInterfaces(
        '@aws-sdk/client-glue',
        '9.9.9',
        () => models,
        (workDir) => {
          attempted += 1;
          leaked = workDir;
          const err: NodeJS.ErrnoException = new Error('EPERM: operation not permitted');
          err.code = 'EPERM';
          throw err;
        }
      );
      expect(attempted, 'the cleanup was never attempted, so the swallow is unproven').toBe(1);
      expect(interfaces?.get('AuthenticationConfiguration')?.has('BasicAuthenticationCredentials')).toBe(
        true
      );
    } finally {
      if (leaked !== undefined) rmSync(leaked, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes its work directory on both the success and the failure path', () => {
    const seen: string[] = [];

    publishedSdkInterfaces('@aws-sdk/client-glue', '9.9.9', (c, v, workDir) => {
      seen.push(workDir);
      const models = join(workDir, ...MODELS_IN_ARCHIVE);
      mkdirSync(models, { recursive: true });
      writeFileSync(join(models, 'models_0.d.ts'), GLUE_DECLARATION);
      return models;
    });
    publishedSdkInterfaces('@aws-sdk/client-glue', '9.9.9', (c, v, workDir) => {
      seen.push(workDir);
      throw new Error('boom');
    });

    // Two distinct directories were created and neither survives. A daily job
    // leaking one SDK tarball per lagging client per cycle fills a runner's
    // disk with nothing reporting why.
    //
    // Asserted on the directories this call actually created, NOT by listing
    // the system temp root for a `cdkd-published-sdk-*` prefix: that root is
    // shared with every other lane and worktree on the machine, so a concurrent
    // run of this same file would transiently expose one and fail a case about
    // something else entirely.
    expect(new Set(seen).size).toBe(2);
    for (const dir of seen) expect(existsSync(dir)).toBe(false);
  });
});
