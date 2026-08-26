/**
 * Discrimination tests for the real-AWS network fence installed by
 * `tests/setup.ts` (issue #2081).
 *
 * The fence exists because a provider that constructs its own SDK client
 * escapes a `getAwsClients` mock and transacts with real AWS from a unit test.
 * These tests must prove BOTH directions:
 *
 *   - it fires on a real SDK client's outbound call, on a provider that
 *     self-constructs its client, on a raw AWS-bound socket, and on every
 *     link-local credential endpoint; and
 *   - it does NOT fire on ordinary local traffic, so a fence that refused every
 *     outbound connection could not pass this file.
 *
 * It must also pin WHICH LAYER refuses. Layer 2 (`net.Socket.prototype.connect`)
 * is reached synchronously from inside the `http.ClientRequest` constructor, so
 * every layer-1 case throws the same marker and the same host with layer 1
 * deleted. The `(via node:https.request())` / `(via node:http.request())`
 * assertions below are the only thing that reddens when layer 1 goes missing.
 *
 * Every test that expects a refusal calls `expectAwsFenceViolation()` first.
 * That is the setup file's per-test opt-out from its own `afterEach` reporter,
 * which otherwise fails any test that reached AWS — the reporter is what makes
 * an escape visible to the 142 `tests/unit/**` assertions written as a bare
 * `rejects.toThrow()`, all of which the refusal itself would satisfy.
 *
 * The one deliberate exception is the "REPORTER itself" block near the bottom.
 * Its two arms are the ones the reporter cannot show in-band — "armed but never
 * tripped" and "an unarmed violation" — since each would fail the very test
 * asserting on it. They drive the setup file's exported audit seams instead
 * (`drainAwsFenceViolations` / `drainAwsFenceExpectation` /
 * `auditAwsFenceViolations`), so the ledger is emptied before the `afterEach`
 * that would otherwise redden them.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo, LookupFunction } from 'node:net';

import { ListHostedZonesCommand, Route53Client } from '@aws-sdk/client-route-53';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';

import {
  auditAwsFenceViolations,
  drainAwsFenceExpectation,
  drainAwsFenceViolations,
  expectAwsFenceViolation,
} from '../setup.js';

const FENCE_MARKER = '[cdkd unit-test AWS fence]';

/** Explicit dummy credentials: proves the fence is at the NETWORK layer, not the credential layer. */
const DUMMY_CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

/**
 * The hole issue #2081 reported, reproduced against a REAL provider:
 * `BudgetsBudgetProvider` resolves the account id through
 * `getAwsClients().sts` — which this mock does isolate — and then sends
 * `DescribeBudget` through a `BudgetsClient` it constructs ITSELF, which the
 * mock cannot reach.
 */
const mockStsSend = vi.hoisted(() => vi.fn());
vi.mock('../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: mockStsSend } }),
}));

import { BudgetsBudgetProvider } from '../../src/provisioning/providers/budgets-budget-provider.js';

/** Collect `message` down an error's `cause` chain (undici and the SDK both wrap). */
const messageChain = (error: unknown): string => {
  const messages: string[] = [];
  for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    messages.push(e.message);
  }
  return messages.join('\n');
};

/**
 * Run a request the fence must LET THROUGH, and dispose of the live
 * `ClientRequest` it returns.
 *
 * Every non-refused row points at 127.0.0.1 / localhost on port 1, where
 * nothing listens: the connection fails asynchronously, so without an 'error'
 * listener the rejection surfaces against whichever test happens to be running.
 */
const expectNoFence = (call: () => http.ClientRequest, why?: string): void => {
  let request: http.ClientRequest | undefined;
  expect(() => {
    request = call();
  }, why).not.toThrow();
  request?.on('error', () => {});
  request?.destroy();
};

