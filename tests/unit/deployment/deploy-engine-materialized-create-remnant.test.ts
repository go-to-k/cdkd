import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, CreateContext } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import type {
  DeploymentEvent,
  DeploymentEventRecorder,
} from '../../../src/types/deployment-events.js';

/**
 * A CREATE that fails AFTER AWS has already materialized its resource must not
 * lose it (issue [#2169](https://github.com/go-to-k/cdkd/issues/2169)).
 *
 * The reported case is `AWS::CertificateManager::Certificate`:
 * `RequestCertificate` returns an ARN immediately and the ISSUED wait that
 * follows it reliably times out for a DNS-validated certificate whose
 * validation records are not live yet. The certificate existed in AWS with
 * nothing naming it — absent from state, so invisible to `cdkd state show`,
 * unreachable by `cdkd destroy`, and re-requested from scratch by the next
 * `cdkd deploy`.
 *
 * The provider-side half is fenced in
 * `tests/unit/provisioning/acm-certificate-provider.test.ts`. This file fences
 * the engine half: what {@link CreateContext.reportMaterialized} does, and —
 * just as load-bearing — the three cases where it must do NOTHING.
 */

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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolveDynamicReferences: vi.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const STACK = 'materialized-remnant-test';
const REGION = 'us-east-1';
const CERT_TYPE = 'AWS::CertificateManager::Certificate';
const ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/abc123';

/**
 * What the provider under test does with its create context. `report` is the
 * physical id it claims AWS materialized (none when undefined); `outcome`
 * decides whether the create then throws.
 */
interface CertBehaviour {
  report?: string;
  outcome: 'throw' | 'succeed';
  /** Only read when `outcome` is `'succeed'`. */
  returns?: string;
}

function makeCreate(logicalId: string, resourceType: string): ResourceChange {
  return {
    logicalId,
    changeType: 'CREATE',
    resourceType,
    desiredProperties: { DomainName: 'example.com' },
    propertyChanges: [],
  } as unknown as ResourceChange;
}

const template: CloudFormationTemplate = {
  Resources: {
    Zone: { Type: 'AWS::Route53::HostedZone', Properties: {} },
    Cert: {
      Type: CERT_TYPE,
      Properties: { DomainName: 'example.com' },
      DependsOn: ['Zone'],
      DeletionPolicy: 'Retain',
    },
  },
} as unknown as CloudFormationTemplate;

class CollectingRecorder implements DeploymentEventRecorder {
  events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
  record(event: Omit<DeploymentEvent, 'timestamp'>): void {
    this.events.push(event);
  }
}

function buildEngine(behaviour: CertBehaviour, preExisting?: StackState['resources']) {
  const recorder = new CollectingRecorder();
  const provider = {
    create: vi
      .fn()
      .mockImplementation(
        (
          logicalId: string,
          _resourceType: string,
          _properties: Record<string, unknown>,
          context?: CreateContext
        ) => {
          if (logicalId !== 'Cert') {
            return Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} });
          }
          if (behaviour.report) {
            context?.reportMaterialized?.(behaviour.report, {
              Arn: behaviour.report,
              CertificateArn: behaviour.report,
            });
          }
          return behaviour.outcome === 'throw'
            ? Promise.reject(new Error('did not reach ISSUED status within 600s'))
            : Promise.resolve({
                physicalId: behaviour.returns ?? behaviour.report ?? ARN,
                attributes: { Arn: behaviour.returns ?? ARN },
              });
        }
      ),
    update: vi.fn().mockResolvedValue({ physicalId: ARN, wasReplaced: false }),
    delete: vi.fn().mockResolvedValue(undefined),
  };

  const currentState: StackState = {
    version: 8,
    stackName: STACK,
    region: REGION,
    resources: preExisting ?? {},
    outputs: {},
    lastModified: Date.now(),
  };

  const saveState = vi.fn().mockResolvedValue('etag-1');
  const stateBackend = {
    getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'e0' }),
    saveState,
    appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    loadRollbackJournal: vi.fn().mockResolvedValue(null),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
  };

  const changes = new Map([
    ['Zone', makeCreate('Zone', 'AWS::Route53::HostedZone')],
    ['Cert', makeCreate('Cert', CERT_TYPE)],
  ]);

  const engine = new DeployEngine(
    stateBackend as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Zone', 'Cert']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as never,
    {
      calculateDiff: vi.fn().mockResolvedValue(changes),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((c: Map<string, ResourceChange>, type: string) =>
          [...c.values()].filter((x) => x.changeType === type)
        ),
    } as never,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    {
      concurrency: 4,
      roleArn: 'arn:aws:iam::1:role/r',
      noRollback: true,
      eventRecorder: recorder,
    },
    REGION
  );
  return { engine, provider, saveState, recorder };
}

/** Every state this deploy persisted, oldest first. */
function savedStates(saveState: ReturnType<typeof vi.fn>): StackState[] {
  return saveState.mock.calls.map((c) => c[2] as StackState);
}

