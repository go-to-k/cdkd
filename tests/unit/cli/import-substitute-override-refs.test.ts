import { describe, it, expect } from 'vite-plus/test';
import { substituteOverrideRefs } from '../../../src/cli/commands/import.js';

/**
 * Unit coverage for the pre-import `{Ref: <X>}` substitution helper added in
 * issue #361's fix. The helper bridges the gap between CDK synth's raw
 * intrinsic-valued Properties and what sub-resource policy providers need to
 * see at `provider.import()` time (e.g. `SQSQueuePolicyProvider`'s fallback
 * branch reads `properties.Queues[0]` as a literal queue URL).
 *
 * The integration coverage lives in
 * `tests/integration/migrate-from-cfn/lib/migrate-small-stack.ts` — once that
 * fixture's `run.sh` no longer needs the `--resource` workaround for the
 * QueuePolicy, the deeper fix is end-to-end verified against real AWS.
 */
describe('substituteOverrideRefs', () => {
  it('substitutes a top-level {Ref: X} with overrides.get(X)', () => {
    const overrides = new Map([['MyQueue', 'https://sqs.us-east-1.amazonaws.com/123/MyQueue']]);
    const result = substituteOverrideRefs({ Ref: 'MyQueue' }, overrides);
    expect(result).toBe('https://sqs.us-east-1.amazonaws.com/123/MyQueue');
  });

  it('substitutes {Ref: X} inside arrays (canonical QueuePolicy.Queues[0] shape)', () => {
    const overrides = new Map([
      ['ExampleQueue', 'https://sqs.us-east-1.amazonaws.com/123/ExampleQueue'],
    ]);
    const input = {
      Queues: [{ Ref: 'ExampleQueue' }],
      PolicyDocument: { Version: '2012-10-17', Statement: [] },
    };
    const result = substituteOverrideRefs(input, overrides);
    expect(result).toEqual({
      Queues: ['https://sqs.us-east-1.amazonaws.com/123/ExampleQueue'],
      PolicyDocument: { Version: '2012-10-17', Statement: [] },
    });
  });

  it('leaves {Ref: X} untouched when X is NOT in the overrides map', () => {
    const overrides = new Map([['OtherResource', 'whatever']]);
    const result = substituteOverrideRefs({ Ref: 'MyQueue' }, overrides);
    expect(result).toEqual({ Ref: 'MyQueue' });
  });

  it('leaves pseudo-parameter Refs (AWS::Region) untouched even if listed in overrides', () => {
    // Pseudo parameters are not in the import overrides map by construction
    // (the CFn DescribeStackResources mapping only carries real logical IDs).
    // This test guards against a future hypothetical contamination.
    const overrides = new Map<string, string>();
    const result = substituteOverrideRefs({ Ref: 'AWS::Region' }, overrides);
    expect(result).toEqual({ Ref: 'AWS::Region' });
  });

  it('does NOT substitute Fn::GetAtt — only Ref is handled at this stage', () => {
    const overrides = new Map([['MyResource', 'physical-id']]);
    const input = { 'Fn::GetAtt': ['MyResource', 'Arn'] };
    const result = substituteOverrideRefs(input, overrides);
    expect(result).toEqual({ 'Fn::GetAtt': ['MyResource', 'Arn'] });
  });

  it('recursively descends into nested objects', () => {
    const overrides = new Map([['MyQueue', 'https://sqs.example.com/MyQueue']]);
    const input = {
      Outer: {
        Inner: {
          DeepValue: { Ref: 'MyQueue' },
        },
      },
    };
    const result = substituteOverrideRefs(input, overrides);
    expect(result).toEqual({
      Outer: {
        Inner: {
          DeepValue: 'https://sqs.example.com/MyQueue',
        },
      },
    });
  });

  it('does not modify the input value (pure-functional)', () => {
    const overrides = new Map([['MyQueue', 'https://sqs.example.com/MyQueue']]);
    const input = { Queues: [{ Ref: 'MyQueue' }] };
    const inputSnapshot = JSON.parse(JSON.stringify(input));
    substituteOverrideRefs(input, overrides);
    expect(input).toEqual(inputSnapshot);
  });

  it('preserves non-intrinsic objects with a Ref-prefixed key', () => {
    // A real-world case: `Properties.Topics` might be a literal array of ARNs
    // — substituteOverrideRefs should leave such non-intrinsic shapes alone.
    const overrides = new Map([['NotARef', 'value']]);
    const input = { Topics: ['arn:aws:sns:us-east-1:123:foo'] };
    const result = substituteOverrideRefs(input, overrides);
    expect(result).toEqual({ Topics: ['arn:aws:sns:us-east-1:123:foo'] });
  });

  it('does not substitute a multi-key object that happens to contain a Ref key', () => {
    // Only the canonical 1-key `{Ref: <X>}` shape is an intrinsic. An object
    // like `{Ref: 'X', extra: ...}` is malformed as a CFn intrinsic — leave
    // it alone rather than partially substitute.
    const overrides = new Map([['MyQueue', 'queue-url']]);
    const input = { Ref: 'MyQueue', extra: 'noise' };
    const result = substituteOverrideRefs(input, overrides);
    expect(result).toEqual({ Ref: 'MyQueue', extra: 'noise' });
  });

  it('handles null / undefined / primitive scalars without throwing', () => {
    const overrides = new Map<string, string>();
    expect(substituteOverrideRefs(null, overrides)).toBeNull();
    expect(substituteOverrideRefs(undefined, overrides)).toBeUndefined();
    expect(substituteOverrideRefs('literal', overrides)).toBe('literal');
    expect(substituteOverrideRefs(42, overrides)).toBe(42);
    expect(substituteOverrideRefs(true, overrides)).toBe(true);
  });

  it('handles empty arrays and empty objects', () => {
    const overrides = new Map<string, string>();
    expect(substituteOverrideRefs([], overrides)).toEqual([]);
    expect(substituteOverrideRefs({}, overrides)).toEqual({});
  });

  it('handles overrides where the resolved value is itself a Ref-looking string', () => {
    // The substituted value should be returned as-is — no recursive
    // resolution. Otherwise a chain like `{X -> "{Ref: Y}"}` could loop
    // forever on a malformed overrides map.
    const overrides = new Map([['MyResource', '{Ref: SomethingElse}']]);
    const result = substituteOverrideRefs({ Ref: 'MyResource' }, overrides);
    expect(result).toBe('{Ref: SomethingElse}');
  });
});
