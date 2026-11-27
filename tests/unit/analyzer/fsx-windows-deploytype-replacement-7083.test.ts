/**
 * go-to-k/cdkd#7083, the fsx-windows integ's Phase 4b without AWS: the record a
 * Phase 4 deploy leaves (DeploymentType SINGLE_AZ_1) against the Phase 4b
 * template (SINGLE_AZ_2). The diff plans the replacement, and
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
// WindowsConfiguration path: only the generated spec-replacement row can
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

const STACK = 'CdkdFsxWindowsExample';
// The template's subnet `Ref`, as the deploy's resolver hands it to the diff.
const SUBNET_ID = 'subnet-0abc';

/** The fixture's `Fs` as synthesized with the Phase 4 envs, DeploymentType aside. */
function fsProperties(deploymentType: string, subnet: string): Record<string, unknown> {
  return {
    FileSystemType: 'WINDOWS',
    StorageCapacity: 32,
    StorageType: 'SSD',
    SubnetIds: [subnet],
    WindowsConfiguration: {
      ActiveDirectoryId: 'd-0123456789',
      DeploymentType: deploymentType,
      ThroughputCapacity: 8,
      AutomaticBackupRetentionDays: 0,
      WeeklyMaintenanceStartTime: '2:06:00',
      Aliases: ['keep.corp.cdkd-integ.com', 'add.corp.cdkd-integ.com'],
    },
    Tags: [
      { Key: 'cdkd-integ', Value: 'fsx-windows' },
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
      properties: fsProperties('SINGLE_AZ_1', SUBNET_ID),
      attributes: {},
      deletionPolicy: 'Delete',
      updateReplacePolicy: 'Delete',
    },
  },
  outputs: {},
  lastModified: 0,
} as unknown as StackState;

const phase4bTemplate = {
  Resources: {
    Fs: {
      Type: 'AWS::FSx::FileSystem',
      Properties: fsProperties('SINGLE_AZ_2', SUBNET_ID),
      UpdateReplacePolicy: 'Delete',
      DeletionPolicy: 'Delete',
    },
  },
} as unknown as CloudFormationTemplate;

describe('fsx-windows Phase 4b: a DeploymentType change (go-to-k/cdkd#7083)', () => {
  it('plans the file system replaced, and only --fail-on=destructive words it "will be replaced"', async () => {
    const changes = await new DiffCalculator().calculateDiff(state, phase4bTemplate);

    const fs = changes.get('Fs');
    expect(fs?.changeType).toBe('UPDATE');
    expect(fs?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'WindowsConfiguration', requiresReplacement: true }),
    ]);

    // The `--fail-on=destructive` listing carries the line the phase greps.
    const destructive = findDestructiveChanges(
      STACK,
      changes.values(),
      state.resources,
      phase4bTemplate
    ).map(formatDestructiveChange);
    expect(destructive).toEqual([`${STACK}: AWS::FSx::FileSystem Fs will be replaced`]);
    expect(destructive[0]).toMatch(/AWS::FSx::FileSystem .*Fs will be replaced/);

    // The plain render does not: it marks the property instead.
    const plain: string[] = [];
    renderChangeLines(changes, (line) => plain.push(line));
    const rendered = plain.join('\n');
    expect(rendered).not.toMatch(/will be replaced/);
    expect(rendered).toMatch(/WindowsConfiguration.*\[requires replacement\]/);
  });
});
