import { describe, it, expect } from 'vite-plus/test';
import {
  ROLLBACK_JOURNAL_VERSION,
  parseRollbackJournal,
  UnknownRollbackJournalVersionError,
  type RollbackJournal,
} from '../../../src/types/rollback-journal.js';

describe('parseRollbackJournal', () => {
  const valid: RollbackJournal = {
    journalVersion: ROLLBACK_JOURNAL_VERSION,
    stackName: 'MyStack',
    region: 'us-east-1',
    segments: [
      {
        runId: '20260101T000000000Z-abc',
        timestamp: 1234567890,
        reason: 'no-rollback-failure',
        initialDeploy: true,
        cdkdVersion: '0.262.2',
        operations: [
          { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'p' },
        ],
      },
    ],
  };

  it('round-trips a valid journal', () => {
    const parsed = parseRollbackJournal(JSON.stringify(valid), 'MyStack');
    expect(parsed).toEqual(valid);
  });

  it('throws UnknownRollbackJournalVersionError on a newer version', () => {
    const body = JSON.stringify({ ...valid, journalVersion: ROLLBACK_JOURNAL_VERSION + 1 });
    expect(() => parseRollbackJournal(body, 'MyStack')).toThrow(UnknownRollbackJournalVersionError);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseRollbackJournal('{not json', 'MyStack')).toThrow(/not valid JSON/);
  });

  it('throws when segments is missing', () => {
    const body = JSON.stringify({ journalVersion: 1, stackName: 'X' });
    expect(() => parseRollbackJournal(body, 'X')).toThrow(/segments/);
  });

  it('throws when journalVersion is missing, and SAYS it is missing', () => {
    // The word, not the `<unrenderable>` placeholder: `displaySafe` renders
    // `undefined` empty, so without an explicit mapping a MISSING field would
    // print exactly like an unrenderable one -- the present/absent distinction
    // the placeholder exists to keep.
    const body = JSON.stringify({ stackName: 'X', segments: [] });
    expect(() => parseRollbackJournal(body, 'X')).toThrow(
      "has an invalid 'journalVersion' (undefined)"
    );
  });
});

/**
 * Issue [#3064](https://github.com/go-to-k/cdkd/issues/3064): every value this
 * parser interpolates is attacker-writable. `rollback-journal.json` is a
 * sibling of `state.json` in the same bucket, so anyone with `s3:PutObject`
 * writes it, and the STACK NAME arrives as an S3 key segment.
 *
 * Two dimensions per site, and the second is the one a control-character
 * fixture cannot see. The HOLE is the guard being dropped; the CLASS is
 * `asciiOnly` being swapped for the denylist, which still removes a newline
 * but leaves the invisible formatters (`U+200B`-`U+200D`, `U+FEFF`) and the
 * bidi marks -- `display-safe.ts` names them as the denylist's residual. A
 * zero-width space is what discriminates them; a control byte is in BOTH
 * classes and tells them apart in neither direction.
 *
 * `formatError` prints a non-`CdkdError`'s `message` RAW -- only `cause` is
 * sanitized there (issue #3003) -- so nothing downstream catches these.
 */
