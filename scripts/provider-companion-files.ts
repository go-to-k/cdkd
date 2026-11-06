/**
 * A provider split across files: `src/provisioning/providers/<stem>-provider.ts`
 * owns the companion directory `src/provisioning/providers/<stem>/`, which holds
 * code moved out of it. A script that reads a provider FILE to judge the
 * provider must read its companion files alongside it, or the moved code drops
 * out of its view silently.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * The companion files of `providerPath` (`.../<stem>-provider.ts`): every `.ts`
 * file under `<stem>/`, recursively, excluding `.test.ts`, as absolute-or-as-given
 * paths sorted by path. Empty when the provider has no companion directory.
 */
export function companionFiles(providerPath: string): string[] {
  const match = /^(.+)-provider\.ts$/.exec(basename(providerPath));
  if (!match) return [];
  const root = join(dirname(providerPath), match[1]!);
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(path);
      }
    }
  };
  walk(root);
  return out.sort();
}
