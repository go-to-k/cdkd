import { describe, it, expect } from 'vite-plus/test';
import { lambdaFunctionNameForMask } from '../../../src/utils/lambda-function-name.js';

describe('lambdaFunctionNameForMask (issue #2177)', () => {
  it.each([
    ['arn:aws:lambda:us-east-1:123456789012:function:my-fn', 'my-fn'],
    ['arn:aws:lambda:us-east-1:123456789012:function:my-fn:live', 'my-fn'],
    ['arn:aws-cn:lambda:cn-north-1:123456789012:function:my-fn:7', 'my-fn'],
    ['123456789012:function:my-fn', 'my-fn'],
    ['123456789012:function:my-fn:$LATEST', 'my-fn'],
    ['my-fn:live', 'my-fn'],
    ['my-fn', 'my-fn'],
  ])('reads the bare name out of %s', (value, name) => {
    expect(lambdaFunctionNameForMask(value)).toBe(name);
  });

  it('returns an unrecognized shape unchanged', () => {
    expect(lambdaFunctionNameForMask('not a function / ref')).toBe('not a function / ref');
  });
});
