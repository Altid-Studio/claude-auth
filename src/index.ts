import fs from "fs";
import path from "path";

const CLAUDE_DIR = "/root/.claude";
const CREDENTIALS_PATH = path.join(CLAUDE_DIR, ".credentials.json");
const OVERRIDE_PATH = path.join(CLAUDE_DIR, ".credentials-override.json");

interface ClaudeAuthConfig {
  /** URL to studio-runner (e.g. "https://studio-runner-production.up.railway.app") */
  tokenServiceUrl: string;
  /** Admin API key for studio-runner */
  adminKey: string;
  /** Service name for logging (e.g. "knowledge-agent") */
  serviceName: string;
  /** Optional: custom credentials path (default: /root/.claude/.credentials.json) */
  credentialsPath?: string;
}

let config: ClaudeAuthConfig | null = null;

/**
 * Initialize claude-auth. Call once at service boot.
 * Fetches credentials from studio-runner and writes to disk.
 * Returns true if credentials are available (fetched or cached).
 */
export async function setup(opts: ClaudeAuthConfig): Promise<boolean> {
  config = opts;

  const credsDir = path.dirname(opts.credentialsPath ?? CREDENTIALS_PATH);
  if (!fs.existsSync(credsDir)) {
    fs.mkdirSync(credsDir, { recursive: true });
  }

  // If override is active, use that
  if (hasOverride()) {
    console.log(`[claude-auth] ${opts.serviceName}: override active — using local token`);
    return true;
  }

  // Fetch from studio-runner
  const fetched = await fetchCredentials();
  if (fetched) {
    console.log(`[claude-auth] ${opts.serviceName}: credentials fetched from studio-runner`);
    return true;
  }

  // Fallback: cached credentials on volume
  const credsPath = opts.credentialsPath ?? CREDENTIALS_PATH;
  if (fs.existsSync(credsPath)) {
    console.log(`[claude-auth] ${opts.serviceName}: using cached credentials from volume`);
    return true;
  }

  console.error(`[claude-auth] ${opts.serviceName}: no credentials available`);
  return false;
}

/**
 * Get the current access token.
 * Priority: override > shared credentials
 */
