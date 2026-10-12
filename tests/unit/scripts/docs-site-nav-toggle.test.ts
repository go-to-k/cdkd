import { describe, expect, it } from 'vite-plus/test';
import {
  NAV_STATE_PREFIX,
  navOpenCurrentScript,
  navRememberScript,
  navToggleScript,
} from '../../../docs/_site/plugins/nav-toggle.js';

// The sidebar's groups fold in CSS where the browser can animate to a height
// of `auto`; docs/_site/plugins/nav-toggle.ts is the fallback where it cannot.
// The two must never both run, and reduced motion must reach the fallback too.

describe('navToggleScript', () => {
  const script = navToggleScript(180, 'cubic-bezier(0.2, 0, 0, 1)');

  it('is a script the browser can parse', () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it('stands down where CSS animates the group itself', () => {
    const guard = script.indexOf("CSS.supports('interpolate-size', 'allow-keywords')");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(script.indexOf('addEventListener'));
  });

  it('leaves a title that is a link to open its page', () => {
    expect(script.indexOf("closest('a[href]")).toBeLessThan(script.indexOf('preventDefault'));
  });

  it('switches at once under reduced motion', () => {
    expect(script).toContain('(prefers-reduced-motion: reduce)');
    expect(script.indexOf('still.matches')).toBeLessThan(script.indexOf('preventDefault'));
  });

  it('takes its timing from the theme tokens', () => {
    expect(script).toContain('duration: 180');
    expect(script).toContain('easing: "cubic-bezier(0.2, 0, 0, 1)"');
  });
});

describe('navOpenCurrentScript', () => {
  const script = navOpenCurrentScript();

  it('is a script the browser can parse', () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it('opens a folded section by the current page inside it', () => {
    expect(script).toContain("details.nav-details");
    expect(script).toContain("querySelector('.nav-link.active')");
  });
});

// Every page is its own document, so a group the reader opened is folded again
// on the next one unless something carries it across. These run the script
// itself against a stand-in sidebar: one page's storage is the next page's.

interface Group {
  open: boolean;
  href: string | null;
  active: boolean;
  toggled: Array<() => void>;
}

const group = (href: string | null, active = false): Group => ({
  open: false,
  href,
  active,
  toggled: [],
});

/** The reader's click: the browser flips `open`, then tells the listeners. */
const toggle = (target: Group): void => {
  target.open = !target.open;
  for (const listener of target.toggled) listener();
};

const memoryStorage = (initial: Record<string, string> = {}) => {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  };
};

/** One page load: the sidebar as rendered, and the scripts in the theme's order. */
const loadPage = (groups: Group[], window: object): void => {
  const document = {
    querySelectorAll: () =>
      groups.map((target) => ({
        get open() {
          return target.open;
        },
        set open(value: boolean) {
          // Setting `open` from a script tells the listeners too.
          if (target.open === value) return;
          target.open = value;
          for (const listener of target.toggled) listener();
        },
        querySelector: (selector: string) => {
          if (selector.includes('.active')) return target.active ? {} : null;
          return target.href === null ? null : { getAttribute: () => target.href };
        },
        addEventListener: (_type: string, listener: () => void) => target.toggled.push(listener),
      })),
  };
  new Function('document', 'window', `${navRememberScript()}\n${navOpenCurrentScript()}`)(
    document,
    window,
  );
};

describe('navRememberScript', () => {
  it('is a script the browser can parse', () => {
    expect(() => new Function(navRememberScript())).not.toThrow();
  });

  it('keeps a group the reader opened open on the next page', () => {
    const sessionStorage = memoryStorage();
    const first = [group('/cli-deploy/index.html'), group('/cli-diff/index.html')];
    loadPage(first, { sessionStorage });
    toggle(first[0]!);

    const next = [group('/cli-deploy/index.html'), group('/cli-diff/index.html')];
    loadPage(next, { sessionStorage });
    expect(next.map((target) => target.open)).toEqual([true, false]);
  });

  it('folds a group the reader closed again', () => {
    const sessionStorage = memoryStorage();
    const first = [group('/cli-deploy/index.html')];
    loadPage(first, { sessionStorage });
    toggle(first[0]!);
    toggle(first[0]!);
    expect(sessionStorage.entries.size).toBe(0);

    const next = [group('/cli-deploy/index.html')];
    loadPage(next, { sessionStorage });
    expect(next[0]!.open).toBe(false);
  });

  it("keeps the current page's group open once the reader has left it", () => {
    const sessionStorage = memoryStorage();
    loadPage([group('/cli-deploy/index.html', true)], { sessionStorage });

    const next = [group('/cli-deploy/index.html'), group('/cli-diff/index.html', true)];
    loadPage(next, { sessionStorage });
    expect(next.map((target) => target.open)).toEqual([true, true]);
  });

  it('names a group by its page, so a reordered sidebar keeps it', () => {
    const sessionStorage = memoryStorage({ [`${NAV_STATE_PREFIX}/cli-diff/index.html`]: 'open' });
    const groups = [group('/cli-deploy/index.html'), group('/cli-diff/index.html')];
    loadPage(groups, { sessionStorage });
    expect(groups.map((target) => target.open)).toEqual([false, true]);
  });

  it('leaves a group without a page of its own alone', () => {
    const sessionStorage = memoryStorage();
    const groups = [group(null)];
    loadPage(groups, { sessionStorage });
    expect(groups[0]!.toggled).toHaveLength(0);
  });

  it('still opens the current group where storage is blocked', () => {
    const blocked = {
      get sessionStorage(): never {
        throw new Error('SecurityError');
      },
    };
    const groups = [group('/cli-deploy/index.html', true)];
    expect(() => loadPage(groups, blocked)).not.toThrow();
    expect(groups[0]!.open).toBe(true);
  });

  it('survives storage that refuses a write', () => {
    const sessionStorage = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const groups = [group('/cli-deploy/index.html')];
    loadPage(groups, { sessionStorage });
    expect(() => toggle(groups[0]!)).not.toThrow();
  });
});
