// The sidebar's folding groups open and close to their own height.
//
// theme/cdkd.css animates that in CSS, through `::details-content` and
// `interpolate-size: allow-keywords`. Where a browser has no
// `interpolate-size` (Safari, Firefox) the group would snap, so this script
// animates the list's height itself there, and only there: the two would
// otherwise run on top of each other. Reduced motion switches at once, as the
// CSS does.

/**
 * A page with pages under it lists them in a group of its own, folded. This
 * opens the group the reader is in: on the page itself, or on a page under it.
 */
export function navOpenCurrentScript(): string {
  return [
    '(function () {',
    "  document.querySelectorAll('.sidebar details.nav-details').forEach(function (group) {",
    "    if (group.querySelector('.nav-link.active')) group.open = true;",
    '  });',
    '})();',
  ].join('\n');
}

/** The fallback, as a script for the theme. Times are the theme's `motion` tokens. */
export function navToggleScript(durationMs: number, ease: string): string {
  return [
    '(function () {',
    "  if (window.CSS && CSS.supports('interpolate-size', 'allow-keywords')) return;",
    "  var still = window.matchMedia('(prefers-reduced-motion: reduce)');",
    "  document.querySelectorAll('.sidebar details').forEach(function (group) {",
    "    var summary = group.querySelector(':scope > summary');",
    "    var list = group.querySelector(':scope > .nav-list');",
    "    if (!summary || !list || typeof list.animate !== 'function') return;",
    '    var running = null;',
    "    summary.addEventListener('click', function (event) {",
    // A title that is a link opens its page; only the rest of the row folds.
    '      if (still.matches || event.target.closest(\'a[href]:not([href="#"])\')) return;',
    '      event.preventDefault();',
    '      var opening = !group.open || (running !== null && running.closing);',
    '      var from = group.open ? list.getBoundingClientRect().height : 0;',
    '      if (running !== null) running.animation.cancel();',
    '      group.open = true;',
    '      var to = opening ? list.scrollHeight : 0;',
    "      list.style.overflow = 'clip';",
    '      var animation = list.animate(',
    "        { blockSize: [from + 'px', to + 'px'] },",
    `        { duration: ${durationMs}, easing: ${JSON.stringify(ease)} },`,
    '      );',
    '      running = { animation: animation, closing: !opening };',
    '      animation.onfinish = function () {',
    '        running = null;',
    "        list.style.overflow = '';",
    '        if (!opening) group.open = false;',
    '      };',
    '    });',
    '  });',
    '})();',
  ].join('\n');
}
