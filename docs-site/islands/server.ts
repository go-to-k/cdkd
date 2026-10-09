// Build-time renderer for the islands, loaded through Vite's SSR module
// loader by ssr-plugin.ts so the SFCs compile exactly as they do for the
// client.
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { components } from 'virtual:ox-content-vue/components';
import { registryName } from './html.js';

const registry = components as Record<string, Component & { clientOnly?: boolean }>;

/** Inner HTML for one island, or `null` when it renders only in the browser. */
export async function renderIsland(
  name: string,
  props: Record<string, unknown>
): Promise<string | null> {
  const component = registry[registryName(name)];
  if (!component) {
    throw new Error(`[islands] no component ${name}.vue in docs-site/components`);
  }
  if (component.clientOnly) return null;
  return renderToString(createSSRApp({ render: () => h(component, props) }));
}
