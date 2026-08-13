import { describe, it, expect } from 'vite-plus/test';
import { formatResourceLine } from '../../../src/utils/resource-line.js';
import { bold, gray, green, red, yellow } from '../../../src/utils/colors.js';

describe('formatResourceLine', () => {
  const id = 'Handler886CB40B';
  const type = 'AWS::Lambda::Function';
  const body = `${bold(id)} ${gray(`(${type})`)}`;

  it('formats a created line with a green check and green verb', () => {
    expect(formatResourceLine('created', id, type)).toBe(`${green('✓')} ${body} ${green('created')}`);
  });

  it('formats an updated line with a yellow check and yellow verb', () => {
    expect(formatResourceLine('updated', id, type)).toBe(
      `${yellow('✓')} ${body} ${yellow('updated')}`
    );
  });

  it('formats a deleted line with a green check (not a red cross) and a red verb', () => {
    expect(formatResourceLine('deleted', id, type)).toBe(`${green('✓')} ${body} ${red('deleted')}`);
  });

  it('applies a verb override while keeping the op glyph and color', () => {
    expect(formatResourceLine('updated', id, type, 'updated (metadata)')).toBe(
      `${yellow('✓')} ${body} ${yellow('updated (metadata)')}`
    );
  });

  it.each(['created', 'updated', 'deleted'] as const)(
    'uses a check, never a cross, for a successful %s',
    (op) => {
      // Regression guard: a successful op must not look like the
      // "✗ Failed to delete" error path. Every op renders a check.
      const line = formatResourceLine(op, id, type);
      expect(line).toContain('✓');
      expect(line).not.toContain('✗');
      expect(line).not.toContain(red('✗'));
    }
  );

  it('embeds the logical id and resource type', () => {
    const line = formatResourceLine('deleted', id, type);
    expect(line).toContain(id);
    expect(line).toContain(`(${type})`);
  });

  // Issue #1752: `skipped` is the one op that is NEITHER success nor failure.
  describe('skipped (issue #1752)', () => {
    it('renders a yellow warning glyph — not a check and not a cross', () => {
      expect(formatResourceLine('skipped', id, type)).toBe(
        `${yellow('⚠')} ${body} ${yellow('skipped')}`
      );
    });

    it('never renders as a successful op', () => {
      // The whole point: a skip must not be readable as `✓ … deleted`, which
      // is what the destroy runner printed before the fix.
      const line = formatResourceLine('skipped', id, type);
      expect(line).not.toContain('✓');
      expect(line).not.toContain('✗');
      expect(line).not.toContain('deleted');
    });

    it('carries the skip reason through verbOverride', () => {
      expect(
        formatResourceLine('skipped', id, type, 'skipped (malformed physicalId in state)')
      ).toBe(`${yellow('⚠')} ${body} ${yellow('skipped (malformed physicalId in state)')}`);
    });
  });
});
