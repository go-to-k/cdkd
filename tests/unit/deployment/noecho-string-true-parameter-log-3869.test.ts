/**
 * A parameter declared `NoEcho: "true"` (the string, as a hand-written or
 * included template spells it) is redacted on the parameter binding's
 * `--verbose` lines like `NoEcho: true` (go-to-k/cdkd#3869). Every other
 * `NoEcho` reader already accepts the string, and `cdkd destroy` now binds the
 * parameters of every stack declaring one.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const lines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const push = (...args: unknown[]): void => void lines.push(args.map(String).join(' '));
  const fake = {
    setLevel: (): void => undefined,
    debug: push,
    info: push,
    warn: push,
    error: push,
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

const { IntrinsicFunctionResolver } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const VALUE = 'string-true-noecho-default-3869';

const template = (noEcho: unknown): CloudFormationTemplate =>
  ({
    Parameters: { Secret: { Type: 'String', NoEcho: noEcho, Default: VALUE } },
    Resources: {},
  }) as unknown as CloudFormationTemplate;

describe('stringifyParameterForLog honours NoEcho: "true" (go-to-k/cdkd#3869)', () => {
  beforeEach(() => {
    lines.length = 0;
  });

  it.each([
    ['the boolean', true],
    ['the string', 'true'],
  ])('redacts a NoEcho Default declared with %s', async (_l, noEcho) => {
    const bound = await new IntrinsicFunctionResolver('us-east-1').resolveParameters(
      template(noEcho)
    );
    // Premise: the value was bound, and a line named the parameter.
    expect(bound['Secret']).toBe(VALUE);
    expect(lines.some((line) => line.includes('Secret'))).toBe(true);
    expect(lines.join('\n')).not.toContain(VALUE);
  });

  it('negative control: an ordinary parameter prints its value', async () => {
    await new IntrinsicFunctionResolver('us-east-1').resolveParameters(template(false));
    expect(lines.join('\n')).toContain(VALUE);
  });
});
