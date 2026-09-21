/**
 * Issue go-to-k/cdkd#3379, diff half — the `orphans` CONTAINER, one level above
 * the ENTRY guard `diff-recursive-malformed-properties.test.ts` covers.
 *
 * `cdkd diff` cannot WRITE state, so the answer here is the repair-and-report
 * half rather than a refusal, exactly as it is for the `resources` bag and the
 * `outputs` map: replace the container with an empty list on the in-memory
 * record, warn naming the container, and list a stand-in row in the node's
 * `unreadable` so `--json` and the rendered preview both say the view is
 * incomplete.
 *
 * AT THE LOAD, and the string shape is why. The adoption gate is
 * `currentState.orphans?.length && options.previewOrphanAdoption`, and
 * `'abc'.length` is 3 — so the gate PASSES for a string and the walk below it
 * reads characters as orphan records. A guard written at the gate would sit
 * under the dereference that already lied.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

import { getLogger } from '../../../src/utils/logger.js';
import { buildDiffTree, diffTreeToJson, renderDiffTree } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { UNREADABLE_ORPHANS_CONTAINER_ROW } from '../../../src/state/malformed-resources-bag.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const STACK = 'DiffStack';
const REGION = 'us-east-1';

const template: CloudFormationTemplate = {
  Resources: { Keep: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
};

function record(orphans: unknown): StackState {
  return {
    stackName: STACK,
    region: REGION,
    version: 10,
    resources: {
      Keep: { physicalId: 'p', resourceType: 'AWS::SSM::Parameter', properties: { Value: 'x' } },
    },
    outputs: {},
    orphans: orphans as StackState['orphans'],
    lastModified: 0,
  };
}

async function diff(state: StackState, previewOrphanAdoption?: () => never) {
  return buildDiffTree({
    stackName: STACK,
    displayName: STACK,
    region: REGION,
    template,
    nestedTemplates: {},
    recursive: false,
    stateBackend: {
      getState: async (name: string) => (name === STACK ? { state, etag: 'fake' } : null),
    } as unknown as S3StateBackend,
    diffCalculator: new DiffCalculator(),
    ...(previewOrphanAdoption && {
      previewOrphanAdoption:
        previewOrphanAdoption as unknown as Parameters<typeof buildDiffTree>[0]['previewOrphanAdoption'],
    }),
  });
}

function warnings(): string {
  return (getLogger().warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((args) => String(args[0]))
    .join('\n');
}

describe('cdkd diff over an unreadable orphans container (go-to-k/cdkd#3379)', () => {
  beforeEach(() => vi.clearAllMocks());

  const MALFORMED: Array<[string, unknown]> = [
    ['a string container', 'abc'],
    ['a number container', 5],
    ['a plain object container', {}],
    ['an object carrying length', { length: 1 }],
    ['a null container', null],
  ];

  for (const [label, orphans] of MALFORMED) {
    it(`reports ${label} and still diffs the stack`, async () => {
      const node = await diff(record(orphans));
      // It REPORTED rather than threw: `cdkd diff` is the command a user runs
      // to inspect a record like this one.
      expect(node.unreadable).toContain(UNREADABLE_ORPHANS_CONTAINER_ROW);
      expect(warnings()).toContain("'orphans'");
      // And the rest of the record still diffed — the resources bag is intact.
      expect(node.stackName).toBe(STACK);
    });
  }

  it('repairs BEFORE the adoption preview, so a string container never reaches it', async () => {
    // The preview throws if it is reached at all. Unrepaired, `'abc'.length`
    // is 3, so the gate passes and this fires — which is the abort the guard
    // removes, and what makes this case discriminate placement rather than
    // merely verdict.
    const node = await diff(record('abc'), () => {
      throw new Error('previewOrphanAdoption was reached with an unreadable container');
    });
    expect(node.unreadable).toContain(UNREADABLE_ORPHANS_CONTAINER_ROW);
  });

  it('names the container in the row rather than rendering it as a logical id', async () => {
    const node = await diff(record(5));
    // The row is a container stand-in; `displayLogicalId` would quote it as if
    // it were a resource name.
    expect(node.unreadable).toEqual([UNREADABLE_ORPHANS_CONTAINER_ROW]);
  });

  it('renders the stand-in row verbatim and withholds the logical-id sentence', async () => {
    // Two clauses of the renderer, both keyed on the row being a CONTAINER
    // stand-in rather than a logical id: it is not quoted like an id, and the
    // "one the template still declares is shown above as a create" sentence —
    // which is about ids — is suppressed. Without the second, a node whose only
    // row is this container claims the template declares one of them.
    const node = await diff(record('abc'));
    expect(diffTreeToJson(node).unreadable).toEqual([UNREADABLE_ORPHANS_CONTAINER_ROW]);
    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    const text = lines.join('\n');
    expect(text).toContain(`1 state record row(s) could not be read: ${UNREADABLE_ORPHANS_CONTAINER_ROW}.`);
    expect(text).not.toContain('shown above as a create');
  });

  it('CONTROL: a readable or absent container yields no row and no warning', async () => {
    for (const orphans of [[], undefined]) {
      vi.clearAllMocks();
      const node = await diff(record(orphans));
      expect(node.unreadable).not.toContain(UNREADABLE_ORPHANS_CONTAINER_ROW);
      expect(warnings()).not.toContain("'orphans'");
    }
  });
});
