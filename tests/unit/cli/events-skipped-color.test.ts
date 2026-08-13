import { describe, it, expect } from 'vite-plus/test';
import { colorizeEventType } from '../../../src/cli/commands/events.js';
import { cyan, green, red, yellow } from '../../../src/utils/colors.js';

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
});
