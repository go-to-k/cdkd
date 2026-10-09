// Site-wide entry, loaded by every page of cdkd.dev. A page without an island
// pays for this file only; Vue and the components load when one is present.
if (document.querySelector('[data-ox-island]')) {
  void import('./hydrate.js');
}
