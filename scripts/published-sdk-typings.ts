/**
 * The AWS SDK typings AS PUBLISHED, so the refresh job can re-ask a nested-key
 * divergence's own question at the version the registry serves rather than only
 * at the version the lockfile pins
 * (issue [#2819](https://github.com/go-to-k/cdkd/issues/2819)).
 *
 * WHY THIS EXISTS
 * ---------------
 * `sdkVersionLag` in `diagnose-schema-refresh.mjs` already tells the report that
 * a divergent type's client is behind the registry. That reading stops one step
 * short of useful: it hands the maintainer a `npm view` / bump / re-check loop
 * whose every input the job holds.
 * [go-to-k/cdkd#2784](https://github.com/go-to-k/cdkd/pull/2784) escalated four
 * `AWS::Glue::Connection` divergences that way, against `@aws-sdk/client-glue`
 * 3.1018.0 while npm published 3.1127.0.
 *
 * **The answer for those four turned out to be NO** — measured against the
 * published tarballs, neither `AuthenticationConfiguration` nor
 * `OAuth2Properties` declares the members at either version, so the loop the PR
 * prescribed ends in no change. That is the value, not a counterexample: the
 * question gets ANSWERED, and a negative answer is worth as much as a positive
 * one when the next step is a standing allow-list entry.
 *
 * The settling direction is real too, and here is a measured instance:
 * `@aws-sdk/client-codebuild`'s `ProjectEnvironment` gains `hostKernel` between
 * 3.1018.0 and 3.1126.0 — the shape that made a `NESTED_KEY_ALLOW_LIST` entry
 * stale and had to be retired by hand. How OFTEN each direction fires is
 * unmeasured; do not put a ratio here without one.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not answer "does the name exist in the newer client". `sdkVersionLag`'s
 * doc comment already records why that shortcut is wrong, measured on the very
 * same four divergences:
 *
 * > the four live `AWS::Glue::Connection` divergences carry names that ARE
 * > present in both the installed and the latest client, because the checker's
 * > finding is about a specific INTERFACE's members, not about the name existing
 * > somewhere. A grep-level "the newer SDK has it" would have contradicted the
 * > checker and been wrong.
 *
 * So this module returns the same `interface -> members` index
 * {@link collectSdkInterfaces} builds for the checker itself, and the caller
 * re-asks the interface-scoped question verbatim. Using the checker's own reader
 * is the point: a second, looser reader here would be free to disagree with the
 * finding it is supposed to be re-testing.
 *
 * TRUST BOUNDARY
 * --------------
 * The tarballs are first-party `@aws-sdk/*` packages fetched from the same
 * registry `vp install` already uses, and the job already reaches that registry
 * through `npm view`. Only `dist-types/**` `.d.ts` TEXT is read: nothing is
 * installed into the tree, `--ignore-scripts` is passed, and no fetched file is
 * ever executed or imported. The workflow keeps `permissions: {}` and no AWS
 * credentials.
 *
 * Every failure degrades to `undefined`, which the caller renders as "still a
 * decision". A diagnosis must never fail the job it describes, and the safe
 * direction here is to escalate.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectSdkInterfaces } from './gen-nested-key-coverage.ts';
import type { SdkMemberType } from './gen-nested-key-coverage.ts';

/** Runs a command for its side effect, throwing on a non-zero exit. */
export type CommandRunner = (command: string, args: readonly string[]) => void;

