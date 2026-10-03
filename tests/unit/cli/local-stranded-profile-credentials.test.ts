/**
 * The sentence every exit path owes when it leaves the mounted AWS credentials
 * file on disk (issue [#3410](https://github.com/go-to-k/cdkd/issues/3410)).
 *
 * ## Two instruments, because one of them cannot see the second site
 *
 * The behavioural half lives in `local-run-task-command-body.test.ts`, which
 * DRIVES the real double-^C handler and reads the bytes it writes to stderr.
 * That is the stronger instrument and it covers exactly one of the two force-
 * exit arms — `cdkd local start-api`'s is inside a long-running server command
 * that no unit test stands up.
 *
 * So this file carries the other two things:
 *
 *  1. the BUILDER's own behaviour, including the `undefined` arm that keeps a
 *     message about a non-existent path off a run that passed no `--profile`;
 *  2. a CLASS fence over the population, so a force-exit arm added to a third
 *     credentials-holding command — or the call deleted from either existing
 *     one — reds here rather than shipping a silent leak.
 *
 * ## The population, and its bound, stated rather than implied
 *
 * The population is `src/cli/commands/` files that write a profile credentials
 * file; the FORCE-EXIT subset is those whose operator-facing text says
 * `force-exit`, which both arms print (`Force-exit on second ^C` /
 * `force-exiting`). That is an anchor on PROSE, and the bound follows from it:
 * a future arm that announces itself with different words is outside this
 * fence. It is anchored there anyway because the alternative — deciding from
 * the source whether a given `process.exit` skips an `await cleanup()` — is a
 * dataflow question — and the repo has just deleted an AST checker that tried
 * to answer one of those (go-to-k/cdkd#3435), so the cheap anchor is the
 * deliberate choice here rather than the lazy one.
 *
 * The floors below are what keep the anchor honest: the membership is asserted
 * BOTH ways (a named file missing from the set reds, and so does an unexpected
 * member), so the fence cannot go quietly empty.
 */
import { describe, expect, it } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { strandedProfileCredentialsNotice } from '../../../src/cli/commands/local-profile-credentials-file.js';
import { forceExitShutdownWarning } from '../../../src/cli/commands/local-start-api.js';

const COMMANDS_DIR = fileURLToPath(new URL('../../../src/cli/commands/', import.meta.url));

function fileAt(name: string): string {
  return readFileSync(path.join(COMMANDS_DIR, name), 'utf8');
}

describe('strandedProfileCredentialsNotice (go-to-k/cdkd#3410)', () => {
  it('names the path and says what to do with it', () => {
    const notice = strandedProfileCredentialsNotice(
      '/tmp/cdkd-profile-creds-abc123/credentials'
    );

    expect(notice).toBeDefined();
    // The PATH is the whole point of the issue: the old force-exit message
    // named no path, so an operator was not told a credentials file existed,
    // let alone where.
    expect(notice).toContain('/tmp/cdkd-profile-creds-abc123/credentials');
    // ...and an instruction, not just a statement of fact.
    expect(notice).toContain('delete');
    expect(notice).toContain('credentials file');
  });

  it('returns undefined when there is no path', () => {
    // The arm that keeps a run with no `--profile` from being told about a
    // path that was never created. Without it every caller would have to
    // re-spell the guard, which is how the three sites came to disagree in the
    // first place.
    expect(strandedProfileCredentialsNotice(undefined)).toBeUndefined();
  });

  it('renders the path through displayIdent, so a hostile one cannot redraw the line', () => {
    // The path is cdkd's own `mkdtemp` output, so sanitization is the identity
    // on every real value — which is precisely why a case is needed: a render
    // that dropped the sanitizer would pass every other assertion in this file
    // forever. Pinned on a value the helper never produces, because the rule
    // belongs to the SURFACE rather than to today's value.
    const ESC = String.fromCharCode(0x1b);
    const notice = strandedProfileCredentialsNotice(`/tmp/x${ESC}[2K\rEvil/credentials`);

    expect(notice).toBeDefined();
    expect(notice, 'a raw ESC reached the message').not.toContain(ESC);
    expect(notice, 'a raw CR reached the message').not.toContain('\r');
    // NOT a bare negative: a render that dropped the path entirely satisfies
    // both lines above while telling the operator nothing.
    expect(notice).toContain('Evil');
  });

  it('is the IDENTITY on a real tmpdir path, so no operator has to un-quote one', () => {
    // The other direction. `displayIdent` JSON-quotes anything it altered or
    // that falls outside its plain-identifier set, and a path that came back
    // quoted would be pasted into `rm` with the quotes attached. `mkdtemp`
    // output is plain ASCII, so it must render bare.
    const real = '/var/folders/9z/T/cdkd-profile-creds-Ab12Cd/credentials';
    const notice = strandedProfileCredentialsNotice(real);

    expect(notice).toContain(` ${real} `);
    expect(notice).not.toContain(`"${real}"`);
  });
});

