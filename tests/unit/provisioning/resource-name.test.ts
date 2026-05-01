import { describe, it, expect } from 'vitest';
import {
  generateResourceName,
  setCurrentStackName,
  withStackName,
} from '../../../src/provisioning/resource-name.js';

describe('resource-name', () => {
  describe('generateResourceName (no stack name set)', () => {
    it('returns the raw name when no stack name is in scope', () => {
      // Outside any withStackName/setCurrentStackName scope.
      const result = generateResourceName('MyResource', { maxLength: 64 });

      expect(result).toBe('MyResource');
    });
  });

  describe('withStackName', () => {
    it('prefixes the generated name with the scoped stack name', () => {
      const result = withStackName('MyStack', () =>
        generateResourceName('MyRole', { maxLength: 64 })
      );

      expect(result).toBe('MyStack-MyRole');
    });

    it('does not leak the stack name outside the callback', () => {
      withStackName('Inner', () => generateResourceName('X', { maxLength: 64 }));
      // After the callback returns, the store is back to whatever was set
      // outside (here: nothing).
      const after = generateResourceName('X', { maxLength: 64 });

      expect(after).toBe('X');
    });

    it('isolates concurrent calls (the regression PR #74 fixes)', async () => {
      // Reproduce the production bug: two parallel deploys, each with its
      // own stack name, must not see each other's value. Before the
      // AsyncLocalStorage refactor, the second `setCurrentStackName` call
      // would clobber the first via a module-global, causing the first
      // stack's resources to be created with the second stack's prefix.
      const work = (stackName: string, delay: number) =>
        withStackName(stackName, async () => {
          // Yield once before reading the store, simulating the AWS-call
          // gap during which a concurrent deploy could have clobbered
          // the global in the old implementation.
          await new Promise((resolve) => setTimeout(resolve, delay));
          return generateResourceName('MyRole', { maxLength: 64 });
        });

      const [a, b, c] = await Promise.all([
        work('StackA', 30),
        work('StackB', 10),
        work('StackC', 20),
      ]);

      expect(a).toBe('StackA-MyRole');
      expect(b).toBe('StackB-MyRole');
      expect(c).toBe('StackC-MyRole');
    });

    it('truncates over-long names with a deterministic hash suffix', () => {
      const result = withStackName('A'.repeat(40), () =>
        generateResourceName('B'.repeat(40), { maxLength: 64 })
      );

      expect(result.length).toBeLessThanOrEqual(64);
      // Same inputs → same output (hash is over the full pre-truncation name)
      const result2 = withStackName('A'.repeat(40), () =>
        generateResourceName('B'.repeat(40), { maxLength: 64 })
      );
      expect(result).toBe(result2);
    });

    it('forces lowercase when option set (S3 bucket case)', () => {
      const result = withStackName('MyStack', () =>
        generateResourceName('MyBucket', { maxLength: 63, lowercase: true })
      );

      expect(result).toBe('mystack-mybucket');
    });
  });

  describe('setCurrentStackName (deprecated, AsyncLocalStorage-backed)', () => {
    it('also isolates concurrent calls thanks to enterWith semantics', async () => {
      // The deprecated setter now uses `enterWith` rather than mutating a
      // module-global. Each Promise has its own async resource, so two
      // concurrent deploys that call `setCurrentStackName(...)` at their
      // top do not collide.
      const work = async (stackName: string, delay: number) => {
        setCurrentStackName(stackName);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return generateResourceName('MyRole', { maxLength: 64 });
      };

      const [a, b] = await Promise.all([work('StackA', 25), work('StackB', 5)]);

      expect(a).toBe('StackA-MyRole');
      expect(b).toBe('StackB-MyRole');
    });
  });
});
