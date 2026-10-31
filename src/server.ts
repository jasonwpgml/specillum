import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Session } from "./session.js";
import { registerTools } from "./tools/index.js";

const VERSION = "0.1.0";

export async function runServer(): Promise<void> {
  const server = new McpServer({ name: "specillum", version: VERSION });
  const session = new Session(server);
  registerTools(server, session);

  // Close the pod window when the agent disconnects, unless asked to keep it.
  const shutdown = async () => {
    if (process.env.SPECILLUM_KEEP_POD !== "1") await session.close();
    process.exit(0);
  };
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
}
