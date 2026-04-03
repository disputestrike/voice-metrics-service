/**
 * ApexAI Voice Metrics Service
 *
 * Reads voice_metric_events from the shared ApexAI MySQL database and
 * exposes a lightweight HTTP API + dashboard for call quality monitoring.
 *
 * Required env vars:
 *   DATABASE_URL  — MySQL connection string (shared with ApexAI main service)
 *   PORT          — HTTP port (default 3001)
 *
 * Optional:
 *   METRICS_API_SECRET — Bearer token to protect read endpoints
 *   REDIS_URL          — Reserved for future pub/sub streaming (unused for now)
 */
import "dotenv/config";
declare const app: import("express-serve-static-core").Express;
export default app;
//# sourceMappingURL=index.d.ts.map