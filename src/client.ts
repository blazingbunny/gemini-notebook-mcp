import fs from "node:fs";
import path from "node:path";
import {
  AuthManager,
  type AuthResult,
  getClientSecretPath,
  getPendingAuthStatePath,
  getTokenPath,
} from "./auth.js";

const API_BASE = "https://notebook.googleapis.com/v1";
const UPLOAD_BASE = "https://notebook.googleapis.com/upload/v1";
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB
const MAX_TEXT_BYTES = 1_000_000; // 1 MB
const MAX_RETRIES = 4;

export interface Notebook {
  name: string;
  displayName?: string;
  createTime?: string;
}

export interface ListNotebooksResponse {
  notebooks?: Notebook[];
  nextPageToken?: string;
}

export type SourceState = "STATE_UNSPECIFIED" | "PROCESSING" | "ACTIVE" | "FAILED" | "DELETING";

export interface RpcStatus {
  code?: number;
  message?: string;
  details?: Array<Record<string, unknown>>;
}

export interface Source {
  name: string;
  displayName?: string;
  mimeType?: string;
  state?: SourceState;
  createTime?: string;
  error?: RpcStatus;
  originalUrl?: string;
  webContent?: { url: string };
  textContent?: { content: string };
}

export interface ListSourcesResponse {
  sources?: Source[];
  nextPageToken?: string;
}

export interface CreateSourceInput {
  displayName?: string;
  mimeType?: "text/plain" | "text/markdown";
  url?: string;
  text?: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".epub": "application/epub+zip",
  ".rtf": "application/rtf",
  ".hwp": "application/x-hwp",
  ".hwpx": "application/hwp+zip",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
  ".weba": "audio/webm",
  ".3gp": "video/3gpp",
  ".3g2": "video/3gpp2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

export function normalizeNotebookName(nameOrId: string): string {
  const trimmed = nameOrId.trim().replace(/^\/+/, "");
  if (trimmed.startsWith("notebooks/")) {
    return trimmed;
  }
  return `notebooks/${trimmed}`;
}

export function inferMimeType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[ext];
}

function parseRetryDelayMs(errorBody: unknown): number | null {
  if (!errorBody || typeof errorBody !== "object") return null;
  const errObj = (errorBody as { error?: { details?: Array<Record<string, unknown>> } }).error;
  const details = errObj?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (
      typeof detail["@type"] === "string" &&
      detail["@type"].includes("RetryInfo") &&
      typeof detail.retryDelay === "string"
    ) {
      const match = /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay);
      if (match) {
        return Math.ceil(parseFloat(match[1]) * 1000);
      }
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveRealOrAbsolutePath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  try {
    return await fs.promises.realpath(resolved);
  } catch {
    return resolved;
  }
}

function formatApiError(status: number, bodyText: string): string {
  let parsed: { error?: { code?: number; message?: string; status?: string } } | null = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // plain text body
  }

  const msg = parsed?.error?.message || bodyText || `HTTP ${status}`;
  const rpcStatus = parsed?.error?.status;
  let hint = "";

  if (status === 404 && msg.includes("Account not found for user")) {
    hint = " Hint: Sign in to https://notebook.google.com at least once with your personal Google Account.";
  } else if (status === 403 && msg.includes("WORKSPACE_ACCOUNT_NOT_SUPPORTED")) {
    hint = " Hint: Gemini Notebook API Preview only supports personal Google Accounts (not Google Workspace).";
  } else if (status === 401) {
    hint = " Hint: OAuth token is invalid or expired. Re-run authentication if auto-refresh failed.";
  }

  return `Gemini Notebook API error (${status}${rpcStatus ? ` ${rpcStatus}` : ""}): ${msg}${hint}`;
}

export class NotebookApiClient {
  private readonly auth: AuthManager;

  constructor(auth = new AuthManager()) {
    this.auth = auth;
  }

