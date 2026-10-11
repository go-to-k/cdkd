// Search scopes for cdkd.dev.
//
// Ox Content's search narrows a query to a scope when it starts with
// `@<scope>` (`@cli deploy`), and labels each result with the scope it came
// from. It derives a document's scopes from the directories in its id, and
// the docs are one flat directory, so no page had a scope at all.
//
// The pages stay where they are: the CLI's messages, the README and released
// binaries link to their URLs, anchors included, and a static host can only
// redirect a moved page by dropping the anchor. Instead the sidebar's groups
// are the scopes. Each group in docs/_site/vite.config.ts names one, and this
// plugin rewrites the id of every document in the emitted search index to
// `<scope>/<page>` after the SSG has written it. Only the id changes: the
// index's postings refer to documents by position and a result opens `url`.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite-plus';

export interface SearchScope {
  /** What a query names after `@`: lowercase letters and hyphens. */
  id: string;
  /** What the search dialog's shortcut for it says. */
  label: string;
}

export interface ScopedGroup {
  scope: string;
  items: Array<{ path?: string }>;
}

interface SearchIndexDocument {
  id: string;
  url: string;
}

const SCOPE_ID = /^[a-z][a-z-]*$/;
/** Indexed without a sidebar entry, so without a scope. */
const UNSCOPED = new Set(['index']);

const slugOf = (path: string): string => path.replace(/^\/+|\/+$/g, '');

/** Page slug -> scope, from the sidebar's groups. */
export function scopesByPage(groups: readonly ScopedGroup[]): Map<string, string> {
  const scopes = new Map<string, string>();
  for (const group of groups) {
    if (!SCOPE_ID.test(group.scope)) {
      throw new Error(`[search-scopes] "${group.scope}" is not a scope a query can name`);
    }
    for (const item of group.items) {
      if (item.path === undefined) continue;
      const slug = slugOf(item.path);
      const taken = scopes.get(slug);
      if (taken !== undefined && taken !== group.scope) {
        throw new Error(`[search-scopes] /${slug} is in two scopes: ${taken} and ${group.scope}`);
      }
      scopes.set(slug, group.scope);
    }
  }
  return scopes;
}

/**
 * Give every document its scope. A document the sidebar does not list has no
 * scope to take, and that stops the build: it would be the one page a scoped
 * query can never find.
 */
export function scopeDocuments<T extends SearchIndexDocument>(
  documents: readonly T[],
  scopes: ReadonlyMap<string, string>,
): T[] {
  const unscoped: string[] = [];
  const scoped = documents.map((doc) => {
    const slug = slugOf(doc.url);
    if (UNSCOPED.has(slug)) return doc;
    const scope = scopes.get(slug);
    if (scope === undefined) {
      unscoped.push(doc.url);
      return doc;
    }
    return { ...doc, id: `${scope}/${slug}` };
  });
  if (unscoped.length > 0) {
    throw new Error(
      `[search-scopes] no sidebar group, so no search scope, for ${unscoped.join(', ')}`,
    );
  }
  return scoped;
}

/**
 * The search dialog's scope shortcuts, as a script for the theme: one button
 * per scope under the input. Pressing one puts `@<scope>` in front of the
 * query (or takes it back out) and runs the search again.
 */
export function scopeShortcutsScript(scopes: readonly SearchScope[]): string {
  return [
    '(function () {',
    `  var scopes = ${JSON.stringify(scopes)};`,
    "  var header = document.querySelector('.search-modal .search-header');",
    "  var input = document.querySelector('.search-modal .search-input');",
    '  if (!header || !input) return;',
    "  input.placeholder = 'Search the docs, or narrow it: @cli deploy';",
    "  var bar = document.createElement('div');",
    "  bar.className = 'cdkd-search-scopes';",
    "  bar.setAttribute('role', 'group');",
    "  bar.setAttribute('aria-label', 'Search within');",
    '  var buttons = scopes.map(function (scope) {',
    "    var button = document.createElement('button');",
    "    button.type = 'button';",
    "    button.className = 'cdkd-search-scope';",
    "    button.textContent = '@' + scope.id;",
    "    button.title = 'Search ' + scope.label + ' only';",
    "    button.setAttribute('aria-pressed', 'false');",
    "    button.addEventListener('click', function () {",
    "      var token = '@' + scope.id;",
    '      var parts = input.value.split(/\\s+/).filter(Boolean);',
    '      var on = parts.indexOf(token) !== -1;',
    "      var rest = parts.filter(function (part) { return part.charAt(0) !== '@'; });",
    "      input.value = (on ? rest : [token].concat(rest)).join(' ') + (on || rest.length ? '' : ' ');",
    "      input.dispatchEvent(new Event('input', { bubbles: true }));",
    '      input.focus();',
    '    });',
    '    bar.append(button);',
    '    return { id: scope.id, button: button };',
    '  });',
    '  var sync = function () {',
    '    var parts = input.value.split(/\\s+/);',
    '    buttons.forEach(function (entry) {',
    "      entry.button.setAttribute('aria-pressed', String(parts.indexOf('@' + entry.id) !== -1));",
    '    });',
    '  };',
    "  input.addEventListener('input', sync);",
    '  header.after(bar);',
    '})();',
  ].join('\n');
}

export interface SearchScopesPluginOptions {
  /** Directory the SSG emits into (`dist/site`), relative to the Vite root. */
  outDir: string;
  groups: readonly ScopedGroup[];
}

/**
 * Vite plugin: after the SSG has written `search-index.json`, rewrite its
 * document ids (sequenced like plugins/home-title.ts). Build-only: the dev
 * server's index keeps flat ids, so `@scope` narrows nothing there.
 */
export function searchScopesPlugin(options: SearchScopesPluginOptions): Plugin {
  let root = process.cwd();
  return {
    name: 'cdkd:docs-search-scopes',
    enforce: 'post',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    closeBundle(error) {
      if (error) return;
      const file = join(resolve(root, options.outDir), 'search-index.json');
      const index = JSON.parse(readFileSync(file, 'utf8')) as {
        documents: SearchIndexDocument[];
      };
      index.documents = scopeDocuments(index.documents, scopesByPage(options.groups));
      writeFileSync(file, JSON.stringify(index));
    },
  };
}
