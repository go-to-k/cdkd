/**
 * go-to-k/cdkd#6357: the four commands that synthesize for `cdkd local` go
 * through `localCommandSynthesizer()` (which lists CDK nested stacks), never a
 * bare `new Synthesizer()`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

const root = join(__dirname, '../../../src/cli/commands');
const sites = [
  'local-invoke/command.ts',
  'local-start-api/command.ts',
  'local-run-task/command.ts',
  'local-invoke-agentcore/command.ts',
];

describe('local command synthesis sites keep nested stacks', () => {
  for (const site of sites) {
    it(`${site} synthesizes through localCommandSynthesizer()`, () => {
      const src = readFileSync(join(root, site), 'utf8');
      expect(src).not.toMatch(/new Synthesizer\(/);
      expect(src).toMatch(/=\s*localCommandSynthesizer\(\)/);
    });
  }
});
