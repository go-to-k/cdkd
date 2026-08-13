import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { canonicalizeUnorderedArraysAtPaths } from '../../../src/analyzer/drift-normalize.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';

/**
 * The `AttributeDefinitions`-ordering half of the two PERMANENT phantom drifts
 * issue #1742 measured on an UNTOUCHED table (us-east-1, 2026-08-13,
 * `tests/integration/rollback-replay-effective-props`). The `WarmThroughput`
 * half is deliberately not fixed — see the trailer at the end of this file.
 *
 * It is reachable whenever the drift baseline is `properties` rather than
 * `observedProperties` — i.e. after any reverse-replacement rollback, which
 * `rollback-executor.ts` strips `observedProperties` on. That is also why
 * neither had been seen: on the ordinary path both comparison sides come from
 * the same `readCurrentState` call, so they already agree.
 */
describe('DynamoDBGlobalTableProvider drift phantoms (issue #1742)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    provider = new DynamoDBGlobalTableProvider();
  });

  // ─── defect 1: AttributeDefinitions is an unordered SET ────────────────

  describe('AttributeDefinitions ordering', () => {
    it('declares AttributeDefinitions as an unordered path', () => {
      expect(provider.getDriftUnorderedPaths(RESOURCE_TYPE)).toContain('AttributeDefinitions');
    });

    it('does NOT declare KeySchema, which is order-SIGNIFICANT', () => {
      // HASH must precede RANGE, so sorting it would silently hide a real key
      // change — the failure direction the provider rules call the worse one.
      const paths = provider.getDriftUnorderedPaths(RESOURCE_TYPE);
      expect(paths).not.toContain('KeySchema');
      expect(paths.some((p) => p.includes('KeySchema'))).toBe(false);
    });

    it('collapses the measured readback reordering through the normalizer', () => {
      // The end-to-end proof: run the declared path through the SAME helper
      // `drift-calculator.ts` applies, using the exact two orders the live run
      // produced. Asserting only the declaration would pass even if the path
      // string were inert (a path that crosses an array is meaningful here but
      // NOT as an ignore-path, so the two lists are not interchangeable).
      const declared = [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'gsipk', AttributeType: 'S' },
      ];
      const readBack = [
        { AttributeName: 'gsipk', AttributeType: 'S' },
        { AttributeName: 'pk', AttributeType: 'S' },
      ];
      const paths = provider.getDriftUnorderedPaths(RESOURCE_TYPE);

      expect(
        canonicalizeUnorderedArraysAtPaths({ AttributeDefinitions: declared }, paths)
      ).toEqual(canonicalizeUnorderedArraysAtPaths({ AttributeDefinitions: readBack }, paths));
    });

    it('still reports a REAL AttributeDefinitions change after canonicalization', () => {
      // The sort must not make the pass vacuous: a retyped attribute is a
      // genuine difference and has to survive it.
      const paths = provider.getDriftUnorderedPaths(RESOURCE_TYPE);
      const before = canonicalizeUnorderedArraysAtPaths(
        { AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }] },
        paths
      );
      const after = canonicalizeUnorderedArraysAtPaths(
        { AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'N' }] },
        paths
      );
      expect(before).not.toEqual(after);
    });
  });

  // Defect 2 of the issue -- the AWS-computed
  // `GlobalSecondaryIndexes[].WarmThroughput` -- is deliberately NOT fixed here
  // and #1742 stays open for it. Gating the readback emission on the desired
  // side (the obvious fix, and the one the sibling `AWS::DynamoDB::Table` issue
  // #1760 prescribes) trades one population's phantom drift for another's: every
  // `observedProperties` bag already in S3 was written by a binary that emitted
  // the member, so the first `cdkd drift` after the upgrade reports the whole
  // `GlobalSecondaryIndexes` array on every untouched table. The companion that
  // closes the transition -- declaring the path in `getDriftUnknownPaths` -- is
  // available for a TOP-LEVEL key but cannot express a PER-INDEX one, because an
  // ignore-path never crosses an array (`drift-normalize.ts` documents that
  // divergence). It needs a both-sides normalizer in the
  // `drift-protocol-normalize.ts` mould, plus a live test seeded with a STALE
  // observed baseline -- which a fresh-deploy fixture structurally cannot
  // provide.
});
