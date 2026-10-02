import { describe, it, expect, afterEach } from 'vite-plus/test';
import {
  allowUnscopedCreateTokensForTests,
  stackScopedCreateToken,
} from '../../../src/provisioning/providers/idempotency-token.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';

/**
 * go-to-k/cdkd#4428: the deterministic file-system create tokens (EFS
 * `CreationToken`, FSx `ClientRequestToken`) carried no stack scope, so two
 * copies of one stack in an account and region sent the same token.
 */
describe('stackScopedCreateToken', () => {
  const savedRegion = process.env['AWS_REGION'];
  afterEach(() => {
    if (savedRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedRegion;
  });

  const token = (stack: string, logicalId = 'MyFs', inputs: unknown[] = ['LUSTRE', ['subnet-1']]) =>
    withStackName(stack, () =>
      stackScopedCreateToken({ logicalId, immutableInputs: inputs, maxLength: 63 })
    );

  it('differs between two stacks declaring the same logical id with the same inputs', () => {
    process.env['AWS_REGION'] = 'us-east-1';
    expect(token('DevStack')).not.toBe(token('StagingStack'));
  });

  it('is identical for every derivation within one stack (retries, and later runs of the stack)', () => {
    process.env['AWS_REGION'] = 'us-east-1';
    expect(token('DevStack')).toBe(token('DevStack'));
  });

  it('differs by region for the same stack', () => {
    process.env['AWS_REGION'] = 'us-east-1';
    const east = token('DevStack');
    process.env['AWS_REGION'] = 'eu-west-1';
    expect(token('DevStack')).not.toBe(east);
  });

  it('differs when an immutable input changes (a replacement coexists with the old resource)', () => {
    process.env['AWS_REGION'] = 'us-east-1';
    expect(token('DevStack', 'MyFs', ['LUSTRE', ['subnet-1']])).not.toBe(
      token('DevStack', 'MyFs', ['LUSTRE', ['subnet-2']])
    );
    // An absent input and an explicit null are the same create.
    expect(token('DevStack', 'MyFs', ['LUSTRE', undefined])).toBe(
      token('DevStack', 'MyFs', ['LUSTRE', null])
    );
  });

  it('keeps the readable logical-id prefix and the cdkd shape', () => {
    process.env['AWS_REGION'] = 'us-east-1';
    expect(token('DevStack')).toMatch(/^cdkd-MyFs-[0-9a-f]{12}$/);
  });

  it('fits maxLength for a long logical id, and two ids sharing the truncated prefix still differ', () => {
    process.env['AWS_REGION'] = 'us-east-1';
    const longA = `${'A'.repeat(200)}1`;
    const longB = `${'A'.repeat(200)}2`;
    for (const maxLength of [63, 64]) {
      const a = withStackName('DevStack', () =>
        stackScopedCreateToken({ logicalId: longA, immutableInputs: [], maxLength })
      );
      const b = withStackName('DevStack', () =>
        stackScopedCreateToken({ logicalId: longB, immutableInputs: [], maxLength })
      );
      expect(a.length).toBe(maxLength);
      expect(b.length).toBe(maxLength);
      expect(a).not.toBe(b);
    }
  });
  it('refuses to derive a token with no stack in scope, unless a test opts out explicitly', () => {
    const derive = () =>
      stackScopedCreateToken({ logicalId: 'MyFs', immutableInputs: [], maxLength: 63 });
    expect(derive).toThrow(/outside a stack scope/);
    const previous = allowUnscopedCreateTokensForTests(true);
    try {
      expect(derive()).toMatch(/^cdkd-MyFs-[0-9a-f]{12}$/);
    } finally {
      allowUnscopedCreateTokensForTests(previous);
    }
    expect(derive).toThrow(/outside a stack scope/);
  });
});
