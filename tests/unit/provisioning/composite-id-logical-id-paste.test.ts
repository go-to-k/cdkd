import { describe, expect, it } from 'vite-plus/test';

import {
  compositeIdFormatMessage,
  compositeIdSeparatorRefusal,
  packCompositeId,
  type CompositeIdFormat,
} from '../../../src/provisioning/composite-id.js';
import {
  CLAUSE_BREAK_PAYLOAD,
  PASTE_PAYLOADS,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

/**
 * go-to-k/cdkd#4107: both composite-id message heads printed the logical id
 * RAW and unquoted. On `cdkd destroy` it is a `state.json` resource key that
 * nothing validates, so a state-bucket writer chose it, and pasting the head
 * with `X$(touch OWNED)` as the id ran the substitution. The pre-fix message
 * RAN, so the paste case below is the primary fence: reverting either head
 * reds it on its own.
 *
 * Asserting that the payload's bytes never appear is what covers the shells
 * the harness does not drive: the skipping arm's zsh glob-qualifier mechanism
 * (go-to-k/cdkd#3950) needs the payload on the line, and it is not there.
 */

const FORMAT: CompositeIdFormat = { label: 'Glue Table', segments: ['databaseName', 'tableName'] };
const TYPE = 'AWS::Glue::Table';
const ID_DESCRIBED = 'a logical id that is not a plain identifier';
const TYPE_DESCRIBED = 'a resource type that is not a plain identifier';

/** A segment list that makes the refusal fire (it carries the separator). */
const REFUSED = [
  { name: 'databaseName', value: 'db' },
  { name: 'tableName', value: 'a|b' },
] as const;

/** Every message the builders print for logical id `logicalId`, labelled by site. */
function messagesFor(logicalId: string): Array<{ site: string; message: string }> {
  let warned: string | undefined;
  packCompositeId(TYPE, logicalId, REFUSED, {
    onRefusal: (message) => {
      warned = message;
    },
  });
  let thrown: string | undefined;
  try {
    packCompositeId(TYPE, logicalId, REFUSED);
  } catch (error) {
    thrown = (error as Error).message;
  }
  return [
    { site: 'separator refusal', message: compositeIdSeparatorRefusal(TYPE, logicalId, REFUSED)! },
    { site: 'pack throw', message: thrown! },
    { site: 'pack replay warning', message: warned! },
    { site: 'decode head', message: compositeIdFormatMessage(FORMAT, logicalId, 'bad') },
    {
      site: 'decode skipping',
      message: compositeIdFormatMessage(FORMAT, logicalId, 'bad', { skipping: true }),
    },
  ];
}

describe('the composite-id message heads never print a raw logical id (go-to-k/cdkd#4107)', () => {
  it('prints a plain logical id exactly as before, hyphenated ones included', () => {
    for (const id of ['MyTable', 'My-Table', 'Table1.v2']) {
      for (const { site, message } of messagesFor(id)) {
        expect(message, `${site}: ${id}`).not.toContain(ID_DESCRIBED);
      }
      expect(compositeIdSeparatorRefusal(TYPE, id, REFUSED)).toMatch(
        new RegExp(`^AWS::Glue::Table ${id.replace('.', '\\.')}: tableName 'a\\|b' contains`)
      );
      expect(compositeIdFormatMessage(FORMAT, id, 'bad')).toBe(
        `Invalid physicalId format for Glue Table ${id}: expected "<databaseName>|<tableName>", got "bad"`
      );
    }
  });

  it('describes every paste payload as the logical id, names none of it, and no pasted span runs', () => {
    const payloads = [...PASTE_PAYLOADS.map((p) => p.value), CLAUSE_BREAK_PAYLOAD.value];
    const rendered: Array<{ value: string; site: string; message: string }> = [];
    for (const value of payloads) {
      for (const m of messagesFor(value)) rendered.push({ value, ...m });
    }
    // Five sites per payload. `messagesFor` always returns five entries, so a
    // site that stopped producing a message is caught by the `any(String)`
    // assertion below, not by this count.
    expect(rendered).toHaveLength(payloads.length * 5);
    withPasteDir((dir) => {
      for (const { value, site, message } of rendered) {
        const label = `${site}: ${value}`;
        expect(message, label).toEqual(expect.any(String));
        expect(message, label).toContain(ID_DESCRIBED);
        expect(message, label).not.toContain(value);
        expect(message, label).not.toContain(JSON.stringify(value));
        expect(spansThatRun(message, dir), label).toEqual([]);
      }
    });
  }, 120_000);

  it('describes a logical id a plain display would still let a shell act on', () => {
    // A leading `-` or `~` is plain to `displayIdent` but is an option or a
    // tilde expansion at the start of a pasted word; a blank or padded id
    // would vanish or spoof a boundary.
    for (const id of ['-rf', '~root', '', ' MyTable', 'My Table', 'a\nb']) {
      for (const { site, message } of messagesFor(id)) {
        expect(message, `${site}: ${JSON.stringify(id)}`).toContain(ID_DESCRIBED);
        // A description added BESIDE the raw id would still let it act; `''` is
        // in every string and ` MyTable` can sit inside the description's text.
        if (id !== '' && id !== ' MyTable') {
          expect(message, `${site}: ${JSON.stringify(id)}`).not.toContain(id);
        }
      }
    }
  });

  it('describes a resource type that is not a plain identifier, and keeps a real one', () => {
    const hostile = 'AWS::Glue::Table$(touch OWNED)';
    const refusal = compositeIdSeparatorRefusal(hostile, 'MyTable', REFUSED)!;
    expect(refusal.startsWith(`${TYPE_DESCRIBED} MyTable: `)).toBe(true);
    expect(refusal).not.toContain('touch OWNED');
    withPasteDir((dir) => {
      expect(spansThatRun(refusal, dir)).toEqual([]);
    });
    for (const type of ['Custom::MyThing', 'Custom::My-Thing', 'AWS::Serverless::Function']) {
      expect(compositeIdSeparatorRefusal(type, 'MyTable', REFUSED)).toMatch(
        new RegExp(`^${type} MyTable: `)
      );
    }
    // Plain to `displayIdent`, but a command path, a tilde expansion, an
    // assignment or an option at the start of a pasted line.
    // The last one fits the type shape but runs past `displayIdent`'s cap, which
    // only the `plainIdentOr` round-trip catches.
    for (const type of [
      './x',
      '~u/x',
      'A=b',
      '-x',
      '/bin/x',
      'AWS::',
      '::Glue',
      'AWS::Glue::Table ',
      `AWS::${'A'.repeat(251)}`,
    ]) {
      expect(compositeIdSeparatorRefusal(type, 'MyTable', REFUSED), JSON.stringify(type)).toMatch(
        new RegExp(`^${TYPE_DESCRIBED} MyTable: `)
      );
    }
  }, 60_000);
});
