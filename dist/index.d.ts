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
/**
 * Initialize claude-auth. Call once at service boot.
 * Fetches credentials from studio-runner and writes to disk.
 * Returns true if credentials are available (fetched or cached).
 */
export declare function setup(opts: ClaudeAuthConfig): Promise<boolean>;
/**
 * Get the current access token.
 * Priority: override > shared credentials
 */
export declare function getAccessToken(): string | null;
/**
 * Check if credentials exist (override or shared).
 */
export declare function hasCredentials(): boolean;
/**
 * Register all credential endpoints on a Fastify instance:
 *
 * - POST /api/refresh-credentials  — receive push from studio-runner
 * - POST /api/claude-override      — set a local test token
 * - DELETE /api/claude-override     — remove override, fetch shared token
 * - GET /api/claude-status          — show current credential state
 */
export declare function registerEndpoints(app: any): void;
/**
 * @deprecated Use registerEndpoints() instead. Kept for backwards compatibility.
 */
export declare function registerRefreshEndpoint(app: any): void;
/**
 * @deprecated No longer needed — push model only. This is a no-op.
 */
export declare function startAutoRefresh(): void;
/**
 * @deprecated No longer needed.
 */
export declare function stopAutoRefresh(): void;
export {};
