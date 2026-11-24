import { describe, it, expect, vi } from 'vite-plus/test';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import { DeferredReadinessRun } from '../../../src/deployment/deferred-readiness-run.js';
import { awaitUpstreamDeferredReadiness } from '../../../src/deployment/deploy-engine/execute/provision-node.js';
import type { DeployRun } from '../../../src/deployment/deploy-engine/execute/run.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import {
  recordResolvedPair,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

/**
 * go-to-k/cdkd#6940 part 2: before a custom resource is invoked, every
 * skipped-wait resource upstream of it — through DependsOn, Ref and
 * Fn::GetAtt, transitively (its handler function included) — is waited for.
 * A resource that is not upstream is never waited for.
 */

// Nat <- Route (Ref) ; Fn DependsOn Route ; Seed GetAtt Fn (ServiceToken)
// Db is upstream of Seed by DependsOn. Lb is NOT upstream of Seed.
const TEMPLATE: CloudFormationTemplate = {
  Resources: {
    Nat: { Type: 'AWS::EC2::NatGateway', Properties: {} },
    Route: { Type: 'AWS::EC2::Route', Properties: { NatGatewayId: { Ref: 'Nat' } } },
    Fn: { Type: 'AWS::Lambda::Function', DependsOn: ['Route'], Properties: {} },
    Db: { Type: 'AWS::RDS::DBCluster', Properties: {} },
    Lb: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: {} },
    Seed: {
      Type: 'Custom::Seed',
      DependsOn: 'Db',
      Properties: { ServiceToken: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
    },
    Plain: { Type: 'AWS::EC2::SecurityGroup', DependsOn: 'Lb', Properties: {} },
  },
};

function runWith(
  readiness: DeferredReadinessRun,
  perResourceSecrets: Map<string, RecordedSecretValues> = new Map()
): DeployRun {
  const dagBuilder = new DagBuilder();
  const dag = dagBuilder.buildGraph(TEMPLATE);
  const secretsRun = { perResourceSecrets, secretNameNeedles: new Map() };
  return {
    engine: { deferredReadiness: readiness, dagBuilder, secretsRun },
    dag,
  } as unknown as DeployRun;
}

function readinessWith(
  waits: Record<string, () => Promise<unknown>>
): DeferredReadinessRun {
  const run = new DeferredReadinessRun({
    logger: { info: vi.fn(), debug: vi.fn() },
    region: 'us-east-1',
    budget: () => ({ warnAfterMs: 1_000_000, timeoutMs: 2_000_000 }),
    interrupted: () => false,
  });
  for (const [id, wait] of Object.entries(waits)) {
    run.record(
      id,
      TEMPLATE.Resources[id]!.Type,
      'CREATE',
      new Map([[`${id}-phys`, { wait, inContext: (fn) => fn() }]])
    );
  }
  return run;
}

describe('awaitUpstreamDeferredReadiness (#6940)', () => {
  it('waits for the deferred resources upstream of the custom resource, transitively', async () => {
    const nat = vi.fn(async () => undefined);
    const db = vi.fn(async () => undefined);
    const lb = vi.fn(async () => undefined);
    await awaitUpstreamDeferredReadiness(
      runWith(readinessWith({ Nat: nat, Db: db, Lb: lb })),
      'Seed',
      'Custom::Seed'
    );
    // Nat reaches Seed only through Route -> Fn (its handler) -> ServiceToken.
    expect(nat).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledTimes(1);
    // Not upstream of Seed: a plain dependent of Lb never makes anything wait.
    expect(lb).not.toHaveBeenCalled();
  });

  it('costs nothing when nothing was deferred', async () => {
    const run = runWith(readinessWith({}));
    const spy = vi.spyOn(run.engine.dagBuilder, 'getAllDependencies');
    await awaitUpstreamDeferredReadiness(run, 'Seed', 'Custom::Seed');
    expect(spy).not.toHaveBeenCalled();
  });

  it('an upstream failure fails the custom resource as refused before applying, unretried', async () => {
    const error = await awaitUpstreamDeferredReadiness(
      runWith(
        readinessWith({
          Db: async () => {
            throw new Error('DBCluster Db entered status failed');
          },
        })
      ),
      'Seed',
      'Custom::Seed'
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /^Seed was not invoked: Db \(AWS::RDS::DBCluster\) did not become ready \(custom resource Seed is invoked after it\): DBCluster Db entered status failed/
    );
    expect(isRefusedBeforeApplying(error, 'Seed')).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('masks a secret-derived upstream name in the custom resource error (S1)', async () => {
    // The cluster's identifier came from a secret: its wait's failure names it.
    const dbSecrets: RecordedSecretValues = new Map();
    dbSecrets.set('prod-billing-db-x7', '{{resolve:ssm:/db/name}}');
    recordResolvedPair(dbSecrets, '{{resolve:ssm:/db/name}}', 'prod-billing-db-x7');
    const error = await awaitUpstreamDeferredReadiness(
      runWith(
        readinessWith({
          Db: async () => {
            throw new Error('Timed out waiting for DBCluster prod-billing-db-x7 to become available');
          },
        }),
        new Map([['Db', dbSecrets]])
      ),
      'Seed',
      'Custom::Seed'
    ).catch((e: unknown) => e);
    expect((error as Error).message).toContain('Seed was not invoked');
    expect((error as Error).message).not.toContain('prod-billing-db-x7');
  });
});
