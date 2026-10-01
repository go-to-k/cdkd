import { describe, expect, it } from 'vite-plus/test';
import {
  displayAwsMessage,
  displaySafe,
  displaySafeMultiline,
} from '../../../src/utils/display-safe.js';

/**
 * go-to-k/cdkd#3479: `displaySafeMultiline` strips the line-FORGING class while
 * keeping the newlines a CDK annotation legitimately carries.
 */
describe('displaySafeMultiline', () => {
  it('is the identity on legitimate multi-line text, tabs and non-ASCII included', () => {
    const text = 'First line\n\tindented: café\nThird line ✓';
    expect(displaySafeMultiline(text)).toBe(text);
    // The contrast that makes the helper necessary: displaySafe joins lines.
    expect(displaySafe(text)).not.toContain('\n');
  });

  it('normalises CRLF to LF instead of leaving a space before each break', () => {
    expect(displaySafeMultiline('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it.each([
    ['a bare CR', 'ok\rFORGED', 'ok FORGED'],
    ['NEL', 'ok\u0085FORGED', 'ok FORGED'],
    ['a lone C1 byte', 'ok\u0090 FORGED', 'ok  FORGED'],
    ['U+2028', 'ok\u2028FORGED', 'ok FORGED'],
    ['U+2029', 'ok\u2029FORGED', 'ok FORGED'],
    ['a bidi override', 'ok\u202eFORGED', 'ok FORGED'],
    ['a bidi isolate', 'ok\u2066FORGED', 'ok FORGED'],
    ['DEL', 'ok\u007fFORGED', 'ok FORGED'],
    ['NUL', 'ok\u0000FORGED', 'ok FORGED'],
  ])('maps %s to a space', (_name, input, expected) => {
    expect(displaySafeMultiline(input)).toBe(expected);
  });

  it('removes an ESC CSI, a C1 CSI and an OSC whole, so no parameter bytes survive', () => {
    expect(displaySafeMultiline('ok\x1b[2KFORGED')).toBe('okFORGED');
    expect(displaySafeMultiline('ok\u009b2KFORGED')).toBe('okFORGED');
    expect(displaySafeMultiline('ok\x1b]8;;https://x.example\x07link\x1b]8;;\x07')).toBe(
      'oklink'
    );
  });

  it("removes every SGR whole, cdkd's own colours included", () => {
    // `safeMsg` keeps cdkd's colours inside a value; a value that keeps its
    // newlines must not, or it could print a whole line in cdkd's red.
    expect(displaySafeMultiline('a\x1b[31mRED\x1b[0m b')).toBe('aRED b');
    expect(displaySafeMultiline('a\x1b[8mHIDDEN\x1b[28m b')).toBe('aHIDDEN b');
  });

  it('keeps the newline around a stripped sequence, and nothing else', () => {
    const out = displaySafeMultiline('line one\x1b[2K\r\nline two\u0085');
    expect(out).toBe('line one\nline two ');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/);
  });

  it('renders an absent value as empty and a throwing toString without throwing', () => {
    expect(displaySafeMultiline(undefined)).toBe('');
    expect(displaySafeMultiline(null)).toBe('');
    expect(displaySafeMultiline({ toString: null })).toBe('[object Object]');
  });

  it('displayAwsMessage keepLineBreaks: keeps line breaks, strips the forging class, bounds the length', () => {
    expect(displayAwsMessage('a\u0085b\nRe-adopt with:\ncmd', { keepLineBreaks: true })).toBe(
      'a b\nRe-adopt with:\ncmd'
    );
    // The default still joins lines.
    expect(displayAwsMessage('a\nb')).toBe('a b');
    const long = displayAwsMessage(`x\n${'y'.repeat(5000)}`, { keepLineBreaks: true });
    expect(long).toMatch(/^x\ny+ \[cut: \d+ more characters withheld\]$/);
  });
});
