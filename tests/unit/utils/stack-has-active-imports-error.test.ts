import { describe, it, expect } from 'vite-plus/test';
import {
  StackHasActiveImportsError,
  type ActiveImportConsumer,
} from '../../../src/utils/error-handler.js';

describe('StackHasActiveImportsError', () => {
  it('carries exit code 2 (same as PartialFailureError)', () => {
    const err = new StackHasActiveImportsError('P', 'us-east-1', [
      { consumerStack: 'C', consumerRegion: 'us-east-1', exportName: 'X' },
    ]);
    expect(err.exitCode).toBe(2);
  });

  it('lists every offending consumer in the message', () => {
    const consumers: ActiveImportConsumer[] = [
      { consumerStack: 'C1', consumerRegion: 'us-east-1', exportName: 'BucketArn' },
      { consumerStack: 'C2', consumerRegion: 'us-east-1', exportName: 'TopicArn' },
    ];
    const err = new StackHasActiveImportsError('Producer', 'us-east-1', consumers);
    expect(err.message).toContain('C1 (us-east-1)');
    expect(err.message).toContain("imports export 'BucketArn'");
    expect(err.message).toContain('C2 (us-east-1)');
    expect(err.message).toContain("imports export 'TopicArn'");
  });

  it('names the producer in the headline', () => {
    const err = new StackHasActiveImportsError('MyProducer', 'us-east-1', [
      { consumerStack: 'X', consumerRegion: 'us-east-1', exportName: 'Y' },
    ]);
    expect(err.message).toContain("Cannot destroy stack 'MyProducer'");
    expect(err.producerStack).toBe('MyProducer');
    expect(err.producerRegion).toBe('us-east-1');
  });

  it('points users at the two valid resolution paths', () => {
    const err = new StackHasActiveImportsError('P', 'us-east-1', [
      { consumerStack: 'C', consumerRegion: 'us-east-1', exportName: 'X' },
    ]);
    expect(err.message).toContain('Destroy the consumer first');
    expect(err.message).toContain('cdkd destroy');
    expect(err.message).toContain('remove the Fn::ImportValue');
  });

  it('mentions Fn::GetStackOutput as a weak-reference alternative', () => {
    const err = new StackHasActiveImportsError('P', 'us-east-1', [
      { consumerStack: 'C', consumerRegion: 'us-east-1', exportName: 'X' },
    ]);
    // Re-emphasize: the error message hints at the weak-ref alternative
    // so users with the wrong tool pick the right one next time.
    expect(err.message).toContain('Fn::GetStackOutput');
    expect(err.message).toContain('does NOT protect the producer');
  });

  it('mentions CloudFormation parity (strong-reference semantics)', () => {
    const err = new StackHasActiveImportsError('P', 'us-east-1', [
      { consumerStack: 'C', consumerRegion: 'us-east-1', exportName: 'X' },
    ]);
    expect(err.message).toContain("CloudFormation's strong-reference semantics");
  });

  it('preserves consumers in .consumers for programmatic access', () => {
    const consumers: ActiveImportConsumer[] = [
      { consumerStack: 'C1', consumerRegion: 'us-east-1', exportName: 'X' },
      { consumerStack: 'C2', consumerRegion: 'us-west-2', exportName: 'Y' },
    ];
    const err = new StackHasActiveImportsError('P', 'us-east-1', consumers);
    expect(err.consumers).toEqual(consumers);
  });

  it('name and prototype are set for instanceof checks', () => {
    const err = new StackHasActiveImportsError('P', 'us-east-1', [
      { consumerStack: 'C', consumerRegion: 'us-east-1', exportName: 'X' },
    ]);
    expect(err.name).toBe('StackHasActiveImportsError');
    expect(err instanceof StackHasActiveImportsError).toBe(true);
  });
});
