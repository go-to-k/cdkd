import { describe, it, expect } from 'vite-plus/test';
import { refuseFailedLookups } from '../../../src/synthesis/failed-lookups.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// go-to-k/cdkd#5807: a failed context lookup blocks a command only for a stack
// it uses, found by the error annotation the app adds for the failure.

const failed = [{ key: 'ssm:account=1:parameterName=/p:region=us-east-1', error: 'SSM parameter not found: /p' }];

function stack(stackName: string, messages: StackInfo['messages'] = []): StackInfo {
  return { stackName, messages } as unknown as StackInfo;
}

describe('refuseFailedLookups', () => {
  it('refuses when a selected stack carries the failure as an error annotation', () => {
    const asked = stack('B', [{ level: 'error', path: '/B', message: 'SSM parameter not found: /p' }]);
    expect(() => refuseFailedLookups([stack('A'), asked], failed)).toThrow(
      'Context lookup failed: ssm:account=1:parameterName=/p:region=us-east-1: SSM parameter not found: /p. ' +
        'Grant the permissions the lookup needs or refresh the AWS credentials, ' +
        'or supply the value in cdk.context.json or with -c <key>=<value>.'
    );
  });

  it('lets the run through when only an unselected stack asked for the lookup', () => {
    expect(() => refuseFailedLookups([stack('A')], failed)).not.toThrow();
  });

  it('ignores the same text at warning level', () => {
    const warned = stack('A', [{ level: 'warning', path: '/A', message: 'SSM parameter not found: /p' }]);
    expect(() => refuseFailedLookups([warned], failed)).not.toThrow();
  });

  it('is a no-op with no failed lookups', () => {
    const asked = stack('A', [{ level: 'error', path: '/A', message: 'SSM parameter not found: /p' }]);
    expect(() => refuseFailedLookups([asked], [])).not.toThrow();
    expect(() => refuseFailedLookups([asked], undefined)).not.toThrow();
  });
});
