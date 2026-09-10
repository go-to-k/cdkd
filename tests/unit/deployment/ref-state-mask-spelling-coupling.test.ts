/**
 * The masked-`Ref` read is a CONTRACT between two modules, and nothing
 * connected them (issue
 * [#2847](https://github.com/go-to-k/cdkd/issues/2847), independent round-2
 * review, T2; re-aimed by the round-4 review).
 *
 * `IntrinsicFunctionResolver.noteRefStateMask` PRODUCES an entry into
 * `ResolverContext.redactedAttributeReads`; `DeployEngine.maskedRecordRemedyFor`
 * CONSUMES it to decide the entry is LOCAL and to name the record the
 * `cdkd import --resource` command must repair.
 *
 * WHAT THE CONTRACT USED TO BE, AND WHY IT MOVED. Until round 4 the entry was a
 * rendered STRING and the consumer recovered the structure back out of it with
 * a regex. Each side hard-coded the shape independently, and each side's own
 * test hard-coded it a third time — so a consistent rename in the producer AND
 * its test left every test green while the consumer silently stopped matching,
 * and the entry fell to the FOREIGN arm: no command at all, and the user told
 * to "act on the producer stack instead" about a resource in their own stack.
 * That is the defect THIS FILE was written for. It then recurred through a
 * second mechanism — the consumer's id class was `[A-Za-z0-9]+`, which a
 * HYPHENATED logical id falls out of — so the structure moved INTO the entry
 * ({@link RedactedAttributeRead}: `kind` + `logicalId` + `key`, with `display`
 * carried alongside for the message).
 *
 * SO THE FILE STILL EARNS ITS PLACE, over a different claim. It no longer
 * fences a spelling; it drives the REAL producer into the REAL consumer and
 * asserts the ROUTING, so a producer that stops setting `kind` or `logicalId` —
 * or sets the CONSUMER's id, the round-6 defect of the `Fn::GetAtt` arm — reds
 * here. No literal of any entry field appears below except the logical ids the
 * cases choose, which are compared against themselves.
 *
 * A shared runtime constant is still not available for the `display` rendering:
 * `deploy-engine.ts` would have to value-import it, and 72 of the 80 suites
 * that `vi.mock` `intrinsic-function-resolver.js` do so with a BARE factory
 * exposing only `getAccountInfo`, so a new named import reds them with a
 * missing-export error that reads as a broken symbol rather than a mocking
 * problem. The TYPE crosses freely — a type-only import is erased.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type RedactedAttributeRead,
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
  reads: readonly RedactedAttributeRead[],
  resources: Record<string, { resourceType?: string }> = {}
): string =>
  (
    DeployEngine as unknown as {
      maskedRecordRemedyFor(
        reads: readonly RedactedAttributeRead[],
        resources: Record<string, { resourceType?: string }>
      ): string;
    }
  ).maskedRecordRemedyFor(reads, resources);

describe('the masked Ref state-key read couples its producer to its consumer (#2847)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver('us-east-1');
    resetAccountInfoCache();
  });

  /** Drive the REAL producer and return exactly what it recorded. */
  async function producedReads(logicalId: string): Promise<RedactedAttributeRead[]> {
    const redactedAttributeReads: RedactedAttributeRead[] = [];
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

  it("the consumer routes the producer's OWN entry to the LOCAL arm", async () => {
    const reads = await producedReads('MyTable');
    // The producer must have written something, or every assertion below is
    // vacuous — a broken producer would otherwise pass this file silently.
    expect(reads).toHaveLength(1);
    // The two ROUTING fields, asserted here rather than only through the
    // rendered remedy: a producer that stops setting either is what the round-3
    // and round-4 blockers each looked like from the consumer's side.
    expect(reads[0]?.kind).toBe('ref-state-key');
    expect(reads[0]?.logicalId).toBe('MyTable');

    const remedy = remedyFor(reads, { MyTable: { resourceType: TABLE_TYPE } });

    // LOCAL: a concrete, copy-pasteable command naming the record that HOLDS
    // the mask...
    expect(remedy).toContain("'cdkd import <stack> --resource MyTable=<physicalId> --force'");
    // ...and NOT the cross-stack arm, which offers no command at all.
    expect(remedy).not.toContain('ANOTHER stack');
  });

  it("the consumer emits the Ref-specific clause for the producer's OWN entry", async () => {
    // The second thing the entry's `kind` selects: the paragraph correcting the
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

  it('a HYPHENATED logical id still routes LOCAL and names itself in the command', async () => {
    // BLOCKER B4's remedy-side half (round-4 review). The retired consumer
    // matched `^Ref ([A-Za-z0-9]+) \(state key [^)]*\)$`, so this id fell out of
    // the pattern entirely and the entry took the FOREIGN arm — the exact
    // wrong-advice outcome the top of this file describes, reached through a
    // CHARSET rather than a rename. cdkd validates no logical-id charset and
    // never hands the template to CloudFormation, so `overrideLogicalId` and a
    // `--migrate-from-cloudformation` template both produce ids like this.
    const logicalId = 'My-Table';
    const reads = await producedReads(logicalId);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.logicalId).toBe(logicalId);

    const remedy = remedyFor(reads, { [logicalId]: { resourceType: TABLE_TYPE } });

    expect(remedy).toContain(`--resource ${logicalId}=<physicalId>`);
    expect(remedy).toContain("CDKD's own read");
    expect(remedy).not.toContain('ANOTHER stack');
  });

  it('a NESTED-STACK target still routes FOREIGN through the same entry', async () => {
    // The type-based exclusion must reach the derived entry too — this is the
    // arm that decides no `--resource` in this stack can clear the mask.
    const reads = await producedReads('Child');
    const remedy = remedyFor(reads, {
      Child: { resourceType: 'AWS::CloudFormation::Stack' },
    });

    expect(remedy).toContain('ANOTHER stack');
    // The `--resource` COMMAND, not the words `cdkd import`: the Ref clause
    // says "re-import it", so a `not.toContain('cdkd import')` could not see
    // that clause and dropping `&& isLocal(read)` from `hasRefStateRead` was
    // measured GREEN. Assert the two things this arm must withhold, each by a
    // string only its own arm emits.
    expect(remedy).not.toContain('--resource');
    expect(remedy).not.toContain("CDKD's own read");
  });
});
