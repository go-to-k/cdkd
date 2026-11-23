/**
 * go-to-k/cdkd#6871: `cdkd diff` merges the stack tags exactly as the deploy
 * does, previews the nested row the deploy updates for its child's tags, and
 * hands the child its effective tags (the parent's plus the row's own).
 */

import { describe, expect, it, vi } from 'vite-plus/test';

const infos = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: (m: unknown): void => void infos.push(String(m)),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: async () => {
        throw Object.assign(new Error('not in this test'), { name: 'TypeNotFoundException' });
      },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
      destroy: vi.fn(),
    })),
  };
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDiffTree,
  diffTreeToJson,
  renderChangeLines,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const ROW = 'AWS::CloudFormation::Stack';

function state(name: string, resources: Record<string, unknown>, patch: Partial<StackState> = {}): StackState {
  return {
    stackName: name,
    region: 'us-east-1',
    version: 16,
    lastModified: 0,
    outputs: {},
    resources: resources as never,
    ...patch,
  };
}

const queueRecord = (tags: unknown) => ({
  physicalId: 'q',
  resourceType: 'AWS::SQS::Queue',
  properties: { Tags: tags },
});

async function tree(
  states: Record<string, StackState>,
  stackTags: Record<string, string> | undefined,
  rowTags?: unknown
) {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-6871-'));
  try {
    writeFileSync(
      join(dir, 'child.json'),
      JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: {} } } })
    );
    const parentTemplate: CloudFormationTemplate = {
      Resources: {
        Q: { Type: 'AWS::SQS::Queue', Properties: { Tags: [{ Key: 'own', Value: 'x' }] } },
        Child: {
          Type: ROW,
          Metadata: { 'aws:asset:path': 'child.json' },
          Properties: { ...(rowTags !== undefined && { Tags: rowTags }) },
        },
      },
    };
    return await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: parentTemplate,
      nestedTemplates: { Child: join(dir, 'child.json') },
      recursive: true,
      stateBackend: {
        getState: async (name: string) => (states[name] ? { state: states[name], etag: 'e' } : null),
      } as unknown as S3StateBackend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      ...(stackTags && { stackTags }),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rowRecord = { physicalId: 'arn', resourceType: ROW, properties: {}, attributes: {} };

describe('cdkd diff previews stack tags as the deploy applies them (go-to-k/cdkd#6871)', () => {
  it("previews the tag change on the root's resources and re-runs the nested child for its tags", async () => {
    const states = {
      S: state('S', { Q: queueRecord([{ Key: 'own', Value: 'x' }]), Child: rowRecord }),
      'S~Child': state('S~Child', { Q: queueRecord(undefined) }),
    };
    const result = await tree(states, { team: 'platform' }, [{ Key: 'row', Value: 'r' }]);
    const q = result.changes.get('Q');
    expect(q?.changeType).toBe('UPDATE');
    expect(q?.propertyChanges?.find((pc) => pc.path === 'Tags')?.newValue).toEqual([
      { Key: 'own', Value: 'x' },
      { Key: 'team', Value: 'platform' },
    ]);
    const row = result.changes.get('Child');
    expect(row).toMatchObject({ changeType: 'UPDATE', nestedStackTagsChanged: true });
    const lines: string[] = [];
    renderChangeLines(result.changes, (m) => lines.push(m));
    expect(lines.some((m) => m.includes('apply its changed stack tags'))).toBe(true);
    expect(diffTreeToJson(result).changes.find((c) => c.logicalId === 'Child')?.nestedStackTagsChanged).toBe(true);
    // The child previews its resources with the parent's tags plus the row's.
    const child = result.children.find((c) => c.stackName === 'S~Child');
    expect(child?.changes.get('Q')?.propertyChanges?.find((pc) => pc.path === 'Tags')?.newValue).toEqual([
      { Key: 'team', Value: 'platform' },
      { Key: 'row', Value: 'r' },
    ]);
  });

  it('CONTROL: recorded tags equal to the effective ones preview no change', async () => {
    const states = {
      S: state(
        'S',
        {
          Q: queueRecord([
            { Key: 'own', Value: 'x' },
            { Key: 'team', Value: 'platform' },
          ]),
          Child: rowRecord,
        },
        { nestedStackTags: { Child: { team: 'platform' } } }
      ),
      'S~Child': state('S~Child', { Q: queueRecord([{ Key: 'team', Value: 'platform' }]) }),
    };
    const result = await tree(states, { team: 'platform' });
    expect(result.changes.get('Q')?.changeType).toBe('NO_CHANGE');
    expect(result.changes.get('Child')?.changeType).toBe('NO_CHANGE');
    expect(result.children[0]?.changes.get('Q')?.changeType).toBe('NO_CHANGE');
  });

  it('CONTROL: without stack tags nothing changes and no nested row runs', async () => {
    const states = {
      S: state('S', { Q: queueRecord([{ Key: 'own', Value: 'x' }]), Child: rowRecord }),
      'S~Child': state('S~Child', { Q: queueRecord(undefined) }),
    };
    const result = await tree(states, undefined);
    expect(result.changes.get('Q')?.changeType).toBe('NO_CHANGE');
    expect(result.changes.get('Child')?.changeType).toBe('NO_CHANGE');
  });
});
