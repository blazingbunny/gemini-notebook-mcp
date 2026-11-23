#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NotebookApiClient } from "./client.js";

const client = new NotebookApiClient();

const server = new McpServer({
  name: "gemini-notebook-mcp",
  version: "1.0.0",
});

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

server.tool(
  "create_notebook",
  "Create a new Gemini Notebook container to hold sources.",
  {
    displayName: z
      .string()
      .max(500)
      .optional()
      .describe("Optional user-facing title for the notebook (max 500 characters)."),
  },
  async ({ displayName }) => {
    try {
      const notebook = await client.createNotebook(displayName);
      return jsonResult(notebook);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "get_notebook",
  "Get metadata for a specific Gemini Notebook by resource name (notebooks/{notebook}) or UUID.",
  {
    name: z
      .string()
      .min(1)
      .describe("Notebook resource name (e.g. 'notebooks/550e8400-...') or notebook UUID."),
  },
  async ({ name }) => {
    try {
      const notebook = await client.getNotebook(name);
      return jsonResult(notebook);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "list_notebooks",
  "List Gemini Notebooks accessible to the authenticated user (owned and/or shared).",
  {
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of notebooks to return (default 50, max 100)."),
    pageToken: z
      .string()
      .optional()
      .describe("Pagination token from a previous list_notebooks call."),
    filter: z
      .enum(["notebook.is_owner = true", "notebook.is_owner = false"])
      .optional()
      .describe("Optional ownership filter: owned only or shared only."),
  },
  async ({ pageSize, pageToken, filter }) => {
    try {
      const res = await client.listNotebooks({ pageSize, pageToken, filter });
      return jsonResult(res);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "update_notebook",
  "Rename an existing Gemini Notebook.",
  {
    name: z
      .string()
      .min(1)
      .describe("Notebook resource name (e.g. 'notebooks/550e8400-...') or notebook UUID."),
    displayName: z
      .string()
      .min(1)
      .max(500)
      .describe("New non-blank display name for the notebook (max 500 characters)."),
  },
  async ({ name, displayName }) => {
    try {
      const notebook = await client.updateNotebook(name, displayName, "displayName");
      return jsonResult(notebook);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "create_source",
  "Add a public web page URL, YouTube video URL, plain text, or Markdown source to a Gemini Notebook.",
  {
    parent: z
      .string()
      .min(1)
      .describe("Parent notebook resource name (e.g. 'notebooks/550e8400-...') or notebook UUID."),
    displayName: z
      .string()
      .max(500)
      .optional()
      .describe("Optional display title (max 500 chars). Omitted web pages use page title; YouTube always uses video title."),
    url: z
      .string()
      .url()
      .optional()
      .describe("Public https:// web page URL or YouTube watch URL to ingest. Mutually exclusive with 'text'."),
    text: z
      .string()
      .optional()
      .describe("Inline UTF-8 plain text or Markdown content (up to 1,000,000 bytes / 500,000 words). Mutually exclusive with 'url'."),
    mimeType: z
      .enum(["text/plain", "text/markdown"])
      .optional()
      .describe("Optional MIME type for inline 'text' sources ('text/plain' or 'text/markdown'). Omit for 'url' sources."),
    wait: z
      .boolean()
      .optional()
      .describe("If true, poll until the source finishes processing (ACTIVE or FAILED)."),
    timeoutSeconds: z
      .number()
      .int()
      .min(5)
      .max(600)
      .optional()
      .describe("Timeout in seconds when wait=true (default 120)."),
  },
  async ({ parent, displayName, url, text, mimeType, wait, timeoutSeconds }) => {
    try {
      const created = await client.createSource(parent, { displayName, url, text, mimeType });
      if (wait && created.name) {
        const finalSource = await client.waitForSource(created.name, timeoutSeconds ?? 120);
        return jsonResult(finalSource);
      }
      return jsonResult(created);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "upload_source",
  "Upload a local file (PDF, DOCX, PPTX, ODT, EPUB, RTF, HWP, CSV, TXT, Markdown, audio, 3GPP video, or image up to 200 MiB) into a Gemini Notebook.",
  {
    parent: z
      .string()
      .min(1)
      .describe("Parent notebook resource name (e.g. 'notebooks/550e8400-...') or notebook UUID."),
    filePath: z
      .string()
      .min(1)
      .describe("Local filesystem path to the file to upload (max 200 MiB)."),
    displayName: z
      .string()
      .max(500)
      .optional()
      .describe("Optional source title (defaults to the filename; max 500 characters)."),
    mimeType: z
      .string()
      .optional()
      .describe("Optional MIME type (auto-detected from file extension when omitted)."),
    wait: z
      .boolean()
      .optional()
      .describe("If true, poll until the uploaded source reaches ACTIVE or FAILED."),
    timeoutSeconds: z
      .number()
      .int()
      .min(5)
      .max(600)
      .optional()
      .describe("Timeout in seconds when wait=true (default 120)."),
  },
  async ({ parent, filePath, displayName, mimeType, wait, timeoutSeconds }) => {
    try {
      const uploaded = await client.uploadSource(parent, filePath, { displayName, mimeType });
      if (wait && uploaded.name) {
        const finalSource = await client.waitForSource(uploaded.name, timeoutSeconds ?? 120);
        return jsonResult(finalSource);
      }
      return jsonResult(uploaded);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "get_source",
  "Get metadata and processing state (PROCESSING, ACTIVE, FAILED, DELETING) for a specific source.",
  {
    name: z
      .string()
      .min(1)
      .describe("Full source resource name: 'notebooks/{notebook}/sources/{source}'."),
  },
  async ({ name }) => {
    try {
      const source = await client.getSource(name);
      return jsonResult(source);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "list_sources",
  "List sources in a Gemini Notebook in ascending order of creation time.",
  {
    parent: z
      .string()
      .min(1)
      .describe("Parent notebook resource name (e.g. 'notebooks/550e8400-...') or notebook UUID."),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of sources to return (default 50, max 100)."),
    pageToken: z
      .string()
      .optional()
      .describe("Pagination token from a previous list_sources call for this same notebook."),
  },
  async ({ parent, pageSize, pageToken }) => {
    try {
      const res = await client.listSources(parent, { pageSize, pageToken });
      return jsonResult(res);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "wait_for_source",
  "Poll a source until its ingestion state reaches ACTIVE or FAILED.",
  {
    name: z
      .string()
      .min(1)
      .describe("Full source resource name: 'notebooks/{notebook}/sources/{source}'."),
    timeoutSeconds: z
      .number()
      .int()
      .min(5)
      .max(600)
      .optional()
      .describe("Maximum seconds to wait before timing out (default 120)."),
  },
  async ({ name, timeoutSeconds }) => {
    try {
      const source = await client.waitForSource(name, timeoutSeconds ?? 120);
      return jsonResult(source);
    } catch (err) {
      return errorResult(err);
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("gemini-notebook-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});
