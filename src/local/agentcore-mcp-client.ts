/**
 * Shim: re-exports cdk-local's AgentCore MCP (Model Context Protocol) client
 * for `cdkd local invoke-agentcore` — speaks the MCP Streamable-HTTP
 * `POST /mcp` contract with SSE-encoded JSON-RPC responses. The implementation
 * lives in cdk-local and cdkd consumes it verbatim instead of carrying a
 * byte-identical copy. See cdk-local's `src/local/agentcore-mcp-client.ts`.
 */
export {
  mcpInvokeOnce,
  parseSseForJsonRpc,
  MCP_CONTAINER_PORT,
  MCP_PATH,
  MCP_PROTOCOL_VERSION,
  type McpInvokeResult,
  type McpInvokeOptions,
  type McpJsonRpcRequest,
} from 'cdk-local/internal';
