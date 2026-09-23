/**
 * A template's `Resources` key and `Condition` name cannot put a
 * terminal-rewriting sequence on a `TemplateParser` log line (issue
 * [#3479](https://github.com/go-to-k/cdkd/issues/3479)).
 *
 * Both are arbitrary template JSON: nothing upstream validates the characters
 * of a logical id or a condition name. `validateTemplate`'s two refusals print
 * at `error`, DEFAULT verbosity, so an `ESC [ 2 K` + CR payload could erase
 * the line and a `U+2028` forge a second one in a JSON log viewer. Each case
 * reads the emitted BYTES, with a CONTROL showing an ordinary id still renders
 * verbatim (so a sanitizer that ate the whole id cannot pass).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const lines = vi.hoisted(() => [] as string[]);

vi.mock('../../../src/utils/logger.js', () => {
  const push = (m: unknown): void => void lines.push(String(m));
  const fns = {
    setLevel: vi.fn(),
    debug: push,
    info: push,
    warn: push,
    error: push,
    child: () => fns,
  };
  return { getLogger: () => fns };
});

import { TemplateParser } from '../../../src/analyzer/template-parser.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
/** U+2028: tells `displaySafe` apart from a bare `stripControlChars`. */
const LS = String.fromCharCode(0x2028);
/** U+202E: the Trojan-Source right-to-left override. */
const RLO = String.fromCharCode(0x202e);

const EVIL = `Prod${ESC}[2K${CR}Ev${LS}il${RLO}X`;

const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  [ESC, 'ESC'],
  [CR, 'CR'],
  [LS, 'U+2028'],
  [RLO, 'U+202E'],
];

function expectSanitized(text: string, what: string): void {
  for (const [ch, name] of FORBIDDEN) {
    expect(text.includes(ch), `${what} still carries ${name}: ${JSON.stringify(text)}`).toBe(false);
  }
  // `displaySafe` maps each forbidden character to a SPACE, so the RLO
  // between `il` and `X` survives as one.
  expect(text, `${what} lost the printable head`).toContain('Prod');
  expect(text, `${what} lost the printable tail`).toContain('il X');
}

beforeEach(() => {
  lines.length = 0;
});

describe('TemplateParser renders a template-supplied logical id through displaySafe (#3479)', () => {
  const parser = new TemplateParser();

  it('sanitizes "Resource <id> is not an object"', () => {
    expect(parser.validateTemplate({ Resources: { [EVIL]: 'not-an-object' } })).toBe(false);
    const line = lines.find((l) => l.startsWith('Resource ') && l.endsWith(' is not an object'));
    expect(line, `did not reach the arm: ${JSON.stringify(lines)}`).toBeDefined();
    expectSanitized(line ?? '', 'the not-an-object refusal');

    // CONTROL: an ordinary logical id renders verbatim.
    lines.length = 0;
    expect(parser.validateTemplate({ Resources: { MyQueue: 'not-an-object' } })).toBe(false);
    expect(lines).toContain('Resource MyQueue is not an object');
  });

  it('sanitizes "Resource <id> missing Type or Type is not a string"', () => {
    expect(parser.validateTemplate({ Resources: { [EVIL]: { Properties: {} } } })).toBe(false);
    const line = lines.find((l) => l.endsWith(' missing Type or Type is not a string'));
    expect(line, `did not reach the arm: ${JSON.stringify(lines)}`).toBeDefined();
    expectSanitized(line ?? '', 'the missing-Type refusal');

    lines.length = 0;
    expect(parser.validateTemplate({ Resources: { MyQueue: { Type: 42 } } })).toBe(false);
    expect(lines).toContain('Resource MyQueue missing Type or Type is not a string');
  });

  it('sanitizes BOTH the logical id and the condition name on the condition-exclusion line', () => {
    const condition = `Is${EVIL}`;
    const template = {
      Resources: { [EVIL]: { Type: 'AWS::SQS::Queue', Condition: condition } },
    } as unknown as CloudFormationTemplate;
    const result = parser.filterResourcesByCondition(template, { [condition]: false });
    expect(Object.keys(result.Resources)).toEqual([]);
    const line = lines.find((l) => l.startsWith('Excluding resource '));
    expect(line, `did not reach the arm: ${JSON.stringify(lines)}`).toBeDefined();
    expectSanitized(line ?? '', 'the exclusion line');
    // Both renders survived: a sanitizer that dropped either one would leave
    // a single tail.
    expect((line ?? '').split('il X').length - 1).toBe(2);

    lines.length = 0;
    const control = {
      Resources: { MyQueue: { Type: 'AWS::SQS::Queue', Condition: 'IsProd' } },
    } as unknown as CloudFormationTemplate;
    parser.filterResourcesByCondition(control, { IsProd: false });
    expect(lines).toContain('Excluding resource MyQueue — condition IsProd is false');
  });
});
