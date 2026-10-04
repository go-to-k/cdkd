import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Shared debug spy so we can assert on update()'s opening `physical ID` line.
// The provider builds its logger via getLogger().child(...), so the child's
// debug must be the shared spy.
const mockCcSend = vi.fn();
const mockDebug = vi.fn();
const mockWarn = vi.fn();
const mockGetAccountInfo = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCcSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: (...args: unknown[]) => mockGetAccountInfo(...args),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: mockDebug,
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { AccountIdUnavailableError } from '../../../src/utils/error-handler.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const TYPE = 'AWS::Logs::MetricFilter';
const REFERENCE = '{{resolve:secretsmanager:filter-name:SecretString:::}}';

function updatingLine(): string {
  const line = mockDebug.mock.calls
    .map((c) => String(c[0]))
    .find((m) => m.startsWith('Updating resource MyFilter '));
  expect(line).toBeDefined();
  return line as string;
}

describe('CloudControlProvider update() physical-ID debug line (go-to-k/cdkd#3869)', () => {
  beforeEach(() => {
    mockCcSend.mockReset();
    mockDebug.mockReset();
    mockWarn.mockReset();
    mockGetAccountInfo.mockReset();
    mockGetAccountInfo.mockResolvedValue({
      partition: 'aws',
      region: 'us-east-1',
      accountId: '123456789012',
    });
    // The line fires before any AWS call; a rejected send ends the update.
    mockCcSend.mockRejectedValue(new Error('UpdateResource boom (log already fired)'));
  });

  it('withholds an identifier whose name the record keeps as a {{resolve: reference (a rotated secret the masker never resolved)', async () => {
    // The PRE-rotation name: in the identifier, in no bag this deploy holds.
    const rotatedName = 'old-rotated-filter-name';
    const provider = new CloudControlProvider();
    await provider
      .update(
        'MyFilter',
        `my-log-group|${rotatedName}`,
        TYPE,
        { LogGroupName: 'my-log-group', FilterName: 'new-rotated-filter-name' },
        { LogGroupName: 'my-log-group', FilterName: REFERENCE },
        // No masker: the recorded reference must withhold the id on its own (with
        // one, the desired side's resolved name would withhold it too).
        {}
      )
      .catch(() => undefined);

    const line = updatingLine();
    expect(line).toContain(`physical ID: ${SECRET_MASK}`);
    expect(line).not.toContain(rotatedName);
    expect(mockDebug.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(rotatedName);
  });

  it('withholds the identifier when the record keeps a secret leaf as the mask itself', async () => {
    const provider = new CloudControlProvider();
    await provider
      .update(
        'MyFilter',
        'my-log-group|masked-filter-name',
        TYPE,
        { LogGroupName: 'my-log-group', FilterName: 'masked-filter-name' },
        { LogGroupName: 'my-log-group', FilterName: SECRET_MASK }
      )
      .catch(() => undefined);

    const line = updatingLine();
    expect(line).toContain(`physical ID: ${SECRET_MASK}`);
    expect(line).not.toContain('masked-filter-name');
  });

  // A rollback revert hands update() RESOLVED bags (`resolveReplayProps`), so
  // no `{{resolve:` survives in either: the evidence is the CURRENT secret,
  // which the masker knows, while the id still carries the rotated-away name.
  it('withholds the identifier on a rollback revert, whose bags are both resolved', async () => {
    const rotatedName = 'old-rotated-filter-name';
    const currentName = 'new-rotated-filter-name';
    const bag: RecordedSecretValues = new Map([[currentName, REFERENCE]]);
    const provider = new CloudControlProvider();
    await provider
      .update(
        'MyFilter',
        `my-log-group|${rotatedName}`,
        TYPE,
        { LogGroupName: 'my-log-group', FilterName: currentName, Pattern: 'WARN' },
        { LogGroupName: 'my-log-group', FilterName: currentName, Pattern: 'ERROR' },
        { maskSecrets: createSecretMasker(bag) }
      )
      .catch(() => undefined);

    const line = updatingLine();
    expect(line).toContain(`physical ID: ${SECRET_MASK}`);
    expect(line).not.toContain(rotatedName);
  });

  // `drift --revert` hands an AWS READBACK as the previous side: it spells the
  // rotated-away name itself, which no masker knows, so only the desired
  // (state-resolved) side carries evidence.
  it('withholds the identifier on drift --revert, whose previous side is an AWS readback', async () => {
    const rotatedName = 'old-rotated-filter-name';
    const currentName = 'new-rotated-filter-name';
    const bag: RecordedSecretValues = new Map([[currentName, REFERENCE]]);
    const provider = new CloudControlProvider();
    await provider
      .update(
        'MyFilter',
        `my-log-group|${rotatedName}`,
        TYPE,
        { LogGroupName: 'my-log-group', FilterName: currentName, Pattern: 'ERROR' },
        { LogGroupName: 'my-log-group', FilterName: rotatedName, Pattern: 'DRIFTED' },
        { maskSecrets: createSecretMasker(bag) }
      )
      .catch(() => undefined);

    const line = updatingLine();
    expect(line).toContain(`physical ID: ${SECRET_MASK}`);
    expect(line).not.toContain(rotatedName);
  });

  it('still routes an identifier through the masker when neither bag carries the secret', async () => {
    const secretGroup = 'secret-log-group-name';
    const provider = new CloudControlProvider();
    await provider
      .update(
        'MyFilter',
        `${secretGroup}|plain-filter`,
        TYPE,
        { FilterName: 'plain-filter', Pattern: 'ERROR' },
        { FilterName: 'plain-filter', Pattern: 'WARN' },
        { maskSecrets: createSecretMasker(new Map([[secretGroup, REFERENCE]])) }
      )
      .catch(() => undefined);

    const line = updatingLine();
    expect(line).toContain(`physical ID: ${SECRET_MASK}|plain-filter`);
    expect(line).not.toContain(secretGroup);
  });

  // State keeps a secret leaf as its reference at whatever depth it sits, so
  // the walk must descend: a top-level-only (or one-level) scan misses it.
  it('withholds the identifier when the recorded reference is NESTED inside a list and an object', async () => {
    const rotatedName = 'old-rotated-filter-name';
    const provider = new CloudControlProvider();
    await provider
      .update(
        'MyFilter',
        `my-log-group|${rotatedName}`,
        TYPE,
        {
          LogGroupName: 'my-log-group',
          MetricTransformations: [{ MetricName: 'new-name', MetricNamespace: 'ns' }],
        },
        {
          LogGroupName: 'my-log-group',
          MetricTransformations: [{ MetricName: { Nested: REFERENCE }, MetricNamespace: 'ns' }],
        },
        {}
      )
      .catch(() => undefined);

    const line = updatingLine();
    expect(line).toContain(`physical ID: ${SECRET_MASK}`);
    expect(line).not.toContain(rotatedName);
  });

  // A resolved secret used as a map KEY renders into the record as a key, not
  // a value, so a values-only walk never sees it.
  it('withholds the identifier when a KEY is secret-derived', async () => {
    const rotatedName = 'old-rotated-filter-name';
    const secretKey = 'secret-dimension-key';
    const bag: RecordedSecretValues = new Map([[secretKey, REFERENCE]]);
    const provider = new CloudControlProvider();
    await provider
      .update(
        'MyFilter',
        `my-log-group|${rotatedName}`,
        TYPE,
        { LogGroupName: 'my-log-group', Dimensions: { [secretKey]: 'value' } },
        { LogGroupName: 'my-log-group', Dimensions: { [secretKey]: 'value' } },
        { maskSecrets: createSecretMasker(bag) }
      )
      .catch(() => undefined);

    const line = updatingLine();
    expect(line).toContain(`physical ID: ${SECRET_MASK}`);
    expect(line).not.toContain(rotatedName);
  });

  it('prints an ordinary identifier unchanged', async () => {
    const provider = new CloudControlProvider();
    await provider
      .update(
        'MyFilter',
        'my-log-group|plain-filter',
        TYPE,
        { LogGroupName: 'my-log-group', FilterName: 'plain-filter', Pattern: 'ERROR' },
        { LogGroupName: 'my-log-group', FilterName: 'plain-filter', Pattern: 'WARN' },
        { maskSecrets: createSecretMasker(new Map([['unrelated-secret', REFERENCE]])) }
      )
      .catch(() => undefined);

    expect(updatingLine()).toBe(
      `Updating resource MyFilter (${TYPE}), physical ID: my-log-group|plain-filter`
    );
  });
});

/**
 * Wire a successful async UPDATE: `resourceModel` is the ProgressEvent's
 * model, `getResource` what each `GetResource` read-back returns (an Error
 * rejects it).
 */
function wireUpdateSuccess(
  identifier: string,
  resourceModel: Record<string, unknown>,
  getResource: Record<string, unknown> | Error
): void {
  mockCcSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'UpdateResourceCommand') {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-update' } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({
        ProgressEvent: {
          OperationStatus: 'SUCCESS',
          Identifier: identifier,
          ResourceModel: JSON.stringify(resourceModel),
        },
      });
    }
    if (name === 'GetResourceCommand') {
      if (getResource instanceof Error) return Promise.reject(getResource);
      return Promise.resolve({
        ResourceDescription: { Identifier: identifier, Properties: JSON.stringify(getResource) },
      });
    }
    return Promise.resolve({});
  });
}

