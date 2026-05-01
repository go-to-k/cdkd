import { describe, it, expect } from 'vitest';
import { runStackBuffered, getCurrentStackOutputBuffer } from '../../../src/utils/stack-context.js';
import { ConsoleLogger } from '../../../src/utils/logger.js';

describe('stack-context', () => {
  describe('getCurrentStackOutputBuffer', () => {
    it('returns undefined outside any runStackBuffered scope', () => {
      expect(getCurrentStackOutputBuffer()).toBeUndefined();
    });

    it('returns the active buffer inside a runStackBuffered scope', async () => {
      let observed: ReturnType<typeof getCurrentStackOutputBuffer>;
      await runStackBuffered(async () => {
        observed = getCurrentStackOutputBuffer();
      });
      expect(observed).toBeDefined();
      expect(observed?.lines).toEqual([]);
    });
  });

  describe('runStackBuffered', () => {
    it('captures buffer mutations done inside the scope', async () => {
      const outcome = await runStackBuffered(async () => {
        getCurrentStackOutputBuffer()!.lines.push('first');
        getCurrentStackOutputBuffer()!.lines.push('second');
        return 42;
      });

      expect(outcome.lines).toEqual(['first', 'second']);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result).toBe(42);
      }
    });

    it('returns the buffer even when the body throws', async () => {
      const outcome = await runStackBuffered(async () => {
        getCurrentStackOutputBuffer()!.lines.push('partial');
        throw new Error('boom');
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.lines).toEqual(['partial']);
      if (!outcome.ok) {
        expect(outcome.error).toBeInstanceOf(Error);
        expect((outcome.error as Error).message).toBe('boom');
      }
    });

    it('isolates concurrent buffers — Promise.all with staggered awaits', async () => {
      // Drives the same case as the resource-name AsyncLocalStorage test:
      // two concurrent invocations must not see each other's buffer. The
      // staggered setTimeout delays force a real interleave between the
      // setter and reader, so a buggy implementation (e.g. module-global
      // `let buffer`) would clobber.
      const work = (label: string, delay: number) =>
        runStackBuffered(async () => {
          getCurrentStackOutputBuffer()!.lines.push(`${label}-start`);
          await new Promise((r) => setTimeout(r, delay));
          getCurrentStackOutputBuffer()!.lines.push(`${label}-end`);
          return label;
        });

      const [a, b, c] = await Promise.all([work('A', 30), work('B', 10), work('C', 20)]);

      expect(a.lines).toEqual(['A-start', 'A-end']);
      expect(b.lines).toEqual(['B-start', 'B-end']);
      expect(c.lines).toEqual(['C-start', 'C-end']);
    });

    it('does not leak the buffer to outer scope after returning', async () => {
      await runStackBuffered(async () => {
        getCurrentStackOutputBuffer()!.lines.push('inside');
      });
      expect(getCurrentStackOutputBuffer()).toBeUndefined();
    });

    it('routes ConsoleLogger output into the buffer instead of console', async () => {
      // Color-free logger so we can match plain strings.
      const logger = new ConsoleLogger('info', false);

      const outcome = await runStackBuffered(async () => {
        logger.info('hello');
        logger.warn('careful');
        logger.error('oops');
        // debug at info level: filtered, should not enter buffer
        logger.debug('quiet');
      });

      expect(outcome.lines).toEqual(['hello', 'careful', 'oops']);
    });

    it('isolates logger output across concurrent stack scopes', async () => {
      const logger = new ConsoleLogger('info', false);

      const work = (label: string, delay: number) =>
        runStackBuffered(async () => {
          logger.info(`${label}-1`);
          await new Promise((r) => setTimeout(r, delay));
          logger.info(`${label}-2`);
          return label;
        });

      const [a, b] = await Promise.all([work('A', 20), work('B', 5)]);

      // Each scope's buffer must contain only its own lines.
      expect(a.lines).toEqual(['A-1', 'A-2']);
      expect(b.lines).toEqual(['B-1', 'B-2']);
    });

    it('supports nested scopes — inner scope shadows outer', async () => {
      let outerLines: string[] | undefined;
      let innerLines: string[] | undefined;

      const outer = await runStackBuffered(async () => {
        getCurrentStackOutputBuffer()!.lines.push('outer-1');
        const inner = await runStackBuffered(async () => {
          getCurrentStackOutputBuffer()!.lines.push('inner-1');
        });
        innerLines = inner.lines;
        getCurrentStackOutputBuffer()!.lines.push('outer-2');
      });
      outerLines = outer.lines;

      expect(innerLines).toEqual(['inner-1']);
      expect(outerLines).toEqual(['outer-1', 'outer-2']);
    });
  });
});