export function getAccessToken(): string | null {
  // Override takes priority
  const override = readOverride();
  if (override) return override;

  // Shared credentials
  const credsPath = config?.credentialsPath ?? CREDENTIALS_PATH;
  try {
    if (!fs.existsSync(credsPath)) return null;
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    return creds.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

/**
 * Check if credentials exist (override or shared).
 */
export function hasCredentials(): boolean {
  if (hasOverride()) return true;
  const credsPath = config?.credentialsPath ?? CREDENTIALS_PATH;
  try {
    if (!fs.existsSync(credsPath)) return false;
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    return !!creds.claudeAiOauth?.accessToken;
  } catch {
    return false;
  }
}

/**
 * Register all credential endpoints on a Fastify instance:
 *
 * - POST /api/refresh-credentials  — receive push from studio-runner
 * - POST /api/claude-override      — set a local test token
 * - DELETE /api/claude-override     — remove override, fetch shared token
 * - GET /api/claude-status          — show current credential state
 */
export function registerEndpoints(app: any): void {
  // Push endpoint — studio-runner calls this when token changes
  app.post("/api/refresh-credentials", async (req: any, reply: any) => {
    if (!config) {
      return reply.code(500).send({ error: "claude-auth not initialized" });
    }

    const providedKey = req.headers["x-admin-key"];
    if (config.adminKey && providedKey !== config.adminKey) {
      return reply.code(401).send({ error: "Invalid admin key" });
    }

    if (hasOverride()) {
      console.log(`[claude-auth] ${config.serviceName}: override active — ignoring push`);
      return reply.send({ status: "skipped", reason: "override active" });
    }

    console.log(`[claude-auth] ${config.serviceName}: refresh pushed by studio-runner`);
    const ok = await fetchCredentials();
    return ok
      ? reply.send({ status: "ok", message: "Credentials refreshed" })
      : reply.code(500).send({ error: "Failed to fetch credentials" });
  });

  // Override — set a test/custom token
  app.post("/api/claude-override", async (req: any, reply: any) => {
    if (!config) {
      return reply.code(500).send({ error: "claude-auth not initialized" });
    }

    const providedKey = req.headers["x-admin-key"];
    if (config.adminKey && providedKey !== config.adminKey) {
      return reply.code(401).send({ error: "Invalid admin key" });
    }

    const { apiKey } = req.body as { apiKey?: string };
    if (!apiKey) {
      return reply.code(400).send({ error: "Missing apiKey in body" });
    }

    setOverride(apiKey);
    console.log(`[claude-auth] ${config.serviceName}: override SET — using custom token`);
    return reply.send({ status: "ok", message: "Override active. POST /api/refresh-credentials or DELETE /api/claude-override to return to shared token." });
  });

  // Remove override — return to shared token
  app.delete("/api/claude-override", async (req: any, reply: any) => {
    if (!config) {
      return reply.code(500).send({ error: "claude-auth not initialized" });
    }

    const providedKey = req.headers["x-admin-key"];
    if (config.adminKey && providedKey !== config.adminKey) {
      return reply.code(401).send({ error: "Invalid admin key" });
    }

    clearOverride();
    console.log(`[claude-auth] ${config.serviceName}: override REMOVED — fetching shared token`);
    const ok = await fetchCredentials();
    return reply.send({
      status: ok ? "ok" : "warning",
      message: ok ? "Override removed, shared credentials restored" : "Override removed but failed to fetch shared credentials",
    });
  });

  // Status — show current credential state
  app.get("/api/claude-status", async (_req: any, reply: any) => {
    const overrideActive = hasOverride();
    const hasShared = hasSharedCredentials();
    const hasAny = overrideActive || hasShared;

    return reply.send({
      hasCredentials: hasAny,
      source: overrideActive ? "override" : hasShared ? "shared" : "none",
      serviceName: config?.serviceName || "unknown",
    });
  });
}

/**
 * @deprecated Use registerEndpoints() instead. Kept for backwards compatibility.
 */
export function registerRefreshEndpoint(app: any): void {
  registerEndpoints(app);
}

/**
 * @deprecated No longer needed — push model only. This is a no-op.
 */
export function startAutoRefresh(): void {
  console.log(`[claude-auth] startAutoRefresh() is deprecated — push model active, no polling needed`);
}

/**
 * @deprecated No longer needed.
 */
export function stopAutoRefresh(): void {
  // no-op
}

// --- Override management ---

function hasOverride(): boolean {
  const overridePath = config?.credentialsPath
    ? config.credentialsPath.replace(".credentials.json", ".credentials-override.json")
    : OVERRIDE_PATH;
  return fs.existsSync(overridePath);
}

function readOverride(): string | null {
  const overridePath = config?.credentialsPath
    ? config.credentialsPath.replace(".credentials.json", ".credentials-override.json")
    : OVERRIDE_PATH;
  try {
    if (!fs.existsSync(overridePath)) return null;
    const data = JSON.parse(fs.readFileSync(overridePath, "utf-8"));
    return data.apiKey || null;
  } catch {
    return null;
  }
}

function setOverride(apiKey: string): void {
  const overridePath = config?.credentialsPath
    ? config.credentialsPath.replace(".credentials.json", ".credentials-override.json")
    : OVERRIDE_PATH;
  const dir = path.dirname(overridePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(overridePath, JSON.stringify({ apiKey, setAt: new Date().toISOString() }), { mode: 0o600 });
}

function clearOverride(): void {
  const overridePath = config?.credentialsPath
    ? config.credentialsPath.replace(".credentials.json", ".credentials-override.json")
    : OVERRIDE_PATH;
  try {
    if (fs.existsSync(overridePath)) fs.unlinkSync(overridePath);
  } catch {
    // ignore
  }
}

function hasSharedCredentials(): boolean {
  const credsPath = config?.credentialsPath ?? CREDENTIALS_PATH;
  try {
    if (!fs.existsSync(credsPath)) return false;
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    return !!creds.claudeAiOauth?.accessToken;
  } catch {
    return false;
  }
}

// --- Fetch from studio-runner ---

async function fetchCredentials(): Promise<boolean> {
  if (!config) return false;

  try {
    const response = await fetch(`${config.tokenServiceUrl}/api/claude-credentials`, {
      method: "GET",
      headers: { "X-Admin-Key": config.adminKey },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[claude-auth] ${config.serviceName}: fetch failed: ${response.status} ${text}`);
      return false;
    }

    const data = (await response.json()) as { claudeAiOauth: any; expiresAt: string };

    const credsPath = config.credentialsPath ?? CREDENTIALS_PATH;
    const credsDir = path.dirname(credsPath);
    if (!fs.existsSync(credsDir)) fs.mkdirSync(credsDir, { recursive: true });

    fs.writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: data.claudeAiOauth }), { mode: 0o600 });

    console.log(`[claude-auth] ${config.serviceName}: credentials written, expires: ${data.expiresAt}`);
    return true;
  } catch (error) {
    console.error(`[claude-auth] ${config.serviceName}: fetch error:`, error);
    return false;
  }
}
