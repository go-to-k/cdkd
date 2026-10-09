// Renders the Vue islands into the pages Ox Content's SSG has written, then
// moves slotted islands into the hero. Sequenced after the SSG the same way
// homeTitlePlugin is: `enforce: 'post'`, and Rolldown runs `closeBundle`
// hooks one after another. Build-only; the dev server mounts islands in the
// browser instead.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type Plugin, type PluginOption } from 'vite-plus';
import { relocateIslands, renderIslands } from './html.js';

export interface IslandSsrOptions {
  /** The SSG's output directory, relative to the Vite root. */
  outDir: string;
  /** Module exporting `renderIsland`, as a root-relative Vite id. */
  entry: string;
  /** Plugins the renderer needs: the SFC compiler and the component registry. */
  plugins: () => PluginOption[];
}

async function listHtml(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => join(entry.parentPath, entry.name));
}

export function islandSsrPlugin(options: IslandSsrOptions): Plugin {
  let root = process.cwd();

  return {
    name: 'cdkd:island-ssr',
    enforce: 'post',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    async closeBundle(error) {
      // A failed bundle keeps its own error as the build's verdict.
      if (error) return;
      const pages: Array<{ file: string; html: string }> = [];
      for (const file of await listHtml(join(root, options.outDir))) {
        const html = await readFile(file, 'utf8');
        if (html.includes('data-ox-island')) pages.push({ file, html });
      }
      if (pages.length === 0) return;

      const server = await createServer({
        configFile: false,
        root,
        logLevel: 'error',
        appType: 'custom',
        plugins: options.plugins(),
        server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      try {
        const { renderIsland } = (await server.ssrLoadModule(options.entry)) as {
          renderIsland: (name: string, props: Record<string, unknown>) => Promise<string | null>;
        };
        for (const page of pages) {
          const rendered = relocateIslands(await renderIslands(page.html, renderIsland));
          if (rendered !== page.html) await writeFile(page.file, rendered);
        }
      } finally {
        await server.close();
      }
    },
  };
}
