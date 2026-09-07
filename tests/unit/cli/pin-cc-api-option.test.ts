import { describe, it, expect } from 'vite-plus/test';
import { parsePinCcApiToken, pinCcApiOption } from '../../../src/cli/options.js';

/**
 * `--pin-cc-api <LogicalId>` token parsing (issue
 * [#2719](https://github.com/go-to-k/cdkd/issues/2719)).
 *
 * The flag DECLINES a routing change and produces no output when it works, so
 * every way it can silently not apply is a way the user gets exactly the flip
 * they passed it to prevent, indistinguishably from success. That is why the
 * malformed-token throw is worth a test rather than being taken on faith from
 * its `--recreate-via-sdk-provider` sibling.
 */
describe('parsePinCcApiToken', () => {
  it('accumulates across repeats, in order', () => {
    expect(parsePinCcApiToken('B', parsePinCcApiToken('A', undefined))).toEqual(['A', 'B']);
  });

  it('trims surrounding whitespace', () => {
    expect(parsePinCcApiToken('  MyTopic  ', undefined)).toEqual(['MyTopic']);
  });

  it('rejects a CDK display path, which is the likely mistake', () => {
    // The construct path is what a user reads off `cdk.out`; the flag needs the
    // CFn-emitted logical id. `--recreate-via-cc-api` refuses the same input.
    expect(() => parsePinCcApiToken('MyStack/MyTopic/Resource', undefined)).toThrow(
      /--pin-cc-api/
    );
  });

  it('rejects an empty token', () => {
    expect(() => parsePinCcApiToken('   ', undefined)).toThrow(/--pin-cc-api/);
  });

  it('rejects a leading digit (CFn logical ids start with a letter)', () => {
    expect(() => parsePinCcApiToken('9Lives', undefined)).toThrow(/--pin-cc-api/);
  });

  it('names the flag in its error, not a sibling flag', () => {
    // Copy-paste between these near-identical parsers is exactly how an error
    // ends up telling the user to fix a flag they did not pass.
    expect(() => parsePinCcApiToken('a/b', undefined)).toThrow(/--pin-cc-api/);
    expect(() => parsePinCcApiToken('a/b', undefined)).not.toThrow(/--recreate-via/);
  });

  it('is registered as a repeatable option taking a value', () => {
    expect(pinCcApiOption.flags).toContain('--pin-cc-api');
    expect(pinCcApiOption.flags).toContain('<logicalId>');
  });
});
