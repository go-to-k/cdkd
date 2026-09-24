import { describe, it, expect } from 'vite-plus/test';
import { buildStackState } from '../../../src/cli/commands/import.js';
import { TemplateParser } from '../../../src/analyzer/template-parser.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * Issue #3645: `cdkd destroy` reads `DeletionPolicy` from STATE only, so an
 * imported record written without the template's policies DELETED a `Retain`
 * resource (and skipped a `Snapshot` one's final snapshot) when destroy ran
 * before the first deploy rewrote the record.
 */
describe('buildStackState records the template policies (issue #3645)', () => {
  const template: CloudFormationTemplate = {
    Resources: {
      Kept: {
        Type: 'AWS::SQS::Queue',
        Properties: {},
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Snapshot',
      },
      Plain: { Type: 'AWS::SQS::Queue', Properties: {} },
    },
  };
  const row = (logicalId: string) => ({
    logicalId,
    resourceType: 'AWS::SQS::Queue',
    outcome: 'imported' as const,
    physicalId: `${logicalId}-phys`,
  });
  const build = (existing: Parameters<typeof buildStackState>[5] = null) =>
    buildStackState(
      'Stack',
      'us-east-1',
      [row('Kept'), row('Plain')],
      new TemplateParser(),
      template,
      existing,
      false
    );

  it('records DeletionPolicy / UpdateReplacePolicy from the template resource', () => {
    const { resources } = build();
    expect(resources['Kept']!.deletionPolicy).toBe('Retain');
    expect(resources['Kept']!.updateReplacePolicy).toBe('Snapshot');
  });

  // Guards a default (`'Delete'`, `null`) being written for an undeclared
  // policy; the pre-fix code passes it too.
  it('leaves both absent for a resource that declares neither', () => {
    const plain = JSON.parse(JSON.stringify(build().resources['Plain']));
    expect(plain).not.toHaveProperty('deletionPolicy');
    expect(plain).not.toHaveProperty('updateReplacePolicy');
  });

  // Guards a `?? prior.deletionPolicy` carry-forward, which would keep a
  // policy the template dropped; the pre-fix code passes it too.
  it('takes the template value over a prior record on re-import', () => {
    const { resources } = build({
      version: 7,
      stackName: 'Stack',
      region: 'us-east-1',
      resources: {
        Plain: {
          physicalId: 'Plain-phys',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          attributes: {},
          dependencies: [],
          deletionPolicy: 'Retain',
        },
      },
      outputs: {},
      lastModified: 0,
    } as Parameters<typeof buildStackState>[5]);
    // The template no longer declares it, as `DeployEngine` would record.
    expect(resources['Plain']!.deletionPolicy).toBeUndefined();
  });
});
