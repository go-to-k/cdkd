/**
 * go-to-k/cdkd#6088: the in-use export refusal exempts a consumer this run
 * deploys, from `DeployEngineOptions.inRunStacks`. The set is built in
 * `cdkd deploy`'s handler and handed to every stack's engine; without that
 * wiring `deploy --all` would refuse the very run the refusal tells the user
 * to make. Pinned on the source, as the sibling wiring tests here are.
 */

import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readDeployModule } from './_deploy-source.js';

const here = dirname(fileURLToPath(import.meta.url));
const stackDeploy = readFileSync(
  join(here, '../../../src/cli/commands/deploy/stack-deploy.ts'),
  'utf8'
);

describe('cdkd deploy hands every stack of the run to each engine (go-to-k/cdkd#6088)', () => {
  it('builds the set from EVERY target stack, each at the region it deploys to', () => {
    const handler = readDeployModule('command.ts');
    const contextAt = handler.indexOf('const stackDeployContext: DeployStackContext = {');
    expect(contextAt).toBeGreaterThan(-1);
    const context = handler.slice(contextAt, handler.indexOf('\n    };', contextAt));
    expect(context).toMatch(
      /inRunStacks: new Set\(\s*targetStacks\.map\(\(s\) =>\s*inRunStackKey\(s\.stackName, stackRegions\.get\(s\) \?\? deployStackRegion\(s, baseRegion\)\)\s*\)\s*\),/
    );
    // The same region rule the per-stack deploy resolves its region with.
    expect(handler).toMatch(
      /const stackRegion = stackRegions\.get\(stackInfo\) \?\? deployStackRegion\(stackInfo, baseRegion\);/
    );
  });

  it('passes the set into the engine options', () => {
    const optionsAt = stackDeploy.indexOf('const deployEngineOptions: DeployEngineOptions = {');
    expect(optionsAt).toBeGreaterThan(-1);
    const options = stackDeploy.slice(optionsAt, stackDeploy.indexOf('\n    };', optionsAt));
    expect(options).toMatch(/^\s*inRunStacks: ctx\.inRunStacks,$/m);
  });
});
