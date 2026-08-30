/// <reference types="node" />

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { afterAll, afterEach, beforeEach, expect, vi } from 'vite-plus/test';

import {
  isConstructable,
  wrapConstructableImplementation,
  type MockableImplementation,
} from './constructable-implementation.js';
import { installOnceLeakDetector } from './once-leak-detector.js';
import { installStreamFence } from './stream-fence.js';

/**
 * The unit suite must not depend on whether the DEVELOPER is behind a proxy.
 *
 * Since issue #2388 every AWS SDK client spreads `awsClientDefaults()`, which
 * returns `{}` unless a proxy variable is set and a `requestHandler` plus an
 * injected `credentials` chain when one is. So on a machine with `HTTPS_PROXY`
 * exported — the very machine the issue was reported from — every test that
 * asserts an exact client-config shape sees two extra properties and fails,
 * while CI stays green. That is a test suite that answers a different question
 * per machine, so the variables are scrubbed once here.
 *
 * The proxy behaviour itself is covered explicitly, by
 * `tests/unit/utils/aws-client-defaults.test.ts` and
 * `tests/unit/utils/proxy-routing-agent.test.ts`, which set the variables
 * themselves and restore them afterwards.
 */
for (const name of [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
]) {
  delete process.env[name];
}

/**
 * Global vitest setup — defenses against Node 24 + vitest 1.6.1 surfacing
 * stray unhandled rejections from `withErrorHandling`-wrapped CLI actions.
 *
 * Background:
 *
 *   Many cdkd test files construct a Commander `Command` via a `create*Command()`
 *   factory and call `cmd.parse([...])` to exercise option parsing. Commander
 *   invokes the registered action as part of `parse()`. The action body is
 *   wrapped in `withErrorHandling`, which catches thrown errors and calls
 *   `process.exit`. Because the action is async, the rejection propagates as
 *   an unhandled rejection on the `parse()` Promise — which vitest does not
 *   await. On Node 20 / 22 the runtime swallows it silently; Node 24 surfaces
 *   it to the test runner as an "Unhandled error" annotation, failing CI.
 *
 *   Individual test files have papered over this by either stubbing the
 *   action with `cmd.action(() => {})` or spying on `process.exit`. But the
 *   unhandled rejection from one test file can bubble up while a different
 *   test file is "currently running" in the same worker, defeating per-file
 *   workarounds (vitest attributes the error to the active file, not the
 *   source).
 *
 *   Two-layer global defense:
 *
 *     1. Replace `process.exit` with a no-op throw. `withErrorHandling`'s
 *        `handleError(...)` calls `process.exit(N)`; a throwing replacement
 *        turns it into a regular synchronous throw that the surrounding
 *        async wrapper catches and turns into a Promise rejection — same
 *        outcome as a real exit from the test's perspective, but without
 *        the vitest reporter complaining about "process.exit unexpectedly
 *        called".
 *     2. `process.on('unhandledRejection', ...)` swallows the leftover
 *        rejections from Commander's `parse()` calls. Tests that genuinely
 *        want to observe rejections still `await` them locally; this
 *        handler only covers the strays.
 *
 *   Tests that explicitly assert on `process.exit` install their own
 *   `vi.spyOn(process, 'exit')` inside the test scope; `vi.spyOn` replaces
 *   the implementation atomically and `mockRestore` returns to whatever
 *   value was current — i.e. our wrapper — so the per-test spies still
 *   work as before.
 */

const originalViFn = vi.fn.bind(vi);

const wrapMockImplementationSetters = <T extends ReturnType<typeof originalViFn>>(mock: T): T => {
  const mockImplementation = mock.mockImplementation.bind(mock);
  type MockImplementationArg = Parameters<typeof mockImplementation>[0];
  mock.mockImplementation = ((implementation: MockImplementationArg) =>
    mockImplementation(
      wrapConstructableImplementation(implementation) as MockImplementationArg
    )) as T['mockImplementation'];

  const mockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  type MockImplementationOnceArg = Parameters<typeof mockImplementationOnce>[0];
  mock.mockImplementationOnce = ((implementation: MockImplementationOnceArg) =>
    mockImplementationOnce(
      wrapConstructableImplementation(implementation) as MockImplementationOnceArg
    )) as T['mockImplementationOnce'];

  return mock;
};

vi.fn = ((implementation?: MockableImplementation) => {
  if (typeof implementation === 'function' && !isConstructable(implementation)) {
    return wrapMockImplementationSetters(
      originalViFn(wrapConstructableImplementation(implementation) as never)
    );
  }

  return wrapMockImplementationSetters(originalViFn(implementation as never));
}) as typeof vi.fn;