const allDebug = (): string => mockDebug.mock.calls.map((c) => String(c[0])).join('\n');

// The integ found a SECOND line printing the pre-rotation name after the
// opening one was withheld: every update-path line naming the id must go
// through the same withholding.
describe('CloudControlProvider update() read-back and enrichment lines (go-to-k/cdkd#3869)', () => {
  const rotatedName = 'old-rotated-filter-name';

  beforeEach(() => {
    mockCcSend.mockReset();
    mockDebug.mockReset();
    mockWarn.mockReset();
    mockGetAccountInfo.mockReset();
    mockGetAccountInfo.mockResolvedValue({
      partition: 'aws',
      region: 'us-east-1',
      accountId: '123456789012',
    });
  });

  it('withholds the id in the sparse read-back merge line', async () => {
    const id = `my-log-group|${rotatedName}`;
    // A model echoing only identifier parts is sparse, so the read-back runs.
    wireUpdateSuccess(
      id,
      { LogGroupName: 'my-log-group', FilterName: rotatedName },
      { LogGroupName: 'my-log-group', FilterName: rotatedName, FilterPattern: 'ERROR' }
    );
    await new CloudControlProvider().update(
      'MyFilter',
      id,
      TYPE,
      { LogGroupName: 'my-log-group', FilterName: 'new-name', FilterPattern: 'ERROR' },
      { LogGroupName: 'my-log-group', FilterName: REFERENCE, FilterPattern: 'WARN' },
      {}
    );

    const merged = mockDebug.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.startsWith('Merged CC GetResource read-back'));
    expect(merged).toBeDefined();
    expect(merged).toContain(SECRET_MASK);
    expect(allDebug()).not.toContain(rotatedName);
  });

  it('withholds the id in the GetResource failure line', async () => {
    const id = `my-log-group|${rotatedName}`;
    wireUpdateSuccess(
      id,
      {},
      // AWS quotes only ONE identifier part, so the whole-id needle alone misses it.
      new Error(`ResourceNotFound: filter ${rotatedName} does not exist`)
    );
    await new CloudControlProvider().update(
      'MyFilter',
      id,
      TYPE,
      { LogGroupName: 'my-log-group', FilterName: 'new-name', FilterPattern: 'ERROR' },
      { LogGroupName: 'my-log-group', FilterName: REFERENCE, FilterPattern: 'WARN' },
      {}
    );

    const failed = mockDebug.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.startsWith('Failed to read CC model'));
    expect(failed).toBeDefined();
    // The AWS echo of one PART is scrubbed too, not only cdkd's interpolation.
    expect(allDebug()).not.toContain(rotatedName);
  });

  it('withholds the id, and an ARN built from it, in an enrichment line', async () => {
    const pipeName = 'old-rotated-pipe-name';
    const arn = `arn:aws:pipes:us-east-1:123456789012:pipe/${pipeName}`;
    // Not sparse (CurrentState is no id echo), so the merge skips and the
    // Pipes enrichment reads the Arn itself.
    wireUpdateSuccess(pipeName, { Name: pipeName, CurrentState: 'RUNNING' }, { Arn: arn });
    await new CloudControlProvider().update(
      'MyPipe',
      pipeName,
      'AWS::Pipes::Pipe',
      { Name: 'new-pipe-name', Description: 'new' },
      { Name: REFERENCE, Description: 'old' },
      {}
    );

    const enriched = mockDebug.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.startsWith('Enriched Pipes Pipe'));
    expect(enriched).toBeDefined();
    expect(enriched).toContain(SECRET_MASK);
    expect(allDebug()).not.toContain(pipeName);
  });

  it('withholds the id in the account-lookup WARN, which prints at default verbosity', async () => {
    const repoName = 'old-rotated-repo-name';
    mockGetAccountInfo.mockRejectedValue(new AccountIdUnavailableError('STS refused.'));
    // Not sparse, so only the ECR enrichment runs (and needs the account).
    wireUpdateSuccess(repoName, { RepositoryName: repoName, ImageTagMutability: 'MUTABLE' }, {});
    await new CloudControlProvider().update(
      'MyRepo',
      repoName,
      'AWS::ECR::Repository',
      { RepositoryName: 'new-repo-name', ImageTagMutability: 'IMMUTABLE' },
      { RepositoryName: REFERENCE, ImageTagMutability: 'MUTABLE' },
      {}
    );

    const warned = mockWarn.mock.calls.map((c) => String(c[0]));
    const line = warned.find((m) => m.startsWith('Not enriching AWS::ECR::Repository'));
    expect(line).toBeDefined();
    expect(line).toContain(SECRET_MASK);
    expect(warned.join('\n')).not.toContain(repoName);
  });

  it('masks a current secret BEFORE scrubbing id parts, so a part inside it cannot split it', async () => {
    const part = 'abcd-part';
    const id = `my-log-group|${part}`;
    // The current secret CONTAINS an id part. Scrubbing first would turn it
    // into `zz-***-zz`, which the masker no longer recognises.
    const secret = `zz-${part}-zz`;
    wireUpdateSuccess(id, {}, new Error(`ValidationException: ${secret} is invalid`));
    await new CloudControlProvider().update(
      'MyFilter',
      id,
      TYPE,
      { LogGroupName: 'my-log-group', FilterName: secret, FilterPattern: 'ERROR' },
      { LogGroupName: 'my-log-group', FilterName: secret, FilterPattern: 'WARN' },
      { maskSecrets: createSecretMasker(new Map([[secret, REFERENCE]])) }
    );

    const failed = mockDebug.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.startsWith('Failed to read CC model'));
    expect(failed).toBeDefined();
    expect(failed).not.toContain('zz-');
    expect(failed).not.toContain('-zz');
  });

  it('does not garble a line when the identifier is empty', async () => {
    await new CloudControlProvider()
      .update(
        'MyFilter',
        '',
        TYPE,
        { LogGroupName: 'my-log-group', FilterName: 'new-name' },
        { LogGroupName: 'my-log-group', FilterName: REFERENCE },
        {}
      )
      .catch(() => undefined);

    expect(updatingLine()).toBe(`Updating resource MyFilter (${TYPE}), physical ID: `);
  });

  it('withholds the remainder of an id part a current secret only partly covers', async () => {
    // The masker runs first and rewrites `prod-old-filter` to `***-old-filter`,
    // so the raw part needle no longer matches; its masked spelling must.
    const id = 'my-log-group|prod-old-filter';
    await new CloudControlProvider()
      .update(
        'MyFilter',
        id,
        TYPE,
        { LogGroupName: 'my-log-group', FilterName: 'prod-new-filter' },
        { LogGroupName: 'my-log-group', FilterName: REFERENCE },
        { maskSecrets: createSecretMasker(new Map([['prod', REFERENCE]])) }
      )
      .catch(() => undefined);

    expect(updatingLine()).toContain(`physical ID: ${SECRET_MASK}`);
    expect(allDebug()).not.toContain('old-filter');
  });

  it('scrubs a longer id part before a shorter one it contains', async () => {
    // Parts `ab-c` and `ab`: scrubbing `ab` first would leave `***-c`. The
    // AWS error names only the longer part.
    wireUpdateSuccess('ab|ab-c', {}, new Error('ResourceNotFound: filter ab-c is gone'));
    await new CloudControlProvider().update(
      'MyFilter',
      'ab|ab-c',
      TYPE,
      { LogGroupName: 'ab', FilterName: 'new-name', FilterPattern: 'ERROR' },
      { LogGroupName: 'ab', FilterName: REFERENCE, FilterPattern: 'WARN' },
      {}
    );

    const failed = mockDebug.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.startsWith('Failed to read CC model'));
    expect(failed).toBeDefined();
    expect(failed).not.toContain('-c');
  });

  /** Wire an UPDATE whose ProgressEvent model is the unparseable `model`. */
  function wireUnparseableModel(id: string, model: string): void {
    mockCcSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'UpdateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-update' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({
          ProgressEvent: { OperationStatus: 'SUCCESS', Identifier: id, ResourceModel: model },
        });
      }
      if (name === 'GetResourceCommand') {
        return Promise.resolve({ ResourceDescription: { Identifier: id, Properties: '{}' } });
      }
      return Promise.resolve({});
    });
  }

  const parseDetail = (): string | undefined =>
    mockDebug.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.startsWith('Resource model parse failure detail'));

  // V8 echoes about ten characters of a model it cannot parse, TRUNCATED: a
  // longer name surfaces as a prefix no needle matches, so the detail line is
  // dropped whole while the id is withheld.
  it('drops the model-parse detail, whose echo is a truncated prefix of the name, while the id is withheld', async () => {
    const id = `my-log-group|${rotatedName}`;
    wireUnparseableModel(id, rotatedName);
    await new CloudControlProvider().update(
      'MyFilter',
      id,
      TYPE,
      { LogGroupName: 'my-log-group', FilterName: 'new-name', FilterPattern: 'ERROR' },
      { LogGroupName: 'my-log-group', FilterName: REFERENCE, FilterPattern: 'WARN' },
      {}
    );

    expect(parseDetail()).toBeUndefined();
    const warned = mockWarn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('Failed to parse resource model');
    expect(allDebug()).not.toContain(rotatedName.slice(0, 10));
    expect(warned).not.toContain(rotatedName.slice(0, 10));
  });

  it('keeps the model-parse detail for an ordinary update', async () => {
    const id = 'my-log-group|plain-filter';
    wireUnparseableModel(id, 'not-json-model');
    await new CloudControlProvider().update(
      'MyFilter',
      id,
      TYPE,
      { LogGroupName: 'my-log-group', FilterName: 'plain-filter', FilterPattern: 'ERROR' },
      { LogGroupName: 'my-log-group', FilterName: 'plain-filter', FilterPattern: 'WARN' },
      {}
    );

    expect(parseDetail()).toBeDefined();
  });

  it('leaves the read-back line alone for an ordinary update', async () => {
    const id = 'my-log-group|plain-filter';
    wireUpdateSuccess(
      id,
      { LogGroupName: 'my-log-group', FilterName: 'plain-filter' },
      { LogGroupName: 'my-log-group', FilterName: 'plain-filter', FilterPattern: 'ERROR' }
    );
    await new CloudControlProvider().update(
      'MyFilter',
      id,
      TYPE,
      { LogGroupName: 'my-log-group', FilterName: 'plain-filter', FilterPattern: 'ERROR' },
      { LogGroupName: 'my-log-group', FilterName: 'plain-filter', FilterPattern: 'WARN' },
      {}
    );

    expect(allDebug()).toContain(
      `Merged CC GetResource read-back over sparse ${TYPE} attributes for ${id}`
    );
  });
});
