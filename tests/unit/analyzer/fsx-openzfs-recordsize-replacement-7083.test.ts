/**
 * go-to-k/cdkd#7083, the fsx-openzfs integ's Phase 2e without AWS: the record a
 * Phase 2c deploy leaves (ThroughputCapacity dropped, RecordSizeKiB 128) against
 * the Phase 2e template (RecordSizeKiB 64). The diff plans the replacement, and
 * the `will be replaced` line the phase asserts is the `--fail-on=destructive`
 * listing: the plain render only marks the property `[requires replacement]`,
 * which is why the phase passes that flag.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SNAPSHOT = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/cfn-registry-create-only-paths.json'), 'utf8')
) as { types: Record<string, string[][]> };

// DescribeType answers with the committed registry snapshot, which has no
// RootVolumeConfiguration path: only the generated spec-replacement row can
// make this change a replacement.
const mockSend = vi.fn(async (command: { input?: { TypeName?: string } }) => {
  const paths = SNAPSHOT.types[command.input?.TypeName ?? ''] ?? [];
  return {
    Schema: JSON.stringify({ createOnlyProperties: paths.map((p) => `/properties/${p.join('/')}`) }),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ cloudFormation: { send: mockSend } }),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...quiet, child: () => quiet }) };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  findDestructiveChanges,
  formatDestructiveChange,
} from '../../../src/analyzer/destructive-changes.js';
import { renderChangeLines } from '../../../src/cli/commands/diff-recursive/render.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const STACK = 'CdkdFsxOpenZfsExample';
// The template's subnet `Ref`, as the deploy's resolver hands it to the diff.
const SUBNET_ID = 'subnet-0abc';

/** The fixture's `Fs` as synthesized with the Phase 2c envs, RecordSizeKiB aside. */
function fsProperties(recordSizeKiB: number, subnet: string): Record<string, unknown> {
  return {
    FileSystemType: 'OPENZFS',
    OpenZFSConfiguration: {
      DeploymentType: 'SINGLE_AZ_1',
      Options: ['DELETE_CHILD_VOLUMES_AND_SNAPSHOTS'],
      RootVolumeConfiguration: { DataCompressionType: 'LZ4', RecordSizeKiB: recordSizeKiB },
      WeeklyMaintenanceStartTime: '7:03:30',
    },
    SubnetIds: [subnet],
    Tags: [
      { Key: 'cdkd-integ', Value: 'fsx-openzfs' },
      { Key: 'env', Value: 'changed' },
    ],
  };
}

const state: StackState = {
  version: 1,
  stackName: STACK,
  resources: {
    Fs: {
      physicalId: 'fs-0abc',
      resourceType: 'AWS::FSx::FileSystem',
      properties: fsProperties(128, SUBNET_ID),
      attributes: {},
      deletionPolicy: 'Delete',
      updateReplacePolicy: 'Delete',
    },
  },
  outputs: {},
  lastModified: 0,
} as unknown as StackState;

const phase2eTemplate = {
  Resources: {
    Fs: {
      Type: 'AWS::FSx::FileSystem',
      Properties: fsProperties(64, SUBNET_ID),
      UpdateReplacePolicy: 'Delete',
      DeletionPolicy: 'Delete',
    },
  },
} as unknown as CloudFormationTemplate;

describe('fsx-openzfs Phase 2e: a RecordSizeKiB change (go-to-k/cdkd#7083)', () => {
  it('plans the file system replaced, and only --fail-on=destructive words it "will be replaced"', async () => {
    const changes = await new DiffCalculator().calculateDiff(state, phase2eTemplate);

    const fs = changes.get('Fs');
    expect(fs?.changeType).toBe('UPDATE');
    expect(fs?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'OpenZFSConfiguration', requiresReplacement: true }),
    ]);

    // The `--fail-on=destructive` listing carries the line the phase greps.
    const destructive = findDestructiveChanges(
      STACK,
      changes.values(),
      state.resources,
      phase2eTemplate
    ).map(formatDestructiveChange);
    expect(destructive).toEqual([`${STACK}: AWS::FSx::FileSystem Fs will be replaced`]);
    expect(destructive[0]).toMatch(/AWS::FSx::FileSystem .*Fs will be replaced/);

    // The plain render does not: it marks the property instead.
    const plain: string[] = [];
    renderChangeLines(changes, (line) => plain.push(line));
    const rendered = plain.join('\n');
    expect(rendered).not.toMatch(/will be replaced/);
    expect(rendered).toMatch(/OpenZFSConfiguration.*\[requires replacement\]/);
  });
});