describe('AWS network fence — fires on real AWS traffic', () => {
  it('refuses an outbound call from a genuinely-constructed AWS SDK client', async () => {
    expectAwsFenceViolation();
    const client = new Route53Client({
      region: 'us-east-1',
      credentials: DUMMY_CREDENTIALS,
      maxAttempts: 1,
    });

    await expect(client.send(new ListHostedZonesCommand({}))).rejects.toThrow(
      /\[cdkd unit-test AWS fence\]/
    );

    await expect(client.send(new ListHostedZonesCommand({}))).rejects.toThrow(/amazonaws\.com/);
  });

  it('names the host and the concrete vi.mock remedy in the message', async () => {
    expectAwsFenceViolation();
    const client = new Route53Client({
      region: 'us-east-1',
      credentials: DUMMY_CREDENTIALS,
      maxAttempts: 1,
    });

    const error = await client.send(new ListHostedZonesCommand({})).catch((e: unknown) => e);
    const message = (error as Error).message;

    expect(message).toContain(FENCE_MARKER);
    expect(message).toContain('route53.amazonaws.com');
    expect(message).toContain("vi.mock('@aws-sdk/client-route-53'");
    expect(message).toContain("'src/utils/aws-clients.js' does NOT isolate");
  });

  it('fires through a provider that self-constructs its client while only getAwsClients is mocked', async () => {
    expectAwsFenceViolation();
    mockStsSend.mockResolvedValue({ Account: '123456789012' });

    const saved = {
      region: process.env['AWS_REGION'],
      accessKeyId: process.env['AWS_ACCESS_KEY_ID'],
      secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'],
      sessionToken: process.env['AWS_SESSION_TOKEN'],
    };
    // Pin credential + region resolution to dummies so the case measures the
    // FENCE and not the runner's ambient AWS config. It still reaches the wire:
    // an env credential resolves without any network of its own.
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_ACCESS_KEY_ID'] = DUMMY_CREDENTIALS.accessKeyId;
    process.env['AWS_SECRET_ACCESS_KEY'] = DUMMY_CREDENTIALS.secretAccessKey;
    delete process.env['AWS_SESSION_TOKEN'];

    try {
      const provider = new BudgetsBudgetProvider();
      const error = await provider
        .getAttribute('cdkd-fence-probe-budget', 'AWS::Budgets::Budget', 'Arn')
        .catch((e: unknown) => e);

      // The `getAwsClients` half WAS isolated — that is exactly why the hole is
      // invisible without this fence.
      expect(mockStsSend).toHaveBeenCalledTimes(1);

      const chain = messageChain(error);
      expect(chain).toContain(FENCE_MARKER);
      expect(chain).toContain('budgets.amazonaws.com');
    } finally {
      for (const [key, value] of [
        ['AWS_REGION', saved.region],
        ['AWS_ACCESS_KEY_ID', saved.accessKeyId],
        ['AWS_SECRET_ACCESS_KEY', saved.secretAccessKey],
        ['AWS_SESSION_TOKEN', saved.sessionToken],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('refuses a direct https.request to an AWS endpoint (layer 1)', () => {
    expectAwsFenceViolation();
    expect(() => https.request('https://sqs.us-east-1.amazonaws.com/')).toThrow(
      /sqs\.us-east-1\.amazonaws\.com/
    );
    expect(() => https.request({ hostname: 'cloudcontrolapi.us-east-1.amazonaws.com' })).toThrow(
      FENCE_MARKER
    );
    // China partition + the newer *.api.aws suffix.
    expect(() => https.request({ host: 's3.cn-north-1.amazonaws.com.cn' })).toThrow(FENCE_MARKER);
    expect(() => https.request({ host: 'bedrock.us-east-1.api.aws' })).toThrow(FENCE_MARKER);
  });

  it('names LAYER 1 as the refusing layer, so deleting layer 1 cannot stay green', () => {
    expectAwsFenceViolation();
    // Layer 2 is reached synchronously from the `http.ClientRequest`
    // constructor and produces the same marker and the same host, so the LABEL
    // is the only discriminator between the two layers.
    expect(() => https.request({ hostname: 'sqs.us-east-1.amazonaws.com' })).toThrow(
      '(via node:https.request())'
    );
    expect(() => https.get({ hostname: 'sqs.us-east-1.amazonaws.com' })).toThrow(
      '(via node:https.get())'
    );
    expect(() => http.request({ host: 'sqs.us-east-1.amazonaws.com' })).toThrow(
      '(via node:http.request())'
    );
    expect(() => http.get({ host: 'sqs.us-east-1.amazonaws.com' })).toThrow(
      '(via node:http.get())'
    );
  });

  it('reads the host the way Node does when request(url, options) disagree', () => {
    expectAwsFenceViolation();
    // Node merges the two arguments into one options object and resolves
    // `options.hostname || options.host`. The URL contributes `hostname`, so an
    // options `hostname` overrides it and this connects to AWS despite the URL.
    // Taking the first argument that yields a host would read `127.0.0.1` and
    // wave it through at layer 1.
    expect(() =>
      http.request('http://127.0.0.1/', { hostname: 'sqs.us-east-1.amazonaws.com' })
    ).toThrow('(via node:http.request())');

    // The INVERSE, and the reason a last-writer-wins walk was wrong: an options
    // `host` does NOT beat a URL. Measured on Node 24.15.0 by recording the host
    // handed to `net.Socket.prototype.connect` — this call connects to
    // 127.0.0.1, so refusing it would be a FALSE POSITIVE. This assertion used
    // to read `.toThrow(FENCE_MARKER)` with a comment claiming Node honours
    // `host` here; it does not.
    expectNoFence(() =>
      http.request('http://127.0.0.1:1/', { host: 'sqs.us-east-1.amazonaws.com' })
    );
  });

  it('matches Node over the whole {url, hostname, host} merge table', () => {
    expectAwsFenceViolation();
    // Every `connects` value below was MEASURED on Node 24.15.0 by replacing
    // `net.Socket.prototype.connect` with a recorder, not reasoned about — a
    // previous round of this file got the third row backwards by reasoning.
    const AWS = 'sqs.us-east-1.amazonaws.com';
    const cases: ReadonlyArray<{
      readonly why: string;
      readonly call: () => http.ClientRequest;
      readonly connects: string;
    }> = [
      {
        why: 'url only — the URL is the whole answer',
        call: () => http.request(`http://${AWS}/`),
        connects: AWS,
      },
      {
        why: 'url + options.hostname — hostname overrides the URL',
        call: () => http.request('http://127.0.0.1:1/', { hostname: AWS }),
        connects: AWS,
      },
      {
        why: 'url + options.host — host does NOT override the URL hostname',
        call: () => http.request('http://127.0.0.1:1/', { host: AWS }),
        connects: '127.0.0.1',
      },
      {
        why: 'options.host alone — nothing supplies a hostname, so host is used',
        call: () => http.request({ host: AWS, port: 1 }),
        connects: AWS,
      },
      {
        why: 'AWS url + a local options.hostname — the override points away from AWS',
        call: () => http.request(`http://${AWS}/`, { hostname: '127.0.0.1', port: 1 }),
        connects: '127.0.0.1',
      },
      {
        why: 'AWS url + a local options.host — the URL hostname still wins',
        call: () => http.request(`http://${AWS}/`, { host: '127.0.0.1' }),
        connects: AWS,
      },
      {
        why: 'neither — Node defaults to localhost',
        call: () => http.request({ path: '/', port: 1 }),
        connects: 'localhost',
      },
    ];

    for (const { why, call, connects } of cases) {
      if (connects === AWS) {
        expect(call, why).toThrow(FENCE_MARKER);
      } else {
        expectNoFence(call, why);
      }
    }
  });

  it('leaves the URL host standing when the options object names no host', () => {
    expectAwsFenceViolation();
    // The overwhelmingly common two-argument shape: the options carry a method,
    // not a host. The URL must still be what is checked.
    expect(() =>
      http.request('http://sqs.us-east-1.amazonaws.com/', { method: 'POST' })
    ).toThrow(FENCE_MARKER);
  });

  it('normalizes the host before matching (case, port, brackets, trailing dot, URL object)', () => {
    expectAwsFenceViolation();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['SQS.US-EAST-1.AmazonAWS.COM', 'upper case — AWS hostnames are case-insensitive'],
      ['sqs.us-east-1.amazonaws.com:443', 'an explicit :port suffix'],
      ['sqs.us-east-1.amazonaws.com.', 'a fully-qualified trailing dot'],
      ['SQS.US-EAST-1.AMAZONAWS.COM.:443', 'all three at once'],
      ['amazonaws.com', 'the apex itself, matched by `host === suffix`'],
      ['api.aws', 'the api.aws apex'],
      ['[fd00:ec2::254]', 'a bracketed IPv6 literal'],
      ['fd00:ec2::254', 'a bare IPv6 literal, which must NOT be read as host:port'],
    ];
    for (const [host, why] of cases) {
      expect(() => https.request({ host }), why).toThrow(FENCE_MARKER);
    }

    // A `URL` instance, not a string, is a first-class argument form.
    expect(() => https.request(new URL('https://sqs.us-east-1.amazonaws.com/'))).toThrow(
      '(via node:https.request())'
    );
  });

  it('refuses every link-local credential endpoint the installed SDK knows', () => {
    expectAwsFenceViolation();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['169.254.169.254', 'IMDSv2 IPv4 (Endpoint.IPv4)'],
      ['fd00:ec2::254', 'IMDSv2 IPv6 (Endpoint.IPv6)'],
      ['[fd00:ec2::254]', 'IMDSv2 IPv6, bracketed as the SDK spells it'],
      ['169.254.170.2', 'ECS task role (CMDS_IP / ECS_CONTAINER_HOST)'],
      ['169.254.170.23', 'EKS Pod Identity IPv4 (EKS_CONTAINER_HOST_IPv4)'],
      ['[fd00:ec2::23]', 'EKS Pod Identity IPv6 (EKS_CONTAINER_HOST_IPv6)'],
      ['fd00:ec2::23', 'EKS Pod Identity IPv6, unbracketed'],
    ];
    for (const [host, why] of cases) {
      expect(() => http.request({ host, path: '/' }), why).toThrow(FENCE_MARKER);
      expect(() => net.connect({ host, port: 80 }), why).toThrow(FENCE_MARKER);
    }
  });

  it('refuses the non-commercial partition suffixes (best-effort, from PARTITION_TABLE)', () => {
    expectAwsFenceViolation();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['s3.us-iso-east-1.c2s.ic.gov', 'aws-iso'],
      ['s3.us-isob-east-1.sc2s.sgov.gov', 'aws-iso-b'],
      ['s3.us-isof-south-1.csp.hci.ic.gov', 'aws-iso-f'],
      ['s3.eu-isoe-west-1.cloud.adc-e.uk', 'aws-iso-e'],
      ['s3.eusc-de-east-1.amazonaws.eu', 'aws-eusc'],
      ['abc123.lambda-url.us-east-1.on.aws', 'a Lambda Function URL'],
    ];
    for (const [host, why] of cases) {
      expect(() => https.request({ host }), why).toThrow(FENCE_MARKER);
    }
  });

  it('refuses a raw AWS-bound socket, so no builtin re-import routes around it', () => {
    expectAwsFenceViolation();
    expect(() => net.connect({ host: 'sts.us-east-1.amazonaws.com', port: 443 })).toThrow(
      /net\.Socket\.prototype\.connect/
    );
    expect(() => net.connect(443, 'lambda.us-east-1.amazonaws.com')).toThrow(FENCE_MARKER);
  });

  it('refuses connect(port, host) called directly on the prototype', () => {
    expectAwsFenceViolation();
    // `net.connect(port, host)` normalizes into the OPTIONS form before it
    // reaches `Socket.prototype.connect` (measured: the wrapper receives
    // `[[{ port, host }, null]]`), so the numeric-first branch is reachable
    // only this way — and it IS reachable, which is why it is not dead code.
    const socket = new net.Socket();
    expect(() => socket.connect(443, 'lambda.us-east-1.amazonaws.com')).toThrow(
      /net\.Socket\.prototype\.connect/
    );
    expect(socket.destroyed, 'the refusal must not leak a live handle').toBe(true);
  });

  it('refuses global fetch to AWS (undici bottoms out on the socket backstop)', async () => {
    expectAwsFenceViolation();
    const error = await fetch('https://sts.us-east-1.amazonaws.com/').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);

    // undici wraps connector failures, so walk the cause chain.
    expect(messageChain(error)).toContain(FENCE_MARKER);
  });
});

describe('AWS network fence — the remedy names the package for the REFUSED endpoint', () => {
  /**
   * The message the fence throws for one endpoint.
   *
   * The refusal is a REAL one — layer 1 raising on `https.request` — so these
   * tests exercise the same path a leaked client takes, not a synthetic
   * re-statement of the remedy builder. Layer 1 throws before a socket exists,
   * so nothing here leaves a live handle behind.
   */
  const refusalMessageFor = (host: string): string => {
    try {
      https.request({ host });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error(`the fence did not refuse ${host}`);
  };

  it('derives the package for an endpoint the SDK spells DIFFERENTLY', () => {
    expectAwsFenceViolation();
    const message = refusalMessageFor('application-autoscaling.us-east-1.amazonaws.com');

    expect(message).toContain('application-autoscaling.us-east-1.amazonaws.com');
    // The whole point: the host runs "autoscaling" together, the package splits
    // it. A naive host -> package transform emits the second string below,
    // which is not a package that exists — and `.claude/rules/testing.md`
    // records that a mis-spelled vi.mock target is silently INERT, so shipping
    // it would be worse than shipping no name.
    expect(message).toContain("vi.mock('@aws-sdk/client-application-auto-scaling'");
    expect(message).toContain('ApplicationAutoScalingClient: vi.fn(');
    expect(message).not.toContain('@aws-sdk/client-application-autoscaling');
    // And it must not fall back on the hardcoded package the message used to
    // name for every host, which is the defect this arm exists to pin.
    expect(message).not.toContain('@aws-sdk/client-route-53');
  });

  it('derives the package for a second service, where host and package DO agree', () => {
    expectAwsFenceViolation();
    const message = refusalMessageFor('cloudformation.us-east-1.amazonaws.com');

    expect(message).toContain('cloudformation.us-east-1.amazonaws.com');
    expect(message).toContain("vi.mock('@aws-sdk/client-cloudformation'");
    expect(message).toContain('CloudFormationClient: vi.fn(');
    expect(message).not.toContain('@aws-sdk/client-route-53');
  });

  it('names NO package for an endpoint it has no mapping for', () => {
    expectAwsFenceViolation();
    const message = refusalMessageFor('sqs.us-east-1.amazonaws.com');

    expect(message).toContain('sqs.us-east-1.amazonaws.com');
    expect(message).toContain('no package mapping for');
    // The strong form of "does not guess": for an unmapped endpoint the message
    // contains no `@aws-sdk/client-*` string at all, so there is nothing a
    // reader can copy that would resolve to the wrong package — or to none.
    expect(message).not.toContain('@aws-sdk/client-');
  });

  it('names no package when SEVERAL endpoints were refused at once', () => {
    // No arming here: the ledger is drained by hand below, exactly as the
    // REPORTER block does, so the file's `afterEach` sees a clean test.
    refusalMessageFor('route53.amazonaws.com');
    refusalMessageFor('application-autoscaling.us-east-1.amazonaws.com');

    const violations = drainAwsFenceViolations();
    expect(violations, 'both refusals must be recorded').toHaveLength(2);

    const verdict = auditAwsFenceViolations(violations, false);
    expect(verdict).toContain('route53.amazonaws.com');
    expect(verdict).toContain('application-autoscaling.us-east-1.amazonaws.com');
    // One package printed beside two hosts would re-create the mis-direction
    // this whole derivation exists to remove.
    expect(verdict).not.toContain('@aws-sdk/client-');
    // ...but the REASON must stay true: both of these hosts ARE mapped, so the
    // unmapped-endpoint sentence would be a fresh false claim in its place.
    expect(verdict).toContain('Several endpoints were refused');
    expect(verdict).not.toContain('no package mapping for');
  });
});

describe('AWS network fence — the REPORTER itself', () => {
  /**
   * The two arms below are the ones the reporter cannot demonstrate in-band:
   * each of them, left alone, would FAIL the very test asserting on it. So they
   * drive `auditAwsFenceViolations()` — the pure decision that `tests/setup.ts`
   * `afterEach` and `afterAll` both call — with input drained out of the real
   * ledger and the real opt-out flag. Nothing here is a synthetic re-statement
   * of the rule: the ledger entry comes from a genuine refusal, and the flag
   * comes from a genuine `expectAwsFenceViolation()`.
   */

  it('fails a test that ARMS the opt-out and never trips the fence', () => {
    // Arm it for real, then drain the flag so this test itself stays green —
    // draining is exactly what the setup file's `afterEach` does.
    expectAwsFenceViolation();
    const armed = drainAwsFenceExpectation();
    expect(armed, 'expectAwsFenceViolation() must set the flag the audit reads').toBe(true);
    expect(drainAwsFenceExpectation(), 'and the flag must be one-shot').toBe(false);

    const verdict = auditAwsFenceViolations([], armed);
    expect(verdict).toContain(FENCE_MARKER);
    expect(verdict).toContain('was armed for this test, but the fence never fired');
  });

  it('fails a test that trips the fence WITHOUT arming the opt-out', () => {
    // Deliberately NO expectAwsFenceViolation() here — this is the unarmed
    // shape, the one a real escape has.
    expect(() => https.request({ host: 'sqs.us-east-1.amazonaws.com' })).toThrow(FENCE_MARKER);

    const violations = drainAwsFenceViolations();
    expect(violations, 'the refusal must be RECORDED, not merely thrown').toHaveLength(1);
    expect(violations[0]).toContain('sqs.us-east-1.amazonaws.com');
    // Finding 4: the ledger entry names where it came from, so the report is
    // self-locating even if a future pool shares a worker across test files.
    expect(violations[0]).toContain('aws-network-fence.test.ts');
    expect(violations[0]).toContain('WITHOUT arming');

    const verdict = auditAwsFenceViolations(violations, false);
    expect(verdict).toContain(FENCE_MARKER);
    // Finding 3: the file, not the test — a module-top-level or `beforeAll`
    // escape is reported against a test that never made the call.
    expect(verdict).toContain('this test file reached real AWS');
    expect(verdict).toContain('sqs.us-east-1.amazonaws.com');
    // The remedy half must ride along on the report, not only on the throw.
    // `sqs` is not a row of the fence's package map, so the report must say so
    // rather than name a package — the message used to hardcode
    // `@aws-sdk/client-route-53` here, which told the reader to add a mock that
    // isolates nothing.
    expect(verdict).toContain('Remedy: mock the SDK PACKAGE');
    expect(verdict).toContain('no package mapping for');
    expect(verdict).not.toContain('@aws-sdk/client-');
  });

  it('says nothing about a clean test, in either arming state', () => {
    expect(auditAwsFenceViolations([], false)).toBeUndefined();
    expect(
      auditAwsFenceViolations(['x (via y)'], true),
      'armed AND tripped is the legitimate case'
    ).toBeUndefined();
  });
});

describe('AWS network fence — NEGATIVE CONTROL: local traffic is untouched', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('local-ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('allows an ordinary http.request to a local server (layer 1 is scoped)', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end();
    });

    expect(body).toBe('local-ok');
  });

  it('allows a raw socket connect to a local server (layer 2 is scoped)', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', reject);
    });

    expect(true).toBe(true);
  });

  it('allows a non-AWS hostname that merely contains "amazonaws"', () => {
    // Suffix matching must be anchored: none of these is an AWS endpoint.
    //
    // `notamazonaws.com` is REGISTRABLE, so it is the one hostname here that a
    // real resolver would answer. The stub `lookup` keeps this a unit test —
    // without it the case does live DNS (and, on a hit, a TCP handshake), which
    // is both a flake offline and an outbound call from a suite whose entire
    // point is that it makes none. The other two use RFC 2606 reserved TLDs.
    const lookup: LookupFunction = ((
      _hostname: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void
    ) => {
      if (options.all === true) {
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
        return;
      }
      callback(null, '127.0.0.1', 4);
    }) as unknown as LookupFunction;

    for (const host of [
      'aws.example.invalid',
      'notamazonaws.com',
      'amazonaws.com.evil.invalid',
    ]) {
      let request: http.ClientRequest | undefined;
      expect(() => {
        request = https.request({ host, port: 443, lookup });
      }, host).not.toThrow();
      request?.on('error', () => {});
      request?.destroy();
    }
  });
});