/** The record for `Cert` in the LAST state persisted. */
function finalCertRecord(saveState: ReturnType<typeof vi.fn>) {
  const states = savedStates(saveState);
  expect(states.length).toBeGreaterThan(0);
  return states[states.length - 1]!.resources['Cert'];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a CREATE that fails after materializing its resource (issue #2169)', () => {
  it('records the reported resource in state, so the failed deploy still names it', async () => {
    const { engine, saveState } = buildEngine({ report: ARN, outcome: 'throw' });

    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Failed to create resource Cert/);

    const record = finalCertRecord(saveState);
    expect(record?.physicalId).toBe(ARN);
    expect(record?.resourceType).toBe(CERT_TYPE);
  });

  it('records a COMPLETE resource, not a bare id', async () => {
    const { engine, saveState } = buildEngine({ report: ARN, outcome: 'throw' });

    await expect(engine.deploy(STACK, template)).rejects.toThrow();

    const record = finalCertRecord(saveState);
    // The attributes the provider reported alongside the id: without them a
    // later `Fn::GetAtt` against the adopted record has nothing to read.
    expect(record?.attributes).toEqual({ Arn: ARN, CertificateArn: ARN });
    // The properties the create attempted, so the next deploy can diff against
    // something rather than treating every field as changed.
    expect(record?.properties).toEqual({ DomainName: 'example.com' });
    // Template-derived fields. `dependencies` is what makes `cdkd destroy`
    // delete this resource BEFORE the hosted zone it needs; `deletionPolicy`
    // is what makes destroy honour the user's Retain. A record carrying only
    // the id would silently drop both.
    expect(record?.dependencies).toEqual(['Zone']);
    expect(record?.deletionPolicy).toBe('Retain');
    // The routing layer, so a later update / delete uses the same one.
    expect(record?.provisionedBy).toBe('sdk');
  });

  it('does not invent a record when the provider reported nothing', async () => {
    // The polarity twin: a create that failed BEFORE AWS produced an id has
    // nothing to record, and inventing one would make `cdkd destroy` chase a
    // resource that does not exist.
    const { engine, saveState } = buildEngine({ outcome: 'throw' });

    await expect(engine.deploy(STACK, template)).rejects.toThrow();

    expect(finalCertRecord(saveState)).toBeUndefined();
    // The sibling that DID succeed is still persisted — the failure path did
    // not stop recording what worked.
    const states = savedStates(saveState);
    expect(states[states.length - 1]!.resources['Zone']?.physicalId).toBe('phys-Zone');
  });

  it('lets the create RESULT win when the create succeeds', async () => {
    // A report is an in-flight claim, not a result. If the create goes on to
    // return, the returned id is authoritative — a retry that materialized a
    // second resource must not leave the FIRST attempt's id on the record.
    const { engine, saveState } = buildEngine({
      report: 'arn:aws:acm:us-east-1:123456789012:certificate/first-attempt',
      outcome: 'succeed',
      returns: ARN,
    });

    await engine.deploy(STACK, template);

    expect(finalCertRecord(saveState)?.physicalId).toBe(ARN);
  });

  it('names the resource on the RESOURCE_FAILED event, so a post-mortem can find it', async () => {
    // `cdkd events` is the durable record of what a run did. A failed CREATE
    // used to be the one per-resource event that could never carry a physical
    // id, which is precisely the row a reader consults to find what was left
    // behind.
    const { engine, recorder } = buildEngine({ report: ARN, outcome: 'throw' });

    await expect(engine.deploy(STACK, template)).rejects.toThrow();

    const failed = recorder.events.find(
      (e) => e.eventType === 'RESOURCE_FAILED' && e.logicalId === 'Cert'
    );
    expect(failed?.physicalId).toBe(ARN);
  });

  it('leaves RESOURCE_FAILED without a physical id when there is nothing to name', async () => {
    const { engine, recorder } = buildEngine({ outcome: 'throw' });

    await expect(engine.deploy(STACK, template)).rejects.toThrow();

    const failed = recorder.events.find(
      (e) => e.eventType === 'RESOURCE_FAILED' && e.logicalId === 'Cert'
    );
    expect(failed).toBeDefined();
    expect(failed?.physicalId).toBeUndefined();
  });

  it('never overwrites a record that already points at another resource', async () => {
    // The replacement shape: the logical id already owns a physical resource
    // cdkd manages and must still be able to delete. Overwriting it with the
    // new one would orphan the old certificate — the very failure this fixes,
    // reintroduced from the other side.
    const existing = {
      Cert: {
        physicalId: 'arn:aws:acm:us-east-1:123456789012:certificate/already-managed',
        resourceType: CERT_TYPE,
        properties: { DomainName: 'example.com' },
      },
    };
    const { engine, saveState } = buildEngine({ report: ARN, outcome: 'throw' }, existing);

    await expect(engine.deploy(STACK, template)).rejects.toThrow();

    expect(finalCertRecord(saveState)?.physicalId).toBe(existing.Cert.physicalId);
  });
});