describe('parseRollbackJournal refuses to forge a line (issue #3064)', () => {
  const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const INVISIBLE = /[\u200b-\u200f\ufeff]/;

  const messageOf = (body: string, stackName: string): string => {
    try {
      parseRollbackJournal(body, stackName);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error('expected parseRollbackJournal to throw');
  };

  it('flattens the BODY BYTES V8 quotes back in its invalid-JSON message', () => {
    // An ARRAY opener, deliberately: V8 quotes the offending input only in the
    // `Unexpected token 'X', "..."` form, and an object-shaped truncation takes
    // the position-only `SyntaxError` instead, which quotes nothing and makes
    // the case vacuous. The invisible sits EARLY because that quote is
    // truncated at ~18 units.
    const message = messageOf('[1,2,\n  Phys\u200bicalID: arn:forged]', 'S');

    expect(message).not.toMatch(CTRL);
    expect(message).not.toMatch(INVISIBLE);
    // Removed, not censored -- the surrounding text still reads.
    expect(message).toContain('Phys ical');
  });

  it('flattens the STACK NAME, which is an S3 key segment', () => {
    const message = messageOf('{not json', 'Gho\u200bst\n  PhysicalID: arn:forged');

    expect(message).not.toMatch(CTRL);
    expect(message).not.toMatch(INVISIBLE);
    // Three spaces: the zero-width, the newline, and the journal's own two
    // literal ones all flatten to one space each.
    expect(message).toContain('Gho st   PhysicalID: arn:forged');
  });

  it('flattens the journalVersion VALUE it echoes back', () => {
    const body = JSON.stringify({
      journalVersion: '0\n  Forged\u200bRow: yes',
      stackName: 'S',
      segments: [],
    });
    const message = messageOf(body, 'S');

    expect(message).not.toMatch(CTRL);
    expect(message).not.toMatch(INVISIBLE);
    expect(message).toContain('Forged Row: yes');
  });

  it('reports a null journalVersion as `null`, not as absent', () => {
    // `null` is mapped to its word before `displaySafe` sees it: the sanitiser
    // renders `null` empty, so without the mapping the refusal would print
    // `(<unrenderable>)` -- a present, wrong field shown as if it had nothing
    // to show.
    const body = JSON.stringify({ journalVersion: null, stackName: 'S', segments: [] });

    expect(messageOf(body, 'S')).toContain("'journalVersion' (null)");
  });

  it('still says something when the quoted input sanitises away entirely', () => {
    // Why there is no empty-detail fallback: V8's own wording is ASCII prose
    // and survives the allowlist even when every byte it quoted does not, so
    // the detail is never empty and a placeholder branch would be dead.
    const message = messageOf('\u0000\u0001', 'S');

    expect(message).not.toMatch(CTRL);
    expect(message).toMatch(/is not valid JSON: \S/);
  });

  it('flattens the stack name in the newer-version refusal too, and keeps the PROPERTY raw', () => {
    // The fifth throw arm, missed by the first round: it goes through the
    // error CLASS rather than a template literal in the parser. The message
    // is what a terminal renders and is sanitized; the `stackName` property
    // is a value a caller may key on and stays exactly what was passed.
    const hostile = 'Gho\u200bst\n  PhysicalID: arn:forged';
    const body = JSON.stringify({
      journalVersion: ROLLBACK_JOURNAL_VERSION + 1,
      stackName: 'X',
      segments: [],
    });
    let caught: unknown;
    try {
      parseRollbackJournal(body, hostile);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(UnknownRollbackJournalVersionError);
    const err = caught as UnknownRollbackJournalVersionError;
    expect(err.message).not.toMatch(CTRL);
    expect(err.message).not.toMatch(INVISIBLE);
    expect(err.message).toContain("'Gho st   PhysicalID: arn:forged'");
    expect(err.stackName).toBe(hostile);
  });

  it('refuses a journalVersion whose coercion THROWS, instead of throwing a raw TypeError', () => {
    // `{"toString": null}` is reachable through `JSON.parse` of a hand-edited
    // journal. `String(v)` on it throws `TypeError: Cannot convert object to
    // primitive value`, which used to escape the parser in place of the
    // refusal (issue #2947). `displaySafe` absorbs it; the refusal stands.
    const body = '{"journalVersion":{"toString":null},"stackName":"S","segments":[]}';
    const message = messageOf(body, 'S');

    // The positive needle alone discriminates: with `String(v)` restored the
    // `TypeError` escapes `parseRollbackJournal` and `messageOf` returns ITS
    // message, `Cannot convert object to primitive value`, which lacks the
    // needle. (A `not.toContain('TypeError')` was here and was vacuous -- the
    // class name lives on `.name`, never in `.message`.)
    expect(message).toContain("has an invalid 'journalVersion'");
  });

  it('renders a journalVersion that sanitizes to NOTHING as the placeholder', () => {
    // All invisibles: `String(v)` keeps it, the allowlist removes every
    // character, and without the fallback the message would read
    // `('journalVersion' ()` -- a present, wrong field shown as absent.
    const body = JSON.stringify({ journalVersion: '\u200b\u200c', stackName: 'S', segments: [] });

    expect(messageOf(body, 'S')).toContain("'journalVersion' (<unrenderable>)");
  });

  it('flattens the stack name in the two SHAPE refusals as well', () => {
    const hostile = 'Gho\u200bst\n  PhysicalID: arn:forged';

    for (const body of [JSON.stringify(7), JSON.stringify({ journalVersion: 1, stackName: 'X' })]) {
      const message = messageOf(body, hostile);
      expect(message).not.toMatch(CTRL);
      expect(message).not.toMatch(INVISIBLE);
    }
  });
});

/**
 * Issue [#3140](https://github.com/go-to-k/cdkd/issues/3140): the executor
 * keys every lookup on `op.logicalId`, and the parser used to validate no
 * per-op field. A planted non-string id either coerced at each lookup (`123`
 * found the record named `'123'`) or threw a raw `TypeError` at the first one
 * (`{"toString": null}`, the issue #2947 shape). Refused here, once.
 *
 * The refusal names the INDEX and the TYPE, never the value: the last case
 * pins that a hostile value never reaches the message at all, which is a
 * stronger property than "sanitized".
 */
describe('parseRollbackJournal refuses a malformed operation (issue #3140)', () => {
  const op = { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'p' };
  const journalWith = (ops: unknown[], failed?: unknown[]): string =>
    JSON.stringify({
      journalVersion: 1,
      stackName: 'S',
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: ops,
          ...(failed && { failedOperations: failed }),
        },
      ],
    });
  const messageOf = (body: string): string => {
    try {
      parseRollbackJournal(body, 'S');
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return '';
  };

  it('accepts every legitimate operation shape, physicalId present or absent', () => {
    // The shapes cdkd's own writers emit: a CREATE with and without a
    // physical id, an UPDATE carrying `previousState` / `provisionedBy` /
    // `oldResourceRetained`, and a failed op with `attemptedProperties`.
    const { physicalId: _omit, ...withoutPhysical } = op;
    const update = {
      ...op,
      changeType: 'UPDATE',
      provisionedBy: 'sdk',
      oldResourceRetained: false,
      previousState: {
        physicalId: 'p-old',
        resourceType: 'AWS::S3::Bucket',
        properties: { a: 1 },
        attributes: {},
        dependencies: [],
      },
    };
    const failed = { ...op, changeType: 'UPDATE', attemptedProperties: {} };
    const parsed = parseRollbackJournal(journalWith([op, withoutPhysical, update], [failed]), 'S');
    expect(parsed.segments[0]!.operations).toHaveLength(3);
    expect(parsed.segments[0]!.failedOperations).toHaveLength(1);
  });

  it('names the way out in every refusal', () => {
    for (const body of [journalWith([7]), journalWith([{ ...op, logicalId: 1 }]), journalWith('x' as never)]) {
      expect(messageOf(body)).toContain(
        "Remove the stack's rollback-journal.json (next to its state.json) to discard it."
      );
    }
  });

  it.each([
    ['a number', 123, 'number'],
    ['null', null, 'null'],
    ['an object whose toString is not callable', { toString: null }, 'object'],
    ['an array', ['B'], 'array'],
    ['an empty string', '', 'string'],
  ])('refuses a logicalId that is %s, naming the index and the type', (_label, id, kind) => {
    const message = messageOf(journalWith([op, { ...op, logicalId: id }]));
    expect(message).toContain('segments[0].operations[1].logicalId must be a non-empty string');
    expect(message).toContain(`(got ${kind})`);
  });

  it('refuses a MISSING logicalId, saying undefined', () => {
    const { logicalId: _omit, ...noId } = op;
    expect(messageOf(journalWith([noId]))).toContain(
      'segments[0].operations[0].logicalId must be a non-empty string (got undefined)'
    );
  });

  it('refuses a non-string resourceType, changeType, and a present non-string physicalId', () => {
    expect(messageOf(journalWith([{ ...op, resourceType: 7 }]))).toContain(
      'operations[0].resourceType must be a string (got number)'
    );
    expect(messageOf(journalWith([{ ...op, changeType: ['CREATE'] }]))).toContain(
      'operations[0].changeType must be a string (got array)'
    );
    expect(messageOf(journalWith([{ ...op, physicalId: null }]))).toContain(
      'operations[0].physicalId must be a string when present (got null)'
    );
  });

  it('checks failedOperations with the same rule, at their own index', () => {
    expect(messageOf(journalWith([op], [op, { ...op, logicalId: 5 }]))).toContain(
      'segments[0].failedOperations[1].logicalId must be a non-empty string (got number)'
    );
    expect(messageOf(journalWith([op], 'nope' as unknown as unknown[]))).toContain(
      'segments[0].failedOperations must be an array when present (got string).'
    );
  });

  it('refuses an operation that is not an object, naming its type', () => {
    // Without this arm a `null` op would throw a raw TypeError at the first
    // property read, and a `7` would be refused under the wrong field.
    expect(messageOf(journalWith([op, null]))).toContain(
      'segments[0].operations[1] must be an object (got null).'
    );
    expect(messageOf(journalWith([7]))).toContain(
      'segments[0].operations[0] must be an object (got number).'
    );
    expect(messageOf(journalWith([['B']]))).toContain(
      'segments[0].operations[0] must be an object (got array).'
    );
  });

  it.each([
    ['a string', 'x', 'string'],
    ['a number', 7, 'number'],
    ['null', null, 'null'],
    ['an array', [], 'array'],
  ])('refuses a previousState that is %s (issue go-to-k/cdkd#3149)', (_label, prev, k) => {
    // A non-object `previousState` loses the whole desired bag, and every arm
    // coalesces (`desiredProps ?? {}`), so the provider is handed an EMPTY
    // desired bag over a LIVE resource: no handling makes that correct.
    expect(messageOf(journalWith([{ ...op, previousState: prev }]))).toContain(
      `segments[0].operations[0].previousState must be an object when present (got ${k}).`
    );
  });

  it('refuses the nested fields the executor dereferences, each TYPE-when-present', () => {
    const withPrev = (over: Record<string, unknown>): string =>
      journalWith([{ ...op, previousState: { physicalId: 'p', resourceType: 'T', ...over } }]);
    expect(messageOf(withPrev({ physicalId: 7 }))).toContain(
      'previousState.physicalId must be a string when present (got number).'
    );
    expect(messageOf(withPrev({ resourceType: null }))).toContain(
      'previousState.resourceType must be a string when present (got null).'
    );
    // A STRING bag would be handed to the provider verbatim.
    expect(messageOf(withPrev({ properties: 'abc' }))).toContain(
      'previousState.properties must be an object when present (got string).'
    );
    expect(messageOf(withPrev({ properties: [] }))).toContain(
      'previousState.properties must be an object when present (got array).'
    );
    expect(messageOf(withPrev({ properties: null }))).toContain(
      'previousState.properties must be an object when present (got null).'
    );
    expect(messageOf(journalWith([op], [{ ...op, attemptedProperties: 'abc' }]))).toContain(
      'segments[0].failedOperations[0].attemptedProperties must be an object when present (got string).'
    );
    // An ARRAY is the shape `?? current.properties` would pass through as
    // truthy, handing a provider a list where a bag belongs.
    expect(messageOf(journalWith([op], [{ ...op, attemptedProperties: [] }]))).toContain(
      'segments[0].failedOperations[0].attemptedProperties must be an object when present (got array).'
    );
    expect(messageOf(journalWith([op], [{ ...op, attemptedProperties: null }]))).toContain(
      'segments[0].failedOperations[0].attemptedProperties must be an object when present (got null).'
    );
    // `properties` is the completed-op twin, same provider argument position.
    for (const [bad, k] of [
      ['abc', 'string'],
      [[], 'array'],
      [null, 'null'],
    ] as const) {
      expect(messageOf(journalWith([{ ...op, properties: bad }]))).toContain(
        `segments[0].operations[0].properties must be an object when present (got ${k}).`
      );
    }
    // `oldResourceRetained` selects the readopt arm through `??`, so a truthy
    // non-boolean skips the re-create and re-points state at the old id.
    expect(messageOf(journalWith([{ ...op, oldResourceRetained: 'no' }]))).toContain(
      'oldResourceRetained must be a boolean when present (got string).'
    );
  });

  it('TOLERATES what the state boundary tolerates: an absent nested field, and any provisionedBy', () => {
    // `previousState` is forwarded verbatim from the state record, which
    // `parseStateBody` deliberately does not validate (`s3-state-backend.ts`,
    // the placement decision go-to-k/cdkd#2947 recorded and go-to-k/cdkd#3018
    // owns the consequences of). Requiring PRESENCE here, or refusing the
    // `provisionedBy` enum, would refuse a journal cdkd itself wrote from a
    // record the read boundary accepts. An unrecognised `provisionedBy`
    // routes to the SDK provider (`=== 'cc-api'` is the only test any
    // consumer makes) and is then written into state.json BY the rollback --
    // not, as an earlier draft of this comment said, "already held" there.
    // Nothing throws and nothing is mis-provisioned.
    const parsed = parseRollbackJournal(
      journalWith([
        { ...op, previousState: {} },
        { ...op, previousState: { physicalId: 'p' } },
        { ...op, provisionedBy: 'not-a-route' },
        { ...op, provisionedBy: 7 },
        // The sibling fields no check names. `updateReplacePolicy` is read at
        // `rollback-executor.ts`'s `?? prev.updateReplacePolicy === 'Retain'`,
        // so a future tightening there would be silent without this row.
        { ...op, previousState: { updateReplacePolicy: 9, attributes: 'x' } },
      ]),
      'S'
    );
    const ops = parsed.segments[0]!.operations as unknown as Record<string, unknown>[];
    expect(ops).toHaveLength(5);
    // FORWARDED verbatim, not merely accepted. This pins a DECISION -- the
    // parser is a validator, not a normaliser -- rather than the tolerance
    // argument, which is about lockout and which normalising would not
    // break. Keeping it honest about what it costs: today a journal's
    // `provisionedBy` WINS over the state record's at
    // `rollback-executor.ts`'s `op.provisionedBy ?? current.provisionedBy`,
    // so a planted value beats a `cc-api` record and routes to the SDK. A
    // later change that wants to normalise here must decide that precedence
    // at the same time, which is exactly why this is pinned rather than left
    // to be discovered.
    expect(ops.map((o) => o['provisionedBy'])).toEqual([
      undefined,
      undefined,
      'not-a-route',
      7,
      undefined,
    ]);
    expect(ops[0]!['previousState']).toEqual({});
    expect(ops[1]!['previousState']).toEqual({ physicalId: 'p' });
    expect(ops[4]!['previousState']).toEqual({ updateReplacePolicy: 9, attributes: 'x' });
  });

  it('refuses a segment that is not an object and an operations that is not an array', () => {
    const seg = (segments: unknown): string =>
      JSON.stringify({ journalVersion: 1, stackName: 'S', region: 'us-east-1', segments });
    expect(messageOf(seg([7]))).toContain('segments[0] must be an object (got number).');
    expect(messageOf(seg([{ timestamp: 1, reason: 'interrupted', initialDeploy: false }]))).toContain(
      'segments[0].operations must be an array (got undefined).'
    );
    expect(messageOf(seg([{ timestamp: 1, operations: { length: 1 } }]))).toContain(
      'segments[0].operations must be an array (got object).'
    );
  });

  it('never carries the planted value into the message', () => {
    // Not "sanitized": ABSENT. A logicalId that is a number carrying a forged
    // line in its string form (an object with a hostile `toString` cannot even
    // be stringified) -- the message names the index and `number`, nothing
    // else, so there is no rendering step to get wrong.
    const message = messageOf(journalWith([{ ...op, logicalId: 424242 }]));
    expect(message).not.toContain('424242');
    expect(message).toMatch(/\(got number\)\. Remove the stack's rollback-journal\.json/);
  });

  it('is refused BEFORE the executor could key a lookup on it -- the same body a round-5 review planted', () => {
    // `{"toString": null}` used to escape as `TypeError: Cannot convert object
    // to primitive value` from the first `stateResources[op.logicalId]`, after
    // the lock was taken. The parser now refuses it with its own wording.
    const body = journalWith([{ ...op, logicalId: { toString: null } }]);
    expect(() => parseRollbackJournal(body, 'S')).toThrow(/is malformed: segments\[0\]\.operations\[0\]\.logicalId/);
  });
});

describe('parseRollbackJournal — the nested-child fields (issue #3754)', () => {
  const body = (segment: Record<string, unknown>): string =>
    JSON.stringify({
      journalVersion: ROLLBACK_JOURNAL_VERSION,
      stackName: 'P~C',
      region: 'us-east-1',
      segments: [{ timestamp: 0, reason: 'nested-pending-parent', initialDeploy: false, operations: [], ...segment }],
    });

  it('round-trips a pending segment with its previous outputs', () => {
    const segment = {
      runId: 'r',
      previousOutputs: { outputs: { Url: 'u' }, exportNames: ['E'] },
    };
    expect(parseRollbackJournal(body(segment), 'P~C').segments[0]).toMatchObject(segment);
  });

  it('refuses a non-string runId, which a nested revert selects segments by', () => {
    expect(() => parseRollbackJournal(body({ runId: 7 }), 'P~C')).toThrow(
      /segments\[0\]\.runId must be a string when present \(got number\)/
    );
  });

  it('round-trips previousCrossStackReads, and refuses a non-object or a non-array list', () => {
    const reads = { imports: [{ exportName: 'E' }], outputReads: [] };
    expect(
      parseRollbackJournal(body({ previousCrossStackReads: reads }), 'P~C').segments[0]
    ).toMatchObject({ previousCrossStackReads: reads });
    expect(() => parseRollbackJournal(body({ previousCrossStackReads: 'x' }), 'P~C')).toThrow(
      /previousCrossStackReads must be an object \(got string\)/
    );
    expect(() =>
      parseRollbackJournal(body({ previousCrossStackReads: { imports: {} } }), 'P~C')
    ).toThrow(/previousCrossStackReads\.imports must be an array when present \(got object\)/);
    expect(() =>
      parseRollbackJournal(body({ previousCrossStackReads: { outputReads: 1 } }), 'P~C')
    ).toThrow(/previousCrossStackReads\.outputReads must be an array when present/);
    expect(() =>
      parseRollbackJournal(body({ previousCrossStackReads: { imports: [null] } }), 'P~C')
    ).toThrow(/previousCrossStackReads\.imports\[0\] must be an object \(got null\)/);
    expect(() =>
      parseRollbackJournal(
        body({ previousCrossStackReads: { outputReads: [{ sourceRegion: 7 }] } }),
        'P~C'
      )
    ).toThrow(/outputReads\[0\]\.sourceRegion must be a string when present \(got number\)/);
  });

  it('refuses previousOutputs whose outputs is not an object, and a non-string exportNames', () => {
    expect(() => parseRollbackJournal(body({ previousOutputs: { outputs: 'x' } }), 'P~C')).toThrow(
      /previousOutputs\.outputs must be an object \(got string\)/
    );
    expect(() => parseRollbackJournal(body({ previousOutputs: [] }), 'P~C')).toThrow(
      /previousOutputs\.outputs must be an object \(got undefined\)/
    );
    expect(() =>
      parseRollbackJournal(body({ previousOutputs: { outputs: {}, exportNames: [1] } }), 'P~C')
    ).toThrow(/previousOutputs\.exportNames must be a string array/);
  });
});