  private async requestJson<T>(
    url: string,
    init: {
      method?: string;
      body?: BodyInit | null;
      headers?: Record<string, string>;
      retryOn5xx?: boolean;
      deadlineMs?: number;
    } = {}
  ): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const retryOn5xx = init.retryOn5xx ?? method === "GET";
    let refreshedOnce = false;
    let pendingAuth: AuthResult | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const authResult = pendingAuth ?? (await this.auth.getAuth(false));
      pendingAuth = null;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${authResult.accessToken}`,
        ...init.headers,
      };
      if (authResult.quotaProject) {
        headers["x-goog-user-project"] = authResult.quotaProject;
      }

      const resp = await fetch(url, {
        method,
        headers,
        body: init.body,
      });

      const text = await resp.text();

      if (resp.ok) {
        if (!text) return {} as T;
        return JSON.parse(text) as T;
      }

      // Retry once on 401 by forcing a token refresh and reusing the refreshed token on the next attempt
      if (resp.status === 401 && !refreshedOnce && attempt < MAX_RETRIES) {
        if (init.deadlineMs !== undefined && Date.now() >= init.deadlineMs) {
          throw new Error(formatApiError(resp.status, text));
        }
        refreshedOnce = true;
        pendingAuth = await this.auth.getAuth(true);
        continue;
      }

      // Retry on 429, or transient 5xx only when retryOn5xx is enabled (defaults to GET)
      const isRetryableStatus = resp.status === 429 || (resp.status >= 500 && retryOn5xx);
      if (isRetryableStatus && attempt < MAX_RETRIES) {
        let parsedErr: unknown = null;
        try {
          parsedErr = JSON.parse(text);
        } catch {
          // ignore
        }
        const retryInfoMs = parseRetryDelayMs(parsedErr);
        let backoffMs = retryInfoMs ?? Math.min(1000 * 2 ** attempt, 16_000) + Math.random() * 400;
        if (init.deadlineMs !== undefined) {
          const remainingMs = init.deadlineMs - Date.now();
          if (remainingMs <= 0) {
            throw new Error(formatApiError(resp.status, text));
          }
          backoffMs = Math.min(backoffMs, remainingMs);
        }
        await sleep(backoffMs);
        if (init.deadlineMs !== undefined && Date.now() >= init.deadlineMs) {
          throw new Error(formatApiError(resp.status, text));
        }
        continue;
      }

      throw new Error(formatApiError(resp.status, text));
    }

    throw new Error("Request failed after maximum retries.");
  }

  async createNotebook(displayName?: string): Promise<Notebook> {
    const payload: Record<string, unknown> = {};
    if (displayName !== undefined) {
      if (displayName.length > 500) {
        throw new Error("displayName cannot exceed 500 characters.");
      }
      payload.displayName = displayName;
    }
    return this.requestJson<Notebook>(`${API_BASE}/notebooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async getNotebook(name: string): Promise<Notebook> {
    const normalized = normalizeNotebookName(name);
    return this.requestJson<Notebook>(`${API_BASE}/${normalized}`);
  }

  async listNotebooks(params?: {
    pageSize?: number;
    pageToken?: string;
    filter?: string;
  }): Promise<ListNotebooksResponse> {
    const url = new URL(`${API_BASE}/notebooks`);
    if (params?.pageSize !== undefined) {
      url.searchParams.set("pageSize", String(params.pageSize));
    }
    if (params?.pageToken) {
      url.searchParams.set("pageToken", params.pageToken);
    }
    if (params?.filter) {
      url.searchParams.set("filter", params.filter);
    }
    return this.requestJson<ListNotebooksResponse>(url.toString());
  }

