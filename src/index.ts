#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectOsKind } from "./os.js";
import { openDb } from "./db.js";
import { loadOrInitConfig } from "./config.js";
import { createScheduler } from "./scheduler/index.js";
import { HomeworkTools } from "./tools.js";

const osKind = detectOsKind();
const config = loadOrInitConfig(osKind);
const db = openDb();
const scheduler = createScheduler(osKind, config);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fireScriptPath = resolve(join(__dirname, "fire.js"));

const tools = new HomeworkTools(db, osKind, scheduler, {
  fireScriptPath,
  nodeExecPath: process.execPath,
});

const server = new Server(
  {
    name: "homework-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "homework_schedule",
      description:
        "Schedule a homework task. At due_at, a fresh Claude Code session opens in a new terminal window with your prompt pre-loaded. cwd is auto-captured from the calling process.",
      inputSchema: {
        type: "object",
        required: ["due_at", "prompt"],
        properties: {
          due_at: {
            type: "string",
            description:
              "ISO 8601 datetime with timezone offset, at least 5 minutes in the future (e.g. 2026-06-02T09:00:00+09:00).",
          },
          prompt: {
            type: "string",
            description: "The natural-language prompt to feed Claude when the task fires.",
          },
          title: {
            type: "string",
            description: "Optional short title shown in homework_list.",
          },
        },
      },
    },
    {
      name: "homework_list",
      description:
        "List homework tasks. Defaults to status='scheduled' ordered by due_at ascending. Use filter.status to inspect 'firing' (crash candidates) / 'fired' / 'cancelled'.",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: ["scheduled", "firing", "fired", "cancelled"],
              },
            },
          },
        },
      },
    },
    {
      name: "homework_cancel",
      description:
        "Cancel a scheduled homework task by id. Throws if id does not exist or task is already firing/fired/cancelled.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  let result: unknown;
  switch (name) {
    case "homework_schedule":
      result = tools.schedule(args as { due_at: string; prompt: string; title?: string });
      break;
    case "homework_list":
      result = tools.list(args as { filter?: { status?: "scheduled" | "firing" | "fired" | "cancelled" } });
      break;
    case "homework_cancel":
      result = tools.cancel(args as { id: string });
      break;
    default:
      throw new Error(`unknown tool: ${name}`);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});
