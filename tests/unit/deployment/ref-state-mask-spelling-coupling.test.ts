/**
 * The `Ref <LogicalId> (state key <Key>)` spelling is a CONTRACT between two
 * modules, and nothing connected them (issue
 * [#2847](https://github.com/go-to-k/cdkd/issues/2847), independent round-2
 * review, T2).
 *
 * `IntrinsicFunctionResolver.noteRefStateMask` PRODUCES that string into
 * `ResolverContext.redactedAttributeReads`; `DeployEngine.maskedRecordRemedyFor`
 * CONSUMES it through `REF_STATE_MASKED_READ` to decide the entry is LOCAL and
 * to read the logical id out of it for the `cdkd import --resource` command.
 * Each side hard-coded the shape independently, and each side's own test
 * hard-coded it a third time — so a consistent rename in the producer AND its
 * test left all 236 tests green while the consumer silently stopped matching.
 * The entry then falls to the FOREIGN arm: no command at all, and the user is
 * told to "act on the producer stack instead" about a resource in their own
 * stack. That is precisely the wrong-advice class this PR spent two rounds
 * removing.
 *
 * WHY A DERIVATION AND NOT A SHARED CONSTANT. A shared runtime constant is the
 * stronger shape and was rejected on a measurement: `deploy-engine.ts` would
 * have to value-import it, and 72 of the 80 suites that `vi.mock`
 * `intrinsic-function-resolver.js` do so with a BARE factory exposing only
 * `getAccountInfo`, so a new named import reds them with a missing-export error
 * that reads as a broken symbol rather than a mocking problem. The repo's own
 * rule for that situation is to spell it in both and fence the pair with a test
 * importing both — this file.
 *
 * NO LITERAL OF THE SPELLING APPEARS BELOW. The entry is taken from what the
 * REAL resolver wrote and handed to the REAL consumer, so a rename on either
 * side (or in either side's own test) reds here.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

const TABLE_TYPE = 'AWS::S3Tables::Table';
/** Pipe-free, UUID-tailed — the CC-routed shape that needs the state key. */
const TABLE_ARN =
  'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/6f1f5a90-2847-4b1a-9d6f-cccc';

const remedyFor = (
  reads: readonly string[],
  resources: Record<string, { resourceType?: string }> = {}
): string =>
  (
    DeployEngine as unknown as {
      maskedRecordRemedyFor(
        reads: readonly string[],
        resources: Record<string, { resourceType?: string }>
      ): string;
    }
  ).maskedRecordRemedyFor(reads, resources);

describe('the Ref state-key read spelling couples its producer to its consumer (#2847)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver('us-east-1');
    resetAccountInfoCache();
  });

  /** Drive the REAL producer and return exactly what it recorded. */
  async function producedReads(logicalId: string): Promise<string[]> {
    const redactedAttributeReads: string[] = [];
    const template: CloudFormationTemplate = {
      Resources: { [logicalId]: { Type: TABLE_TYPE, Properties: {} } },
    };
    const context: ResolverContext = {
      template,
      resources: {
        [logicalId]: {
          physicalId: TABLE_ARN,
          resourceType: TABLE_TYPE,
          properties: { TableName: SECRET_MASK },
          dependencies: [],
        },
      },
      redactedAttributeReads,
    };
    await resolver.resolve({ Ref: logicalId }, context);
    return redactedAttributeReads;
  }

  it('the consumer routes the producer\'s OWN entry to the LOCAL arm', async () => {
    const reads = await producedReads('MyTable');
    // The producer must have written something, or every assertion below is
    // vacuous — a broken producer would otherwise pass this file silently.
    expect(reads).toHaveLength(1);

    const remedy = remedyFor(reads, { MyTable: { resourceType: TABLE_TYPE } });

    // LOCAL: a concrete, copy-pasteable command naming the record that HOLDS
    // the mask...
    expect(remedy).toContain("'cdkd import <stack> --resource MyTable=<physicalId> --force'");
    // ...and NOT the cross-stack arm, which offers no command at all.
    expect(remedy).not.toContain('ANOTHER stack');
  });

  it("the consumer emits the Ref-specific clause for the producer's OWN entry", async () => {
    // The second thing the spelling selects: the paragraph correcting the
    // refusal's "stop reading it" advice, which is wrong for a read cdkd
    // issues on the template's behalf.
    const remedy = remedyFor(await producedReads('MyTable'), {
      MyTable: { resourceType: TABLE_TYPE },
    });

    expect(remedy).toContain("CDKD's own read");
  });

  it('the logical id the consumer extracts is the one the producer was given', async () => {
    // Derived on BOTH sides from the same variable, so a producer that started
    // emitting the CONSUMER's id (the round-6 defect of the GetAtt arm) reds
    // here rather than reading as a cosmetic difference.
    const logicalId = 'ZzTable2847';
    const remedy = remedyFor(await producedReads(logicalId), {
      [logicalId]: { resourceType: TABLE_TYPE },
    });

    expect(remedy).toContain(`--resource ${logicalId}=<physicalId>`);
  });

  it('a NESTED-STACK target still routes FOREIGN through the same entry', async () => {
    // The type-based exclusion must reach the derived spelling too — this is
    // the arm that decides no `--resource` in this stack can clear the mask.
    const reads = await producedReads('Child');
    const remedy = remedyFor(reads, {
      Child: { resourceType: 'AWS::CloudFormation::Stack' },
    });

    expect(remedy).not.toContain('cdkd import');
    expect(remedy).toContain('ANOTHER stack');
  });
});
