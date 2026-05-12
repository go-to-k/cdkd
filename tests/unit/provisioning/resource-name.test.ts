import { describe, it, expect } from 'vitest';
import {
  generateResourceName,
  generateResourceNameWithFallback,
  getCurrentSkipPrefix,
  setCurrentStackName,
  withSkipPrefix,
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

  describe('withSkipPrefix + userSupplied flag', () => {
    it('still prefixes user-supplied names by default (no withSkipPrefix scope)', () => {
      // Pre-PR behavior preserved: an IAM Role with user-declared
      // `RoleName: 'my-role'` deployed by cdkd still gets the stack
      // name prefix unless the user opts in via
      // --no-prefix-user-supplied-names.
      const result = withStackName('MyStack', () =>
        generateResourceName('my-role', { maxLength: 64, userSupplied: true })
      );
      expect(result).toBe('MyStack-my-role');
    });

    it('skips the prefix on user-supplied names when withSkipPrefix(true) is active', () => {
      const result = withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          generateResourceName('my-role', { maxLength: 64, userSupplied: true })
        )
      );
      expect(result).toBe('my-role');
    });

    it('still prefixes the logical-id fallback path even with withSkipPrefix(true)', () => {
      // The flag only affects user-supplied names. Auto-generated names
      // (where the user did NOT declare a physical name) need the prefix
      // for cross-stack uniqueness regardless of the flag.
      const result = withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          generateResourceName('MyLogicalId', { maxLength: 64 /* userSupplied default false */ })
        )
      );
      expect(result).toBe('MyStack-MyLogicalId');
    });

    it('still prefixes when withSkipPrefix(false) is active (the opt-out / default-off case)', () => {
      const result = withStackName('MyStack', () =>
        withSkipPrefix(false, () =>
          generateResourceName('my-role', { maxLength: 64, userSupplied: true })
        )
      );
      expect(result).toBe('MyStack-my-role');
    });

    it('flag has no effect outside withStackName scope (the no-stack-name path is unchanged)', () => {
      const result = withSkipPrefix(true, () =>
        generateResourceName('my-role', { maxLength: 64, userSupplied: true })
      );
      expect(result).toBe('my-role');
    });

    it('does not leak the skip-prefix flag outside the callback', () => {
      withSkipPrefix(true, () => generateResourceName('x', { maxLength: 64, userSupplied: true }));
      const after = withStackName('MyStack', () =>
        generateResourceName('my-role', { maxLength: 64, userSupplied: true })
      );
      expect(after).toBe('MyStack-my-role');
    });

    it('isolates concurrent withSkipPrefix scopes', async () => {
      const work = async (stackName: string, skip: boolean, delay: number) =>
        withStackName(stackName, () =>
          withSkipPrefix(skip, async () => {
            await new Promise((resolve) => setTimeout(resolve, delay));
            return generateResourceName('my-role', { maxLength: 64, userSupplied: true });
          })
        );

      const [a, b, c] = await Promise.all([
        work('StackA', true, 30),
        work('StackB', false, 10),
        work('StackC', true, 20),
      ]);

      expect(a).toBe('my-role');
      expect(b).toBe('StackB-my-role');
      expect(c).toBe('my-role');
    });

    it('getCurrentSkipPrefix reflects the active scope', () => {
      expect(getCurrentSkipPrefix()).toBe(false);
      withSkipPrefix(true, () => {
        expect(getCurrentSkipPrefix()).toBe(true);
      });
      withSkipPrefix(false, () => {
        expect(getCurrentSkipPrefix()).toBe(false);
      });
      expect(getCurrentSkipPrefix()).toBe(false);
    });
  });

  describe('generateResourceNameWithFallback', () => {
    it('uses the user-supplied name with userSupplied: true', () => {
      const result = withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          generateResourceNameWithFallback('my-role', 'CRRole', { maxLength: 64 })
        )
      );
      expect(result).toBe('my-role');
    });

    it('falls back to the logical id and keeps the prefix', () => {
      const result = withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          generateResourceNameWithFallback(undefined, 'CRRole', { maxLength: 64 })
        )
      );
      expect(result).toBe('MyStack-CRRole');
    });

    it('treats empty-string user names as missing and uses the logical id', () => {
      const result = withStackName('MyStack', () =>
        generateResourceNameWithFallback('', 'CRRole', { maxLength: 64 })
      );
      expect(result).toBe('MyStack-CRRole');
    });

    it('prefixes the user-supplied name when the flag is off (pre-PR behavior)', () => {
      const result = withStackName('MyStack', () =>
        // No withSkipPrefix scope → flag defaults to false → prefix applied.
        generateResourceNameWithFallback('my-role', 'CRRole', { maxLength: 64 })
      );
      expect(result).toBe('MyStack-my-role');
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
