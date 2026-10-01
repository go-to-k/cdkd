import { describe, expect, it } from 'vite-plus/test';

import {
  renderNameHeldElsewhere,
  type ReplacementNameChange,
} from '../../../src/deployment/replacement-name-holder.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

/**
 * go-to-k/cdkd#3950: `renderNameHeldElsewhere` printed the desired and held
 * names as `"${displaySafe(name)}"`. `displaySafe` keeps `"`, `$`, `(` and a
 * backtick, so a name closed cdkd's quote or ran a substitution inside it, and
 * the deploy engine appends `cdkd deploy --replace` to the sentence. Now a
 * plain name keeps its quotes byte-identically and any other is described,
 * like a physical id that is not plain. Each message is rendered inside the
 * deploy engine's remedy and fed WHOLE to the paste harness.
 */

const NAME_DESCRIBED = 'a name (FunctionName) that is not a plain identifier';
const ID_DESCRIBED = 'whose recorded id is not a plain identifier';

const base: ReplacementNameChange = {
  property: 'FunctionName',
  desiredName: 'taken-name',
  heldName: 'my-fn',
  heldProperty: 'FunctionName',
  physicalId: 'my-fn',
};

/**
 * The head line as `deploy-engine-update.ts`'s #3808 refusal throws it, remedy
 * included (the provider text is on its own line since go-to-k/cdkd#4291, and
 * the command carries no backtick wrapper).
 */
function thrown(change: ReplacementNameChange): string {
  return (
    `Fn (AWS::Lambda::Function) requires replacement, but the create-first attempt collided ` +
    `(the provider text is on the Underlying collision line below). ` +
    `${renderNameHeldElsewhere(change)} — so cdkd deploy --replace would delete ` +
    `this resource and still collide. Choose a name no other resource holds, or delete the ` +
    `resource holding it if it is yours.`
  );
}

/** Each field carrying `value`, labelled. */
function changesFor(value: string): Array<{ field: string; change: ReplacementNameChange }> {
  return [
    { field: 'desiredName', change: { ...base, desiredName: value } },
    { field: 'heldName', change: { ...base, heldName: value } },
    { field: 'physicalId', change: { ...base, physicalId: value } },
    { field: 'physicalId, no held name', change: { ...base, heldName: undefined, physicalId: value } },
  ];
}

describe('renderNameHeldElsewhere never puts a name inside cdkd quotes (go-to-k/cdkd#3950)', () => {
  it('keeps plain names quoted, byte-identical to before', () => {
    expect(renderNameHeldElsewhere(base)).toBe(
      'The replacement asks for FunctionName "taken-name", but the resource being replaced ' +
        '(my-fn) holds FunctionName "my-fn" — so "taken-name" is held by ANOTHER existing ' +
        'resource, not by the one being replaced, and deleting the old resource first cannot free it'
    );
    // An ARN physical id is plain and is not cut, past `displayIdent`'s
    // default 255-character cap too.
    const arn = `arn:aws:sqs:us-east-1:123456789012:${'q'.repeat(300)}`;
    expect(renderNameHeldElsewhere({ ...base, physicalId: arn })).toContain(`(${arn})`);
  });

  it('describes every payload, names none of it, and no pasted span runs', () => {
    const rendered: Array<{ label: string; value: string; field: string; message: string }> = [];
    for (const { value } of PASTE_PAYLOADS) {
      for (const { field, change } of changesFor(value)) {
        rendered.push({ label: `${field}: ${value}`, value, field, message: thrown(change) });
      }
    }
    expect(rendered).toHaveLength(PASTE_PAYLOADS.length * 4);
    withPasteDir((dir) => {
      for (const { label, value, field, message } of rendered) {
        expect(message, label).toContain(field.startsWith('physicalId') ? ID_DESCRIBED : NAME_DESCRIBED);
        expect(message, label).not.toContain(value);
        expect(message, label).not.toContain(JSON.stringify(value));
        expect(spansThatRun(message, dir), label).toEqual([]);
      }
    });
  }, 120_000);

  it('does not repeat a described desired name as if it were the name', () => {
    const text = renderNameHeldElsewhere({ ...base, desiredName: 'x"y' });
    expect(text).toContain(`asks for ${NAME_DESCRIBED}, but`);
    expect(text).toContain('— so the requested name is held by ANOTHER');
  });

  it('keeps the second mention on the DESIRED name when both names are described', () => {
    // `that name` would have bound to the described held name nearer to it.
    const text = renderNameHeldElsewhere({ ...base, desiredName: 'x"y', heldName: 'a"b' });
    expect(text).toBe(
      `The replacement asks for ${NAME_DESCRIBED}, but the resource being replaced (my-fn) ` +
        `holds ${NAME_DESCRIBED} — so the requested name is held by ANOTHER existing resource, ` +
        'not by the one being replaced, and deleting the old resource first cannot free it'
    );
  });

  it("describes a name that ends in displayIdent's own cut marker, which round-trips unchanged", () => {
    // `displayIdent` cuts at the stack-ref cap and appends exactly this
    // suffix, so the round-trip alone reads the value as plain.
    const forged = `${'a'.repeat(1152)} [cut: 35 more characters withheld]`;
    for (const change of [
      { ...base, desiredName: forged },
      { ...base, heldName: forged },
      { ...base, physicalId: forged },
    ]) {
      const text = renderNameHeldElsewhere(change);
      expect(text).not.toContain('[cut:');
      expect(text).not.toContain('a'.repeat(1152));
    }
  });

  it('says an empty recorded id is absent rather than not plain', () => {
    expect(renderNameHeldElsewhere({ ...base, physicalId: '' })).toContain(
      'the resource being replaced, which has no recorded id, holds FunctionName "my-fn"'
    );
  });
});
