import fs from "node:fs";
import http from "node:http";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  getPendingAuthStatePath,
  getTokenPath,
  PendingAuthState,
} from "./auth.js";

async function runCallbackServer(port: number): Promise<void> {
  const statePath = getPendingAuthStatePath();
  const redirectUri = `http://localhost:${port}/callback`;
  const { url, pending } = createAuthorizationRequest(redirectUri);
  fs.writeFileSync(statePath, JSON.stringify(pending, null, 2) + "\n", { mode: 0o600 });

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url || !req.url.startsWith("/callback")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      try {
        const fullUrl = `http://localhost:${port}${req.url}`;
        const tokens = await exchangeAuthorizationCode(fullUrl, pending);
        if (fs.existsSync(statePath)) {
          fs.unlinkSync(statePath);
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><html><body style='font-family:system-ui;padding:2rem'><h2>Gemini Notebook MCP Authenticated</h2><p>OAuth tokens saved with auto-refresh enabled. You can close this tab and return to your agent.</p></body></html>"
        );
        console.log(
          JSON.stringify(
            {
              status: "authenticated",
              tokenPath: getTokenPath(),
              hasRefreshToken: Boolean(tokens.refresh_token),
              scope: tokens.scope,
              expiresAt: new Date(tokens.expiry_date).toISOString(),
            },
            null,
            2
          )
        );
        server.close(() => resolve());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Authentication failed: ${message}`);
        server.close(() => reject(err));
      }
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`AUTH_URL=${url}`);
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const statePath = getPendingAuthStatePath();

  if (args[0] === "--listen") {
    const port = args[1] ? Number(args[1]) : 8765;
    await runCallbackServer(port);
    return;
  }

  if (args[0] === "--url") {
    const { url, pending } = createAuthorizationRequest();
    fs.writeFileSync(statePath, JSON.stringify(pending, null, 2) + "\n", { mode: 0o600 });
    console.log(url);
    return;
  }

  if (args[0] === "--exchange") {
    const codeOrUrl = args[1];
    if (!codeOrUrl) {
      console.error("Usage: node dist/auth-cli.js --exchange <redirect-url-or-code>");
      process.exit(1);
    }
    let pending: PendingAuthState | undefined;
    if (fs.existsSync(statePath)) {
      pending = JSON.parse(fs.readFileSync(statePath, "utf8")) as PendingAuthState;
    }
    const tokens = await exchangeAuthorizationCode(codeOrUrl, pending);
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
    console.log(
      JSON.stringify(
        {
          status: "authenticated",
          tokenPath: getTokenPath(),
          hasRefreshToken: Boolean(tokens.refresh_token),
          scope: tokens.scope,
          expiresAt: new Date(tokens.expiry_date).toISOString(),
        },
        null,
        2
      )
    );
    return;
  }

  // Interactive headless-friendly flow
  const { url, pending } = createAuthorizationRequest();
  fs.writeFileSync(statePath, JSON.stringify(pending, null, 2) + "\n", { mode: 0o600 });

  console.log("\n1. Open this URL in your browser and sign in with your personal Google Account:\n");
  console.log(url);
  console.log(
    "\n2. After approving, your browser will redirect to http://localhost/?code=... (it's normal if the page says it can't connect)."
  );
  console.log("   Copy the full URL from your browser's address bar and paste it below.\n");

  const rl = readline.createInterface({ input, output });
  try {
    const pasted = await rl.question("Paste redirect URL (or code): ");
    const tokens = await exchangeAuthorizationCode(pasted, pending);
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
    console.log(`\nSaved OAuth tokens to ${getTokenPath()}`);
    console.log(`Refresh token stored: ${tokens.refresh_token ? "yes (auto-refresh enabled)" : "no"}`);
    console.log(`Expires at: ${new Date(tokens.expiry_date).toISOString()}`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Authentication error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
