# Gemini Notebook MCP Server

A local [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for the [Google Gemini Notebook API](https://developers.google.com/notebook/docs) (`v1`).

Compared to Google's hosted remote MCP endpoint, this local server adds:
- **Local file uploads (`upload_source`)** up to 200 MiB (PDF, DOCX, PPTX, ODT, EPUB, RTF, HWP, CSV, TXT, Markdown, audio, 3GPP video, and images) — which the hosted remote MCP does not expose.
- **Automatic OAuth 2.0 token refresh** via a stored refresh token, avoiding hourly manual bearer token updates.
- **Source ingestion polling (`wait_for_source` and `wait: true`)** and automatic `429`/`5xx` exponential backoff (honoring `RetryInfo.retryDelay`).

## Tools

| Tool | Description |
| --- | --- |
| `create_notebook` | Create a new Gemini Notebook container. |
| `get_notebook` | Get metadata for a notebook (`notebooks/{id}` or UUID). |
| `list_notebooks` | List notebooks accessible to the authenticated user (`pageSize`, `pageToken`, `filter`). |
| `update_notebook` | Rename an existing notebook (`displayName`). |
| `create_source` | Ingest a public web URL, YouTube video URL, plain text, or Markdown source (supports `wait: true`). |
| `upload_source` | Upload a local file up to 200 MiB into a notebook (supports `wait: true`). |
| `get_source` | Get metadata and ingestion state (`PROCESSING`, `ACTIVE`, `FAILED`) for a source. |
| `list_sources` | List sources in a notebook (`pageSize`, `pageToken`). |
| `wait_for_source` | Poll a source until its ingestion state reaches `ACTIVE` or `FAILED`. |

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

You can also run a one-shot local callback server for browser redirects:

```bash
node dist/auth-cli.js --listen 8765
```

Tokens are saved locally to `tokens.json` (`0600`, gitignored) and refreshed automatically before expiry.

## MCP Client Configuration

Use the built-in config writer script to safely merge `gemini-notebook` into Google, Claude, and generic MCP client configs without overwriting existing servers:

```bash
# Google (Antigravity ~/.gemini/config/mcp_config.json + Gemini CLI ~/.gemini/settings.json)
npm run configure -- --target google

# Claude (Claude Code + Claude Desktop)
npm run configure -- --target claude

# Both Google and Claude
npm run configure -- --target google,claude

# Generic MCP JSON (stdout, or write/merge to any path with --output)
npm run configure -- --target generic
npm run configure -- --target generic --output ./mcp.json

# Other supported targets: antigravity, gemini-cli, claude-code, claude-desktop, cursor, vscode, all
# Preview changes without touching disk:
npm run configure -- --target all --dry-run
```

Project-scoped configs are supported via `--scope project` (e.g., `.mcp.json` for Claude Code, `.gemini/settings.json` for Gemini CLI, `.cursor/mcp.json` for Cursor, `.vscode/mcp.json` for VS Code).

### Manual configuration

#### Claude Code

```bash
claude mcp add -s user gemini-notebook -- node /absolute/path/to/gemini-notebook-mcp/dist/index.js
```

#### Antigravity (`~/.gemini/config/mcp_config.json`) / Gemini CLI / Cursor / Claude Desktop

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

## Optional Environment Variables

- `NOTEBOOK_CLIENT_SECRET_PATH`: custom path to `client_secret.json`
- `NOTEBOOK_TOKEN_PATH`: custom path to `tokens.json`
- `NOTEBOOK_ACCESS_TOKEN`: static OAuth bearer token override
- `NOTEBOOK_USE_ADC=1`: use `gcloud auth application-default print-access-token` instead of `tokens.json` (pair with `NOTEBOOK_PROJECT_ID` or `GOOGLE_CLOUD_PROJECT`)

## License

MIT
