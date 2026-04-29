/**
 * Live multi-line progress renderer for the bottom of the terminal.
 *
 * Maintains a "live area" listing in-flight tasks (Creating MyBucket...),
 * redrawn on a spinner timer. Other log output is routed through
 * {@link LiveRenderer.printAbove} so it appears above the live area without
 * disturbing the currently-displayed in-flight tasks.
 *
 * Design notes:
 * - Multiple resources can be in flight concurrently (cdkd uses parallel DAG
 *   dispatch), so a single in-place line overwrite is not enough — each
 *   in-flight resource is its own line in the live area.
 * - On non-TTY (CI/log-collection), the renderer stays inactive and
 *   {@link LiveRenderer.printAbove} falls through to a direct write, so output
 *   matches the previous append-only behavior.
 * - In verbose mode (debug level) the caller should not start the renderer:
 *   debug logs would interleave too aggressively with the live area.
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;
const ESC = '\x1b[';

interface Task {
  label: string;
  startedAt: number;
}

export class LiveRenderer {
  private tasks = new Map<string, Task>();
  private active = false;
  private spinnerIndex = 0;
  private interval: NodeJS.Timeout | null = null;
  private linesDrawn = 0;

  constructor(private readonly stream: NodeJS.WriteStream = process.stdout) {}

  isActive(): boolean {
    return this.active;
  }

  /**
   * Enable the live renderer. No-op if stdout is not a TTY or if
   * `CDKD_NO_LIVE=1`. Returns true if successfully enabled.
   */
  start(): boolean {
    if (this.active) return true;
    if (!this.stream.isTTY) return false;
    if (process.env['CDKD_NO_LIVE'] === '1') return false;

    this.active = true;
    this.interval = setInterval(() => this.draw(), FRAME_INTERVAL_MS);
    if (typeof this.interval.unref === 'function') this.interval.unref();
    return true;
  }

  stop(): void {
    if (!this.active) return;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.clear();
    this.tasks.clear();
    this.active = false;
  }

  addTask(id: string, label: string): void {
    this.tasks.set(id, { label, startedAt: Date.now() });
    if (this.active) this.draw();
  }

  removeTask(id: string): void {
    if (!this.tasks.delete(id)) return;
    if (this.active) this.draw();
  }

  /**
   * Print content above the live area. Clears the live area, runs the writer,
   * then redraws the live area. When the renderer is inactive, the writer
   * runs directly so callers can use this unconditionally.
   */
  printAbove(write: () => void): void {
    if (!this.active) {
      write();
      return;
    }
    this.clear();
    write();
    this.draw();
  }

  private clear(): void {
    if (this.linesDrawn === 0) return;
    this.stream.write('\r');
    for (let i = 0; i < this.linesDrawn; i++) {
      this.stream.write(`${ESC}1A${ESC}2K`);
    }
    this.linesDrawn = 0;
  }

  private draw(): void {
    if (!this.active) return;
    this.clear();
    if (this.tasks.size === 0) return;

    const frame = SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length]!;
    this.spinnerIndex++;

    const lines: string[] = [];
    for (const task of this.tasks.values()) {
      const elapsed = ((Date.now() - task.startedAt) / 1000).toFixed(1);
      lines.push(`  ${frame} ${task.label} (${elapsed}s)`);
    }
    this.stream.write(lines.join('\n') + '\n');
    this.linesDrawn = lines.length;
  }
}

let globalRenderer: LiveRenderer | null = null;

export function getLiveRenderer(): LiveRenderer {
  if (!globalRenderer) globalRenderer = new LiveRenderer();
  return globalRenderer;
}

/**
 * Reset the singleton (for tests).
 */
export function resetLiveRenderer(): void {
  if (globalRenderer) globalRenderer.stop();
  globalRenderer = null;
}
