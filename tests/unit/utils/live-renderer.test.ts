import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiveRenderer } from '../../../src/utils/live-renderer.js';

class FakeStream {
  isTTY = true;
  columns: number | undefined = 200;
  chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  output(): string {
    return this.chunks.join('');
  }
  reset(): void {
    this.chunks = [];
  }
}

function makeRenderer(stream: FakeStream): LiveRenderer {
  return new LiveRenderer(stream as unknown as NodeJS.WriteStream);
}

describe('LiveRenderer', () => {
  beforeEach(() => {
    delete process.env['CDKD_NO_LIVE'];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() returns false on non-TTY', () => {
    const stream = new FakeStream();
    stream.isTTY = false;
    const r = makeRenderer(stream);
    expect(r.start()).toBe(false);
    expect(r.isActive()).toBe(false);
  });

  it('start() returns false when CDKD_NO_LIVE=1', () => {
    process.env['CDKD_NO_LIVE'] = '1';
    const r = makeRenderer(new FakeStream());
    expect(r.start()).toBe(false);
    expect(r.isActive()).toBe(false);
  });

  it('start() activates and stop() deactivates', () => {
    const r = makeRenderer(new FakeStream());
    expect(r.start()).toBe(true);
    expect(r.isActive()).toBe(true);
    r.stop();
    expect(r.isActive()).toBe(false);
  });

  it('addTask draws a line for each in-flight task', () => {
    const stream = new FakeStream();
    const r = makeRenderer(stream);
    r.start();
    stream.reset();

    r.addTask('A', 'Creating A');
    const out1 = stream.output();
    expect(out1).toContain('Creating A');

    r.addTask('B', 'Creating B');
    const out2 = stream.output();
    expect(out2).toContain('Creating B');
    // Most recent draw should contain both labels
    const lastDraw = stream.chunks[stream.chunks.length - 1] ?? '';
    expect(lastDraw).toContain('Creating A');
    expect(lastDraw).toContain('Creating B');

    r.stop();
  });

  it('removeTask redraws without the removed label', () => {
    const stream = new FakeStream();
    const r = makeRenderer(stream);
    r.start();

    r.addTask('A', 'Creating A');
    r.addTask('B', 'Creating B');
    stream.reset();

    r.removeTask('A');
    const lastDraw = stream.chunks[stream.chunks.length - 1] ?? '';
    expect(lastDraw).not.toContain('Creating A');
    expect(lastDraw).toContain('Creating B');

    r.stop();
  });

  it('removeTask is idempotent (second call is a no-op)', () => {
    const stream = new FakeStream();
    const r = makeRenderer(stream);
    r.start();

    r.addTask('A', 'Creating A');
    r.removeTask('A');
    stream.reset();

    r.removeTask('A'); // second remove
    // Nothing should be written since the task was already removed
    expect(stream.chunks.length).toBe(0);

    r.stop();
  });

  it('printAbove falls through directly when inactive', () => {
    const stream = new FakeStream();
    const r = makeRenderer(stream);
    let called = false;
    r.printAbove(() => {
      called = true;
    });
    expect(called).toBe(true);
    expect(stream.chunks.length).toBe(0); // renderer wrote nothing itself
  });

  it('printAbove clears live area, runs writer, redraws when active', () => {
    const stream = new FakeStream();
    const r = makeRenderer(stream);
    r.start();
    r.addTask('A', 'Creating A');
    stream.reset();

    let writerRanAt = -1;
    r.printAbove(() => {
      writerRanAt = stream.chunks.length;
    });

    // Sequence should be: clear bytes → writer runs → redraw bytes.
    // We expect at least one ANSI clear sequence before the writer ran,
    // and at least one redraw after.
    expect(writerRanAt).toBeGreaterThan(0);
    const beforeWriter = stream.chunks.slice(0, writerRanAt).join('');
    const afterWriter = stream.chunks.slice(writerRanAt).join('');
    expect(beforeWriter).toContain('\x1b['); // clear
    expect(afterWriter).toContain('Creating A'); // redraw

    r.stop();
  });

  it('stop() clears the live area', () => {
    const stream = new FakeStream();
    const r = makeRenderer(stream);
    r.start();
    r.addTask('A', 'Creating A');
    stream.reset();

    r.stop();
    // After stop, a clear sequence should be in the output
    expect(stream.output()).toContain('\x1b[');
  });

  it('spinner timer redraws periodically while tasks are in flight', () => {
    const stream = new FakeStream();
    const r = makeRenderer(stream);
    r.start();
    r.addTask('A', 'Creating A');
    stream.reset();

    vi.advanceTimersByTime(100); // > 80ms frame interval
    // Should have drawn at least once
    expect(stream.chunks.length).toBeGreaterThan(0);
    expect(stream.output()).toContain('Creating A');

    r.stop();
  });

  it('does not draw when no tasks are in flight', () => {
    const stream = new FakeStream();
    const r = makeRenderer(stream);
    r.start();
    stream.reset();

    vi.advanceTimersByTime(200);
    expect(stream.chunks.length).toBe(0);

    r.stop();
  });

  it('hides cursor on start and restores it on stop', () => {
    const stream = new FakeStream();
    const r = makeRenderer(stream);
    r.start();
    // Cursor-hide ANSI (\x1b[?25l) should have been written during start
    expect(stream.output()).toContain('\x1b[?25l');

    stream.reset();
    r.stop();
    // Cursor-show ANSI (\x1b[?25h) should be written during stop
    expect(stream.output()).toContain('\x1b[?25h');
  });

  it('truncates labels that exceed terminal width', () => {
    const stream = new FakeStream();
    stream.columns = 30;
    const r = makeRenderer(stream);
    r.start();
    stream.reset();

    const longLabel = 'Creating SomeReallyLongResourceLogicalIdThatDefinitelyOverflows';
    r.addTask('A', longLabel);

    const out = stream.output();
    // The full long label must not appear (it would have wrapped). The
    // ellipsis indicates truncation.
    expect(out).not.toContain(longLabel);
    expect(out).toContain('…');
    // Each rendered line must fit within the column budget. The renderer
    // writes lines separated by '\n', plus a trailing newline; check the
    // longest non-empty line.
    const longest = out.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
    expect(longest).toBeLessThanOrEqual(30);

    r.stop();
  });

  it('addTask / removeTask are idempotent silent no-ops when CDKD_NO_LIVE=1', () => {
    process.env['CDKD_NO_LIVE'] = '1';
    const stream = new FakeStream();
    const r = makeRenderer(stream);
    expect(r.start()).toBe(false);

    // Even with start() refused, the API stays usable (so callers don't have
    // to branch). It just produces no output.
    r.addTask('A', 'Creating A');
    r.removeTask('A');
    r.removeTask('A');
    expect(stream.chunks.length).toBe(0);
  });
});
