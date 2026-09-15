import { describe, it, expect } from 'vite-plus/test';
import {
  applyDefaultNameForFallback,
  explicitNamePropertyFor,
  fallbackNamePropertyFor,
  generateResourceName,
  generateResourceNameWithFallback,
  getCurrentSkipPrefix,
  setCurrentStackName,
  withoutGeneratedFallbackName,
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

  // Issue #3174: a Cloud Control create of `AWS::Lambda::CapacityProvider`
  // without `CapacityProviderName` fails with `Resource Handler Internal
  // Failure`, although the schema does not require the name.
  describe('applyDefaultNameForFallback — AWS::Lambda::CapacityProvider (#3174)', () => {
    const TYPE = 'AWS::Lambda::CapacityProvider';
    // The name alternative of the schema's `CapacityProviderName` pattern.
    const SCHEMA_NAME = /^[a-zA-Z0-9-_]+$/;

    it('fills CapacityProviderName from the stack name and logical id when absent', () => {
      const props = { VpcConfig: { SubnetIds: ['subnet-1'] } };
      const result = withStackName('MyStack', () =>
        applyDefaultNameForFallback('Provider2281708E', TYPE, props)
      );
      expect(result).toEqual({
        VpcConfig: { SubnetIds: ['subnet-1'] },
        CapacityProviderName: 'MyStack-Provider2281708E',
      });
      // Not mutated: the caller's resolved bag is reused by the diff.
      expect(props).not.toHaveProperty('CapacityProviderName');
    });

    it('keeps a user-supplied name untouched', () => {
      const props = { CapacityProviderName: 'my-provider' };
      const result = withStackName('MyStack', () =>
        applyDefaultNameForFallback('Provider2281708E', TYPE, props)
      );
      expect(result).toBe(props);
    });

    // The two sides of the schema's 140-character cap: a name AT the cap is
    // kept verbatim, one character over it is cut to exactly the cap.
    it('keeps a name of exactly 140 characters verbatim', () => {
      const stack = 'A'.repeat(70);
      const logicalId = 'B'.repeat(69);
      expect(`${stack}-${logicalId}`).toHaveLength(140);
      const result = withStackName(stack, () => applyDefaultNameForFallback(logicalId, TYPE, {}));
      expect(result['CapacityProviderName']).toBe(`${stack}-${logicalId}`);
    });

    it('cuts a 141-character name to exactly 140, ending in the hash', () => {
      const stack = 'A'.repeat(70);
      const logicalId = 'B'.repeat(70);
      const full = `${stack}-${logicalId}`;
      expect(full).toHaveLength(141);
      const result = withStackName(stack, () => applyDefaultNameForFallback(logicalId, TYPE, {}));
      const name = result['CapacityProviderName'] as string;
      expect(name).toHaveLength(140);
      // 131 kept characters, a separator, 8 hex characters of hash.
      expect(name.startsWith(full.slice(0, 131))).toBe(true);
      expect(name).toMatch(/-[0-9a-f]{8}$/);
    });

    it('sanitizes a nested child stack name into the schema pattern at 140 characters', () => {
      // A nested child deploys under `<parent>~<logicalId>`, and `~` is outside
      // both the default allowed set and the schema pattern: unsanitized, the
      // name fails the pattern; sanitized, it reads `Parent-...`.
      const stack = `Parent~${'S'.repeat(120)}`;
      const logicalId = `Provider${'L'.repeat(100)}`;
      expect(`${stack}-${logicalId}`.length).toBeGreaterThan(140);
      const result = withStackName(stack, () => applyDefaultNameForFallback(logicalId, TYPE, {}));
      const name = result['CapacityProviderName'] as string;
      expect(name.startsWith(`Parent-${'S'.repeat(120)}-Pro`)).toBe(true);
      expect(name).toHaveLength(140);
      expect(name).toMatch(SCHEMA_NAME);
      expect(name).toMatch(/-[0-9a-f]{8}$/);
    });

    it('is the name property the orphan-adoption allow-list reads', () => {
      expect(explicitNamePropertyFor(TYPE)).toBe('CapacityProviderName');
    });
  });

  describe('fallbackNamePropertyFor (#3174)', () => {
    it.each([
      ['AWS::Lambda::CapacityProvider', 'CapacityProviderName'],
      // Two whose name is UPDATABLE: the update path's drop must cover them
      // too, or a generated name renames an imported resource.
      ['AWS::Cognito::UserPool', 'UserPoolName'],
      ['AWS::IAM::Policy', 'PolicyName'],
      ['AWS::S3::Bucket', 'BucketName'],
    ])('%s answers %s, the property applyDefaultNameForFallback fills', (type, property) => {
      expect(fallbackNamePropertyFor(type)).toBe(property);
      const filled = withStackName('MyStack', () => applyDefaultNameForFallback('Res', type, {}));
      expect(Object.keys(filled)).toEqual([property]);
    });

    it('answers undefined for a type with no rule, including one only the adoption table names', () => {
      expect(fallbackNamePropertyFor('AWS::EFS::FileSystem')).toBeUndefined();
      // `ADOPTION_ONLY_NAME_PROPERTIES` names it, and nothing generates it.
      expect(explicitNamePropertyFor('AWS::Scheduler::Schedule')).toBe('Name');
      expect(fallbackNamePropertyFor('AWS::Scheduler::Schedule')).toBeUndefined();
    });
  });

  describe('withoutGeneratedFallbackName (#3174)', () => {
    const TYPE = 'AWS::Lambda::CapacityProvider';

    it('takes a generated name back out, keeps every other key, and mutates neither input', () => {
      const resolved = { VpcConfig: { SubnetIds: ['subnet-1'] } };
      const prepared = { ...resolved, CapacityProviderName: 'MyStack-Provider' };
      const result = withoutGeneratedFallbackName(TYPE, resolved, prepared);
      expect(result).toEqual(resolved);
      expect(result).not.toHaveProperty('CapacityProviderName');
      expect(prepared).toHaveProperty('CapacityProviderName', 'MyStack-Provider');
      expect(resolved).not.toHaveProperty('CapacityProviderName');
    });

    it('does the same for another table member whose name is updatable', () => {
      const result = withoutGeneratedFallbackName(
        'AWS::Cognito::UserPool',
        { MfaConfiguration: 'OFF' },
        { MfaConfiguration: 'OFF', UserPoolName: 'MyStack-Pool' }
      );
      expect(result).toEqual({ MfaConfiguration: 'OFF' });
    });

    it('gives an empty template name back, since the fill generates over it too', () => {
      const resolved = { CapacityProviderName: '' };
      const prepared = withStackName('MyStack', () =>
        applyDefaultNameForFallback('Provider', TYPE, resolved)
      );
      // Premise: the fill really did generate over the empty string.
      expect(prepared['CapacityProviderName']).toBe('MyStack-Provider');
      expect(withoutGeneratedFallbackName(TYPE, resolved, prepared)).toEqual({
        CapacityProviderName: '',
      });
    });

    it('returns prepared by identity when the template supplies the name', () => {
      const resolved = { CapacityProviderName: 'my-provider' };
      const prepared = { ...resolved };
      expect(withoutGeneratedFallbackName(TYPE, resolved, prepared)).toBe(prepared);
    });

    it('returns prepared by identity when it carries no name to take out', () => {
      // A provider's `preparePropertiesForFallback` hook may build a bag
      // without the property: nothing was generated.
      const prepared = { VpcConfig: {} };
      expect(withoutGeneratedFallbackName(TYPE, {}, prepared)).toBe(prepared);
    });

    it('returns prepared by identity for a type with no rule, whatever keys it holds', () => {
      // `undefined` is the key an unguarded lookup of a missing rule indexes.
      const prepared = { undefined: 'kept', Name: 'kept' };
      expect(withoutGeneratedFallbackName('AWS::EFS::FileSystem', {}, prepared)).toBe(prepared);
    });
  });
});
