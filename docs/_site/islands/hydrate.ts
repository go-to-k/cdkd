// Mounts the Vue islands on a page. Components come from Ox Content's Vue
// integration registry (the `components` map in docs/_site/vite.config.ts), so a
// new SFC in docs/_site/components is usable from Markdown without touching
// this.
import { initIslands } from '@ox-content/islands';
import { createApp, createSSRApp, h, type Component } from 'vue';
import { components } from 'virtual:ox-content-vue/components';
import { ISLAND_SLOTS, islandIdPrefix, isIslandSlot, registryName } from './html.js';

const registry = components as Record<string, Component>;

// The build already moved slotted islands into the hero (relocateIslands);
// the dev server serves the SSG's page as written, so do the same move here.
for (const element of document.querySelectorAll<HTMLElement>('[data-cdkd-slot]')) {
  const slot = element.dataset['cdkdSlot'];
  if (!isIslandSlot(slot)) continue;
  const target = document.querySelector(`.${ISLAND_SLOTS[slot]}`);
  if (target && !target.contains(element)) target.append(element);
}

// Ids for islands the build did not render (client-only, or any in dev).
let clientOnly = 0;

initIslands((element, props) => {
  const component = registry[registryName(element.dataset['oxIsland'] ?? '')];
  if (!component) return;
  const root = { render: () => h(component, props) };
  // Server-rendered islands are hydrated in place; client-only ones mount.
  const app = element.dataset['oxSsr'] === 'true' ? createSSRApp(root) : createApp(root);
  // Each island is its own app: a prefix keeps two islands' ids apart, and
  // matches the one the build rendered it with.
  const index = element.dataset['cdkdIsland'];
  app.config.idPrefix =
    index === undefined ? `cdkd-client-${clientOnly++}` : islandIdPrefix(Number(index));
  app.mount(element);
  return () => app.unmount();
});
