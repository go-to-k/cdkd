/**
 * `cdkd diff` masks a physical name derived from a secret in the orphan-
 * adoption refusal it previews (go-to-k/cdkd#3869). The refusal names a kept
 * record's physical id (`<id>: <physicalId> is already recorded by another
 * cdkd stack ...`), and the diff rendered it with control characters stripped
 * only, and emitted it raw under `--json`. It is now masked at the source with
 * the same orphan-record needles `cdkd deploy`'s refusal uses.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('../deployment/_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { setLevel: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import {
  buildDiffTree,
  diffTreeToJson,
  renderDiffTree,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const REF = '{{resolve:secretsmanager:team:SecretString:bucket::}}';
const BUCKET = 'team-secret-bucket';

async function previewOf(bucketName: string) {
  const state: StackState = {
    stackName: 'S',
    region: 'us-east-1',
    version: 10,
    resources: {},
    outputs: {},
    lastModified: 0,
    orphans: [
      {
        logicalId: 'Kept',
        orphanedAt: 1,
        state: {
          physicalId: BUCKET,
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: bucketName },
          deletionPolicy: 'Retain',
        },
      },
    ],
  } as StackState;
  const node = await buildDiffTree({
    stackName: 'S',
    displayName: 'S',
    region: 'us-east-1',
    template: { Resources: { Kept: { Type: 'AWS::S3::Bucket', Properties: {} } } },
    nestedTemplates: {},
    recursive: false,
    stateBackend: {
      getState: async (name: string) => (name === 'S' ? { state, etag: 'e' } : null),
    } as unknown as S3StateBackend,
    diffCalculator: new DiffCalculator(),
    isNestedChild: false,
    // The planner's own refusal text, as `planOrphanAdoption` builds it when
    // another stack's record holds the same physical id.
    previewOrphanAdoption: async () => ({
      adopted: {},
      refusals: [
        `'Kept': ${BUCKET} is already recorded by another cdkd stack. cdkd will not adopt a resource another stack manages.`,
      ],
    }),
  });
  const rendered: string[] = [];
  renderDiffTree(node, true, (line: string) => void rendered.push(line));
  return { rendered: rendered.join('\n'), json: JSON.stringify(diffTreeToJson(node)) };
}

describe("cdkd diff masks the adoption refusal's secret-derived physical id (go-to-k/cdkd#3869)", () => {
  it.each([
    ['a record naming it by its reference', REF, false],
    ['negative control, a literal name', BUCKET, true],
  ])('in the rendered view and in --json: %s', async (_l, bucketName, shown) => {
    const { rendered, json } = await previewOf(bucketName);
    // Premise: the refusal is rendered and emitted.
    expect(rendered).toContain('is already recorded by another cdkd stack');
    expect(json).toContain('is already recorded by another cdkd stack');
    expect(rendered.includes(BUCKET)).toBe(shown);
    expect(json.includes(BUCKET)).toBe(shown);
  });
});