// Runtime `*Once`-leak detector (issue #1618). Installed AFTER the `vi.fn`
// patch above so it composes over it rather than being overwritten by it, and
// inert unless `CDKD_ONCE_LEAK_DETECT=1`.
installOnceLeakDetector();

// Buffer raw `process.stdout` / `process.stderr` writes made inside a test and
// replay them only when that test FAILS. See tests/stream-fence.ts for why a
// green run printing 20 KB of product notices is a problem worth solving.
installStreamFence();

const originalExit = process.exit;

// Replace `process.exit` with a NO-OP. The action's async wrapper that
// calls `handleError(...)` then resumes after the supposed-fatal call,
// the wrapper's Promise resolves cleanly, and no unhandled rejection
// leaks into vitest's reporter.
//
// Why no-op instead of throw: throwing turns the exit into a rejected
// Promise (because withErrorHandling's action body is async), which
// becomes an `unhandledRejection`. We cannot reliably suppress that —
// `process.on('unhandledRejection', ...)` only ADDS a listener;
// vitest's own listener still surfaces the rejection alongside ours.
// A no-op produces no rejection at all.
//
// Tests that genuinely want exit semantics install their own per-test
// `vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error(...) })`,
// which atomically replaces this wrapper for the scope of that test.
// On `mockRestore`, vi reverts to whatever was current — i.e. this
// wrapper — so cleanup is clean.
(process as unknown as { exit: (code?: number) => never }).exit = ((_code?: number): never => {
  // no-op; original is on globalThis if anything truly needs it
  return undefined as never;
}) as never;

// Keep a reference to the real exit in case anything downstream wants it.
(globalThis as Record<string, unknown>).__cdkd_test_original_exit__ = originalExit;


/* ------------------------------------------------------------------------ *
 * Real-AWS network fence (issue #2081)
 *
 * A provider that constructs its OWN SDK client — `new Route53Client({...})`
 * inside the provider — is not isolated by a test that only mocks
 * `src/utils/aws-clients.js`. The provider ignores the mock, the client is
 * real, and the test transacts with whatever AWS account the runner is
 * authenticated to. The dangerous direction is the SILENT one: a call that
 * FAILS looks like an ordinary red, while a call that SUCCEEDS creates a real,
 * billable resource and still reports green.
 *
 * The fence is at the NETWORK layer rather than the credential-provider layer
 * on purpose: a client built with explicit dummy credentials skips credential
 * resolution entirely but still transacts, so a credential-level fence would
 * miss exactly the shape that is easiest to write by accident.
 *
 * Two layers, because one of them is defeatable:
 *
 *   1. `http` / `https` `request` + `get`, replaced on the module's exports
 *      object. A consumer only sees the replacement if it reads the property at
 *      CALL time, and whether it does depends on which build of the package Node
 *      loads. Measured against the installed tree: `@aws-sdk/client-route-53`
 *      3.1018.0 resolves `@smithy/node-http-handler` 4.5.0, whose `dist-es`
 *      build uses a NAMED import (`import { Agent as hsAgent, request as
 *      hsRequest } from 'node:https'`) — a snapshot that would escape this
 *      layer. That build is not the one that loads: 4.5.0 ships NO `exports`
 *      field, so Node falls back to `main` (`dist-cjs/index.js`), which does
 *      `var node_https = require('node:https')` and evaluates
 *      `node_https.request` at request time. That live property read is what
 *      layer 1 depends on. (@smithy/node-http-handler 4.9.x, also present in the
 *      tree for other clients, moved its ESM build to a DEFAULT import,
 *      `import node_https from 'node:https'`, which is live as well.) The
 *      fragile part is the ABSENT `exports` field: if upstream adds one, the
 *      ESM build starts loading, and for a named-import version every AWS call
 *      would silently demote to layer 2 — still fenced, but with the less
 *      specific message. This layer produces the actionable message.
 *   2. `net.Socket.prototype.connect`, as a backstop. Node snapshots a builtin's
 *      ESM NAMED exports, so a module written as `import { request } from
 *      'node:http'` — which is exactly what `@smithy/credential-provider-imds`
 *      does — keeps the pre-patch function and escapes layer 1. Every outbound
 *      TCP connection opened through Node's own networking stack bottoms out
 *      here, including `node:http2.connect`, `node:tls.connect` and undici
 *      (global `fetch`).
 *
 * The boundary is IN-PROCESS Node networking APIs, and ONLY those. Three routes
 * escape both layers, so the fence is not a claim about the whole process: a
 * child process (`node:child_process`), a worker thread
 * (`node:worker_threads`), and a hostname resolved out-of-band to a bare IP
 * that is then connected to numerically. `src/synthesis/app-executor.ts` spawns
 * the CDK app and is isolated today only because its tests mock
 * `node:child_process` — not because of anything here. The REPORTING half has
 * one gap of its own behind those three: a violation recorded after the file's
 * `afterAll` drain — a floating async teardown that resolves past file end —
 * dies with the worker and leaves the run green, so the refusal still holds and
 * only the report is lost.
 *
 * Only AWS endpoints and the link-local credential addresses are refused. Tests
 * that talk to a local HTTP server (tests/unit/local/**, the asset-manifest
 * loader, ...) are deliberately unaffected — a fence that refused everything
 * would pass its own positive test while telling us nothing.
 *
 * There is deliberately NO env-var kill switch. Other gates in this repo bypass
 * through one (`CDKD_SKIP_CI_GREEN_GATE=1`, `CDKD_ALLOW_DIRTY_RESTORE=1`, ...),
 * but those gate the AGENT's own commands, where an inherited value shows up in
 * the transcript of the very command it disarms. This one gates a whole test
 * run, where an inherited environment is precisely how a safety control goes
 * quietly inert — and what it protects against is a GREEN run that created
 * billable resources. Code that genuinely needs the network belongs in the
 * shell-driven integration suite under `tests/integration/`, which vitest does
 * not execute: `vite.config.ts` collects only `.test.ts` files, and there are
 * none under `tests/integration/` (nor under `src/`) today.
 * `expectAwsFenceViolation()` below opts out of REPORTING only — it never lets
 * a call through.
 * ------------------------------------------------------------------------ */

