import { describe, expect, it } from 'vite-plus/test';
import {
  parseTimeoutMs,
  platformToArchitecture,
  buildMcpRequest,
  buildA2aRequest,
} from '../../../src/cli/commands/local-invoke-agentcore.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

// G4 from the PR #717 3-axis review: the agentcore command file ships
// ~1650 lines with no direct unit tests beyond the G1 case in
// `local-invoke-auto-assume-role.test.ts`. Cover the pure-functional
// exported helpers — option parsing + protocol-specific request shapers —
// where a wrong-shape regression would surface at the unit layer without
// having to spin up Docker. Coupled call-graph helpers
// (`resolveAssumeRoleArn`, `emitResult` / `emitMcpResult` / `emitA2aResult`,
// `readEnvOverridesFile`) are exercised by the end-to-end integ fixture's
// 20 scenarios; this file deliberately covers only the pure-input shapers
// to keep the unit suite fast (no fs/process mocking).

describe('parseTimeoutMs (`--timeout` parser)', () => {
  it('accepts a positive integer string and returns the parsed number', () => {
    expect(parseTimeoutMs('1')).toBe(1);
    expect(parseTimeoutMs('120000')).toBe(120000);
    expect(parseTimeoutMs('300000')).toBe(300000);
  });

  it('rejects zero', () => {
    expect(() => parseTimeoutMs('0')).toThrow(CdkdError);
    expect(() => parseTimeoutMs('0')).toThrow(/positive integer.*'0'/);
  });

  it('rejects negative integers', () => {
    expect(() => parseTimeoutMs('-1')).toThrow(/positive integer.*'-1'/);
    expect(() => parseTimeoutMs('-1000')).toThrow(/positive integer.*'-1000'/);
  });

  it('rejects fractional numbers', () => {
    expect(() => parseTimeoutMs('1.5')).toThrow(/positive integer.*'1.5'/);
  });

  it('rejects non-numeric input', () => {
    expect(() => parseTimeoutMs('abc')).toThrow(/positive integer.*'abc'/);
    expect(() => parseTimeoutMs('')).toThrow(/positive integer.*''/);
  });

  it('throws CdkdError with the documented error code', () => {
    try {
      parseTimeoutMs('bad');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CdkdError);
      expect((err as CdkdError).code).toBe('LOCAL_INVOKE_AGENTCORE_TIMEOUT_INVALID');
    }
  });
});

describe('platformToArchitecture (`--platform` -> CDK architecture)', () => {
  it('maps linux/amd64 to x86_64', () => {
    expect(platformToArchitecture('linux/amd64')).toBe('x86_64');
  });

  it('maps linux/arm64 to arm64 (the AgentCore-required default)', () => {
    expect(platformToArchitecture('linux/arm64')).toBe('arm64');
  });

  it('maps every other value to arm64 (the AgentCore-required default fallback)', () => {
    // commander's .choices() restricts the CLI input to the two valid platforms
    // before this helper is reached, so this is the documented default-fallback
    // for any other value a programmatic caller might pass.
    expect(platformToArchitecture('anything-else')).toBe('arm64');
    expect(platformToArchitecture('')).toBe('arm64');
  });
});

describe('buildMcpRequest (`--event` -> MCP JSON-RPC request)', () => {
  it('defaults to tools/list when --event is undefined', () => {
    expect(buildMcpRequest(undefined)).toEqual({ method: 'tools/list', params: {} });
  });

  it('defaults to tools/list when --event is null', () => {
    expect(buildMcpRequest(null)).toEqual({ method: 'tools/list', params: {} });
  });

  it('defaults to tools/list when --event is an empty object', () => {
    expect(buildMcpRequest({})).toEqual({ method: 'tools/list', params: {} });
  });

  it('forwards method when --event has a string method', () => {
    expect(buildMcpRequest({ method: 'tools/list' })).toEqual({ method: 'tools/list' });
  });

  it('forwards method + params when --event has both', () => {
    const event = { method: 'tools/call', params: { name: 'add', arguments: { a: 1, b: 2 } } };
    expect(buildMcpRequest(event)).toEqual(event);
  });

  it('rejects non-object events (strings, numbers, arrays)', () => {
    expect(() => buildMcpRequest('tools/list')).toThrow(CdkdError);
    expect(() => buildMcpRequest('tools/list')).toThrow(/MCP.*JSON object/);
    expect(() => buildMcpRequest(42)).toThrow(/MCP.*JSON object/);
    expect(() => buildMcpRequest([{ method: 'tools/list' }])).toThrow(/MCP.*JSON object/);
  });

  it('rejects objects with non-string method', () => {
    expect(() => buildMcpRequest({ method: 42 })).toThrow(/MCP.*string "method"/);
    expect(() => buildMcpRequest({ method: null, params: {} })).toThrow(/MCP.*string "method"/);
    expect(() => buildMcpRequest({ params: {} })).toThrow(/MCP.*string "method"/);
  });

  it('throws CdkdError with the documented error code', () => {
    try {
      buildMcpRequest('not-an-object');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CdkdError);
      expect((err as CdkdError).code).toBe('LOCAL_INVOKE_AGENTCORE_MCP_EVENT_INVALID');
    }
  });
});

describe('buildA2aRequest (`--event` -> A2A JSON-RPC request)', () => {
  it('defaults to agent/getCard when --event is undefined', () => {
    expect(buildA2aRequest(undefined)).toEqual({ method: 'agent/getCard', params: {} });
  });

  it('defaults to agent/getCard when --event is null', () => {
    expect(buildA2aRequest(null)).toEqual({ method: 'agent/getCard', params: {} });
  });

  it('defaults to agent/getCard when --event is an empty object', () => {
    expect(buildA2aRequest({})).toEqual({ method: 'agent/getCard', params: {} });
  });

  it('forwards method + params when --event has both', () => {
    const event = { method: 'tasks/send', params: { id: 'task-1', message: { text: 'hi' } } };
    expect(buildA2aRequest(event)).toEqual(event);
  });

  it('rejects non-object events', () => {
    expect(() => buildA2aRequest('tasks/send')).toThrow(/A2A.*JSON object/);
    expect(() => buildA2aRequest([{ method: 'tasks/send' }])).toThrow(/A2A.*JSON object/);
  });

  it('rejects objects with non-string method', () => {
    expect(() => buildA2aRequest({ method: 42 })).toThrow(/A2A.*string "method"/);
    expect(() => buildA2aRequest({ params: {} })).toThrow(/A2A.*string "method"/);
  });

  it('throws CdkdError with the documented error code', () => {
    try {
      buildA2aRequest('not-an-object');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CdkdError);
      expect((err as CdkdError).code).toBe('LOCAL_INVOKE_AGENTCORE_A2A_EVENT_INVALID');
    }
  });
});