  async updateNotebook(name: string, displayName: string, updateMask = "displayName"): Promise<Notebook> {
    const trimmed = displayName.trim();
    if (!trimmed) {
      throw new Error("displayName cannot be blank when updating a notebook.");
    }
    if (trimmed.length > 500) {
      throw new Error("displayName cannot exceed 500 characters.");
    }
    const normalized = normalizeNotebookName(name);
    const url = new URL(`${API_BASE}/${normalized}`);
    if (updateMask) {
      url.searchParams.set("updateMask", updateMask);
    }
    return this.requestJson<Notebook>(url.toString(), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: trimmed }),
    });
  }

  async createSource(parent: string, input: CreateSourceInput): Promise<Source> {
    const normalizedParent = normalizeNotebookName(parent);
    const hasUrl = Boolean(input.url);
    const hasText = input.text !== undefined;

    if (hasUrl === hasText) {
      throw new Error("Provide exactly one of 'url' (web page or YouTube video) or 'text' (plain text or Markdown).");
    }

    const body: Record<string, unknown> = {};
    if (input.displayName) {
      if (input.displayName.length > 500) {
        throw new Error("displayName cannot exceed 500 characters.");
      }
      body.displayName = input.displayName;
    }

    if (hasUrl && input.url) {
      body.webContent = { url: input.url };
    } else if (hasText && input.text !== undefined) {
      const byteLen = Buffer.byteLength(input.text, "utf8");
      if (byteLen === 0) {
        throw new Error("text content cannot be empty.");
      }
      if (byteLen > MAX_TEXT_BYTES) {
        throw new Error(
          `Inline text content is ${byteLen} bytes, which exceeds the 1,000,000 byte limit. Use upload_source for larger files.`
        );
      }
      if (input.mimeType) {
        body.mimeType = input.mimeType;
      }
      body.textContent = { content: input.text };
    }

    return this.requestJson<Source>(`${API_BASE}/${normalizedParent}/sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async uploadSource(
    parent: string,
    filePath: string,
    options?: { displayName?: string; mimeType?: string }
  ): Promise<Source> {
    const normalizedParent = normalizeNotebookName(parent);
    const resolvedPath = path.resolve(filePath);

    let realFilePath: string;
    try {
      realFilePath = await fs.promises.realpath(resolvedPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new Error(`File not found: ${resolvedPath}`);
      }
      throw err;
    }

    const blockedPaths = await Promise.all([
      resolveRealOrAbsolutePath(getClientSecretPath()),
      resolveRealOrAbsolutePath(getTokenPath()),
      resolveRealOrAbsolutePath(getPendingAuthStatePath()),
    ]);
    if (blockedPaths.includes(realFilePath)) {
      throw new Error(`Refusing to upload sensitive MCP auth file: ${resolvedPath}`);
    }

    const uploadRootEnv = process.env.NOTEBOOK_UPLOAD_ROOT?.trim();
    if (uploadRootEnv) {
      let realRoot: string;
      try {
        realRoot = await fs.promises.realpath(path.resolve(uploadRootEnv));
      } catch (err) {
        throw new Error(
          `Invalid NOTEBOOK_UPLOAD_ROOT (${uploadRootEnv}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      const rel = path.relative(realRoot, realFilePath);
      if (
        rel === "" ||
        rel === ".." ||
        rel.startsWith(`..${path.sep}`) ||
        path.isAbsolute(rel)
      ) {
        throw new Error(
          `Refusing to upload file outside NOTEBOOK_UPLOAD_ROOT (${realRoot}): ${resolvedPath}`
        );
      }
    }

    const stat = await fs.promises.stat(realFilePath);
    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${resolvedPath}`);
    }
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `File size (${stat.size} bytes) exceeds the 200 MiB (${MAX_UPLOAD_BYTES} bytes) Gemini Notebook upload limit.`
      );
    }

    const mimeType = options?.mimeType || inferMimeType(resolvedPath) || inferMimeType(realFilePath);
    if (!mimeType) {
      throw new Error(
        `Could not infer MIME type for "${path.basename(resolvedPath)}". Pass mimeType explicitly (e.g. application/pdf, text/markdown, audio/mpeg, image/png).`
      );
    }

    const displayName = options?.displayName || path.basename(resolvedPath);
    if (displayName.length > 500) {
      throw new Error("displayName cannot exceed 500 characters.");
    }

    const url = new URL(`${UPLOAD_BASE}/${normalizedParent}/sources:upload`);
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("source.displayName", displayName);

    const fileBytes = await fs.promises.readFile(realFilePath);
    const response = await this.requestJson<{ source?: Source } & Partial<Source>>(url.toString(), {
      method: "POST",
      headers: { "Content-Type": mimeType },
      body: fileBytes,
    });

    return response.source ?? (response as Source);
  }

  async getSource(name: string, options?: { deadlineMs?: number }): Promise<Source> {
    const normalized = name.trim().replace(/^\/+/, "");
    return this.requestJson<Source>(`${API_BASE}/${normalized}`, {
      deadlineMs: options?.deadlineMs,
    });
  }

  async listSources(
    parent: string,
    params?: { pageSize?: number; pageToken?: string }
  ): Promise<ListSourcesResponse> {
    const normalizedParent = normalizeNotebookName(parent);
    const url = new URL(`${API_BASE}/${normalizedParent}/sources`);
    if (params?.pageSize !== undefined) {
      url.searchParams.set("pageSize", String(params.pageSize));
    }
    if (params?.pageToken) {
      url.searchParams.set("pageToken", params.pageToken);
    }
    return this.requestJson<ListSourcesResponse>(url.toString());
  }

  async waitForSource(name: string, timeoutSeconds = 120): Promise<Source> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let delayMs = 2000;

    while (Date.now() < deadline) {
      const source = await this.getSource(name, { deadlineMs: deadline });
      if (source.state === "ACTIVE" || source.state === "FAILED" || source.state === "DELETING") {
        return source;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(delayMs, remaining));
      delayMs = Math.min(Math.round(delayMs * 1.5), 10_000);
    }

    let latestState = "UNKNOWN";
    try {
      const latest = await this.getSource(name, { deadlineMs: deadline });
      if (latest.state === "ACTIVE" || latest.state === "FAILED" || latest.state === "DELETING") {
        return latest;
      }
      latestState = latest.state ?? "UNKNOWN";
    } catch {
      // Ignore network/API errors on final status check so the timeout error is not masked.
    }

    throw new Error(
      `Source ${name} is still in state ${latestState} after ${timeoutSeconds}s.`
    );
  }
}