const AWS_FENCE_MARKER = '[cdkd unit-test AWS fence]';

/**
 * Endpoint suffixes, matched anchored (`host === suffix` or `host` ends with
 * `.${suffix}`) so `notamazonaws.com` and `amazonaws.com.evil.example` do not
 * match.
 *
 * The partition suffixes are the ones in `src/utils/aws-partition.ts`'s
 * `PARTITION_TABLE`, which is the repo's own source of truth for them.
 * Best-effort: cdkd has no ISO / EUSC coverage today, so these are here to keep
 * a future non-commercial endpoint from being the one hole in the fence, not
 * because any current test approaches one.
 */
const AWS_ENDPOINT_SUFFIXES = [
  'amazonaws.com', // commercial + GovCloud
  'amazonaws.com.cn', // aws-cn
  'c2s.ic.gov', // aws-iso
  'sc2s.sgov.gov', // aws-iso-b
  'csp.hci.ic.gov', // aws-iso-f
  'cloud.adc-e.uk', // aws-iso-e
  'amazonaws.eu', // aws-eusc
  'api.aws', // dual-stack service endpoints
  'on.aws', // Lambda Function URLs
] as const;

/**
 * Link-local credential endpoints reached by the default credential chain.
 * Every constant below was read out of the INSTALLED SDK, not from memory:
 *
 * - `169.254.169.254` / `fd00:ec2::254` — IMDSv2. `Endpoint.IPv4` /
 *   `Endpoint.IPv6` in `@smithy/credential-provider-imds`.
 * - `169.254.170.2` — ECS task role. `CMDS_IP` in
 *   `@smithy/credential-provider-imds`, `ECS_CONTAINER_HOST` in
 *   `@aws-sdk/credential-provider-http`.
 * - `169.254.170.23` / `fd00:ec2::23` — EKS Pod Identity.
 *   `EKS_CONTAINER_HOST_IPv4` / `EKS_CONTAINER_HOST_IPv6` in
 *   `@aws-sdk/credential-provider-http`.
 *
 * The last three matter on a containerized runner specifically: there the chain
 * does not fail, it MINTS a real credential set into the worker, which is the
 * state this fence exists to make impossible.
 */
const AWS_METADATA_HOSTS = [
  '169.254.169.254',
  'fd00:ec2::254',
  '169.254.170.2',
  '169.254.170.23',
  'fd00:ec2::23',
] as const;

const normalizeHost = (raw: string): string => {
  let host = raw.trim().toLowerCase();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close !== -1) {
      return host.slice(1, close);
    }
  }
  // Strip a `:port` suffix, but only when the single colon cannot be part of a
  // bare IPv6 literal.
  const colon = host.indexOf(':');
  if (colon !== -1 && host.indexOf(':', colon + 1) === -1) {
    host = host.slice(0, colon);
  }
  return host.endsWith('.') ? host.slice(0, -1) : host;
};

