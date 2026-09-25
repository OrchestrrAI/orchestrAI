import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createMcpServer } from "./index"

const server = createMcpServer()
const transport = new StdioServerTransport()

await server.connect(transport)
console.error("OrchestrAI DevOps MCP Server v2.2 running over stdio")
