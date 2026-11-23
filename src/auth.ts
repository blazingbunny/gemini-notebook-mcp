import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "..");

export const NOTEBOOK_SCOPE = "https://www.googleapis.com/auth/notebook";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const DEFAULT_REDIRECT_URI = "http://localhost";
const EXPIRY_BUFFER_MS = 60_000;

export interface OAuthClientConfig {
  client_id: string;
  client_secret: string;
  project_id?: string;
  auth_uri?: string;
  token_uri?: string;
  redirect_uris?: string[];
}

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope?: string;
  expiry_date: number; // Unix epoch ms
}

export interface PendingAuthState {
  state: string;
  code_verifier: string;
  redirect_uri: string;
  created_at: number;
}

export interface AuthResult {
  accessToken: string;
  quotaProject?: string;
  source: "env" | "oauth" | "adc";
}

export function getClientSecretPath(): string {
  return process.env.NOTEBOOK_CLIENT_SECRET_PATH || path.join(REPO_ROOT, "client_secret.json");
}

export function getTokenPath(): string {
  return process.env.NOTEBOOK_TOKEN_PATH || path.join(REPO_ROOT, "tokens.json");
}

export function getPendingAuthStatePath(): string {
  return path.join(REPO_ROOT, ".auth-state.json");
}

