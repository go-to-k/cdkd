import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import {
  OUT_JSON,
  OUT_MD,
  asyncEvidence,
  buildPopulation,
  checkClassification,
  collectOutOfScopeAsyncSends,
  repoRoot,
  isTransitionalValue,
  renderJson,
  renderMarkdown,
  unitCalls,
  unitCallsInFile,
  unitPollsInline,
  type PopulationRow,
} from '../../../scripts/gen-async-operation-waits.ts';
import { ASYNC_OPERATION_CLASSIFICATION } from '../../../src/provisioning/async-operation-waits.js';

/**
 * go-to-k/cdkd#7132: every provider call the SDK model marks asynchronous has a
 * verdict on whether the provider waits for it, and a `waits` verdict names a
 * helper the provider still references.
 */

const population = buildPopulation();
const FIREHOSE_ROOT_ONLY = 'src/provisioning/providers/firehose-provider.ts';

/**
 * The `unmeasured` rows as of the #7132 audit. The set may only SHRINK: a row
 * leaves when its CloudFormation A/B lands (a wait, or a measured
 * `no-wait-by-design`). A NEW asynchronous operation must arrive classified
 * `waits` or `no-wait-by-design` with evidence; `unmeasured` would let it
 * pass forever.
 */
const FROZEN_UNMEASURED: ReadonlySet<string> = new Set([
  'bedrock-agentcore-control:CreateEvaluator',
  'bedrock-agentcore-control:DeleteAgentRuntime',
  'bedrock-agentcore-control:DeleteEvaluator',
  'bedrock-agentcore-control:UpdateEvaluator',
  'codebuild:CreateWebhook',
  'codebuild:UpdateWebhook',
  'rds:ModifyDBProxyTargetGroup',
  'rds:RegisterDBProxyTargets',
]);

/**
 * Asynchronous sends under `src/provisioning/**` outside `providers/`, which
 * the population does not read. Cloud Control is cdkd's own poller
 * (`ProgressEvent` polling to a terminal `OperationStatus`); the final-snapshot
 * calls wait in their own modules. A new site here is a decision: classify it
 * by moving it under a provider, or add it to this list with its reason.
 */
const OUT_OF_SCOPE_SEND_SITES: readonly string[] = [
  'src/provisioning/cloud-control/create.ts cloudcontrol:CreateResource',
  'src/provisioning/cloud-control/delete.ts cloudcontrol:DeleteResource',
  // #7125's location role switch, through the same `waitForOperation` poll.
  'src/provisioning/cloud-control/lakeformation-role-switch.ts cloudcontrol:CreateResource',
  'src/provisioning/cloud-control/lakeformation-role-switch.ts cloudcontrol:DeleteResource',
  'src/provisioning/cloud-control/protection.ts cloudcontrol:UpdateResource',
  'src/provisioning/cloud-control/update.ts cloudcontrol:UpdateResource',
  'src/provisioning/final-snapshot/ebs.ts ec2:CreateSnapshot',
  'src/provisioning/final-snapshot/pre-delete.ts elasticache:CreateSnapshot',
  'src/provisioning/final-snapshot/pre-delete.ts redshift:CreateClusterSnapshot',
];

/**
 * Types in docs/cli-deploy.md's wait table whose waited-for operation the SDK
 * model walk cannot see (its output carries no status), each with why.
 */
const DOC_TYPES_OUTSIDE_POPULATION: Readonly<Record<string, string>> = {
  // RequestCertificate answers only the ARN; ISSUED is read with DescribeCertificate.
  'AWS::CertificateManager::Certificate': 'RequestCertificate output has no status',
  // CreateInstance answers Id / Arn; ACTIVE is read with DescribeInstance.
  'AWS::Connect::Instance': 'CreateInstance output has no status',
  // The CodeDeploy wait is the deploy engine's update-policy path, not a provider's.
  'AWS::Lambda::Alias': 'no SDK provider: the CodeDeploy wait lives in the update-policy path',
};

describe('the committed classification (#7132)', () => {
  it('classifies every asynchronous operation, with no stale row and no lost helper', () => {
    expect(checkClassification(population)).toEqual({
      unclassified: [],
      stale: [],
      missingHelper: [],
    });
  });

  it('keeps the generated files current', () => {
    expect(readFileSync(OUT_JSON, 'utf8')).toBe(renderJson(population));
    expect(readFileSync(OUT_MD, 'utf8')).toBe(renderMarkdown(population));
  });

  it('gives every unmeasured and no-wait row a reason, and every waits row a helper', () => {
    for (const [key, v] of Object.entries(ASYNC_OPERATION_CLASSIFICATION)) {
      if (v.verdict === 'waits') {
        expect(v.helpers.length, key).toBeGreaterThan(0);
        for (const h of v.helpers) expect(h, key).toMatch(/^[A-Za-z_$][\w$]*$/);
      }
      else expect(v.reason.trim(), key).not.toBe('');
    }
  });
});