describe('forceExitShutdownWarning — the start-api arm, made testable (go-to-k/cdkd#3435)', () => {
  // `cdkd local start-api` is a long-running server command that no unit test
  // stands up, so its force-exit arm's only fence was the source-shape rule
  // below. A reviewer MEASURED that predicate: mutating the rendered line to
  // drop `stranded` while keeping the builder call left the whole suite green,
  // with the operator never told the credentials tmpdir exists — go-to-k/cdkd#3410's
  // own defect, re-opened in the arm this PR added by class sweep. The
  // CONCATENATION moved into a pure function so these cases can read it.
  it('names the containers AND the credentials file', () => {
    const line = forceExitShutdownWarning(
      'SIGINT',
      '/tmp/cdkd-profile-creds-abc123/credentials'
    );

    expect(line).toContain('Received second SIGINT');
    // The half that already worked, asserted so a fix to the other half cannot
    // quietly drop it.
    expect(line).toContain('docker ps --filter name=cdkd-local-');
    // The half go-to-k/cdkd#3410 is about.
    expect(line).toContain('/tmp/cdkd-profile-creds-abc123/credentials');
    expect(line).toContain('delete');
  });

  it('says nothing about a credentials file when none was written', () => {
    // The direction that keeps the case above honest: a builder returning a
    // constant would satisfy every assertion there.
    const line = forceExitShutdownWarning('SIGTERM', undefined);

    expect(line).toContain('Received second SIGTERM');
    expect(line).toContain('docker ps --filter name=cdkd-local-');
    expect(line).not.toContain('credentials');
    expect(line).not.toContain('undefined');
    // No trailing separator left behind by the absent clause.
    expect(line.endsWith('clean up.')).toBe(true);
  });

  it('sanitizes a hostile path, like every other site on this surface', () => {
    const ESC = String.fromCharCode(0x1b);
    const line = forceExitShutdownWarning('SIGINT', `/tmp/x${ESC}[2K\rEvil/credentials`);

    expect(line).not.toContain(ESC);
    expect(line).not.toContain('\r');
    expect(line).toContain('Evil');
  });
});

