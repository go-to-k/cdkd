import { describe, it, expect } from 'vite-plus/test';
import { parseReplaceResourceToken, replaceResourceOption } from '../../../src/cli/options.js';
import { createDeployCommand } from '../../../src/cli/commands/deploy.js';

/** `--replace-resource <logicalId>` token parsing (go-to-k/cdkd#7079). */
describe('parseReplaceResourceToken', () => {
  it('accumulates across repeats, in order', () => {
    expect(parseReplaceResourceToken('B', parseReplaceResourceToken('A', undefined))).toEqual([
      'A',
      'B',
    ]);
  });

  it('trims surrounding whitespace', () => {
    expect(parseReplaceResourceToken('  MyVolume  ', undefined)).toEqual(['MyVolume']);
  });

  it('rejects a CDK display path, an empty token and a leading digit, naming the flag', () => {
    for (const bad of ['MyStack/MyVolume/Resource', '   ', '9Lives']) {
      expect(() => parseReplaceResourceToken(bad, undefined)).toThrow(/--replace-resource/);
      expect(() => parseReplaceResourceToken(bad, undefined)).not.toThrow(/--recreate-via/);
    }
  });

  it('is registered on cdkd deploy as a repeatable option taking a value', () => {
    expect(replaceResourceOption.flags).toBe('--replace-resource <logicalId>');
    const option = createDeployCommand().options.find((o) => o.long === '--replace-resource');
    expect(option).toBeDefined();
    expect(option!.parseArg?.('B', ['A'])).toEqual(['A', 'B']);
  });
});