export function loadOAuthClientConfig(): OAuthClientConfig {
  const filePath = getClientSecretPath();
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `OAuth client config not found at ${filePath}. Download a Desktop OAuth client JSON from Google Cloud Console or set NOTEBOOK_CLIENT_SECRET_PATH.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    installed?: OAuthClientConfig;
    web?: OAuthClientConfig;
  } & Partial<OAuthClientConfig>;

  const cfg = raw.installed ?? raw.web ?? (raw as OAuthClientConfig);
  if (!cfg.client_id || !cfg.client_secret) {
    throw new Error(`Invalid client_secret.json at ${filePath}: missing client_id or client_secret.`);
  }
  return cfg;
}

export function loadStoredTokens(): StoredTokens | null {
  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as StoredTokens;
  if (!parsed.access_token && !parsed.refresh_token) {
    return null;
  }
  return parsed;
}

export function saveStoredTokens(tokens: StoredTokens): void {
  const tokenPath = getTokenPath();
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // Ignore chmod failures on filesystems that don't support POSIX modes.
  }
}

export function createAuthorizationRequest(redirectUri?: string): {
  url: string;
  pending: PendingAuthState;
} {
  const cfg = loadOAuthClientConfig();
  const chosenRedirect = redirectUri || cfg.redirect_uris?.[0] || DEFAULT_REDIRECT_URI;
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  const authUrl = new URL(cfg.auth_uri || DEFAULT_AUTH_URI);
  authUrl.searchParams.set("client_id", cfg.client_id);
  authUrl.searchParams.set("redirect_uri", chosenRedirect);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", NOTEBOOK_SCOPE);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const pending: PendingAuthState = {
    state,
    code_verifier: codeVerifier,
    redirect_uri: chosenRedirect,
    created_at: Date.now(),
  };

  return { url: authUrl.toString(), pending };
}

export function parseCodeFromRedirectInput(
  input: string,
  expectedState?: string
): { code: string; state?: string } {
  const trimmed = input.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const parsed = new URL(trimmed);
    const error = parsed.searchParams.get("error");
    if (error) {
      const desc = parsed.searchParams.get("error_description") || "";
      throw new Error(`OAuth authorization failed: ${error}${desc ? ` (${desc})` : ""}`);
    }
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state") || undefined;
    if (!code) {
      throw new Error("No 'code' query parameter found in the pasted redirect URL.");
    }
    if (expectedState && state && state !== expectedState) {
      throw new Error("OAuth state mismatch. Please generate a fresh authorization URL and try again.");
    }
    return { code, state };
  }
  return { code: trimmed };
}

export async function exchangeAuthorizationCode(
  codeOrUrl: string,
  pending?: PendingAuthState
): Promise<StoredTokens> {
  const cfg = loadOAuthClientConfig();
  const { code } = parseCodeFromRedirectInput(codeOrUrl, pending?.state);

  const body = new URLSearchParams({
    code,
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    redirect_uri: pending?.redirect_uri || cfg.redirect_uris?.[0] || DEFAULT_REDIRECT_URI,
    grant_type: "authorization_code",
  });
  if (pending?.code_verifier) {
    body.set("code_verifier", pending.code_verifier);
  }

  const resp = await fetch(cfg.token_uri || DEFAULT_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!resp.ok || !data.access_token) {
    throw new Error(
      `Failed to exchange authorization code (${resp.status}): ${data.error || "unknown_error"} ${data.error_description || ""}`.trim()
    );
  }

  const tokens: StoredTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type || "Bearer",
    scope: data.scope,
    expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  saveStoredTokens(tokens);
  return tokens;
}

async function refreshOAuthToken(existing: StoredTokens): Promise<StoredTokens> {
  if (!existing.refresh_token) {
    throw new Error(
      `Access token expired and no refresh_token is stored. Re-run authentication with: npm run auth`
    );
  }
  const cfg = loadOAuthClientConfig();
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    refresh_token: existing.refresh_token,
    grant_type: "refresh_token",
  });

  const resp = await fetch(cfg.token_uri || DEFAULT_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!resp.ok || !data.access_token) {
    throw new Error(
      `Failed to refresh OAuth token (${resp.status}): ${data.error || "unknown_error"} ${data.error_description || ""}. Re-run: npm run auth`.trim()
    );
  }

  const updated: StoredTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || existing.refresh_token,
    token_type: data.token_type || existing.token_type || "Bearer",
    scope: data.scope || existing.scope,
    expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  saveStoredTokens(updated);
  return updated;
}

async function getAdcToken(): Promise<AuthResult> {
  const gcloudBin =
    process.env.GCLOUD_BIN ||
    (fs.existsSync(path.join(process.env.HOME || "", "google-cloud-sdk/bin/gcloud"))
      ? path.join(process.env.HOME || "", "google-cloud-sdk/bin/gcloud")
      : "gcloud");

  const { stdout } = await execFileAsync(gcloudBin, [
    "auth",
    "application-default",
    "print-access-token",
  ]);
  const accessToken = stdout.trim();
  if (!accessToken) {
    throw new Error("gcloud auth application-default print-access-token returned an empty token.");
  }
  const quotaProject = process.env.NOTEBOOK_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  return { accessToken, quotaProject, source: "adc" };
}

export class AuthManager {
  private inflightRefresh: Promise<AuthResult> | null = null;

  async getAuth(forceRefresh = false): Promise<AuthResult> {
    if (process.env.NOTEBOOK_ACCESS_TOKEN && !forceRefresh) {
      return {
        accessToken: process.env.NOTEBOOK_ACCESS_TOKEN,
        quotaProject: process.env.NOTEBOOK_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
        source: "env",
      };
    }

    if (process.env.NOTEBOOK_USE_ADC === "1") {
      return getAdcToken();
    }

    const stored = loadStoredTokens();
    if (!stored) {
      // Fall back to ADC if explicitly configured or available, otherwise instruct user to run npm run auth
      try {
        return await getAdcToken();
      } catch {
        throw new Error(
          `No OAuth tokens found at ${getTokenPath()}. Run "npm run auth" in ${REPO_ROOT} to authenticate your personal Google Account.`
        );
      }
    }

    const needsRefresh =
      forceRefresh ||
      !stored.access_token ||
      !stored.expiry_date ||
      Date.now() >= stored.expiry_date - EXPIRY_BUFFER_MS;

    if (!needsRefresh) {
      return {
        accessToken: stored.access_token,
        source: "oauth",
      };
    }

    if (!this.inflightRefresh) {
      this.inflightRefresh = refreshOAuthToken(stored)
        .then((updated) => ({
          accessToken: updated.access_token,
          source: "oauth" as const,
        }))
        .finally(() => {
          this.inflightRefresh = null;
        });
    }

    return this.inflightRefresh;
  }
}
