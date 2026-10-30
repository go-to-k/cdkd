import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyDefaultNameForFallback,
  generateResourceName,
  generateResourceNameWithFallback,
  getCurrentStackInstanceId,
  getCurrentStackName,
  looksLikeCdkdGeneratedName,
  recordedGeneratedNameKept,
  stackInstanceNameSuffix,
  withSkipPrefix,
  withStackScope,
  withStackScopeBeforeStateRead,
} from '../../../src/provisioning/resource-name.js';

/**
 * go-to-k/cdkd#5064: a stack with an instance id (state schema v13) gets
 * CloudFormation-style `{stack}-{logicalId}-{suffix}` names for what its
 * template does not name; a legacy stack keeps its names byte for byte.
 */
const ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';

/** The suffix, computed here independently of the module. */
const expectedSuffix = (id: string, name: string): string =>
  createHash('sha256').update(`${id}\u0000${name}`).digest('hex').substring(0, 12);

const legacy = <T>(stackName: string, fn: () => T): T =>
  withStackScope({ stackName, stackInstanceId: undefined, nameGenerations: new Map() }, fn);
const v13 = <T>(stackName: string, fn: () => T, id = ID): T =>
  withStackScope({ stackName, stackInstanceId: id, nameGenerations: new Map() }, fn);