describe('the frozen unmeasured set (#7132)', () => {
  it('admits no NEW unmeasured row', () => {
    const added = Object.entries(ASYNC_OPERATION_CLASSIFICATION)
      .filter(([k, v]) => v.verdict === 'unmeasured' && !FROZEN_UNMEASURED.has(k))
      .map(([k]) => k);
    expect(
      added,
      'A new asynchronous operation must be classified waits or no-wait-by-design with ' +
        'evidence, not unmeasured: measure it against CloudFormation first (#7132).'
    ).toEqual([]);
  });

  it('only shrinks: a frozen key that is no longer unmeasured leaves the set', () => {
    const left = [...FROZEN_UNMEASURED].filter(
      (k) => ASYNC_OPERATION_CLASSIFICATION[k]?.verdict !== 'unmeasured'
    );
    expect(left, 'Delete these keys from FROZEN_UNMEASURED (#7132).').toEqual([]);
  });
});

describe('the out-of-scope send sites', () => {
  it('names every asynchronous send outside providers/', () => {
    expect(collectOutOfScopeAsyncSends()).toEqual([...OUT_OF_SCOPE_SEND_SITES].sort());
  });
});

describe('docs/cli-deploy.md wait table (#7132 step 4)', () => {
  const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');
  const doc = read('docs/cli-deploy.md');
  const section = doc.slice(doc.indexOf('## Wait behaviour by resource type'));
  const table = section.slice(0, section.indexOf('\n\n', section.indexOf('| Resource type')));
  const docTypes = table
    .split('\n')
    .filter((l) => l.startsWith('| `AWS::'))
    .flatMap((l) => {
      const cell = l.split(' | ')[0]!;
      const full = [...cell.matchAll(/`(AWS::[A-Za-z0-9]+)::([A-Za-z0-9]+)`/g)];
      const service = full[0]![1]!;
      const short = [...cell.matchAll(/ \/ `([A-Za-z0-9]+)`/g)].map((m) => `${service}::${m[1]}`);
      return [...full.map((m) => `${m[1]}::${m[2]}`), ...short];
    });

  // type -> provider file, from register-providers.ts + provider-classes.ts.
  const register = read('src/provisioning/register-providers.ts');
  const classes = read('src/provisioning/provider-classes.ts');
  const variables = new Map(
    [...register.matchAll(/const (\w+) = new (\w+)\(/g)].map((m) => [m[1]!, m[2]!])
  );
  const fileOf = new Map(
    [...classes.matchAll(/export \{ (\w+) \} from '\.\/(providers\/[\w-]+)\.js'/g)].map((m) => [
      m[1]!,
      `src/provisioning/${m[2]}.ts`,
    ])
  );
  const providerFileOf = (type: string): string | undefined => {
    const m = new RegExp(`register\\('${type}', (?:new (\\w+)\\(\\)|(\\w+))\\)`).exec(register);
    const cls = m?.[1] ?? (m?.[2] ? variables.get(m[2]) : undefined);
    return cls ? fileOf.get(cls) : undefined;
  };

  it('parses every row of the table', () => {
    expect(docTypes.length).toBeGreaterThanOrEqual(17);
  });

  it('gives every type the table says waits a decided row in the generated table', () => {
    const decided = new Set(
      population
        .filter((r) => ASYNC_OPERATION_CLASSIFICATION[r.key]?.verdict !== 'unmeasured')
        .flatMap((r) => r.units)
    );
    const missing = docTypes
      .filter((t) => !(t in DOC_TYPES_OUTSIDE_POPULATION))
      .filter((t) => {
        const file = providerFileOf(t);
        return file === undefined || !decided.has(file);
      });
    expect(missing).toEqual([]);
  });

  it('keeps the outside-population list to types the table still names', () => {
    expect(Object.keys(DOC_TYPES_OUTSIDE_POPULATION).filter((t) => !docTypes.includes(t))).toEqual(
      []
    );
  });
});

describe('the population rules', () => {
  const keys = new Set(population.map((r) => r.key));

  it('finds the three instances found by hand, each by its own signal', () => {
    // #7127: a Start* operation whose output status enum carries PROCESSING.
    expect(asyncEvidence('appsync', 'StartSchemaCreation').map((e) => e.signal)).toEqual([
      'start-operation',
      'transitional-enum',
    ]);
    // #6778: a toggle whose output enum carries ENABLING.
    expect(asyncEvidence('dynamodb', 'UpdateContributorInsights')).toEqual([
      {
        signal: 'transitional-enum',
        detail: 'ContributorInsightsStatus: ContributorInsightsStatus (DISABLING, ENABLING)',
      },
    ]);
    // #5737: the SDK models the mapping's State as a plain string.
    expect(asyncEvidence('lambda', 'CreateEventSourceMapping')).toEqual([
      { signal: 'state-string', detail: 'State: string' },
    ]);
    for (const k of [
      'appsync:StartSchemaCreation',
      'dynamodb:UpdateContributorInsights',
      'lambda:CreateEventSourceMapping',
    ]) {
      expect(keys.has(k), k).toBe(true);
    }
  });

  it('leaves read operations out: they start nothing', () => {
    expect([...keys].filter((k) => /:(Describe|Get|List)[A-Z]/.test(k))).toEqual([]);
  });

  it('reads a transitional value case- and separator-insensitively, and not a steady -ING word', () => {
    for (const v of [
      'CREATING',
      'Creating',
      'pending',
      'PENDING_ACCEPTANCE',
      'IN_PROGRESS',
      'InProgress',
      'CREATE_IN_PROGRESS',
      'PROCESSING',
    ]) {
      expect(isTransitionalValue(v), v).toBe(true);
    }
    for (const v of [
      'ACTIVE',
      'STRING',
      'SINGLE_STRING',
      'Throttling',
      'INTELLIGENT_TIERING',
      'internet-facing',
      'RUNNING',
      'FAILED',
    ]) {
      expect(isTransitionalValue(v), v).toBe(false);
    }
  });
});

describe('the critic', () => {
  const row = (key: string, unit: string): PopulationRow => {
    const [client, operation] = key.split(':') as [string, string];
    return { key, client, operation, evidence: [], files: [unit], units: [unit] };
  };
  const unit = 'src/provisioning/providers/dynamodb-table-provider.ts';

  it('fails an unclassified operation and a row no provider sends', () => {
    expect(
      checkClassification([row('x:StartThing', unit)], {
        'x:Gone': { verdict: 'unmeasured', reason: 'r' },
      })
    ).toEqual({ unclassified: ['x:StartThing'], stale: ['x:Gone'], missingHelper: [] });
  });

  it('fails a waits row whose helper the provider unit no longer calls', () => {
    const findings = checkClassification([row('x:StartThing', unit)], {
      'x:StartThing': { verdict: 'waits', helpers: ['noSuchWaitHelperAnywhere'], failureStatuses: [] },
    });
    expect(findings.missingHelper).toEqual([
      `x:StartThing: ${unit} calls none of noSuchWaitHelperAnywhere`,
      'x:StartThing: no sending provider calls noSuchWaitHelperAnywhere',
    ]);
  });

  it('fails a waits row listing a helper no sending unit calls, beside one that is', () => {
    const findings = checkClassification([row('x:StartThing', unit)], {
      'x:StartThing': {
        verdict: 'waits',
        helpers: ['applyIndexUpdates', 'noSuchWaitHelperAnywhere'],
        failureStatuses: [],
      },
    });
    expect(findings.missingHelper).toEqual([
      'x:StartThing: no sending provider calls noSuchWaitHelperAnywhere',
    ]);
  });

  it('does not count a declaration, an import or a self-delegation as a call', () => {
    // firehose-provider.ts imports `waitForEncryption`, declares a member of
    // that name, and delegates `return waitForEncryption.call(this, ...)`
    // from it; nothing in the file calls it otherwise.
    expect(unitCallsInFile(FIREHOSE_ROOT_ONLY, 'waitForEncryption')).toBe(false);
    // ...while its companion calls the member after StartDeliveryStreamEncryption.
    expect(unitCalls(FIREHOSE_ROOT_ONLY, 'waitForEncryption')).toBe(true);
  });

  it('accepts an inline poll only in the same function as the send', () => {
    const unit = 'src/provisioning/providers/rds-dbproxy-provider.ts';
    expect(unitPollsInline(unit, 'CreateDBProxy', 'DescribeDBProxiesCommand')).toBe(true);
    expect(unitPollsInline(unit, 'DeleteDBProxy', 'DescribeDBProxiesCommand')).toBe(false);
  });

  it('accepts a helper referenced only from a companion file of the unit', () => {
    const findings = checkClassification([row('x:StartThing', unit)], {
      // Defined and called in providers/dynamodb-table/** only, never named in the root file.
      'x:StartThing': {
        verdict: 'waits',
        helpers: ['applyIndexUpdates'],
        failureStatuses: [],
      },
    });
    expect(findings.missingHelper).toEqual([]);
  });
});
