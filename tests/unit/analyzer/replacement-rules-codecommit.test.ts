import { describe, it, expect } from 'vite-plus/test';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

/**
 * Pin for the AWS::CodeCommit::Repository classification (issue #1045).
 *
 * The INVERSE of the immutable-name bug class pinned in
 * replacement-rules-named-immutables.test.ts: CFn marks EVERY CodeCommit
 * Repository property "Update requires: No interruption" (the registry
 * schema's createOnlyProperties is empty), and CloudFormation renames the
 * repository in place via UpdateRepositoryName. Misclassifying a rename as
 * replacement would DELETE the repository — and its entire git history —
 * on a rename. This pin keeps the rule from regressing; the live
 * `codecommit` integ additionally asserts the repository ID survives a
 * real rename.
 */
describe('ReplacementRulesRegistry — AWS::CodeCommit::Repository (in-place rename)', () => {
  const registry = new ReplacementRulesRegistry();

  it.each(['RepositoryName', 'RepositoryDescription', 'KmsKeyId', 'Tags'])(
    'does NOT require replacement when %s changes',
    (prop) => {
      expect(
        registry.requiresReplacement('AWS::CodeCommit::Repository', prop, 'old', 'new')
      ).toBe(false);
    }
  );
});
