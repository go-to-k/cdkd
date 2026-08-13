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
import { cyan, green, red, yellow } from '../../../src/utils/colors.js';

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

/**
 * Issue #1752: `cdkd events` colors each event-type token by lifecycle phase.
 * `RESOURCE_SKIPPED` fell through to the neutral default arm, rendering
 * identically to `RESOURCE_STARTED` — so the one event meaning "cdkd left a
 * resource it could not address" read as routine progress.
 */
describe('colorizeEventType (issue #1752)', () => {
  it('renders RESOURCE_SKIPPED as a warning, not as neutral progress', () => {
    expect(colorizeEventType('RESOURCE_SKIPPED')).toBe(yellow('RESOURCE_SKIPPED'));
    expect(colorizeEventType('RESOURCE_SKIPPED')).not.toBe(cyan('RESOURCE_SKIPPED'));
  });

  it('leaves RESOURCE_RETAINED neutral — that resource is kept ON PURPOSE', () => {
    // The two destroy-side skips mean opposite things: RETAINED is the user's
    // own `DeletionPolicy: Retain` instruction, SKIPPED is cdkd failing to
    // address the resource. Sweeping both into yellow would lose that.
    expect(colorizeEventType('RESOURCE_RETAINED')).toBe(cyan('RESOURCE_RETAINED'));
  });

  it('does not disturb the pre-existing phase colors', () => {
    expect(colorizeEventType('RESOURCE_FAILED')).toBe(red('RESOURCE_FAILED'));
    expect(colorizeEventType('RESOURCE_SUCCEEDED')).toBe(green('RESOURCE_SUCCEEDED'));
    expect(colorizeEventType('RUN_FINISHED')).toBe(green('RUN_FINISHED'));
    expect(colorizeEventType('ROLLBACK_STARTED')).toBe(yellow('ROLLBACK_STARTED'));
    expect(colorizeEventType('RESOURCE_STARTED')).toBe(cyan('RESOURCE_STARTED'));
  });

  // Issue #1752 (review): `counts.skipped` was emitted but never RENDERED, so
  // a skip-only destroy showed `RUN_FINISHED FAILED +0/~0/-2` — a failed run
  // naming nothing that failed, the exact symptom the field exists to remove.
  describe('printRunEvents renders the skip count and reason', () => {
    it('renders ⚠N alongside the created/updated/deleted triple', () => {
      infoSpy.mockReset();
      printRunEvents('run-1', 'MyStack', 'us-east-1', [
        {
          timestamp: '2026-08-13T00:00:00Z',
          eventType: 'RUN_FINISHED',
          stackName: 'MyStack',
          result: 'FAILED',
          counts: { created: 0, updated: 0, deleted: 2, skipped: 1 },
        },
      ] as never);

      const out = stripAnsi(infoSpy.mock.calls.map((c) => String(c[0])).join('\n'));
      expect(out).toContain('+0/~0/-2');
      expect(out).toContain('⚠1');
    });

    it('omits the skip marker entirely when nothing was skipped', () => {
      infoSpy.mockReset();
      printRunEvents('run-1', 'MyStack', 'us-east-1', [
        {
          timestamp: '2026-08-13T00:00:00Z',
          eventType: 'RUN_FINISHED',
          stackName: 'MyStack',
          result: 'SUCCEEDED',
          counts: { created: 0, updated: 0, deleted: 2 },
        },
      ] as never);

      const out = stripAnsi(infoSpy.mock.calls.map((c) => String(c[0])).join('\n'));
      expect(out).toContain('+0/~0/-2');
      expect(out).not.toContain('⚠');
    });

    it('renders a RESOURCE_SKIPPED reason on its own line', () => {
      infoSpy.mockReset();
      printRunEvents('run-1', 'MyStack', 'us-east-1', [
        {
          timestamp: '2026-08-13T00:00:00Z',
          eventType: 'RESOURCE_SKIPPED',
          stackName: 'MyStack',
          operation: 'DELETE',
          logicalId: 'MyTable',
          resourceType: 'AWS::Glue::Table',
          reason: 'malformed physicalId in state — no delete issued',
        },
      ] as never);

      const out = stripAnsi(infoSpy.mock.calls.map((c) => String(c[0])).join('\n'));
      expect(out).toContain('RESOURCE_SKIPPED');
      expect(out).toContain('malformed physicalId in state — no delete issued');
    });
  });
});