const isAwsHost = (raw: string): boolean => {
  const host = normalizeHost(raw);
  if (host.length === 0) {
    return false;
  }
  if ((AWS_METADATA_HOSTS as readonly string[]).includes(host)) {
    return true;
  }
  return AWS_ENDPOINT_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

/**
 * The SDK package (and its client class) behind a refused endpoint, keyed by the
 * host's FIRST label — the service label the SDK's own endpoint resolver emits.
 *
 * An explicit map rather than a host -> package transform, because there is no
 * such transform. The SDK re-hyphenates several service names, and the two this
 * fence has already caught disagree with their endpoints in OPPOSITE directions:
 * `application-autoscaling.<region>.amazonaws.com` is served by
 * `@aws-sdk/client-application-auto-scaling` (the package splits a word the host
 * runs together), while `route53.amazonaws.com` is served by
 * `@aws-sdk/client-route-53` (the package splits digits off a name the host runs
 * together). A name derived from the host would be plausible and WRONG, which is
 * worse than no name: `.claude/rules/testing.md` records that a mis-spelled
 * `vi.mock` target is silently INERT, so the fence would be handing the reader a
 * mock that changes nothing and a rerun that still transacts with AWS.
 *
 * Deliberately small — only the services a cdkd unit test has actually been
 * caught reaching (`cloudformation`, `sts` and `application-autoscaling`, the
 * three behind the nine files this fence found) plus `route53`, which the
 * fence's own test drives. Every row was read out of the INSTALLED SDK rather
 * than from memory: the host from `client.config.endpointProvider(...)`, the
 * class from the package's own exports. Any other host takes the generic arm
 * below, which names the host and refuses to guess.
 */
const AWS_SDK_PACKAGE_BY_SERVICE_LABEL: Readonly<
  Record<string, { readonly package: string; readonly client: string } | undefined>
> = {
  'application-autoscaling': {
    package: '@aws-sdk/client-application-auto-scaling',
    client: 'ApplicationAutoScalingClient',
  },
  cloudformation: {
    package: '@aws-sdk/client-cloudformation',
    client: 'CloudFormationClient',
  },
  route53: { package: '@aws-sdk/client-route-53', client: 'Route53Client' },
  sts: { package: '@aws-sdk/client-sts', client: 'STSClient' },
};

const sdkPackageForHost = (
  host: string
): { readonly package: string; readonly client: string } | undefined => {
  const label = normalizeHost(host).split('.')[0];
  return label === undefined ? undefined : AWS_SDK_PACKAGE_BY_SERVICE_LABEL[label];
};

/**
 * The ledger entry format, minted and read back in one place so the reader half
 * cannot drift from the writer half.
 */
const AWS_FENCE_VIA_SEPARATOR = ' (via ';

const formatAwsFenceViolation = (host: string, via: string, origin: string): string =>
  `${host}${AWS_FENCE_VIA_SEPARATOR}${via}) — from ${origin}`;

/**
 * The host back out of a ledger entry. Not a parse of foreign input: the string
 * is produced by `formatAwsFenceViolation` directly above, and a hostname can
 * never contain the separator. `auditAwsFenceViolations` is an exported seam
 * that a test may drive with an arbitrary string, so an entry without the
 * separator yields `undefined` and routes the remedy to its generic arm rather
 * than reporting a host that was never refused.
 */
const hostFromAwsFenceViolation = (entry: string): string | undefined => {
  const cut = entry.indexOf(AWS_FENCE_VIA_SEPARATOR);
  return cut > 0 ? entry.slice(0, cut) : undefined;
};

/**
 * The remedy half of the message, DERIVED from the host(s) that were refused.
 * Shared by the thrown error and by the `afterEach` report, so an escape that is
 * swallowed by a bare `rejects.toThrow()` still surfaces the same actionable
 * text.
 *
 * Why it takes the hosts at all: a fixed template naming one package tells a
 * reader whose test reached `application-autoscaling...` to mock
 * `@aws-sdk/client-route-53`, i.e. to add a mock that isolates nothing. The
 * message is the whole discovery half of this control, so it has to name the
 * package for the endpoint actually refused, or say plainly that it cannot.
 */
const awsFenceRemedyLines = (hosts: readonly string[]): readonly string[] => {
  const distinct = [...new Set(hosts.map((host) => normalizeHost(host)))].filter(
    (host) => host.length > 0
  );
  const [first] = distinct;
  // A concrete package only when exactly ONE endpoint was refused and it is a
  // row of the map above. Several endpoints at once, or an unmapped one, both
  // take the generic arm — printing one package beside a list of hosts would
  // re-create the mis-direction this exists to remove.
  const mapped =
    distinct.length === 1 && first !== undefined ? sdkPackageForHost(first) : undefined;

  const remedy =
    mapped !== undefined && first !== undefined
      ? [
          'Remedy: mock the SDK PACKAGE the escaping client is constructed from, not',
          'only the shared client factory. The refused endpoint',
          `  ${first}`,
          `is served by ${mapped.package}:`,
          '',
          `  vi.mock('${mapped.package}', () => ({`,
          `    ${mapped.client}: vi.fn(() => ({ send: sendMock })),`,
          '    // ...plus every Command the code under test constructs, e.g.',
          '    // SomeCommand: vi.fn((input) => ({ input })),',
          '  }));',
        ]
      : [
          'Remedy: mock the SDK PACKAGE the escaping client is constructed from, not',
          // Why the generic arm was reached decides the sentence. Saying "no
          // mapping" for a MULTI-host report would be false whenever the fence
          // does map those hosts — it declined to print one package beside two
          // endpoints, which is a different thing.
          ...(distinct.length > 1
            ? [
                'only the shared client factory. Several endpoints were refused, so this',
                'message names no single package:',
                ...distinct.map((host) => `  ${host}`),
              ]
            : distinct.length === 1
              ? [
                  'only the shared client factory. This fence has no package mapping for',
                  ...distinct.map((host) => `  ${host}`),
                ]
              : ['only the shared client factory. This report names no endpoint,']),
          'so read the specifier off the `new <Service>Client(...)` call the stack',
          'trace points at and mock THAT string verbatim. Do NOT spell it from the',
          'host: the SDK re-hyphenates several service names, so a derived name may',
          'name no package at all — and a mis-spelled vi.mock target is silently',
          'INERT, which leaves the run green and still transacting.',
          ...(distinct.some((host) => (AWS_METADATA_HOSTS as readonly string[]).includes(host))
            ? [
                '',
                'A link-local address here is the default credential chain, which only',
                'runs because a real client was constructed; the same remedy applies.',
              ]
            : []),
          '',
          "  vi.mock('<the specifier the provider imports>', () => ({",
          '    <Service>Client: vi.fn(() => ({ send: sendMock })),',
          '  }));',
        ];

  return [
    'Tests run under vitest must never transact with AWS. A call that succeeds',
    'creates real, billable resources in whatever account the runner is',
    'authenticated to, and the test still reports green (issue #2081).',
    '',
    'This almost always means an SDK client escaped its mock. Mocking',
    "'src/utils/aws-clients.js' does NOT isolate a provider that builds its own",
    'client — `new Route53Client({ region })` inside the provider ignores that mock',
    'entirely. The converse is just as true: when the escaping client comes FROM',
    "that factory, mocking 'src/utils/aws-clients.js' is the fix and a package mock",
    'is not. Find the construction site before choosing which one to add.',
    '',
    ...remedy,
    '',
    'tests/unit/provisioning/route53-provider.test.ts shows the established shape',
    'for a package mock.',
    '',
    'If the code under test genuinely needs real AWS, it does not belong in the',
    'vitest suite at all: cdkd covers real AWS with the shell-driven integration',
    'tests under tests/integration/, run via `/run-integ`. There is no env-var',
    'bypass for this fence.',
    '',
    'A test that asserts ON the fence calls `expectAwsFenceViolation()` from',
    'tests/setup.ts, once per test, BEFORE the call it expects to be refused.',
  ];
};

class UnitTestAwsNetworkError extends Error {
  constructor(host: string, via: string) {
    super(
      [
        `${AWS_FENCE_MARKER} a test tried to reach real AWS at "${host}" (via ${via}).`,
        '',
        ...awsFenceRemedyLines([host]),
      ].join('\n')
    );
    this.name = 'UnitTestAwsNetworkError';
    // Repo convention (`src/utils/error-handler.ts` does the same on every
    // CdkdError subclass): re-pin the prototype so `instanceof` holds no matter
    // how the class is downlevelled. Under this repo's `target: "ESNext"` the
    // native `extends` already preserves it, so today the call is belt-and-
    // braces rather than load-bearing — it is kept so every error class in the
    // codebase reads the same way.
    Object.setPrototypeOf(this, UnitTestAwsNetworkError.prototype);
  }
}

/**
 * Pull the target host out of `http.request` / `https.request` style arguments.
 *
 * Node does NOT pick a single winner across the argument list. It merges the
 * two forms into ONE options object — `{ ...urlToHttpOptions(url), ...options }`
 * — and then resolves `options.hostname || options.host` in `_http_client`,
 * defaulting to `localhost`. The URL argument only ever contributes `hostname`
 * (`urlToHttpOptions()` returns no `host` key at all), so the two fields have to
 * be tracked SEPARATELY and combined at the end. Measured on Node 24.15.0 by
 * recording the host handed to `net.Socket.prototype.connect`:
 *
 *   request('http://127.0.0.1:9/', { host: 'x.example' })      -> 127.0.0.1
 *   request('http://127.0.0.1:9/', { hostname: 'x.example' })  -> x.example
 *   request('http://x.example/',   { host: '127.0.0.1' })      -> x.example
 *   request({ host: 'a.example', hostname: 'b.example' })      -> b.example
 *   request({ host: 'a.example' })                             -> a.example
 *
 * A last-writer-wins walk — which this used to be — gets rows 1 and 3 wrong in
 * BOTH directions: it reports `x.example` for a request Node sends to
 * 127.0.0.1 (a false positive), and `127.0.0.1` for one Node sends to
 * `x.example` (layer 1 misses; layer 2 still refuses it, only with a less
 * specific message).
 *
 * The subtlety is that an options object OWNING a `hostname` key overrides the
 * URL's even when the value is empty or `undefined` — that is plain object
 * spread, not a truthiness test — after which `|| options.host` takes over.
 * Also measured:
 *
 *   request('http://url.example/', { hostname: undefined })              -> localhost
 *   request('http://url.example/', { hostname: '', host: 'h.example' })  -> h.example
 *
 * which is why the `hostname` branch below keys on `hasOwnKey` and then
 * normalizes an unusable value back to `undefined`.
 */
const hasOwnKey = (target: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(target, key);

const hostFromRequestArgs = (args: readonly unknown[]): string | undefined => {
  // Node's merged view of the call: the URL seeds `hostname`; an options object
  // may override `hostname` and may supply `host`, independently.
  let hostname: string | undefined;
  let host: string | undefined;
  for (const arg of args.slice(0, 2)) {
    if (typeof arg === 'string') {
      try {
        hostname = new URL(arg).hostname;
      } catch {
        // Not a URL — Node would reject it too; leave the seed alone.
      }
      continue;
    }
    if (arg instanceof URL) {
      hostname = arg.hostname;
      continue;
    }
    if (arg !== null && typeof arg === 'object') {
      const options = arg as { hostname?: unknown; host?: unknown };
      if (hasOwnKey(options, 'hostname')) {
        hostname =
          typeof options.hostname === 'string' && options.hostname.length > 0
            ? options.hostname
            : undefined;
      }
      if (typeof options.host === 'string' && options.host.length > 0) {
        host = options.host;
      }
    }
  }
  // `options.hostname || options.host`, as `_http_client` spells it.
  return hostname ?? host;
};

/** Pull the target host out of `net.Socket.prototype.connect` arguments. */
const hostFromSocketConnectArgs = (args: readonly unknown[]): string | undefined => {
  // `net.createConnection()` normalizes its arguments and then calls
  // `socket.connect(normalizedArray)`, so the real options object arrives
  // nested one array level deep. Missing this unwrap is what made an earlier
  // draft of layer 2 silently pass `net.connect({ host: 'sts...' })` through.
  const flattened = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  const [first, second] = flattened;
  // connect(port, host?, listener?) — reachable only by calling
  // `net.Socket.prototype.connect` directly; `net.connect(...)` normalizes to
  // the options form first.
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return typeof second === 'string' ? second : undefined;
  }
  // connect(options, listener?). Only `host` — deliberately NOT `hostname`.
  // `net` has no `hostname` option: a socket given one connects to localhost,
  // so reading it here would report an AWS host for a connection that never
  // went to AWS. (`http`/`https` DO honour `hostname`, which is why layer 1
  // reads it and layer 2 does not.)
  if (first !== null && typeof first === 'object') {
    const options = first as { host?: unknown };
    if (typeof options.host === 'string' && options.host.length > 0) {
      return options.host;
    }
  }
  return undefined;
};

type AnyFn = (...args: never[]) => unknown;

const fenceModuleRequestFn = (
  moduleExports: object,
  key: 'request' | 'get',
  label: string
): void => {
  const target = moduleExports as Record<string, unknown>;
  const original = target[key] as AnyFn;
  if (typeof original !== 'function') {
    return;
  }
  const fenced = function fencedAwsRequest(this: unknown, ...args: unknown[]): unknown {
    const host = hostFromRequestArgs(args);
    if (host !== undefined && isAwsHost(host)) {
      // No socket exists yet on this path — `http.ClientRequest` is what would
      // create one — so there is nothing to destroy before throwing.
      throw recordAwsFenceViolation(normalizeHost(host), `${label}.${key}()`);
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  target[key] = fenced;
};

// `setupFiles` is re-evaluated for EVERY test file, but `node:http` /
// `node:https` / `node:net` are external to vite's module graph and so are
// cached per WORKER. Without this guard the wrappers would stack one level
// deeper per test file the worker runs. The violation ledger and the
// expectation flag live on the same object for the same reason: the fenced
// functions are installed once per worker, while the `afterEach` that reads
// them is registered once per test FILE.
const FENCE_INSTALLED_KEY = '__cdkd_aws_network_fence_installed__';
const FENCE_VIOLATIONS_KEY = '__cdkd_aws_network_fence_violations__';
const FENCE_EXPECTED_KEY = '__cdkd_aws_network_fence_violation_expected__';
// Whether a TEST body (as opposed to module top level / `beforeAll` /
// `afterAll`) is currently executing. vitest's `expect.getState()
// .currentTestName` is NOT cleared when a test ends, so on its own it would
// blame the file's last test for a violation raised from an `afterAll`.
const FENCE_IN_TEST_KEY = '__cdkd_aws_network_fence_in_test__';
const fenceHost = globalThis as Record<string, unknown>;

const fenceViolations = (): string[] => {
  const existing = fenceHost[FENCE_VIOLATIONS_KEY];
  if (Array.isArray(existing)) {
    return existing as string[];
  }
  const created: string[] = [];
  fenceHost[FENCE_VIOLATIONS_KEY] = created;
  return created;
};

/**
 * Build the refusal AND record it, then hand the error back to the caller to
 * throw.
 *
 * Recording is the half that makes the fence VISIBLE. Throwing alone is not
 * enough: `tests/unit/**` holds 142 assertions written as a bare
 * `await expect(...).rejects.toThrow()` with no matcher, and every one of them
 * is SATISFIED by this error. Without the ledger + the `afterEach` / `afterAll`
 * audit below, a client that escaped its mock would keep the suite green and
 * say nothing —
 * the billable-resource half of the control would hold while the discovery half
 * (issue #2081's acceptance item 1, "fails, and says so in those terms") would
 * not.
 */
const recordAwsFenceViolation = (host: string, via: string): UnitTestAwsNetworkError => {
  fenceViolations().push(formatAwsFenceViolation(host, via, currentTestOrigin()));
  return new UnitTestAwsNetworkError(host, via);
};

/**
 * Where the refusal happened, captured AT RECORD TIME.
 *
 * The ledger hangs off `globalThis`, i.e. it is shared by every test FILE the
 * worker runs. That is harmless today only because vitest's `isolate` is on and
 * each file gets its own process. Under `--no-isolate`, or a future
 * single-threaded pool, a violation recorded late in file A would redden file
 * B's first test with a message naming nothing that leads back to A. Stamping
 * the origin at record time removes the whole class instead of resting on the
 * pool configuration.
 */
const currentTestOrigin = (): string => {
  try {
    const state = expect.getState() as { testPath?: unknown; currentTestName?: unknown };
    const rawPath = typeof state.testPath === 'string' ? state.testPath : undefined;
    const cwd = `${process.cwd()}/`;
    const file =
      rawPath !== undefined && rawPath.startsWith(cwd) ? rawPath.slice(cwd.length) : rawPath;
    const name =
      fenceHost[FENCE_IN_TEST_KEY] === true &&
      typeof state.currentTestName === 'string' &&
      state.currentTestName.length > 0
        ? state.currentTestName
        : undefined;
    if (file !== undefined && name !== undefined) {
      return `${file} > ${name}`;
    }
    if (file !== undefined) {
      // No current test: module top level, a `beforeAll`, or an `afterAll`.
      return `${file} (outside any test — module top level or a beforeAll/afterAll hook)`;
    }
    if (name !== undefined) {
      return name;
    }
  } catch {
    // `expect.getState()` is unavailable outside a vitest run; fall through.
  }
  return 'an unidentified test (vitest expect state unavailable)';
};

/**
 * The audit both fence hooks run, expressed as a PURE function of the drained
 * ledger and the drained opt-out flag: it returns the failure message, or
 * `undefined` when the test is clean.
 *
 * Pure on purpose. Two arms of this mechanism can only demonstrate themselves by
 * FAILING a test — "armed but never tripped" and "an unarmed violation" — so a
 * nested `describe` cannot cover them. Exporting the decision lets
 * `tests/unit/aws-network-fence.test.ts` drive both arms with synthetic input
 * and assert on the answer.
 */
export const auditAwsFenceViolations = (
  violations: readonly string[],
  expected: boolean
): string | undefined => {
  if (expected) {
    if (violations.length === 0) {
      return (
        `${AWS_FENCE_MARKER} expectAwsFenceViolation() was armed for this test, but the ` +
        'fence never fired. Either the call under test no longer reaches AWS, or the ' +
        'arming call belongs in a different test.'
      );
    }
    return undefined;
  }

  if (violations.length === 0) {
    return undefined;
  }

  // The remedy is keyed on the endpoints actually refused, so a violation on
  // `application-autoscaling...` is never answered with the route-53 package.
  const refusedHosts = violations
    .map((violation) => hostFromAwsFenceViolation(violation))
    .filter((host): host is string => host !== undefined);

  return [
    `${AWS_FENCE_MARKER} this test file reached real AWS. The call was REFUSED, but the`,
    'assertion around it did not notice — a bare `rejects.toThrow()` is satisfied by',
    'the refusal itself, so the escape would otherwise have stayed invisible.',
    '',
    `Refused ${violations.length === 1 ? 'call' : `calls (${violations.length})`}:`,
    ...violations.map((violation) => `  - ${violation}`),
    '',
    ...awsFenceRemedyLines(refusedHosts),
  ].join('\n');
};

/** Read-and-clear the violation ledger. Exported as the seam the audit tests drive. */
export const drainAwsFenceViolations = (): string[] => fenceViolations().splice(0);

/** Read-and-clear the per-test opt-out flag. Exported for the same reason. */
export const drainAwsFenceExpectation = (): boolean => {
  const expected = fenceHost[FENCE_EXPECTED_KEY] === true;
  fenceHost[FENCE_EXPECTED_KEY] = false;
  return expected;
};

/**
 * Opt out of the post-test report (`afterEach`, and the `afterAll` sweep behind
 * it) for the CURRENT test, for a test that is deliberately asserting on the
 * fence itself.
 *
 * Deliberately narrow, three ways over a "fence off" flag:
 *
 * - it is armed per TEST and consumed by the very next `afterEach`, so it
 *   cannot leak past the test that called it;
 * - it is SELF-VERIFYING — arming it without then tripping the fence fails the
 *   test, so it cannot be sprinkled around defensively "just in case"; and
 * - it silences REPORTING only. The call is still refused, so no opt-out
 *   anywhere can put a real AWS request on the wire.
 */
export const expectAwsFenceViolation = (): void => {
  fenceHost[FENCE_EXPECTED_KEY] = true;
};

beforeEach(() => {
  fenceHost[FENCE_IN_TEST_KEY] = true;
});

const runAwsFenceAudit = (): void => {
  fenceHost[FENCE_IN_TEST_KEY] = false;
  // Drain FIRST, unconditionally. If a violation survived into the next test,
  // one escape would redden every test after it in the file and the real
  // culprit would be unfindable.
  const violations = drainAwsFenceViolations();
  const message = auditAwsFenceViolations(violations, drainAwsFenceExpectation());
  if (message !== undefined) {
    throw new Error(message);
  }
};

afterEach(runAwsFenceAudit);

// A violation planted AFTER the last `afterEach` — from a file-level
// `afterAll`, or from a teardown a test scheduled and did not await — used to
// leave the run GREEN: the ledger simply died with the worker. "Refused but
// unreported" is exactly the half of this control the reporter exists to close,
// so drain once more at file end.
//
// It cannot double-report: `afterEach` SPLICES the ledger, so this pass only
// ever sees entries recorded after the last test finished.
//
// Ordering is what makes it work, and it was MEASURED rather than assumed: a
// throwaway file whose own top-level `afterAll` planted a violation went GREEN
// with this line commented out and RED with it restored. The setup file is
// evaluated before the test file, so this hook is registered first and runs
// last under vitest's reverse ordering for `after*` hooks.
afterAll(runAwsFenceAudit);

if (fenceHost[FENCE_INSTALLED_KEY] !== true) {
  fenceHost[FENCE_INSTALLED_KEY] = true;

  // Layer 1 — the path `@smithy/node-http-handler` actually takes for every
  // AWS service call in the installed tree (see the header comment for the
  // build-resolution detail this depends on).
  fenceModuleRequestFn(https, 'request', 'node:https');
  fenceModuleRequestFn(https, 'get', 'node:https');
  fenceModuleRequestFn(http, 'request', 'node:http');
  fenceModuleRequestFn(http, 'get', 'node:http');

  // Layer 2 — the backstop for in-process Node networking. Covers builtin
  // NAMED-import escapes (IMDS), `node:http2.connect`, `node:tls.connect`, and
  // undici / global `fetch`.
  const originalSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function fencedAwsSocketConnect(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    const host = hostFromSocketConnectArgs(args);
    if (host !== undefined && isAwsHost(host)) {
      const error = recordAwsFenceViolation(
        normalizeHost(host),
        'net.Socket.prototype.connect()'
      );
      // The socket already exists by the time `connect` is called (`tls.connect`
      // builds a TLSSocket, then connects it), so throwing without this leaves
      // one live handle per refusal. `destroy()` on a not-yet-connected socket
      // is a no-op-and-mark, emits no 'error', and is what keeps a run that
      // trips the fence N times from ending with N dangling handles.
      this.destroy();
      throw error;
    }
    return (originalSocketConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
}
