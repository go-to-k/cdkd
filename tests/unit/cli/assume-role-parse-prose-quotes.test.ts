import { describe, expect, it } from 'vite-plus/test';

import { normalizeStartApiAssumeRole, parseAssumeRoleToken } from '../../../src/cli/options.js';
import { ROLE_ARN_MAX_CODE_POINTS } from '../../../src/utils/display-safe.js';
import { shellQuote, UNSHOWABLE_VALUE } from '../../../src/utils/pasteable-command.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

/**
 * go-to-k/cdkd#3950: `parseAssumeRoleToken`'s three refusals printed the argv,
 * its logical id and its ARN as `"${displayIdent(...)}"`. `displayIdent`'s JSON
 * boundary does not survive a quote around it, so a `"` closed cdkd's, and
 * `$( )` or a backtick runs inside double quotes regardless. Now a plain
 * operand keeps its `"..."` byte-identically, and any other is shown as its
 * JSON render inside single quotes (`shellBoundedDisplay`), unless that render
 * holds a clause or sentence break, where it is described; an empty operand
 * prints `'<unrenderable>'`. Each refusal is
 * fed WHOLE to the paste harness.
 */

function refusal(raw: string): string {
  try {
    parseAssumeRoleToken(raw, undefined);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected ${JSON.stringify(raw)} to be refused`);
}

const GOOD = 'arn:aws:iam::123456789012:role/Good';

/** The three refusals for `value`, and the operand text each must carry when non-plain. */
function refusalsFor(value: string): Array<{ site: string; message: string; operand: string }> {
  return [
    { site: 'bare form', message: refusal(value), operand: value },
    { site: 'left-hand side', message: refusal(`${value}=${GOOD}`), operand: value },
    { site: 'right-hand side', message: refusal(`Fn=arn:${value}`), operand: `arn:${value}` },
  ];
}

describe('--assume-role refusals never put an operand inside cdkd double quotes (go-to-k/cdkd#3950)', () => {
  it('describes an operand whose render holds a clause break, and no pasted span runs', () => {
    // `—` is not in the list: `displayIdent` folds it to a space, so no render
    // carries one.
    const operands = [
      'x: touch OWNED; # : y',
      'x. touch OWNED; # . y',
      'x -- touch OWNED; # -- y',
      'x? touch OWNED; # ? y',
      'x! touch OWNED; # ! y',
    ];
    withPasteDir((dir) => {
      for (const value of operands) {
        for (const { site, message } of refusalsFor(value)) {
          expect(message, `${site}: ${value}`).toContain(UNSHOWABLE_VALUE);
          expect(message, `${site}: ${value}`).not.toContain('touch OWNED');
          expect(spansThatRun(message, dir), `${site}: ${value}`).toEqual([]);
        }
      }
    });
  }, 120_000);

  it('tests the RENDER for a break, which displayIdent can create', () => {
    // A tab becomes a space, so `x:<TAB>y` renders `x: y`: a break the raw
    // value did not hold.
    expect(refusal('x:\ttouch OWNED; # :\ty')).toContain(
      `Invalid --assume-role value ${UNSHOWABLE_VALUE}: expected`
    );
    // A cut render ends in `[cut: N more characters withheld]`, whose `: ` is a break.
    expect(refusal(`Fn=arn:${'a'.repeat(700)}`)).toContain(
      `right-hand side ${UNSHOWABLE_VALUE} must be`
    );
    // An empty operand renders UNRENDERABLE, shell-quoted.
    expect(refusal('')).toContain("Invalid --assume-role value '<unrenderable>': expected");
  });

  it('shell-bounds the --assume-role-auto refusal global ARN, which isIamRoleArn admitted', () => {
    // `role/[!-~]+` admits `$`, `(`, a backtick and `"`, so this ARN reaches
    // the refusal. A paste-only assertion would not discriminate: the `'` in
    // `Lambda's` earlier in the sentence keeps every whole-sentence span inert.
    const autoRefusal = (arn: string): string => {
      const parsed = parseAssumeRoleToken(arn, undefined);
      try {
        normalizeStartApiAssumeRole(parsed, true);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error(`expected ${arn} to be refused beside --assume-role-auto`);
    };
    // `${IFS}` for the space: `isIamRoleArn`'s `[!-~]` refuses a space, and
    // the shell still splits the substitution's words on it.
    const arn = 'arn:aws:iam::123456789012:role/$(touch${IFS}OWNED)/x';
    const message = autoRefusal(arn);
    expect(message).toContain(`but --assume-role ${shellQuote(JSON.stringify(arn))} also names`);
    // Not the pre-fix bare JSON, which ran from `but --assume-role` onward.
    expect(message).not.toContain(`--assume-role ${JSON.stringify(arn)} also`);
    withPasteDir((dir) => {
      expect(spansThatRun(message.slice(message.indexOf('but --assume-role')), dir)).toEqual([]);
    });
    // A plain ARN is quoted, as the parse refusals quote one, a long one whole:
    // it takes the role-ARN cap, not `displayIdent`'s default 255.
    expect(autoRefusal(GOOD)).toContain(`but --assume-role "${GOOD}" also names`);
    const long = `arn:aws:iam::123456789012:role/${'r'.repeat(300)}`;
    expect(autoRefusal(long)).toContain(`but --assume-role "${long}" also names`);
  }, 120_000);

  it("describes an operand ending in displayIdent's pre-digest cut marker", () => {
    // Exactly the role-ARN cap of plain characters, then the 35-character
    // suffix `displayIdent` appended when it cut 35 before go-to-k/cdkd#4002
    // added the tail digest: the render was the value.
    const forged = `arn:${'a'.repeat(ROLE_ARN_MAX_CODE_POINTS - 4)} [cut: 35 more characters withheld]`;
    expect(forged.length - ROLE_ARN_MAX_CODE_POINTS).toBe(35);
    const message = refusal(`Fn=${forged}`);
    expect(message).not.toContain(`"${forged}"`);
    expect(message).toContain(`right-hand side ${UNSHOWABLE_VALUE} must be`);
  });

  it('shows an empty left-hand side and a padded operand through the same boundary', () => {
    // An empty logical id renders UNRENDERABLE, shell-quoted.
    expect(refusal(`=${GOOD}`)).toContain("left-hand side '<unrenderable>' must be");
    // Padding is trimmed by `displayIdent`, so the render differs from the raw
    // value and takes the JSON-in-single-quotes boundary.
    expect(refusal(' Fn ')).toContain(`Invalid --assume-role value ${shellQuote('"Fn"')}: expected`);
  });

  it('keeps a plain operand quoted, byte-identical to before', () => {
    expect(refusal('Fn')).toContain('Invalid --assume-role value "Fn": expected an IAM role ARN');
    expect(refusal(`Fn-1=${GOOD}`)).toContain('left-hand side "Fn-1" must be');
    expect(refusal('Fn=arn:bad')).toContain('right-hand side "arn:bad" must be');
    // Past `displayIdent`'s default 255-character cap: the argv and the ARN
    // take the role-ARN cap, so a long plain operand is still printed whole.
    const long = `arn:${'a'.repeat(300)}`;
    expect(refusal(long)).toContain(`Invalid --assume-role value "${long}": expected`);
    expect(refusal(`Fn=${long}`)).toContain(`right-hand side "${long}" must be`);
  });

  it('shows every payload single-quoted around its JSON, and no pasted span runs', () => {
    const rendered = PASTE_PAYLOADS.flatMap(({ value }) =>
      refusalsFor(value).map((r) => ({ label: `${r.site}: ${value}`, ...r }))
    );
    expect(rendered).toHaveLength(PASTE_PAYLOADS.length * 3);
    withPasteDir((dir) => {
      for (const { label, message, operand } of rendered) {
        // The boundary itself, not just an inert result: the JSON render
        // wrapped in `shellQuote`, never inside a hand-written `"..."`.
        expect(message, label).toContain(shellQuote(JSON.stringify(operand)));
        expect(message, label).not.toContain(`"${JSON.stringify(operand)}"`);
        expect(spansThatRun(message, dir), label).toEqual([]);
      }
    });
  }, 120_000);
});