describe('generateResourceName with a stack instance id (#5064)', () => {
  it('appends the 12-hex suffix of sha256(id NUL name) to {stack}-{logicalId}', () => {
    expect(v13('MyStack', () => generateResourceName('MyRole', { maxLength: 64 }))).toBe(
      `MyStack-MyRole-${expectedSuffix(ID, 'MyRole')}`
    );
    expect(stackInstanceNameSuffix(ID, 'MyRole')).toBe(expectedSuffix(ID, 'MyRole'));
  });

  it('separates the id from the name unambiguously', () => {
    expect(stackInstanceNameSuffix('ab', 'c')).not.toBe(stackInstanceNameSuffix('a', 'bc'));
  });

  it('is a pure function of (stack, id, logical id): re-derivation reproduces it', () => {
    const a = v13('MyStack', () => generateResourceName('Queue', { maxLength: 80 }));
    const b = v13('MyStack', () => generateResourceName('Queue', { maxLength: 80 }));
    expect(a).toBe(b);
  });

  it('gives a recreated stack (a new id) a different name', () => {
    const before = v13('MyStack', () => generateResourceName('Queue', { maxLength: 80 }));
    const after = v13('MyStack', () => generateResourceName('Queue', { maxLength: 80 }), OTHER_ID);
    expect(after).not.toBe(before);
    expect(after.startsWith('MyStack-Queue-')).toBe(true);
  });

  it('cuts {stack}-{logicalId} to maxLength - 13 (ELBv2, 32)', () => {
    const name = v13('MyVeryLongStackNameForTesting', () =>
      generateResourceName('MyLoadBalancer', { maxLength: 32 })
    );
    expect(name).toBe(`MyVeryLongStackName-${expectedSuffix(ID, 'MyLoadBalancer')}`);
    expect(name).toHaveLength(32);
  });

  it('drops a hyphen the cut leaves at the end of the base', () => {
    // 19 chars of `ABCDEFGHIJKLMNOPQR-X...` end on the separator.
    const name = v13('ABCDEFGHIJKLMNOPQR', () => generateResourceName('XLongName', { maxLength: 32 }));
    expect(name).toBe(`ABCDEFGHIJKLMNOPQR-${expectedSuffix(ID, 'XLongName')}`);
    expect(name).not.toMatch(/--/);
  });

  it('keeps a lowercase type valid (ElastiCache cluster, 40)', () => {
    const name = v13('MyVeryLongStackNameForTesting', () =>
      generateResourceName('CacheClusterResource', { maxLength: 40, lowercase: true })
    );
    expect(name).toBe(`myverylongstacknamefortesti-${expectedSuffix(ID, 'CacheClusterResource')}`);
    expect(name).toHaveLength(40);
    expect(name).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
  });

  it('keeps an S3 bucket name within its pattern', () => {
    const name = v13('MyStack', () =>
      generateResourceName('DataBucket', {
        maxLength: 63,
        lowercase: true,
        allowedPattern: /[^a-z0-9.-]/g,
      })
    );
    expect(name).toBe(`mystack-databucket-${expectedSuffix(ID, 'DataBucket')}`);
    expect(name).toMatch(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  });

  it('fills a Cloud Control create name with the suffix too', () => {
    const props = v13('MyStack', () =>
      applyDefaultNameForFallback('Provider', 'AWS::Lambda::CapacityProvider', {})
    );
    expect(props).toEqual({ CapacityProviderName: `MyStack-Provider-${expectedSuffix(ID, 'Provider')}` });
  });

  it('never changes a declared name, prefixed or not', () => {
    expect(
      v13('MyStack', () => generateResourceNameWithFallback('my-role', 'R', { maxLength: 64 }))
    ).toBe('MyStack-my-role');
    expect(
      v13('MyStack', () =>
        withSkipPrefix(true, () => generateResourceNameWithFallback('my-role', 'R', { maxLength: 64 }))
      )
    ).toBe('my-role');
    expect(
      v13('MyStack', () => generateResourceName('my-role', { maxLength: 64, userSupplied: true }))
    ).toBe('MyStack-my-role');
  });

  it('is the bare name outside any scope', () => {
    expect(generateResourceName('MyRole', { maxLength: 64 })).toBe('MyRole');
  });
});

describe('generateResourceName for a LEGACY stack (no id) stays byte-identical (#5064)', () => {
  // Literals computed from origin/main's implementation, before #5064.
  it.each([
    ['MyStack', 'MyRole', { maxLength: 64 }, 'MyStack-MyRole'],
    [
      'MyStack',
      'DataBucket',
      { maxLength: 63, lowercase: true, allowedPattern: /[^a-z0-9.-]/g },
      'mystack-databucket',
    ],
    ['MyVeryLongStackNameForTesting', 'MyLoadBalancer', { maxLength: 32 }, 'MyVeryLongStackNameForT-92c69e61'],
    [
      'MyVeryLongStackNameForTesting',
      'CacheClusterResource',
      { maxLength: 40, lowercase: true },
      'myverylongstacknamefortesting-c-0af8d2b7',
    ],
    ['MyStack', 'Queue_With.Odd', { maxLength: 80 }, 'MyStack-Queue-With-Odd'],
    ['MyStack', 'LogGroup', { maxLength: 506, allowedPattern: /[^a-zA-Z0-9-/_]/g }, 'MyStack-LogGroup'],
  ])('%s / %s', (stackName, logicalId, options, expected) => {
    expect(legacy(stackName, () => generateResourceName(logicalId, options))).toBe(expected);
  });
});

describe('the stack scope (#5064)', () => {
  it('carries the name and the id, and an inner scope replaces an outer one', () => {
    v13('Outer', () => {
      expect(getCurrentStackName()).toBe('Outer');
      expect(getCurrentStackInstanceId()).toBe(ID);
      legacy('Inner', () => {
        expect(getCurrentStackName()).toBe('Inner');
        expect(getCurrentStackInstanceId()).toBeUndefined();
      });
    });
    expect(getCurrentStackName()).toBeUndefined();
  });

  it('copies the scope object, so a later mutation renames nothing', () => {
    const scope = {
      stackName: 'MyStack',
      stackInstanceId: ID as string | undefined,
      nameGenerations: new Map<string, number>(),
    };
    const name = withStackScope(scope, () => {
      scope.stackInstanceId = OTHER_ID;
      return generateResourceName('Queue', { maxLength: 80 });
    });
    expect(name).toBe(`MyStack-Queue-${expectedSuffix(ID, 'Queue')}`);
  });

  it('refuses a generated name before the state read, but not a declared one', async () => {
    await withStackScopeBeforeStateRead('MyStack', async () => {
      expect(() => generateResourceName('Queue', { maxLength: 80 })).toThrow(
        /cdkd internal error: a generated name for Queue was derived before the state record of MyStack was read/
      );
      expect(generateResourceNameWithFallback('my-role', 'R', { maxLength: 64 })).toBe(
        'MyStack-my-role'
      );
      expect(getCurrentStackName()).toBe('MyStack');
      // The id-bearing scope opened after the read derives normally.
      expect(v13('MyStack', () => generateResourceName('Queue', { maxLength: 80 }))).toBe(
        `MyStack-Queue-${expectedSuffix(ID, 'Queue')}`
      );
    });
  });
});

describe('looksLikeCdkdGeneratedName with a stack instance id (#5064)', () => {
  const suffixed = `MyStack-DurableFn-${expectedSuffix(ID, 'DurableFn')}`;

  it('accepts the exact suffix the id derives for the logical id', () => {
    expect(looksLikeCdkdGeneratedName(suffixed, 'DurableFn', 'MyStack', ID)).toBe(true);
  });

  it('accepts the truncated suffixed form', () => {
    const cut = v13('MyVeryLongStackNameForTesting', () =>
      generateResourceName('MyLoadBalancer', { maxLength: 32 })
    );
    expect(looksLikeCdkdGeneratedName(cut, 'MyLoadBalancer', 'MyVeryLongStackNameForTesting', ID)).toBe(
      true
    );
  });

  it('rejects a bare 12-hex shape: no id, another id, or another logical id', () => {
    expect(looksLikeCdkdGeneratedName(suffixed, 'DurableFn', 'MyStack', undefined)).toBe(false);
    expect(looksLikeCdkdGeneratedName(suffixed, 'DurableFn', 'MyStack', OTHER_ID)).toBe(false);
    const otherLogical = `MyStack-DurableFn-${expectedSuffix(ID, 'Other')}`;
    expect(looksLikeCdkdGeneratedName(otherLogical, 'DurableFn', 'MyStack', ID)).toBe(false);
    expect(looksLikeCdkdGeneratedName('MyStack-DurableFn-0123456789ab', 'DurableFn', 'MyStack', ID)).toBe(
      false
    );
  });

  it('rejects the right suffix behind a base that is not the derivation', () => {
    const forged = `totally-other-${expectedSuffix(ID, 'DurableFn')}`;
    expect(looksLikeCdkdGeneratedName(forged, 'DurableFn', 'MyStack', ID)).toBe(false);
  });

  it('still recognizes the legacy form on a v13 stack (an imported resource)', () => {
    expect(looksLikeCdkdGeneratedName('MyStack-DurableFn', 'DurableFn', 'MyStack', ID)).toBe(true);
  });
});

describe('recordedGeneratedNameKept (#5064)', () => {
  const opts = { maxLength: 64 };
  const keep = (recorded: string, extra: { declared?: unknown; previous?: unknown } = {}): boolean =>
    recordedGeneratedNameKept({
      recorded,
      derived: generateResourceNameWithFallback(extra.declared as string | undefined, 'L', opts),
      declaredName: extra.declared,
      previousDeclaredName: extra.previous,
      logicalId: 'L',
      options: opts,
    });
  const suffixedL = `MyStack-L-${expectedSuffix(ID, 'L')}`;

  it('keeps a legacy name on a v13 stack (an imported resource)', () => {
    expect(v13('MyStack', () => keep('MyStack-L'))).toBe(true);
  });

  it('keeps a suffixed name when the scope lacks the id', () => {
    expect(legacy('MyStack', () => keep(suffixedL))).toBe(true);
    // Any id's suffix has the same base and length; a wrong base does not.
    expect(legacy('MyStack', () => keep(`MyStack-X-${expectedSuffix(ID, 'L')}`))).toBe(false);
    expect(legacy('MyStack', () => keep(`MyStack-L-${expectedSuffix(ID, 'L')}0`))).toBe(false);
    expect(legacy('MyStack', () => keep('MyStack-L-0123456789AB'))).toBe(false);
  });

  it('keeps nothing when the names already agree, or with no scope', () => {
    expect(v13('MyStack', () => keep(suffixedL))).toBe(false);
    expect(keep('MyStack-L')).toBe(false);
  });

  it('never keeps a name the template declares, now or before', () => {
    expect(v13('MyStack', () => keep('MyStack-L', { declared: 'new-role' }))).toBe(false);
    expect(v13('MyStack', () => keep('MyStack-L', { previous: 'old-role' }))).toBe(false);
  });

  it('never keeps an unrelated name', () => {
    expect(v13('MyStack', () => keep('someone-else'))).toBe(false);
    expect(v13('OtherStack', () => keep('MyStack-L'))).toBe(false);
  });
});
