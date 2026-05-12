/**
 * Structural regression guard: every known Pattern B provider source file
 * imports `generateResourceNameWithFallback` (issue #301).
 *
 * Background: issue #296 / PR #297 introduced the Pattern A vs Pattern B
 * distinction in `src/provisioning/providers/`:
 *
 *  - Pattern A providers (Lambda / S3 / SNS / SQS / DynamoDB / Logs etc.)
 *    short-circuit user-supplied physical names OUT of `generateResourceName`
 *    — they already never prefixed with the stack name.
 *  - Pattern B providers (IAM Role / User / Group / InstanceProfile +
 *    ELBv2 LoadBalancer / TargetGroup) flow user-supplied names THROUGH
 *    `generateResourceName`, which prepends the stack name. PR #297
 *    introduced the shared helper `generateResourceNameWithFallback`
 *    (in `src/provisioning/resource-name.ts`) — the only API that
 *    correctly splits Pattern B calls into the user-supplied
 *    (skippable via `--no-prefix-user-supplied-names`) vs logical-id
 *    (always-prefixed) branches.
 *
 * This test asserts every Pattern B provider source file imports the
 * helper. If a future refactor reverts to raw `generateResourceName` on
 * one of these files (re-introducing the bug PR #297 fixed), this test
 * fires before the regression lands.
 *
 * Scope intentionally narrow (Option B per issue #301): the file list
 * here covers exactly the providers PR #297 converted. Catching the
 * complementary "new Pattern B provider added without using the helper"
 * case (Option A / C — registry-based or per-provider metadata) is
 * deferred to a separate follow-up.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

const PATTERN_B_PROVIDER_FILES = [
  'src/provisioning/providers/iam-role-provider.ts',
  'src/provisioning/providers/iam-user-group-provider.ts',
  'src/provisioning/providers/iam-instance-profile-provider.ts',
  'src/provisioning/providers/elbv2-provider.ts',
] as const;

describe('Pattern B providers import generateResourceNameWithFallback (issue #301)', () => {
  for (const relPath of PATTERN_B_PROVIDER_FILES) {
    it(`${relPath} references generateResourceNameWithFallback`, () => {
      const absPath = join(repoRoot, relPath);
      const source = readFileSync(absPath, 'utf-8');
      expect(
        source.includes('generateResourceNameWithFallback'),
        `${relPath} must use generateResourceNameWithFallback for user-supplied physical names. ` +
          `See issue #301 / PR #297 — reverting to raw generateResourceName would re-introduce ` +
          `the stack-name prefix on user-declared names regardless of --no-prefix-user-supplied-names.`,
      ).toBe(true);
    });
  }
});