describe('every force-exit arm that can strand the file consults the builder', () => {
  /** `src/cli/commands/` files that write a profile credentials file. */
  function credentialsHoldingCommands(): string[] {
    return readdirSync(COMMANDS_DIR)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => name !== 'local-profile-credentials-file.ts')
      .filter((name) => fileAt(name).includes('writeProfileCredentialsFile'));
  }

  /** ...of those, the ones with an operator-facing force-exit arm. */
  function forceExitCommands(): string[] {
    return credentialsHoldingCommands().filter((name) => /force-exit/i.test(fileAt(name)));
  }

  it('the population is non-empty and contains the commands it is meant to', () => {
    // A fence that selects its population BY the remedy it is checking for is
    // satisfied by the collapse it exists to catch, so the membership is
    // asserted independently, in both directions.
    const population = credentialsHoldingCommands();
    expect(
      population.length,
      'no command writes a profile credentials file — the scan stopped matching'
    ).toBeGreaterThanOrEqual(4);
    for (const expected of [
      'local-run-task.ts',
      'local-start-api.ts',
      'local-invoke.ts',
      'local-invoke-agentcore.ts',
    ]) {
      expect(population, `${expected} dropped out of the population`).toContain(expected);
    }
  });

  it('both known force-exit arms are found, and nothing else is', () => {
    const forceExit = forceExitCommands();
    // Asserted as a SET rather than a floor: a third arm appearing is a
    // decision this file should be read for, and a member disappearing means
    // the anchor stopped matching rather than that the arm went away.
    expect([...forceExit].sort()).toEqual(['local-run-task.ts', 'local-start-api.ts']);
  });

  it('each of them CALLS the shared notice builder', () => {
    const forceExit = forceExitCommands();
    // The FLOOR, so a scan that silently returned nothing cannot report
    // "every member complies".
    expect(forceExit.length).toBeGreaterThanOrEqual(2);
    for (const name of forceExit) {
      // A CALL, not a mention. The first cut asked whether the name appeared
      // anywhere in the file, and a mutation probe measured it GREEN after the
      // call site was replaced by `const stranded = undefined` — the IMPORT
      // line alone satisfied it. That is the allow-list-goes-inert shape: a
      // fence whose predicate a non-load-bearing occurrence can answer. The
      // import is stripped first rather than the call pattern narrowed, so a
      // future `strandedProfileCredentialsNotice(` appearing inside a multi-line
      // import cannot re-open it either.
      const withoutImports = fileAt(name).replace(/import[\s\S]*?from '[^']*';/g, '');
      expect(
        /strandedProfileCredentialsNotice\(/.test(withoutImports),
        `${name} has a force-exit arm but never builds the stranded-credentials notice. ` +
          'process.exit runs no finally, so the mode-0600 credentials tmpdir survives with live ' +
          'AWS credentials in it and nothing tells the operator where it is (go-to-k/cdkd#3410).'
      ).toBe(true);
    }
  });

  it("run-task's force-exit reads the EARLY binding, not the resolved file", () => {
    // A MUTATION PROBE FOUND THIS CASE MISSING. Swapping
    // `strandedProfileCredentialsNotice(credsHostPath)` for
    // `...(channels?.profileCredsFile?.hostPath)` left the DRIVEN behavioural
    // suite green — correctly, because by the time that test's `runEcsTask`
    // mock fires the handler, `channels` is already assigned and the two
    // spellings produce the same string. The two differ only inside
    // `writeProfileCredentialsFile`'s `mkdtemp` -> `await writeFile` window,
    // which no unit test can deliver a signal into.
    //
    // So the WINDOW is covered by the hook's own seam test
    // (`local-profile-credentials-file.test.ts` asserts it fires after the
    // tmpdir exists and before the file does) and the WIRING is covered here.
    // Neither substitutes for the other: the hook could fire perfectly into a
    // binding the handler never reads.
    expect(
      fileAt('local-run-task.ts').includes(
        'strandedProfileCredentialsNotice(credsHostPath)'
      ),
      "local-run-task.ts's force-exit arm no longer reads the binding onDirCreated sets. " +
        'Reading it off `channels` instead is silent: it renders identically once the write ' +
        'has resolved, and names NOTHING for a ^C delivered during it (go-to-k/cdkd#3435).'
    ).toBe(true);
  });

  it("start-api's force-exit arm is WIRED to the builder, not to an inline string", () => {
    // A probed callee says nothing about its WIRING. `forceExitShutdownWarning`
    // is covered above, and nothing else would notice the one `logger.warn` in
    // that arm being handed a literal instead — which is the same shape the
    // reviewer measured on the predicate this replaces.
    //
    // A pinned LINE rather than a looser pattern, and the failure message says
    // what to do about a reformat: the point is that this call site is read by
    // something, and a reformat that reds here is a one-line update.
    expect(
      fileAt('local-start-api.ts').includes(
        'logger.warn(forceExitShutdownWarning(signal, credsHostPath));'
      ),
      "local-start-api.ts's force-exit arm no longer renders through " +
        'forceExitShutdownWarning. If the line was merely reformatted, update this needle; if ' +
        'the composition was inlined, the arm is unfenced again (go-to-k/cdkd#3435).'
    ).toBe(true);
  });

  it('the commands with NO force-exit arm are the ones whose second ^C re-enters cleanup', () => {
    // Scoping, made checkable. `local-invoke.ts` and `local-invoke-agentcore.ts`
    // hold the same file and register the same kind of handler, but their
    // handlers have no early arm at all — a second ^C re-enters the same
    // single-flight `cleanup()` and the file is disposed. They are correct
    // WITHOUT the notice, and stating that here is what keeps a future reader
    // from "fixing" them.
    for (const name of ['local-invoke.ts', 'local-invoke-agentcore.ts']) {
      const source = fileAt(name);
      expect(source, `${name} grew a force-exit arm`).not.toMatch(/force-exit/i);
      // Whitespace-collapsed and brace-tolerant: the two files spell the same
      // handler differently (`.then(() => process.exit(130))` vs a braced
      // body), and a needle that reds on a REFORMAT is one a future author
      // deletes rather than reads.
      const collapsed = source.replace(/\s+/g, ' ');
      expect(
        /void cleanup\(\)\.then\(\(\) => \{? ?process\.exit\(130\)/.test(collapsed),
        `${name} no longer routes its SIGINT handler through cleanup(), so a second ^C may now ` +
          'skip the dispose — it needs the force-exit notice, or its handler restored.'
      ).toBe(true);
    }
  });
});
