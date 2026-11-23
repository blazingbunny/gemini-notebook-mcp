#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

type SingleTarget =
  | "antigravity"
  | "gemini-cli"
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "generic";

type TargetArg = SingleTarget | "google" | "claude" | "all";
type Scope = "user" | "project";

interface CliOptions {
  targets: TargetArg[];
  name: string;
  scope: Scope;
  output?: string;
  dryRun: boolean;
  portable: boolean;
  env: Record<string, string>;
  help: boolean;
}

interface StdioServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface VsCodeServerEntry extends StdioServerEntry {
  type: "stdio";
}

function printHelp(): void {
  console.log(`Usage: npm run configure -- [options]

Write or print MCP server configuration for Google, Claude, and generic MCP clients.

Options:
  --target, -t <list>   Comma-separated or repeated target(s):
                          google          Antigravity + Gemini CLI
                          antigravity     ~/.gemini/config/mcp_config.json
                          gemini-cli      ~/.gemini/settings.json (or .gemini/settings.json)
                          claude          Claude Code + Claude Desktop
                          claude-code     Claude Code (user ~/.claude.json / CLI, or project .mcp.json)
                          claude-desktop  Claude Desktop config JSON
                          cursor          ~/.cursor/mcp.json (or .cursor/mcp.json)
                          vscode          .vscode/mcp.json (or user VS Code mcp.json)
                          generic         Standard { "mcpServers": ... } JSON (stdout or --output)
                          all             google + claude + cursor + generic
                        (default: generic)
  --scope, -s <scope>   "user" (default) or "project" (current working directory)
  --name, -n <name>     MCP server name in config (default: "gemini-notebook")
  --output, -o <path>   Custom JSON file path to write/merge (for generic or single target)
  --env, -e KEY=VAL     Add an environment variable entry (repeatable)
  --portable            Use "node" instead of absolute Node binary path
  --dry-run, --print    Print resulting JSON/actions without modifying any files
  --help, -h            Show this help message

Examples:
  npm run configure -- --target google,claude
  npm run configure -- --target google --dry-run
  npm run configure -- --target claude-code --scope project
  npm run configure -- --target generic --output ./mcp.json
`);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    targets: [],
    name: "gemini-notebook",
    scope: "user",
    dryRun: false,
    portable: false,
    env: {},
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--dry-run" || arg === "--print") {
      opts.dryRun = true;
    } else if (arg === "--portable") {
      opts.portable = true;
    } else if (arg === "--target" || arg === "-t") {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      for (const part of val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        opts.targets.push(part as TargetArg);
      }
    } else if (arg.startsWith("--target=")) {
      const val = arg.slice("--target=".length);
      for (const part of val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        opts.targets.push(part as TargetArg);
      }
    } else if (arg === "--scope" || arg === "-s") {
      const val = argv[++i];
      if (val !== "user" && val !== "project") {
        throw new Error(`Invalid scope "${val}". Expected "user" or "project".`);
      }
      opts.scope = val;
    } else if (arg.startsWith("--scope=")) {
      const val = arg.slice("--scope=".length);
      if (val !== "user" && val !== "project") {
        throw new Error(`Invalid scope "${val}". Expected "user" or "project".`);
      }
      opts.scope = val;
    } else if (arg === "--name" || arg === "-n") {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      opts.name = val;
    } else if (arg.startsWith("--name=")) {
      opts.name = arg.slice("--name=".length);
    } else if (arg === "--output" || arg === "-o") {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      opts.output = val;
    } else if (arg.startsWith("--output=")) {
      opts.output = arg.slice("--output=".length);
    } else if (arg === "--env" || arg === "-e") {
      const val = argv[++i];
      if (!val || !val.includes("=")) throw new Error(`Expected KEY=VALUE for ${arg}`);
      const eq = val.indexOf("=");
      opts.env[val.slice(0, eq)] = val.slice(eq + 1);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (opts.targets.length === 0) {
    opts.targets.push("generic");
  }
  return opts;
}

function expandTargets(targets: TargetArg[]): SingleTarget[] {
  const valid = new Set<TargetArg>([
    "google",
    "antigravity",
    "gemini-cli",
    "claude",
    "claude-code",
    "claude-desktop",
    "cursor",
    "vscode",
    "generic",
    "all",
  ]);
  const out: SingleTarget[] = [];
  const add = (t: SingleTarget) => {
    if (!out.includes(t)) out.push(t);
  };

  for (const t of targets) {
    if (!valid.has(t)) {
      throw new Error(
        `Unknown target "${t}". Valid targets: google, antigravity, gemini-cli, claude, claude-code, claude-desktop, cursor, vscode, generic, all`
      );
    }
    if (t === "google") {
      add("antigravity");
      add("gemini-cli");
    } else if (t === "claude") {
      add("claude-code");
      add("claude-desktop");
    } else if (t === "all") {
      add("antigravity");
      add("gemini-cli");
      add("claude-code");
      add("claude-desktop");
      add("cursor");
      add("vscode");
      add("generic");
    } else {
      add(t);
    }
  }
  return out;
}

function getClaudeDesktopConfigPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

function getVsCodeUserMcpPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Code", "User", "mcp.json");
  }
  return path.join(home, ".config", "Code", "User", "mcp.json");
}

