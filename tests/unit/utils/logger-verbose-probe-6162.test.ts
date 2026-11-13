import { describe, it, expect, afterEach } from 'vite-plus/test';
import { getLogger } from '../../../src/utils/logger.js';
import { VERBOSE_POINTER, verbosePointerSentence } from '../../../src/utils/aws-failure-text.js';

/**
 * go-to-k/cdkd#6162: loading the logger is what tells `aws-failure-text.ts`
 * whether the run is `--verbose`; a command's `setLevel('debug')` must reach it.
 */
describe('the logger registers the verbose-run probe', () => {
  const before = getLogger().getLevel();
  afterEach(() => {
    getLogger().setLevel(before);
  });

  it('drops the pointer once the level is debug, and restores it after', () => {
    getLogger().setLevel('info');
    expect(verbosePointerSentence()).toBe(`${VERBOSE_POINTER} `);
    getLogger().setLevel('debug');
    expect(verbosePointerSentence()).toBe('');
    getLogger().setLevel('info');
    expect(verbosePointerSentence()).toBe(`${VERBOSE_POINTER} `);
  });
});
