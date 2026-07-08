/**
 * Spawn a generated python (FastMCP) server over stdio for the parity suite.
 *
 * Thin wrapper over the shared stdio client: the python server speaks the same
 * newline-delimited JSON-RPC on stdin/stdout as the node one, so the only
 * differences are the interpreter (the provisioned venv's python) and the
 * entrypoint (`server.py`). FastMCP can be slower to first-answer than node
 * (module import + pydantic model build), hence the longer request timeout.
 */

import { startMcpServer, type McpStdioClient } from './mcp-client.js';

export async function startPythonMcpServer(
  python: string,
  projectDir: string,
  env: Record<string, string>,
): Promise<{ client: McpStdioClient; serverInfo: { name: string; version: string } }> {
  return startMcpServer({
    command: python,
    args: ['server.py'],
    cwd: projectDir,
    env,
    requestTimeoutMs: 30_000,
  });
}
