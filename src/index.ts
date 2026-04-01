import fs from "fs";
import path from "path";

const CLAUDE_DIR = "/root/.claude";
const CREDENTIALS_PATH = path.join(CLAUDE_DIR, ".credentials.json");
const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface ClaudeAuthConfig {
  /** URL to studio-runner (e.g. "https://studio-runner-production.up.railway.app") */
  tokenServiceUrl: string;
  /** Admin API key for studio-runner */
  adminKey: string;
  /** Service name for logging (e.g. "shadow-haiku") */
  serviceName: string;
  /** Optional: Slack agent URL for alerts on failure */
  slackAgentUrl?: string;
  /** Optional: Slack post token for auth */
  slackPostToken?: string;
  /** Optional: refresh interval in ms (default: 6 hours) */
  refreshIntervalMs?: number;
  /** Optional: custom credentials path (default: /root/.claude/.credentials.json) */
  credentialsPath?: string;
}

let config: ClaudeAuthConfig | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize claude-auth. Call once at service boot.
 * Fetches credentials from studio-runner and writes to disk.
 * Returns true if credentials are available (fetched or cached).
 */
export async function setup(opts: ClaudeAuthConfig): Promise<boolean> {
  config = opts;

  const credsPath = opts.credentialsPath || CREDENTIALS_PATH;
  const credsDir = path.dirname(credsPath);

  if (!fs.existsSync(credsDir)) {
    fs.mkdirSync(credsDir, { recursive: true });
  }

  // Try to fetch fresh credentials from studio-runner
  const fetched = await fetchCredentials();
  if (fetched) {
    console.log(`[claude-auth] ${opts.serviceName}: credentials fetched from token service`);
    return true;
  }

  // Fallback: use cached credentials from volume
  if (fs.existsSync(credsPath)) {
    console.log(`[claude-auth] ${opts.serviceName}: using cached credentials from volume`);
    return true;
  }

  console.error(`[claude-auth] ${opts.serviceName}: no credentials available`);
  return false;
}

/**
 * Start auto-refresh timer. Call after setup().
 * Fetches fresh credentials from studio-runner periodically.
 */
export function startAutoRefresh(): void {
  if (!config) throw new Error("[claude-auth] Call setup() before startAutoRefresh()");
  if (refreshTimer) clearInterval(refreshTimer);

  const intervalMs = config.refreshIntervalMs || DEFAULT_REFRESH_INTERVAL_MS;

  refreshTimer = setInterval(async () => {
    console.log(`[claude-auth] ${config!.serviceName}: refreshing credentials...`);
    const ok = await fetchCredentials();
    if (!ok) {
      console.error(`[claude-auth] ${config!.serviceName}: refresh failed`);
    }
  }, intervalMs);
}

/**
 * Stop auto-refresh timer.
 */
export function stopAutoRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Get the current access token from disk.
 * Returns null if no credentials available.
 */
export function getAccessToken(): string | null {
  const credsPath = config?.credentialsPath || CREDENTIALS_PATH;
  try {
    if (!fs.existsSync(credsPath)) return null;
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    return creds.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

/**
 * Check if credentials exist on disk.
 */
export function hasCredentials(): boolean {
  const credsPath = config?.credentialsPath || CREDENTIALS_PATH;
  try {
    if (!fs.existsSync(credsPath)) return false;
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    return !!creds.claudeAiOauth?.accessToken;
  } catch {
    return false;
  }
}

/**
 * Manually write credentials to disk (for setup endpoints).
 */
export function writeCredentials(base64: string): boolean {
  const credsPath = config?.credentialsPath || CREDENTIALS_PATH;
  const credsDir = path.dirname(credsPath);
  try {
    const decoded = Buffer.from(base64, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (!parsed.claudeAiOauth) throw new Error("Invalid credentials format");

    if (!fs.existsSync(credsDir)) fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(credsPath, decoded, { mode: 0o600 });
    console.log(`[claude-auth] Credentials written via writeCredentials()`);
    return true;
  } catch (error) {
    console.error(`[claude-auth] writeCredentials failed:`, error);
    return false;
  }
}

/**
 * Register a /api/refresh-credentials endpoint on a Fastify instance.
 * When called, fetches fresh credentials from the token service.
 * Requires setup() to have been called first.
 */
export function registerRefreshEndpoint(app: any): void {
  app.post("/api/refresh-credentials", async (req: any, reply: any) => {
    if (!config) {
      return reply.code(500).send({ error: "claude-auth not initialized" });
    }

    // Verify the request comes from studio-runner (simple shared secret)
    const providedKey = req.headers["x-admin-key"];
    if (config.adminKey && providedKey !== config.adminKey) {
      return reply.code(401).send({ error: "Invalid admin key" });
    }

    console.log(`[claude-auth] ${config.serviceName}: refresh triggered by token service`);
    const ok = await fetchCredentials();
    if (ok) {
      return reply.send({ status: "ok", message: "Credentials refreshed" });
    } else {
      return reply.code(500).send({ error: "Failed to fetch credentials" });
    }
  });
}

// --- Internal ---

async function fetchCredentials(): Promise<boolean> {
  if (!config) return false;

  try {
    const response = await fetch(`${config.tokenServiceUrl}/api/claude-credentials`, {
      method: "GET",
      headers: {
        "X-Admin-Key": config.adminKey,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[claude-auth] ${config.serviceName}: fetch failed: ${response.status} ${text}`);
      await alertFailure(`Token service returned ${response.status}: ${text}`);
      return false;
    }

    const data = await response.json() as { claudeAiOauth: any; expiresAt: string };

    // Write full credentials object to disk (SDK reads from here)
    const credsPath = config.credentialsPath || CREDENTIALS_PATH;
    const credsDir = path.dirname(credsPath);
    if (!fs.existsSync(credsDir)) fs.mkdirSync(credsDir, { recursive: true });

    fs.writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: data.claudeAiOauth }), { mode: 0o600 });

    console.log(`[claude-auth] ${config.serviceName}: credentials written, expires: ${data.expiresAt}`);
    return true;
  } catch (error) {
    console.error(`[claude-auth] ${config.serviceName}: fetch error:`, error);
    await alertFailure(`Fetch error: ${error}`);
    return false;
  }
}

async function alertFailure(reason: string): Promise<void> {
  if (!config?.slackAgentUrl) return;
  try {
    await fetch(`${config.slackAgentUrl}/notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.slackPostToken
          ? { Authorization: `Bearer ${config.slackPostToken}` }
          : {}),
      },
      body: JSON.stringify({
        target: "niklas",
        message: `⚠️ *${config.serviceName}*: Kunne ikke hente Claude credentials fra token service.\nGrund: ${reason}`,
        type: "dm",
      }),
    });
  } catch {
    // Silent — don't fail on alert failure
  }
}
