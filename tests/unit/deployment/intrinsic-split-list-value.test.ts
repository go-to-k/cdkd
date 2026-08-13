import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import {
  RETRYABLE_ERROR_MESSAGE_PATTERNS,
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

// Mock logger (this resolver logs on every resolution path).
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

/**
 * Issue [#1874](https://github.com/go-to-k/cdkd/issues/1874): `Fn::Split` over
 * a list-valued `Fn::GetAtt`.
 *
 * The BEHAVIOR is unchanged — a non-string value is still refused, because
 * real CloudFormation rejects `Fn::Split` over a list too and accepting it
 * would let cdkd deploy templates `cdkd export` cannot hand back to CFn. What
 * changed is the MESSAGE, so these tests are message tests by design: the
 * pre-fix `value must be a string, got object` named neither the situation nor
 * the remedy.
 */
const mkResource = (attributes: Record<string, unknown>): ResourceState => ({
  physicalId: 'Z123456789',
  resourceType: 'AWS::Route53::HostedZone',
  properties: {},
  attributes,
  dependencies: [],
});

const mkContext = (resources: Record<string, ResourceState> = {}): ResolverContext => ({
  resources,
  template: {} as CloudFormationTemplate,
});

const splitError = async (
  resolver: IntrinsicFunctionResolver,
  args: unknown,
  context: ResolverContext
): Promise<Error> => {
  try {
    await resolver.resolve({ 'Fn::Split': args }, context);
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected Fn::Split to throw, but it resolved');
};

describe('Fn::Split over an already-list value (issue #1874)', () => {
  it('refuses a resolved ARRAY with a message naming the situation and the remedy', async () => {
    const resolver = new IntrinsicFunctionResolver();
    const arrayError = await splitError(resolver, [',', ['a', 'b', 'c']], mkContext());
    expect(arrayError.message).toContain('is ALREADY a list');
    expect(arrayError.message).toContain('an array of 3 items');
    expect(arrayError.message).toContain('Remove the Fn::Split');
    // The refusal must state WHY it is not a cdkd divergence, so a reader does
    // not re-open the accept-the-array option the maintainer decided against.
    expect(arrayError.message).toContain('CloudFormation rejects Fn::Split over a list too');
  });

  it('singularizes the item count for a one-element array', async () => {
    const resolver = new IntrinsicFunctionResolver();
    const error = await splitError(resolver, [',', ['only']], mkContext());
    expect(error.message).toContain('an array of 1 item)');
    expect(error.message).not.toContain('1 items');
  });

  it('refuses the real-world shape from the issue, naming the source Fn::GetAtt', async () => {
    // {"Fn::Split": [",", {"Fn::GetAtt": ["Zone", "NameServers"]}]} against a
    // state record whose NameServers attribute is a LIST — exactly what
    // PR #1868 made `AWS::Route53::HostedZone.NameServers` resolve to.
    const resolver = new IntrinsicFunctionResolver();
    const context = mkContext({
      Zone: mkResource({
        NameServers: [
          'ns-1.awsdns-00.com',
          'ns-2.awsdns-01.net',
          'ns-3.awsdns-02.org',
          'ns-4.awsdns-03.co.uk',
        ],
      }),
    });

    const error = await splitError(
      resolver,
      [',', { 'Fn::GetAtt': ['Zone', 'NameServers'] }],
      context
    );

    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(error.message).toContain('is ALREADY a list');
    expect(error.message).toContain('an array of 4 items');
    // ResolverContext carries no referencing logical id, but the UNRESOLVED
    // value expression does — so the message can still name the exact site.
    expect(error.message).toContain('(from Fn::GetAtt [Zone, NameServers])');
    // The workaround pointer: this template shape only ever worked because of
    // the pre-#1868 comma-delimited-string bug.
    expect(error.message).toContain('#1868');
  });

  it('names the source for the dotted `Fn::GetAtt` string spelling too', async () => {
    const resolver = new IntrinsicFunctionResolver();
    const context = mkContext({ Zone: mkResource({ NameServers: ['ns-1', 'ns-2'] }) });

    const error = await splitError(resolver, [',', { 'Fn::GetAtt': 'Zone.NameServers' }], context);
    expect(error.message).toContain('(from Fn::GetAtt [Zone, NameServers])');
  });

  it('omits the source clause for a literal value (nothing to name)', async () => {
    const resolver = new IntrinsicFunctionResolver();
    const error = await splitError(resolver, [',', ['a', 'b']], mkContext());
    expect(error.message).toContain('Fn::Split: the value to split is ALREADY a list');
    expect(error.message).not.toContain('(from ');
  });

  it('keeps a distinct refusal for a non-array non-string, never claiming "already a list"', async () => {
    const resolver = new IntrinsicFunctionResolver();

    const numberError = await splitError(resolver, [',', 42], mkContext());
    expect(numberError).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(numberError.message).toContain('must be a string, got number');
    expect(numberError.message).not.toContain('ALREADY a list');

    const objectError = await splitError(resolver, [',', { Some: 'record' }], mkContext());
    expect(objectError.message).toContain('must be a string, got object');
    expect(objectError.message).not.toContain('ALREADY a list');

    // `typeof null === 'object'` would have read as a record; say `null`.
    const nullError = await splitError(resolver, [',', null], mkContext());
    expect(nullError.message).toContain('must be a string, got null');
    expect(nullError.message).not.toContain('ALREADY a list');
  });

  it('still splits an ordinary string, including a list-valued attribute joined first', async () => {
    const resolver = new IntrinsicFunctionResolver();
    expect(await resolver.resolve({ 'Fn::Split': [',', 'a,b,c'] }, mkContext())).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(await resolver.resolve({ 'Fn::Split': ['|', 'single'] }, mkContext())).toEqual([
      'single',
    ]);

    // The supported way to split a list-valued attribute: join it first.
    const context = mkContext({ Zone: mkResource({ NameServers: ['ns-1', 'ns-2'] }) });
    expect(
      await resolver.resolve(
        { 'Fn::Split': [',', { 'Fn::Join': [',', { 'Fn::GetAtt': ['Zone', 'NameServers'] }] }] },
        context
      )
    ).toEqual(['ns-1', 'ns-2']);
  });

  it('throws IntrinsicResolutionRefusalError (a deliberate refusal), not a bare Error', async () => {
    const resolver = new IntrinsicFunctionResolver();
    for (const value of [['a'], 42, null, { Some: 'record' }]) {
      const error = await splitError(resolver, [',', value], mkContext());
      expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect((error as IntrinsicResolutionRefusalError).code).toBe('INTRINSIC_RESOLUTION_REFUSAL');
    }
  });

  it('is marked non-retryable, so the refusal cannot burn the retry schedule', async () => {
    // Issue #1838. The criterion is "can this ever succeed on a retry" — an
    // Fn::Split over an array never can — NOT "does today's wording collide
    // with a pattern", which `retryable-errors.ts` documents as insufficient.
    // Reachability is real: resolution runs outside `withRetry` on the flat
    // path, but `NestedStackProvider.create` runs a child `DeployEngine.deploy()`
    // and re-throws, and the parent wraps `create()` in `withRetry` — so inside
    // a nested stack each retry re-runs a whole child deploy plus rollback.
    const resolver = new IntrinsicFunctionResolver();
    for (const value of [['a', 'b'], 42, null, { Some: 'record' }]) {
      const error = await splitError(resolver, [',', value], mkContext());
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(isRetryableTransientError(error, error.message)).toBe(false);
    }
  });

  it('stays non-retryable when the logical id itself contains a retryable pattern', async () => {
    // The regression the marker exists for: `sourceClause` interpolates
    // template-controlled text, so an ordinary composite CDK logical id can put
    // a retryable pattern INTO the message. `DependencyViolation` is the
    // table's only whitespace-free entry, which is what makes it reachable
    // from an identifier. Asserted through the classifier (the OUTCOME), not by
    // re-checking the message against the table — the wording is expected to
    // collide here, and the marker is what has to win.
    const resolver = new IntrinsicFunctionResolver();
    const logicalId = 'MyDependencyViolationHandler';
    const context = mkContext({ [logicalId]: mkResource({ NameServers: ['ns-1', 'ns-2'] }) });

    const error = await splitError(
      resolver,
      [',', { 'Fn::GetAtt': [logicalId, 'NameServers'] }],
      context
    );

    // The message really does contain a retryable pattern...
    expect(error.message).toContain('DependencyViolation');
    expect(RETRYABLE_ERROR_MESSAGE_PATTERNS).toContain('DependencyViolation');
    // ...and the classifier must still refuse to retry it.
    expect(isRetryableTransientError(error, error.message)).toBe(false);
  });

  it('carries no retryable message pattern on its own, either', async () => {
    // Belt-and-braces beside the marker: with no user text interpolated the
    // static wording must not collide, so a future reword cannot quietly rely
    // on the marker alone (and a `--dry-run`-style consumer that only ever sees
    // the message keeps a clean read).
    const resolver = new IntrinsicFunctionResolver();
    const messages = [
      (await splitError(resolver, [',', ['a', 'b']], mkContext())).message,
      (await splitError(resolver, [',', 42], mkContext())).message,
    ];
    for (const message of messages) {
      const matched = RETRYABLE_ERROR_MESSAGE_PATTERNS.filter((p) => message.includes(p));
      expect(matched).toEqual([]);
    }
  });
});
