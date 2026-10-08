import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/synthesis` slice: a SWALLOWING handler that stringified its caught value
 * with `x instanceof Error ? x.message : String(x)` turned a graceful
 * degradation into a hard failure when the value could not be converted --
 * `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value`.
 *
 * Every case rejects with exactly that value and asserts the DEGRADATION still
 * happens, plus the placeholder, so a fix that swallowed the failure without
 * reporting it would not pass.
 */

const waiterMock = vi.hoisted(() => vi.fn());

const cfnCommands = vi.hoisted(() => {
  class FakeCfnCommand {
    constructor(
      public readonly _name: string,
      public readonly input: Record<string, unknown>
    ) {}
  }
  const named = (name: string) =>
    class extends FakeCfnCommand {
      constructor(input: Record<string, unknown>) {
        super(name, input);
      }
    };
  return {
    CreateChangeSetCommand: named('CreateChangeSet'),
    DescribeChangeSetCommand: named('DescribeChangeSet'),
    GetTemplateCommand: named('GetTemplate'),
    DeleteChangeSetCommand: named('DeleteChangeSet'),
    DeleteStackCommand: named('DeleteStack'),
  };
});

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: vi.fn(),
  ...cfnCommands,
  waitUntilChangeSetCreateComplete: waiterMock,
}));

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...loggerSpies, child: () => loggerSpies }),
}));

import { expandMacros } from '../../../src/synthesis/macro-expander.js';
import { ContextProviderRegistry } from '../../../src/synthesis/context-providers/index.js';
import type { MissingContext } from '../../../src/types/assembly.js';

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const warnings = (): string[] => loggerSpies.warn.mock.calls.map((c) => String(c[0]));
const errors = (): string[] => loggerSpies.error.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('expandMacros cleanup (#3361)', () => {
  const SAM_TEMPLATE = {
    Transform: ['AWS::Serverless-2016-10-31'],
    Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: {} } },
  };
  const EXPANDED = { Resources: { Fn: { Type: 'AWS::Lambda::Function', Properties: {} } } };

  it('a DeleteStack rejecting unconvertibly still returns the expansion, and warns', async () => {
    // The transient stack's `DeleteStack` runs in the expansion's `finally`,
    // and its catch logs the failure and moves on. `formatErr` used the bare
    // ternary, so the WARN threw out of the `finally` and replaced the
    // finished expansion with a TypeError: the deploy failed over a cleanup.
    waiterMock.mockResolvedValue({});
    const send = vi.fn(async (cmd: { _name: string }) => {
      if (cmd._name === 'CreateChangeSet') return { Id: 'cs', StackId: 's' };
      if (cmd._name === 'GetTemplate') return { TemplateBody: EXPANDED };
      if (cmd._name === 'DeleteStack') throw unconvertible();
      throw new Error(`unexpected command ${cmd._name}`);
    });

    const result = await expandMacros(SAM_TEMPLATE, {
      region: 'us-east-1',
      stateBucket: 'cdkd-state-123456789012',
      cfnClient: { send, destroy: vi.fn() } as never,
    });

    expect(result.Resources).toEqual(EXPANDED.Resources);
    const cleanup = warnings().filter((w) => w.includes('Failed to delete transient macro-expand stack'));
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toContain(PLACEHOLDER);
  });
});

describe('ContextProviderRegistry.resolve (#3361)', () => {
  it('a provider rejecting unconvertibly records a transient error, and the next entry still resolves', async () => {
    // Each lookup's catch records a transient `$providerError` and continues to
    // the next missing entry. Built with the bare ternary, the record threw, so
    // one failed lookup rejected the whole resolve and every other context
    // value of that synth round was lost with it.
    const registry = new ContextProviderRegistry({ region: 'us-east-1' });
    registry.register('failing', { resolve: () => Promise.reject(unconvertible()) });
    registry.register('working', { resolve: () => Promise.resolve('ok') });

    const results = await registry.resolve([
      { provider: 'failing', key: 'failing-key', props: {} },
      { provider: 'working', key: 'working-key', props: {} },
    ] as unknown as MissingContext[]);

    expect(results['failing-key']).toEqual({
      $providerError: PLACEHOLDER,
      $dontSaveContext: true,
    });
    expect(results['working-key']).toBe('ok');
    const failed = errors().filter((e) => e.includes("Context provider 'failing' failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(PLACEHOLDER);
  });
});
