import { describe, it, expect } from 'vite-plus/test';
import { extractDeploymentEventError } from '../../../src/types/deployment-events.js';

/** AWS-SDK-shaped error: carries `$metadata.requestId` + a service `Code`. */
function awsError(opts: {
  name?: string;
  message: string;
  code?: string;
  requestId?: string;
}): Error & { $metadata?: { requestId?: string }; Code?: string } {
  const err = new Error(opts.message) as Error & {
    $metadata?: { requestId?: string };
    Code?: string;
  };
  if (opts.name) err.name = opts.name;
  err.$metadata = opts.requestId ? { requestId: opts.requestId } : {};
  if (opts.code) err.Code = opts.code;
  return err;
}

describe('extractDeploymentEventError', () => {
  it('takes name/message from the outermost error', () => {
    const err = new Error('top-level boom');
    err.name = 'ProvisioningError';
    const result = extractDeploymentEventError(err);
    expect(result.name).toBe('ProvisioningError');
    expect(result.message).toBe('top-level boom');
  });

  it('extracts the DEEPEST AWS-shaped error code + requestId from the cause chain', () => {
    // outer (no $metadata) -> middle (no $metadata) -> inner (AWS-shaped)
    const inner = awsError({
      name: 'AccessDeniedException',
      message: 'not authorized',
      code: 'AccessDeniedException',
      requestId: 'req-inner-999',
    });
    const middle = new Error('wrapping middle') as Error & { cause?: unknown };
    middle.cause = inner;
    const outer = new Error('Failed to create resource X') as Error & { cause?: unknown };
    outer.name = 'ProvisioningError';
    outer.cause = middle;

    const result = extractDeploymentEventError(outer);
    // Outermost supplies name/message...
    expect(result.name).toBe('ProvisioningError');
    expect(result.message).toBe('Failed to create resource X');
    // ...the AWS-shaped inner supplies code + requestId.
    expect(result.awsErrorCode).toBe('AccessDeniedException');
    expect(result.requestId).toBe('req-inner-999');
  });

  it('prefers the DEEPEST AWS-shaped error when multiple appear in the chain', () => {
    const inner = awsError({
      message: 'inner',
      code: 'InnerCode',
      requestId: 'req-inner',
    });
    const outerAws = awsError({
      message: 'outer aws',
      code: 'OuterCode',
      requestId: 'req-outer',
    }) as Error & { cause?: unknown };
    outerAws.cause = inner;

    const result = extractDeploymentEventError(outerAws);
    // Loop walks outer-to-inner overwriting, so the deepest (inner) wins.
    expect(result.awsErrorCode).toBe('InnerCode');
    expect(result.requestId).toBe('req-inner');
  });

  it('falls back to Error.name when an AWS-shaped error has no explicit Code', () => {
    const err = awsError({
      name: 'ThrottlingException',
      message: 'slow down',
      requestId: 'req-throttle',
    });
    // No `Code` set — code should fall back to the error name.
    const result = extractDeploymentEventError(err);
    expect(result.awsErrorCode).toBe('ThrottlingException');
    expect(result.requestId).toBe('req-throttle');
  });

  it('does not infinite-loop on a self-referencing (cyclic) cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a; // cycle
    // The bounded depth(10) guard must terminate.
    const result = extractDeploymentEventError(a);
    expect(result.name).toBe('Error');
    expect(result.message).toBe('a');
    // No AWS-shaped error anywhere in the cycle.
    expect(result.awsErrorCode).toBeUndefined();
    expect(result.requestId).toBeUndefined();
  });

  it('stops at the bounded depth and does not walk past 10 cause levels', () => {
    // Build a chain of 15 plain errors with the AWS-shaped error at the very
    // bottom (depth 14) — past the depth-10 guard, so it is NOT reached.
    const deepAws = awsError({
      message: 'too deep',
      code: 'TooDeepCode',
      requestId: 'req-too-deep',
    });
    let head: Error & { cause?: unknown } = deepAws;
    for (let i = 0; i < 14; i++) {
      const wrap = new Error(`wrap-${i}`) as Error & { cause?: unknown };
      wrap.cause = head;
      head = wrap;
    }
    const result = extractDeploymentEventError(head);
    // The guard stops before reaching the depth-14 AWS error.
    expect(result.awsErrorCode).toBeUndefined();
    expect(result.requestId).toBeUndefined();
  });

  it('handles a non-Error input (string / object) without throwing', () => {
    expect(extractDeploymentEventError('plain string failure')).toEqual({
      name: 'UnknownError',
      message: 'plain string failure',
    });
    expect(extractDeploymentEventError({ some: 'object' })).toEqual({
      name: 'UnknownError',
      message: '[object Object]',
    });
    expect(extractDeploymentEventError(undefined)).toEqual({
      name: 'UnknownError',
      message: 'undefined',
    });
  });
});