const defaultRun: CommandRunner = (command, args) => {
  execFileSync(command, [...args], {
    timeout: 120_000,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
};

/**
 * Download `<client>@<version>` and unpack ONLY its model typings into
 * `workDir`, returning the models directory.
 *
 * `npm pack` rather than an install: it writes a tarball and touches neither
 * `node_modules` nor the lockfile, so the checkout the rest of the run measures
 * is unchanged. `--ignore-scripts` is belt-and-braces — a registry spec runs no
 * lifecycle script on pack — and costs nothing to state.
 *
 * The tarball is located by LISTING `workDir` rather than by predicting npm's
 * filename mangling (`@aws-sdk/client-glue` -> `aws-sdk-client-glue-…tgz`) or by
 * parsing its stdout. The caller owns a freshly-created empty directory, so the
 * single `.tgz` in it is unambiguous, and a name-mangling change upstream cannot
 * silently turn "found it" into "not published".
 *
 * The extract is scoped to `package/dist-types/models` so a malformed or
 * unexpected archive cannot spill files elsewhere in `workDir`, and so an
 * archive laid out differently FAILS rather than yielding a partial read that
 * would answer the caller's question from an empty index.
 *
 * @returns the models directory, or `undefined` on any failure
 */
export function publishedModelsDir(
  client: string,
  version: string,
  workDir: string,
  run: CommandRunner = defaultRun
): string | undefined {
  // The scope and version shapes are enforced HERE, not only at the one caller
  // that happens to produce them. This module's header states "first-party
  // `@aws-sdk/*`" as a property of what it downloads, and until this test
  // existed the only thing making it true was a regex in a different file
  // (`sdkClientVersions`) — so widening that regex, or adding a second caller,
  // would silently turn this into arbitrary-package fetch inside an unattended
  // `contents: write` job. The anchors also make a leading `-` unrepresentable,
  // which is what keeps either operand from being read as a flag by npm.
  if (!/^@aws-sdk\/client-[a-z0-9-]+$/.test(client)) return undefined;
  if (!/^\d+\.\d+\.\d+[\w.+-]*$/.test(version)) return undefined;

  try {
    run('npm', ['pack', `${client}@${version}`, '--ignore-scripts', '--pack-destination', workDir]);
  } catch {
    return undefined;
  }

  let tarball: string | undefined;
  try {
    tarball = readdirSync(workDir).find((f) => f.endsWith('.tgz'));
  } catch {
    return undefined;
  }
  if (tarball === undefined) return undefined;

  const modelsInArchive = 'package/dist-types/models';
  try {
    run('tar', ['-xzf', join(workDir, tarball), '-C', workDir, modelsInArchive]);
  } catch {
    return undefined;
  }

  // Checked rather than assumed: `tar` can exit 0 having warned, and an absent
  // directory reaching `collectSdkInterfaces` throws on `readdirSync` — turning
  // a "could not read" into a crash of the report.
  const modelsDir = join(workDir, ...modelsInArchive.split('/'));
  return existsSync(modelsDir) ? modelsDir : undefined;
}

/**
 * The `interface -> members` index for `<client>@<version>` as the registry
 * publishes it, built with the checker's own {@link collectSdkInterfaces}.
 *
 * The temp directory is removed in a `finally`, including on the failure paths —
 * a job that runs daily and leaks one SDK tarball per divergent client per cycle
 * would fill a runner's disk without anything reporting why.
 *
 * @param materialize injectable so the unit suite exercises the real index
 *   builder against a fixture tree with no network
 */
export function publishedSdkInterfaces(
  client: string,
  version: string,
  materialize: (
    client: string,
    version: string,
    workDir: string
  ) => string | undefined = publishedModelsDir
): Map<string, Map<string, SdkMemberType>> | undefined {
  let workDir: string | undefined;
  try {
    workDir = mkdtempSync(join(tmpdir(), 'cdkd-published-sdk-'));
  } catch {
    return undefined;
  }
  try {
    const modelsDir = materialize(client, version, workDir);
    if (modelsDir === undefined) return undefined;
    return collectSdkInterfaces(modelsDir);
  } catch {
    return undefined;
  } finally {
    // Swallowed on purpose. A `finally` runs AFTER the `catch`, so an EPERM or
    // EBUSY here would propagate past this module's "every failure degrades to
    // undefined" contract, out through the partition, and abort `main()` — which
    // replaces the whole PR body with one sentence and leaves the decision count
    // unwritten. A leaked temp directory is the smaller failure by far.
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* the OS will reclaim it; losing the report would not be reclaimed */
    }
  }
}
