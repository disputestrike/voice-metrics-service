"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const promise_1 = __importDefault(require("mysql2/promise"));
// ── DB connection pool ────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL ?? "";
let pool = null;
function getPool() {
    if (pool)
        return pool;
    if (!DATABASE_URL)
        throw new Error("DATABASE_URL not set");
    pool = promise_1.default.createPool({
        uri: DATABASE_URL,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0,
        connectTimeout: 10000,
    });
    return pool;
}
async function query(sql, params = []) {
    const [rows] = await getPool().execute(sql, params);
    return rows;
}
// ── Ensure table exists ───────────────────────────────────────────────────────
async function ensureTable() {
    await getPool().execute(`
    CREATE TABLE IF NOT EXISTS \`voice_metric_events\` (
      \`id\`              int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      \`sessionId\`       varchar(128),
      \`callId\`          varchar(128),
      \`phase\`           varchar(64) NOT NULL,
      \`msSinceCallStart\` int,
      \`extra\`           json,
      \`createdAt\`       timestamp DEFAULT CURRENT_TIMESTAMP,
      KEY \`idx_voice_metric_call\`    (\`callId\`),
      KEY \`idx_voice_metric_session\` (\`sessionId\`),
      KEY \`idx_voice_metric_created\` (\`createdAt\`)
    )
  `);
    console.log("[DB] voice_metric_events table ready");
}
// ── Express app ───────────────────────────────────────────────────────────────
const app = (0, express_1.default)();
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const API_SECRET = process.env.METRICS_API_SECRET ?? "";
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: "512kb" }));
// ── Optional auth ─────────────────────────────────────────────────────────────
function optionalAuth(req, res, next) {
    if (!API_SECRET) {
        next();
        return;
    }
    const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (auth === API_SECRET || req.query.secret === API_SECRET) {
        next();
        return;
    }
    res.status(401).json({ error: "Unauthorized" });
}
// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
    let dbOk = false;
    let dbError = null;
    try {
        await query("SELECT 1");
        dbOk = true;
    }
    catch (e) {
        dbError = e.message;
    }
    res.status(dbOk ? 200 : 503).json({
        status: dbOk ? "ok" : "degraded",
        service: "voice-metrics-service",
        uptime: Math.round(process.uptime()),
        db: dbOk ? "connected" : `error: ${dbError}`,
        ts: new Date().toISOString(),
    });
});
// ── POST /metrics/event — ingest a single trace event ────────────────────────
// Called by ApexAI main service (or external tools) to persist a metric row.
app.post("/metrics/event", optionalAuth, async (req, res) => {
    const { callId, sessionId, phase, msSinceCallStart, extra } = req.body ?? {};
    if (!phase) {
        res.status(400).json({ error: "phase is required" });
        return;
    }
    try {
        await query("INSERT INTO `voice_metric_events` (`callId`, `sessionId`, `phase`, `msSinceCallStart`, `extra`) VALUES (?, ?, ?, ?, ?)", [
            callId ?? null,
            sessionId ?? null,
            String(phase),
            typeof msSinceCallStart === "number" ? msSinceCallStart : null,
            extra ? JSON.stringify(extra) : null,
        ]);
        res.status(201).json({ ok: true });
    }
    catch (e) {
        console.error("[POST /metrics/event]", e);
        res.status(500).json({ error: "DB insert failed" });
    }
});
app.get("/metrics/calls", optionalAuth, async (req, res) => {
    const limit = Math.min(200, parseInt(String(req.query.limit ?? "50"), 10) || 50);
    const hours = Math.min(168, parseInt(String(req.query.hours ?? "24"), 10) || 24);
    try {
        const rows = await query(`SELECT callId,
              COUNT(*)              AS eventCount,
              MIN(createdAt)        AS firstAt,
              MAX(createdAt)        AS lastAt
       FROM   voice_metric_events
       WHERE  callId IS NOT NULL
         AND  createdAt >= NOW() - INTERVAL ? HOUR
       GROUP BY callId
       ORDER BY lastAt DESC
       LIMIT ?`, [hours, limit]);
        res.json({ calls: rows, hours, total: rows.length });
    }
    catch (e) {
        console.error("[GET /metrics/calls]", e);
        res.status(500).json({ error: "Query failed" });
    }
});
app.get("/metrics/calls/:callId", optionalAuth, async (req, res) => {
    const { callId } = req.params;
    try {
        const rows = await query("SELECT * FROM `voice_metric_events` WHERE callId = ? ORDER BY msSinceCallStart ASC, id ASC LIMIT 500", [callId]);
        if (rows.length === 0) {
            res.status(404).json({ error: "Call not found" });
            return;
        }
        res.json({ callId, events: rows });
    }
    catch (e) {
        console.error("[GET /metrics/calls/:callId]", e);
        res.status(500).json({ error: "Query failed" });
    }
});
app.get("/metrics/summary", optionalAuth, async (req, res) => {
    const hours = Math.min(168, parseInt(String(req.query.hours ?? "24"), 10) || 24);
    function percentile(values, pct) {
        if (values.length === 0)
            return null;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor((sorted.length - 1) * pct / 100)] ?? null;
    }
    function statsFrom(values) {
        return {
            count: values.length,
            p50: percentile(values, 50),
            p95: percentile(values, 95),
            p99: percentile(values, 99),
            avg: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
        };
    }
    try {
        // STT → first TTS latency (the most important metric)
        const latencyRows = await query(`SELECT JSON_EXTRACT(extra, '$.ms') AS ms
       FROM   voice_metric_events
       WHERE  phase = 'latency_stt_final_to_tts_first'
         AND  createdAt >= NOW() - INTERVAL ? HOUR
         AND  extra IS NOT NULL
       LIMIT 2000`, [hours]);
        const latencyMs = latencyRows
            .map(r => Number(r.ms))
            .filter(v => Number.isFinite(v) && v > 0);
        const phaseRows = await query(`SELECT phase, COUNT(*) AS cnt
       FROM   voice_metric_events
       WHERE  createdAt >= NOW() - INTERVAL ? HOUR
       GROUP BY phase
       ORDER BY cnt DESC
       LIMIT 50`, [hours]);
        const callCount = await query(`SELECT COUNT(DISTINCT callId) AS n
       FROM   voice_metric_events
       WHERE  createdAt >= NOW() - INTERVAL ? HOUR`, [hours]);
        // Budget exceeded count
        const budgetRows = await query(`SELECT COUNT(*) AS n
       FROM   voice_metric_events
       WHERE  phase = 'latency_budget_exceeded'
         AND  createdAt >= NOW() - INTERVAL ? HOUR`, [hours]);
        // Total turns (tts_first_clause_streaming events = one per turn)
        const turnRows = await query(`SELECT COUNT(*) AS n
       FROM   voice_metric_events
       WHERE  phase = 'tts_first_clause_streaming'
         AND  createdAt >= NOW() - INTERVAL ? HOUR`, [hours]);
        res.json({
            generatedAt: new Date().toISOString(),
            windowHours: hours,
            uniqueCalls: callCount[0]?.n ?? 0,
            totalTurns: turnRows[0]?.n ?? 0,
            latencyBudgetExceeded: budgetRows[0]?.n ?? 0,
            sttToTtsFirstMs: statsFrom(latencyMs),
            phaseBreakdown: phaseRows,
        });
    }
    catch (e) {
        console.error("[GET /metrics/summary]", e);
        res.status(500).json({ error: "Query failed" });
    }
});
// ── GET /metrics/latency/histogram — latency distribution ────────────────────
app.get("/metrics/latency/histogram", optionalAuth, async (req, res) => {
    const hours = Math.min(168, parseInt(String(req.query.hours ?? "24"), 10) || 24);
    const buckets = [200, 300, 400, 500, 600, 700, 800, 1000, 1200, 1500, 2000, Infinity];
    try {
        const rows = await query(`SELECT JSON_EXTRACT(extra, '$.ms') AS ms
       FROM   voice_metric_events
       WHERE  phase = 'latency_stt_final_to_tts_first'
         AND  createdAt >= NOW() - INTERVAL ? HOUR
         AND  extra IS NOT NULL
       LIMIT 5000`, [hours]);
        const values = rows.map(r => Number(r.ms)).filter(v => Number.isFinite(v) && v > 0);
        const histogram = [];
        let prev = 0;
        for (const ceil of buckets) {
            const label = ceil === Infinity ? `>${prev}ms` : `${prev}–${ceil}ms`;
            const count = values.filter(v => v > prev && v <= ceil).length;
            histogram.push({ bucket: label, count, pct: values.length ? Math.round(count / values.length * 100) : 0 });
            prev = ceil;
        }
        res.json({ windowHours: hours, total: values.length, histogram });
    }
    catch (e) {
        console.error("[GET /metrics/latency/histogram]", e);
        res.status(500).json({ error: "Query failed" });
    }
});
// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({
        error: "Not found",
        endpoints: [
            "GET  /api/health",
            "GET  /metrics/calls",
            "GET  /metrics/calls/:callId",
            "GET  /metrics/summary",
            "GET  /metrics/latency/histogram",
            "POST /metrics/event",
        ],
    });
});
// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
    // Validate DB connection and ensure table exists on startup
    if (DATABASE_URL) {
        try {
            await ensureTable();
        }
        catch (e) {
            console.error("[STARTUP] DB init failed:", e.message);
            console.error("  → Service will start but DB endpoints will return errors.");
            console.error("  → Check DATABASE_URL is set correctly in Railway variables.");
        }
    }
    else {
        console.warn("[STARTUP] DATABASE_URL not set — DB endpoints will be unavailable");
    }
    app.listen(PORT, () => {
        console.log(`[voice-metrics-service] Listening on port ${PORT}`);
        console.log(`  Health:   http://localhost:${PORT}/api/health`);
        console.log(`  Summary:  http://localhost:${PORT}/metrics/summary`);
        console.log(`  DB:       ${DATABASE_URL ? "configured" : "MISSING (set DATABASE_URL)"}`);
        console.log(`  Auth:     ${API_SECRET ? "enabled (METRICS_API_SECRET)" : "open (no secret set)"}`);
    });
}
start().catch((e) => {
    console.error("[FATAL]", e);
    process.exit(1);
});
exports.default = app;
//# sourceMappingURL=index.js.map