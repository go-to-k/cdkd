import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The deploy flow's entry: `doDeployWithPrefetch`, re-exported unchanged. */
export const DEPLOY_FLOW = 'src/deployment/deploy-engine/deploy-flow.ts';
/** The modules split out of it (go-to-k/cdkd#5835). */
export const DEPLOY_FLOW_DIR = 'src/deployment/deploy-engine/deploy-flow/';

/**
 * The modules under `deploy-flow/`, repo-relative and POSIX-separated, the
 * directory read recursively so a new module or subdirectory is never missed.
 * Throws when the read finds none: a renamed directory must not leave a fence
 * reading the entry alone.
 */
export function deployFlowModules(): string[] {
  const modules = readdirSync(`${REPO_ROOT}${DEPLOY_FLOW_DIR}`, {
    recursive: true,
    encoding: 'utf8',
  })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => name.split('\\').join('/'))
    .sort()
    .map((name) => `${DEPLOY_FLOW_DIR}${name}`);
  if (modules.length < 2) {
    throw new Error(`the deploy-flow directory read found ${String(modules.length)} module(s)`);
  }
  return modules;
}

/** The entry, then every module in name order (not run order). */
export function deployFlowSourceFiles(): string[] {
  return [DEPLOY_FLOW, ...deployFlowModules()];
}

/**
 * The whole flow as ONE text in RUN order, for a fence that checks that a
 * guard precedes a read: the entry, with each module's text spliced in at the
 * entry's first call of a function the module exports, where its body runs.
 * A module the entry never calls (a type-only module) is appended last. Each
 * file is read through `read`, so a caller can strip comments first.
 */
export function readDeployFlowInRunOrder(
  read: (relPath: string) => string = (rel) => readFileSync(`${REPO_ROOT}${rel}`, 'utf8')
): string {
  const entry = read(DEPLOY_FLOW);
  const raw = (rel: string): string => readFileSync(`${REPO_ROOT}${rel}`, 'utf8');
  const splices: { at: number; text: string }[] = [];
  const trailing: string[] = [];
  for (const rel of deployFlowModules()) {
    const exported = [...raw(rel).matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!);
    const calls = exported
      .map((name) => entry.search(new RegExp(`(?<![\\w.])${name}\\(`)))
      .filter((at) => at > -1);
    if (calls.length === 0) {
      if (exported.length > 0) {
        throw new Error(`${rel} exports ${exported.join(', ')}, and the entry calls none of them`);
      }
      trailing.push(read(rel));
      continue;
    }
    splices.push({ at: Math.min(...calls), text: read(rel) });
  }
  splices.sort((a, b) => a.at - b.at);
  let out = '';
  let from = 0;
  for (const { at, text } of splices) {
    out += `${entry.slice(from, at)}\n${text}\n`;
    from = at;
  }
  return [out + entry.slice(from), ...trailing].join('\n');
}
