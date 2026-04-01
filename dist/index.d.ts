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
/**
 * Initialize claude-auth. Call once at service boot.
 * Fetches credentials from studio-runner and writes to disk.
 * Returns true if credentials are available (fetched or cached).
 */
export declare function setup(opts: ClaudeAuthConfig): Promise<boolean>;
/**
 * Start auto-refresh timer. Call after setup().
 * Fetches fresh credentials from studio-runner periodically.
 */
export declare function startAutoRefresh(): void;
/**
 * Stop auto-refresh timer.
 */
export declare function stopAutoRefresh(): void;
/**
 * Get the current access token from disk.
 * Returns null if no credentials available.
 */
export declare function getAccessToken(): string | null;
/**
 * Check if credentials exist on disk.
 */
export declare function hasCredentials(): boolean;
/**
 * Manually write credentials to disk (for setup endpoints).
 */
export declare function writeCredentials(base64: string): boolean;
/**
 * Register a /api/refresh-credentials endpoint on a Fastify instance.
 * When called, fetches fresh credentials from the token service.
 * Requires setup() to have been called first.
 */
export declare function registerRefreshEndpoint(app: any): void;
export {};
