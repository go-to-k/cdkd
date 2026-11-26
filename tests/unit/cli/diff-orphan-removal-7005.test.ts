/**
 * go-to-k/cdkd#7005: a removed resource whose recorded `DeletionPolicy` keeps
 * it (`Retain` / `RetainExceptOnCreate`) is ORPHANED by the deploy, so every
 * change summary must say so instead of counting it under `to delete`: the
 * `cdkd diff` tree, the deploy's `Changes:` plan line and the
 * `--require-approval` prompt. The AWS CDK CLI marks the row `orphan`.
 */
import { describe, it, expect } from 'vite-plus/test';
import { renderDiffTree, type DiffTreeNode } from '../../../src/cli/commands/diff-recursive.js';
import { findDestructiveChanges } from '../../../src/analyzer/destructive-changes.js';
import { renderApprovalRequest } from '../../../src/cli/commands/require-approval.js';
import {
  plannedChangeCounts,
  plannedChangesLine,
} from '../../../src/deployment/deploy-engine/deploy-flow/change-summary.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const del = (logicalId: string): ResourceChange => ({
  logicalId,
  changeType: 'DELETE',
  resourceType: 'AWS::SQS::Queue',
});

const record = (deletionPolicy?: ResourceState['deletionPolicy']): ResourceState => ({
  physicalId: 'pid',
  resourceType: 'AWS::SQS::Queue',
  properties: {},
  ...(deletionPolicy !== undefined && { deletionPolicy }),
});

const RECORDS: Record<string, ResourceState> = {
  QRet: record('Retain'),
  QRou: record('RetainExceptOnCreate'),
  QSnap: record('Snapshot'),
  QDel: record('Delete'),
  QNone: record(),
};

const CHANGES = new Map(Object.keys(RECORDS).map((id) => [id, del(id)]));

function node(): DiffTreeNode {
  return {
    stackName: 'S',
    displayName: 'S',
    region: 'us-east-1',
    changes: CHANGES,
    ccApiRoutes: new Map(),
    outputChanges: [],
    adoptedOrphans: [],
    unreadable: [],
    unreadableContainers: [],
    unreadableOrphans: [],
    destructiveChanges: findDestructiveChanges('S', CHANGES.values(), RECORDS),
    blocking: [],
    children: [],
  };
}

function rendered(n: DiffTreeNode): string[] {
  const lines: string[] = [];
  renderDiffTree(n, true, (m) => lines.push(m));
  return lines;
}

describe('cdkd diff: a retained removal is an orphan (#7005)', () => {
  it('marks each retained row and counts it as orphaned, not deleted', () => {
    const lines = rendered(node());
    const row = (id: string): string | undefined =>
      lines.find((l) => l.startsWith(`  [-] ${id} `));
    expect(row('QRet')).toBe(
      '  [-] QRet (AWS::SQS::Queue) [orphan: its DeletionPolicy keeps it in AWS]'
    );
    expect(row('QRou')).toBe(
      '  [-] QRou (AWS::SQS::Queue) [orphan: its DeletionPolicy keeps it in AWS]'
    );
    for (const id of ['QSnap', 'QDel', 'QNone']) {
      expect(row(id)).toBe(`  [-] ${id} (AWS::SQS::Queue)`);
    }
    expect(lines).toContain('\n0 to create, 0 to update, 3 to delete, 2 to orphan');
  });

  it('keeps the unchanged summary when nothing is retained', () => {
    const n = node();
    n.destructiveChanges = n.destructiveChanges.filter((c) => c.impact !== 'WILL_ORPHAN');
    const lines = rendered(n);
    expect(lines).toContain('\n0 to create, 0 to update, 5 to delete');
    expect(lines.some((l) => l.includes('[orphan'))).toBe(false);
  });
});

describe('cdkd deploy plan line: a retained removal is an orphan (#7005)', () => {
  it('counts by the recorded policy', () => {
    const counts = plannedChangeCounts(CHANGES.values(), RECORDS, undefined);
    expect(counts).toEqual({ create: 0, update: 0, delete: 3, orphan: 2 });
    // eslint-disable-next-line no-control-regex
    expect(plannedChangesLine(counts).replace(/\x1b\[[0-9;]*m/g, '')).toBe(
      'Changes: 0 to create, 0 to update, 3 to delete, 2 to orphan'
    );
  });

  it('falls back to the template policy for a record without one, as the delete does', () => {
    const template: CloudFormationTemplate = {
      Resources: { QNone: { Type: 'AWS::SQS::Queue', DeletionPolicy: 'Retain' } },
    } as CloudFormationTemplate;
    const counts = plannedChangeCounts([del('QNone')], { QNone: record() }, template);
    expect(counts).toEqual({ create: 0, update: 0, delete: 0, orphan: 1 });
  });

  it('prints no orphan term when there is none', () => {
    // eslint-disable-next-line no-control-regex
    const line = plannedChangesLine({ create: 1, update: 2, delete: 3, orphan: 0 }).replace(
      /\x1b\[[0-9;]*m/g,
      ''
    );
    expect(line).toBe('Changes: 1 to create, 2 to update, 3 to delete');
  });
});

describe('--require-approval prompt: a retained removal is an orphan (#7005)', () => {
  it('prints the orphan count beside the delete count', () => {
    const text = renderApprovalRequest({
      stackName: 'S',
      level: 'destructive',
      counts: { create: 0, update: 1, delete: 0, orphan: 1 },
      destructiveChanges: findDestructiveChanges('S', [del('QRet')], RECORDS),
    });
    expect(text).toContain('S: AWS::SQS::Queue QRet will be orphaned');
    expect(text).toContain('Stack S: 0 to create, 1 to update, 0 to delete, 1 to orphan.');
  });
});
