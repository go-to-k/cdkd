import { describe, expect, it } from 'vite-plus/test';
import { navOpenCurrentScript, navToggleScript } from '../../../docs/_site/plugins/nav-toggle.js';

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
