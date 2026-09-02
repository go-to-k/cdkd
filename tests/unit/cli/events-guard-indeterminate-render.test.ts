import { describe, it, expect, vi } from 'vite-plus/test';

const infoSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import { colorizeEventType, printRunEvents } from '../../../src/cli/commands/events.js';
import { cyan, yellow } from '../../../src/utils/colors.js';

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

/**
 * Issue #2301 item 3: `RESOURCE_GUARD_INDETERMINATE` is the durable record of a
 * pre-flight safety guard that could not answer. It ends in neither `FAILED`
 * nor `SUCCEEDED`, so without an explicit arm it falls to the neutral default
 * and reads exactly like routine lifecycle progress -- which is the reading
 * this event exists to prevent.
 */
describe('colorizeEventType for RESOURCE_GUARD_INDETERMINATE (issue #2301)', () => {
  it('renders it as a warning, not as neutral progress', () => {
    expect(colorizeEventType('RESOURCE_GUARD_INDETERMINATE')).toBe(
      yellow('RESOURCE_GUARD_INDETERMINATE')
    );
    expect(colorizeEventType('RESOURCE_GUARD_INDETERMINATE')).not.toBe(
      cyan('RESOURCE_GUARD_INDETERMINATE')
    );
  });
});

describe('printRunEvents renders the guard row (issue #2301)', () => {
  const lines = (): string[] =>
    infoSpy.mock.calls.flatMap((c) => stripAnsi(String(c[0])).split('\n'));

  it('renders the guard id as a column and the reason on its own line', () => {
    infoSpy.mockReset();
    printRunEvents('MyStack', 'us-east-1', 'run-1', [
      {
        timestamp: '2026-09-02T00:00:00Z',
        eventType: 'RESOURCE_GUARD_INDETERMINATE',
        stackName: 'MyStack',
        operation: 'DELETE',
        logicalId: 'Bucket',
        resourceType: 'AWS::S3::Bucket',
        provisionedBy: 'cc-api',
        physicalId: 'poisoned-bucket',
        guard: 'cc-delete-region-identity',
        reason: 's3:GetBucketLocation on poisoned-bucket could not be answered: AccessDenied',
      },
    ]);

    const out = lines().join('\n');
    expect(out).toContain('RESOURCE_GUARD_INDETERMINATE');
    expect(out).toContain('Bucket (AWS::S3::Bucket)');
    expect(out).toContain('guard=cc-delete-region-identity');
    // The reason is the whole value of the row, so it must not be dropped the
    // way a bare event type would leave it.
    expect(out).toContain('could not be answered: AccessDenied');
  });

  it('omits the guard column entirely for every other event type', () => {
    // The negative control: a `guard=` column on an unrelated row would be a
    // column that means nothing, and this is also what keeps the pre-#2301
    // rendering byte-identical.
    infoSpy.mockReset();
    printRunEvents('MyStack', 'us-east-1', 'run-1', [
      {
        timestamp: '2026-09-02T00:00:00Z',
        eventType: 'RESOURCE_SUCCEEDED',
        stackName: 'MyStack',
        operation: 'DELETE',
        logicalId: 'Bucket',
        resourceType: 'AWS::S3::Bucket',
      },
    ]);

    expect(lines().join('\n')).not.toContain('guard=');
  });
});
