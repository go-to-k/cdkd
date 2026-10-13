import { describe, expect, it, vi } from 'vite-plus/test';

/**
 * `describeLocalAwsFailureForWarn` ends in `displaySafe` so a call site can put
 * its result beside a sanitized identifier without relying on cdk-local's own
 * flattening (go-to-k/cdkd#2300), and the mixed-render fence trusts it as a
 * sanitizer on that basis. cdk-local is stubbed here to return raw terminal
 * controls, which is the only way to see that last step: the real one already
 * strips them.
 */
vi.mock('cdk-local/internal', () => ({
  describeAwsFailureForWarn: () => 'AccessDenied: a\u001b[2Kb\nc‮d',
  describeCredentialLoadFailure: () => 'unused',
}));

const { describeLocalAwsFailureForWarn } = await import(
  '../../../src/cli/commands/local-aws-failure.js'
);

describe('describeLocalAwsFailureForWarn: the final displaySafe', () => {
  it('strips terminal controls even when cdk-local returned them', () => {
    const rendered = describeLocalAwsFailureForWarn(new Error('x'), 'STS AssumeRole');
    expect(rendered).not.toMatch(/[\u001b\n‮]/);
    expect(rendered.startsWith('AccessDenied: a')).toBe(true);
  });
});
