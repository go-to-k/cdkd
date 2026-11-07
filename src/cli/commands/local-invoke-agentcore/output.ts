import { getLogger } from '../../../utils/logger.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { type AgentCoreInvokeResult } from '../../../local/agentcore-client.js';
import {
  type McpInvokeResult,
  type McpJsonRpcRequest,
} from '../../../local/agentcore-mcp-client.js';
import {
  type A2aInvokeResult,
  type A2aJsonRpcRequest,
} from '../../../local/agentcore-a2a-client.js';
import { type AgentCoreWsResult } from '../../../local/agentcore-ws-client.js';

export function emitResult(result: AgentCoreInvokeResult): void {
  const logger = getLogger();
  if (result.status >= 400) {
    logger.warn(`Agent /invocations returned HTTP ${result.status}.`);
    process.exitCode = 1;
  }
  if (result.streamed) {
    // The SSE body was already written chunk-by-chunk via the onChunk sink;
    // just terminate with a newline so the shell prompt resumes cleanly.
    process.stdout.write('\n');
    return;
  }
  process.stdout.write(`${result.raw}\n`);
}

/**
 * Finish a `/ws` exchange: the frames were already streamed to stdout via the
 * onMessage sink, so just terminate with a newline (so the shell prompt resumes
 * cleanly) and note the frame count at debug level.
 */
export function emitWsResult(result: AgentCoreWsResult): void {
  process.stdout.write('\n');
  getLogger().debug(`Agent /ws closed after ${result.frames} frame(s).`);
}

/**
 * Build the JSON-RPC request to send to an MCP runtime from `--event`:
 *   - no `--event` (empty object) → `tools/list` (discover the server's tools),
 *   - an object with a string `method` → that method + its `params`,
 *   - anything else → a fail-fast error.
 *
 * Exported for unit testing.
 */
export function buildMcpRequest(event: unknown): McpJsonRpcRequest {
  if (event === undefined || event === null) return { method: 'tools/list', params: {} };
  if (typeof event !== 'object' || Array.isArray(event)) {
    throw new CdkdError(
      'MCP --event must be a JSON object describing a JSON-RPC request ' +
        '(e.g. {"method":"tools/call","params":{"name":"...","arguments":{...}}}).',
      'LOCAL_INVOKE_AGENTCORE_MCP_EVENT_INVALID'
    );
  }
  const obj = event as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return { method: 'tools/list', params: {} };
  if (typeof obj['method'] !== 'string') {
    throw new CdkdError(
      'MCP --event must include a string "method" (a JSON-RPC method such as ' +
        `"tools/list" or "tools/call"). Got keys: ${Object.keys(obj).join(', ')}.`,
      'LOCAL_INVOKE_AGENTCORE_MCP_EVENT_INVALID'
    );
  }
  return {
    method: obj['method'],
    ...(obj['params'] !== undefined && { params: obj['params'] }),
  };
}

/** Print the MCP JSON-RPC response; exit 1 when it carried a JSON-RPC error. */
export function emitMcpResult(result: McpInvokeResult): void {
  if (!result.ok) {
    getLogger().warn('MCP server returned a JSON-RPC error.');
    process.exitCode = 1;
  }
  process.stdout.write(`${result.raw}\n`);
}

/**
 * Build the JSON-RPC request to send to an A2A runtime from `--event`:
 *   - no `--event` (empty object) → `agent/getCard` (discover the agent's card),
 *   - an object with a string `method` → that method + its `params`,
 *   - anything else → a fail-fast error.
 *
 * Exported for unit testing.
 */
export function buildA2aRequest(event: unknown): A2aJsonRpcRequest {
  if (event === undefined || event === null) return { method: 'agent/getCard', params: {} };
  if (typeof event !== 'object' || Array.isArray(event)) {
    throw new CdkdError(
      'A2A --event must be a JSON object describing a JSON-RPC request ' +
        '(e.g. {"method":"tasks/send","params":{"id":"...","message":{...}}}).',
      'LOCAL_INVOKE_AGENTCORE_A2A_EVENT_INVALID'
    );
  }
  const obj = event as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return { method: 'agent/getCard', params: {} };
  if (typeof obj['method'] !== 'string') {
    throw new CdkdError(
      'A2A --event must include a string "method" (a JSON-RPC method such as ' +
        `"agent/getCard" or "tasks/send"). Got keys: ${Object.keys(obj).join(', ')}.`,
      'LOCAL_INVOKE_AGENTCORE_A2A_EVENT_INVALID'
    );
  }
  return {
    method: obj['method'],
    ...(obj['params'] !== undefined && { params: obj['params'] }),
  };
}

/** Print the A2A JSON-RPC response; exit 1 when it carried a JSON-RPC error. */
export function emitA2aResult(result: A2aInvokeResult): void {
  if (!result.ok) {
    getLogger().warn('A2A server returned a JSON-RPC error.');
    process.exitCode = 1;
  }
  process.stdout.write(`${result.raw}\n`);
}

/** Map a `--platform` value to the architecture `buildContainerImage` expects. */
export function platformToArchitecture(platform: string): 'x86_64' | 'arm64' {
  return platform === 'linux/amd64' ? 'x86_64' : 'arm64';
}
