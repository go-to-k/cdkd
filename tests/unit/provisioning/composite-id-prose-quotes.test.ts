import { describe, expect, it } from 'vite-plus/test';

import {
  compositeIdFormatMessage,
  compositeIdSeparatorRefusal,
  type CompositeIdFormat,
} from '../../../src/provisioning/composite-id.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

/**
 * go-to-k/cdkd#3950: the composite-id refusal and the malformed-id decode
 * message quoted a RAW value, a template segment in `'...'` and a `state.json`
 * physical id in `"..."`. A `'` or a `"` in it closed cdkd's quote, and `$( )`
 * runs inside double quotes anyway, so pasting the sentence ran the payload.
 * Now a value made of plain-identifier characters (plus `|` and `*`) keeps its
 * quotes byte-identically and any other is described. Every message is fed
 * WHOLE to the paste harness, and every one must be inert.
 */

const FORMAT: CompositeIdFormat = { label: 'Glue Table', segments: ['databaseName', 'tableName'] };
const SEGMENT_DESCRIBED = 'tableName (its value is not shown: it is not a plain identifier)';
const ID_DESCRIBED = 'got an id that is not a plain identifier';

/** Every message the two builders print for `value`, labelled by site. */
function messagesFor(value: string): Array<{ site: string; message: string }> {
  return [
    {
      site: 'separator refusal',
      message: compositeIdSeparatorRefusal('AWS::Glue::Table', 'MyTable', [
        { name: 'databaseName', value: 'db' },
        // Carries the separator, or the refusal does not fire.
        { name: 'tableName', value: `a|${value}` },
      ])!,
    },
    { site: 'decode head', message: compositeIdFormatMessage(FORMAT, 'MyTable', value) },
    {
      site: 'decode skipping',
      message: compositeIdFormatMessage(FORMAT, 'MyTable', value, { skipping: true }),
    },
  ];
}

describe('the composite-id messages never put a raw value inside cdkd quotes (go-to-k/cdkd#3950)', () => {
  it('keeps a plain value quoted, byte-identical to before', () => {
    const [refusal, head, skipping] = messagesFor('t');
    expect(refusal!.message).toContain("tableName 'a|t' contains '|'");
    expect(head!.message).toContain('expected "<databaseName>|<tableName>", got "t"');
    expect(skipping!.message).toContain('got "t". Skipping the delete');
    // A masked segment and a blank id keep their spelling too.
    expect(
      compositeIdSeparatorRefusal('AWS::Glue::Table', 'T', [{ name: 'tableName', value: 'a|b' }], () => '***')
    ).toContain("tableName '***' contains");
    expect(compositeIdFormatMessage(FORMAT, 'T', '')).toContain('got ""');
  });

  it('describes every payload, names none of it, and no pasted span runs', () => {
    const rendered: Array<{ value: string; site: string; message: string }> = [];
    for (const { value } of PASTE_PAYLOADS) {
      for (const m of messagesFor(value)) rendered.push({ value, ...m });
    }
    expect(rendered).toHaveLength(PASTE_PAYLOADS.length * 3);
    withPasteDir((dir) => {
      for (const { value, site, message } of rendered) {
        const label = `${site}: ${value}`;
        expect(message, label).toContain(site === 'separator refusal' ? SEGMENT_DESCRIBED : ID_DESCRIBED);
        // The value is not shown in any spelling.
        expect(message, label).not.toContain(value);
        expect(message, label).not.toContain(JSON.stringify(value));
        expect(spansThatRun(message, dir), label).toEqual([]);
      }
    });
  }, 120_000);

  it('quotes exactly the admitted characters, one printable ASCII character at a time', () => {
    // The invariant, not a payload instance: a payload carries several
    // refused characters, so admitting ONE of them (a `'` or a `"`) alone
    // would leave every payload case described and green.
    const admitted = /[A-Za-z0-9:_@./+=,~|*-]/;
    let quoted = 0;
    for (let code = 0x21; code <= 0x7e; code++) {
      const c = String.fromCharCode(code);
      const value = `a${c}b`;
      const head = compositeIdFormatMessage(FORMAT, 'T', value);
      const refusal = compositeIdSeparatorRefusal('AWS::Glue::Table', 'T', [
        { name: 'tableName', value: `|${value}` },
      ]);
      if (admitted.test(c)) {
        quoted++;
        expect(head, value).toContain(`got "${value}"`);
        expect(refusal, value).toContain(`tableName '|${value}'`);
      } else {
        expect(head, value).toContain(ID_DESCRIBED);
        expect(refusal, value).toContain(SEGMENT_DESCRIBED);
      }
    }
    // 62 alphanumerics plus the 12 listed punctuation characters.
    expect(quoted).toBe(74);
  });

  it('describes a value with a line break or a clause separator, which could cut a quote apart', () => {
    for (const value of ['a\nb', 'a: b', 'a. b', 'a — b', '\t']) {
      expect(compositeIdFormatMessage(FORMAT, 'T', value), JSON.stringify(value)).toContain(ID_DESCRIBED);
      expect(
        compositeIdSeparatorRefusal('AWS::Glue::Table', 'T', [{ name: 'tableName', value: `|${value}` }]),
        JSON.stringify(value)
      ).toContain(SEGMENT_DESCRIBED);
    }
  });
});