function resolveTargetPath(target: SingleTarget, scope: Scope, customOutput?: string): string | null {
  if (customOutput) {
    return path.resolve(customOutput);
  }
  const home = os.homedir();
  const cwd = process.cwd();

  switch (target) {
    case "antigravity":
      return path.join(home, ".gemini", "config", "mcp_config.json");
    case "gemini-cli":
      return scope === "project"
        ? path.join(cwd, ".gemini", "settings.json")
        : path.join(home, ".gemini", "settings.json");
    case "claude-code":
      return scope === "project"
        ? path.join(cwd, ".mcp.json")
        : path.join(home, ".claude.json");
    case "claude-desktop":
      return getClaudeDesktopConfigPath();
    case "cursor":
      return scope === "project"
        ? path.join(cwd, ".cursor", "mcp.json")
        : path.join(home, ".cursor", "mcp.json");
    case "vscode":
      return scope === "project"
        ? path.join(cwd, ".vscode", "mcp.json")
        : getVsCodeUserMcpPath();
    case "generic":
      return null; // print to stdout unless --output is provided
  }
}

function buildEntry(opts: CliOptions): StdioServerEntry {
  const entry: StdioServerEntry = {
    command: opts.portable ? "node" : process.execPath,
    args: [SERVER_ENTRY],
  };
  if (Object.keys(opts.env).length > 0) {
    entry.env = { ...opts.env };
  }
  return entry;
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Existing file ${filePath} does not contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function mergeAndWriteJsonConfig(
  filePath: string,
  rootKey: "mcpServers" | "servers",
  serverName: string,
  entry: StdioServerEntry | VsCodeServerEntry,
  dryRun: boolean
): { snippet: Record<string, unknown>; existed: boolean } {
  const existed = fs.existsSync(filePath);
  const existing = readJsonObject(filePath);
  const existingMap = existing[rootKey];

  if (
    existingMap !== undefined &&
    (typeof existingMap !== "object" || existingMap === null || Array.isArray(existingMap))
  ) {
    throw new Error(`Expected "${rootKey}" in ${filePath} to be a JSON object.`);
  }

  const updated: Record<string, unknown> = {
    ...existing,
    [rootKey]: {
      ...((existingMap as Record<string, unknown>) || {}),
      [serverName]: entry,
    },
  };

  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  }

  return {
    existed,
    snippet: {
      [rootKey]: {
        [serverName]: entry,
      },
    },
  };
}

function hasClaudeCli(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function configureTarget(target: SingleTarget, opts: CliOptions, singleCustomOutput?: string): void {
  const entry = buildEntry(opts);
  const isVsCode = target === "vscode";
  const rootKey: "mcpServers" | "servers" = isVsCode ? "servers" : "mcpServers";
  const shapedEntry: StdioServerEntry | VsCodeServerEntry = isVsCode
    ? { type: "stdio", ...entry }
    : entry;

  const targetPath = resolveTargetPath(target, opts.scope, singleCustomOutput);

  if (target === "generic" && !targetPath) {
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            [opts.name]: entry,
          },
        },
        null,
        2
      )
    );
    return;
  }

  // For Claude Code user scope without custom output, prefer `claude mcp add` when installed
  if (target === "claude-code" && opts.scope === "user" && !singleCustomOutput && hasClaudeCli()) {
    const cliArgs = ["mcp", "add", "-s", "user", opts.name];
    for (const [k, v] of Object.entries(opts.env)) {
      cliArgs.push("-e", `${k}=${v}`);
    }
    cliArgs.push("--", entry.command, ...entry.args);

    if (opts.dryRun) {
      console.log(`[dry-run] claude-code (CLI): claude ${cliArgs.join(" ")}`);
      return;
    }

    try {
      execFileSync("claude", ["mcp", "remove", opts.name, "-s", "user"], { stdio: "ignore" });
    } catch {
      // Not previously registered; ignore
    }
    execFileSync("claude", cliArgs, { stdio: "inherit" });
    console.log(`[ok] claude-code: registered "${opts.name}" via claude CLI (user scope)`);
    return;
  }

  if (!targetPath) {
    throw new Error(`No output path resolved for target "${target}".`);
  }

  const { snippet } = mergeAndWriteJsonConfig(
    targetPath,
    rootKey,
    opts.name,
    shapedEntry,
    opts.dryRun
  );

  if (opts.dryRun) {
    console.log(`[dry-run] ${target} -> ${targetPath}`);
    console.log(JSON.stringify(snippet, null, 2));
  } else {
    console.log(`[ok] ${target}: wrote "${opts.name}" to ${targetPath}`);
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const targets = expandTargets(opts.targets);
  if (opts.output && targets.length > 1) {
    throw new Error("--output can only be used with a single target (e.g. --target generic --output ./mcp.json).");
  }

  if (!fs.existsSync(SERVER_ENTRY)) {
    console.error(
      `Warning: ${SERVER_ENTRY} does not exist yet. Run "npm run build" before starting the MCP server.`
    );
  }

  for (const target of targets) {
    configureTarget(target, opts, opts.output);
  }
}

try {
  main();
} catch (err) {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
