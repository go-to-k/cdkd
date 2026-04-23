import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const cliPath = join(repoRoot, 'dist', 'cli.js');
const pkgPath = join(repoRoot, 'package.json');

describe('cdkd --version', () => {
  it.skipIf(!existsSync(cliPath))(
    'reports the version baked in from package.json',
    () => {
      const { version } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const output = execFileSync('node', [cliPath, '--version'], {
        encoding: 'utf-8',
      }).trim();
      expect(output).toBe(version);
    },
  );
});
