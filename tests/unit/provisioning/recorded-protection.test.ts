/**
 * Issue go-to-k/cdkd#2610, sites 9-11: the deploy engine's generic stateful
 * replacement refusals read a resource's protection flag through
 * `recordedProtectionEvidence`, over the same `PROTECTION_PROPERTY_BY_TYPE`
 * table the destroy confirm prompt counts with.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  readerLocatedTypesWithoutLabel,
  recordedProtectionEvidence,
  recordedProtectionNote,
} from '../../../src/provisioning/recorded-protection.js';
import { removeProtectionTypes } from '../../../src/provisioning/remove-protection-types.js';
import { DELETION_PROTECTION_DOC_POINTER } from '../../../src/provisioning/replacement-protection-advice.js';

const evidence = (
  type: string,
  props: Record<string, unknown> | undefined,
  observed?: Record<string, unknown>,
  region = 'us-east-1'
): string | undefined => recordedProtectionEvidence(type, props, observed, region);

describe('recordedProtectionEvidence', () => {
  it('can name the flag of every type --remove-protection covers', () => {
    expect(readerLocatedTypesWithoutLabel()).toEqual([]);
  });

  // One ON bag per covered type, in the shape a CDK app records it. A type
  // added to `--remove-protection` without a row here fails the floor below.
  const ON: Record<string, Record<string, unknown>> = {
    'AWS::Logs::LogGroup': { DeletionProtectionEnabled: true },
    'AWS::RDS::DBInstance': { DeletionProtection: true },
    'AWS::RDS::DBCluster': { DeletionProtection: 'true' },
    'AWS::DocDB::DBCluster': { DeletionProtection: true },
    'AWS::Neptune::DBCluster': { DeletionProtection: true },
    'AWS::Neptune::DBInstance': { DeletionProtection: true },
    'AWS::DynamoDB::Table': { DeletionProtectionEnabled: true },
    'AWS::DynamoDB::GlobalTable': {
      Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }],
    },
    'AWS::EC2::Instance': { DisableApiTermination: true },
    'AWS::Cognito::UserPool': { DeletionProtection: 'ACTIVE' },
    'AWS::AutoScaling::AutoScalingGroup': { DeletionProtection: 'prevent-all-deletion' },
    'AWS::ElasticLoadBalancingV2::LoadBalancer': {
      LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }],
    },
    'AWS::EMR::Cluster': { Instances: { TerminationProtected: true } },
    'AWS::DSQL::Cluster': { DeletionProtectionEnabled: true },
    'AWS::NeptuneGraph::Graph': { DeletionProtection: true },
    'AWS::SMSVOICE::ProtectConfiguration': { DeletionProtectionEnabled: true },
    'AWS::VerifiedPermissions::PolicyStore': { DeletionProtection: { Mode: 'ENABLED' } },
    'AWS::EKS::Cluster': { DeletionProtection: true },
    'AWS::RDS::GlobalCluster': { DeletionProtection: true },
    'AWS::DocDB::GlobalCluster': { DeletionProtection: true },
  };

  it('has an ON case for every covered type', () => {
    expect(removeProtectionTypes().filter((t) => !(t in ON))).toEqual([]);
  });

  for (const [type, bag] of Object.entries(ON)) {
    it(`${type}: names the recorded flag when on, nothing when the bag is empty`, () => {
      expect(evidence(type, bag)).toMatch(/^cdkd's recorded properties for this resource carry /);
      expect(evidence(type, {})).toBeUndefined();
    });
  }

  it('spells the fragment from the flag, never from free-form recorded text', () => {
    expect(evidence('AWS::RDS::DBInstance', { DeletionProtection: true })).toBe(
      "cdkd's recorded properties for this resource carry DeletionProtection: true"
    );
    expect(evidence('AWS::ElasticLoadBalancingV2::LoadBalancer', ON['AWS::ElasticLoadBalancingV2::LoadBalancer'])).toBe(
      "cdkd's recorded properties for this resource carry LoadBalancerAttributes " +
        'deletion_protection.enabled: true'
    );
    expect(evidence('AWS::Cognito::UserPool', { DeletionProtection: 'ACTIVE' })).toBe(
      "cdkd's recorded properties for this resource carry DeletionProtection: ACTIVE"
    );
    expect(evidence('AWS::EMR::Cluster', { Instances: { TerminationProtected: 'true' } })).toBe(
      "cdkd's recorded properties for this resource carry Instances.TerminationProtected: true"
    );
    expect(
      evidence('AWS::VerifiedPermissions::PolicyStore', {
        DeletionProtection: { Mode: 'ENABLED', Note: 'x\nforged' },
      })
    ).toBe("cdkd's recorded properties for this resource carry DeletionProtection enabled");
  });

  it('reads the observed bag when the recorded one says nothing, and says which bag', () => {
    expect(evidence('AWS::DynamoDB::Table', {}, { DeletionProtectionEnabled: true })).toBe(
      'the AWS read-back cdkd stored for this resource carries DeletionProtectionEnabled: true'
    );
    expect(evidence('AWS::DynamoDB::Table', {}, { DeletionProtectionEnabled: false })).toBe(
      undefined
    );
  });

  it('prefers the recorded bag when both say on', () => {
    expect(
      evidence(
        'AWS::DynamoDB::Table',
        { DeletionProtectionEnabled: true },
        { DeletionProtectionEnabled: true }
      )
    ).toMatch(/^cdkd's recorded properties/);
  });

  it('off values are not protection', () => {
    expect(evidence('AWS::RDS::DBCluster', { DeletionProtection: false })).toBeUndefined();
    expect(evidence('AWS::RDS::DBCluster', { DeletionProtection: 'false' })).toBeUndefined();
    expect(evidence('AWS::Cognito::UserPool', { DeletionProtection: 'INACTIVE' })).toBeUndefined();
    expect(
      evidence('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }],
      })
    ).toBeUndefined();
    expect(
      evidence('AWS::VerifiedPermissions::PolicyStore', { DeletionProtection: { Mode: 'DISABLED' } })
    ).toBeUndefined();
  });

  it("an Auto Scaling group's prevent-force-deletion does not block a replacement's delete", () => {
    // The destroy prompt counts it (`countProtectedResources`), but the deploy
    // path's delete is not a forced one, so only prevent-all-deletion blocks.
    expect(
      evidence('AWS::AutoScaling::AutoScalingGroup', { DeletionProtection: 'prevent-force-deletion' })
    ).toBeUndefined();
    expect(
      evidence('AWS::AutoScaling::AutoScalingGroup', { DeletionProtection: 'prevent-all-deletion' })
    ).toBe(
      "cdkd's recorded properties for this resource carry DeletionProtection: prevent-all-deletion"
    );
  });

  it("reads a global table's flag on the deploy region's replica only", () => {
    const bag = {
      Replicas: [
        { Region: 'us-east-1', DeletionProtectionEnabled: false },
        { Region: 'eu-west-1', DeletionProtectionEnabled: true },
      ],
    };
    expect(evidence('AWS::DynamoDB::GlobalTable', bag, undefined, 'us-east-1')).toBeUndefined();
    expect(evidence('AWS::DynamoDB::GlobalTable', bag, undefined, 'eu-west-1')).toBe(
      "cdkd's recorded properties for this resource carry DeletionProtectionEnabled for the " +
        'deploy region: true'
    );
  });

  it('a type with no protection flag, or a torn bag, yields nothing', () => {
    expect(evidence('AWS::S3::Bucket', { DeletionProtection: true })).toBeUndefined();
    expect(evidence('AWS::EMR::Cluster', { Instances: null })).toBeUndefined();
    expect(evidence('AWS::RDS::DBInstance', undefined, undefined)).toBeUndefined();
  });
});

describe('recordedProtectionNote', () => {
  const note = recordedProtectionNote(
    "cdkd's recorded properties for this resource carry DeletionProtection: true",
    '--force-stateful-recreation'
  );

  it('says the flag alone cannot remove the resource, names both outcomes, and the doc', () => {
    expect(note).toContain(
      'cdkd deploy has no --remove-protection flag to clear it (only cdkd destroy and cdkd ' +
        'state destroy act on one), so --force-stateful-recreation alone does not remove the ' +
        'old resource'
    );
    expect(note).toContain('either fails at that delete or completes leaving the old resource');
    expect(note).toContain(`Read ${DELETION_PROTECTION_DOC_POINTER} before you disable anything`);
    expect(note.endsWith('and re-run with --force-stateful-recreation.')).toBe(true);
  });

  it('carries none of the phrases the already-deleted classifiers match', () => {
    for (const needle of ['does not exist', 'not found', 'NotFound']) {
      expect(note).not.toContain(needle);
    }
  });
});
