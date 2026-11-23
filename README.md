# Gemini Notebook MCP Server

A local [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for the [Google Gemini Notebook API](https://developers.google.com/notebook/docs) (`v1`).

Compared to Google's hosted remote MCP endpoint, this local server adds:
- **Local file uploads (`upload_source`)** up to 200 MiB (PDF, DOCX, PPTX, ODT, EPUB, RTF, HWP, CSV, TXT, Markdown, audio, 3GPP video, and images) — which the hosted remote MCP does not expose.
- **Automatic OAuth 2.0 token refresh** via a stored refresh token, avoiding hourly manual bearer token updates.
- **Source ingestion polling (`wait_for_source` and `wait: true`)** and automatic `429`/`5xx` exponential backoff (honoring `RetryInfo.retryDelay`, with `5xx` retries restricted to safe read requests).

## Tools

| Tool | Description |
| --- | --- |
| `create_notebook` | Create a new Gemini Notebook container. |
| `get_notebook` | Get metadata for a notebook (`notebooks/{id}` or UUID). |
| `list_notebooks` | List notebooks accessible to the authenticated user (`pageSize`, `pageToken`, `filter`). |
| `update_notebook` | Rename an existing notebook (`displayName`). |
| `create_source` | Ingest a public web URL, YouTube video URL, plain text, or Markdown source (supports `wait: true`). |
| `upload_source` | Upload a local file up to 200 MiB into a notebook (supports `wait: true`). |
| `get_source` | Get metadata and ingestion state (`PROCESSING`, `ACTIVE`, `FAILED`, `DELETING`) for a source. |
| `list_sources` | List sources in a notebook (`pageSize`, `pageToken`). |
| `wait_for_source` | Poll a source until its ingestion state reaches `ACTIVE`, `FAILED`, or `DELETING`. |

## Prerequisites

1. A **personal Google Account** that has signed in to [Gemini Notebook](https://notebook.google.com) at least once (Google Workspace accounts are not yet supported during Public Preview).
2. A Google Cloud project with the **Gemini Notebook API** (`notebook.googleapis.com`) enabled.
3. A **Desktop app** OAuth 2.0 client JSON downloaded from Google Cloud Console:
   - Enable the API: `https://console.cloud.google.com/apis/library/notebook.googleapis.com`
   - Configure the OAuth consent screen (`External`), add your Gmail under **Audience -> Test users**, and add the `https://www.googleapis.com/auth/notebook` scope under **Data Access**.
   - Create a **Desktop app** client under **Clients**, download the JSON, and save it as `client_secret.json` in the repo root (gitignored).

## Installation & Authentication

```bash
npm install
npm run build
npm run auth
```

You can also run a one-shot local callback server for automatic browser redirects:

```bash
node dist/auth-cli.js --listen 8765
```

Tokens are saved locally to `tokens.json` (`0600`, gitignored) and refreshed automatically before expiry.

## Convert & Configure for Any MCP Client or Format

This server runs over **MCP stdio** (`node /absolute/path/to/gemini-notebook-mcp/dist/index.js`), so it can be wired directly into any MCP client—or bridged to Streamable HTTP / SSE—using either the built-in config writer or the format templates below.

### 1. Automatic config writer (`npm run configure`)

Safely generates and merges configs without overwriting existing servers. It parses JSONC (comments and trailing commas), writes atomically with `.bak` backups, and preserves `0600` file permissions on private config files.

```bash
# Google (Antigravity + Gemini CLI)
npm run configure -- --target google

# Claude (Claude Code + Claude Desktop)
npm run configure -- --target claude

# Multiple targets at once
npm run configure -- --target google,claude,cursor

# Generic MCP JSON to stdout or merged into any custom file
npm run configure -- --target generic
npm run configure -- --target generic --output ./mcp.json

# Project-scoped configs (.mcp.json, .gemini/settings.json, .cursor/mcp.json, .vscode/mcp.json)
npm run configure -- --target claude-code,gemini-cli,cursor,vscode --scope project

# Preview changes without writing any files
npm run configure -- --target all --dry-run
```

#### Supported `--target` values

| Target | Default User Path | Project Path (`--scope project`) | Config Format |
| --- | --- | --- | --- |
| `google` | Expands to `antigravity` + `gemini-cli` | — | `mcpServers` JSON |
| `antigravity` | `~/.gemini/config/mcp_config.json` | — | `mcpServers` JSON |
| `gemini-cli` | `~/.gemini/settings.json` | `.gemini/settings.json` | `mcpServers` JSON |
| `claude` | Expands to `claude-code` + `claude-desktop` | — | CLI / `mcpServers` JSON |
| `claude-code` | `claude mcp add -s user` (fallback: `~/.claude.json`) | `.mcp.json` | CLI / `mcpServers` JSON |
| `claude-desktop` | OS-specific `claude_desktop_config.json` | — | `mcpServers` JSON |
| `cursor` | `~/.cursor/mcp.json` | `.cursor/mcp.json` | `mcpServers` JSON |
| `vscode` | OS-specific VS Code `User/mcp.json` | `.vscode/mcp.json` | `servers` JSON (`"type": "stdio"`) |
| `generic` | Prints to stdout (or writes `--output <path>`) | `--output <path>` | `mcpServers` JSON |
| `all` | All targets above | — | All formats |

#### Useful flags

- `--name <name>`: Override server name (default: `gemini-notebook`)
- `--env KEY=VAL`: Inject environment variables into the generated config (repeatable, e.g. `--env NOTEBOOK_UPLOAD_ROOT=/path/to/docs`)
- `--portable`: Emit `"command": "node"` instead of the absolute Node binary path
- `--output <path>`: Merge into any custom JSON file (use with a single target such as `--target generic`)
- `--dry-run` / `--print`: Print the generated snippet/command without modifying disk

---

### 2. Format templates for any MCP client

Replace `/absolute/path/to/gemini-notebook-mcp/dist/index.js` with your local path (or run `npm link` once and use `"command": "gemini-notebook-mcp"` with `"args": []`).

#### Standard `mcpServers` JSON (Antigravity, Gemini CLI, Claude Desktop, Claude Code `.mcp.json`, Cursor, Windsurf, Cline)

```json
{
  "mcpServers": {
    "gemini-notebook": {
      "command": "node",
      "args": ["/absolute/path/to/gemini-notebook-mcp/dist/index.js"]
    }
  }
}
```

#### Claude Code CLI

```bash
claude mcp add -s user gemini-notebook -- node /absolute/path/to/gemini-notebook-mcp/dist/index.js
```

#### VS Code (`.vscode/mcp.json` or User `mcp.json`)

```json
{
  "servers": {
    "gemini-notebook": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/gemini-notebook-mcp/dist/index.js"]
    }
  }
}
```

#### OpenAI Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.gemini-notebook]
command = "node"
args = ["/absolute/path/to/gemini-notebook-mcp/dist/index.js"]
```

#### Zed (`~/.config/zed/settings.json`)

```json
{
  "context_servers": {
    "gemini-notebook": {
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/gemini-notebook-mcp/dist/index.js"]
      }
    }
  }
}
```

#### Global binary (`npm link`)

If you prefer a command name over an absolute script path:

```bash
npm link
```

Then configure any stdio client with `"command": "gemini-notebook-mcp"` and `"args": []`.

#### Converting to Streamable HTTP or SSE (for remote/HTTP-only MCP clients)

If your client requires an HTTP/SSE MCP endpoint instead of local stdio, wrap this server with any standard MCP stdio-to-HTTP bridge such as [`supergateway`](https://github.com/supercorp-ai/supergateway):

```bash
# Expose as Streamable HTTP on http://localhost:8000/mcp
npx -y supergateway \
  --stdio "node /absolute/path/to/gemini-notebook-mcp/dist/index.js" \
  --outputTransport streamableHttp \
  --port 8000

# Or expose as legacy SSE on http://localhost:8000/sse
npx -y supergateway \
  --stdio "node /absolute/path/to/gemini-notebook-mcp/dist/index.js" \
  --outputTransport sse \
  --port 8000
```

Then point your HTTP-capable MCP client at `http://localhost:8000/mcp` (Streamable HTTP) or `http://localhost:8000/sse` (SSE). *(Note: Google also hosts a remote Streamable HTTP endpoint at `https://notebook.googleapis.com/mcp`, though it does not support `upload_source` or automatic token refresh.)*

## Environment Variables

| Variable | Description |
| --- | --- |
| `NOTEBOOK_CLIENT_SECRET_PATH` | Custom path to `client_secret.json` (defaults to `<repo>/client_secret.json`). |
| `NOTEBOOK_TOKEN_PATH` | Custom path to `tokens.json` (defaults to `<repo>/tokens.json`). |
| `NOTEBOOK_UPLOAD_ROOT` | Optional directory allow-list restricting which local files `upload_source` may read (server auth files are always blocked). |
| `NOTEBOOK_ACCESS_TOKEN` | Static OAuth bearer token override (cannot auto-refresh on `401`). |
| `NOTEBOOK_USE_ADC=1` | Use `gcloud auth application-default print-access-token` instead of `tokens.json` (pair with `NOTEBOOK_PROJECT_ID` or `GOOGLE_CLOUD_PROJECT`). |
| `NOTEBOOK_PROJECT_ID` | Quota project sent as `x-goog-user-project` when using ADC or a static ADC token. |

## License

MIT
