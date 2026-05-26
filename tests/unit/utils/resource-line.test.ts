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
});
