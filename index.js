/**
 * ApexAI Voice Metrics Service — plain Node.js, no build step required.
 * Reads voice_metric_events from MySQL and exposes a metrics API.
 *
 * Env vars:
 *   DATABASE_URL  (required) — MySQL connection string
 *   PORT          (default 3001)
 *   METRICS_API_SECRET (optional)
 */

const http = require("http");
const url = require("url");

const PORT = parseInt(process.env.PORT || "3001", 10);
const DATABASE_URL = process.env.DATABASE_URL || "";
const API_SECRET = process.env.METRICS_API_SECRET || "";

// ── DB pool (lazy-loaded so startup never crashes if mysql2 isn't installed) ──
let pool = null;

function getPool() {
  if (pool) return pool;
  if (!DATABASE_URL) throw new Error("DATABASE_URL not configured");
  const mysql = require("mysql2/promise");
  pool = mysql.createPool({
    uri: DATABASE_URL,
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10000,
  });
  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

async function ensureTable() {
  await getPool().execute(`
    CREATE TABLE IF NOT EXISTS \`voice_metric_events\` (
      \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      \`sessionId\` varchar(128),
      \`callId\` varchar(128),
      \`phase\` varchar(64) NOT NULL,
      \`msSinceCallStart\` int,
      \`extra\` json,
      \`createdAt\` timestamp DEFAULT CURRENT_TIMESTAMP,
      KEY \`idx_vme_call\` (\`callId\`),
      KEY \`idx_vme_session\` (\`sessionId\`),
      KEY \`idx_vme_created\` (\`createdAt\`)
    )
  `);
  console.log("[DB] voice_metric_events table ready");

  // Quality events table — stores per-call guardrail failure results
  await getPool().execute(`
    CREATE TABLE IF NOT EXISTS \`call_quality_events\` (
      \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      \`callId\` varchar(128) NOT NULL,
      \`sessionId\` varchar(128),
      \`healthy\` tinyint(1) NOT NULL DEFAULT 1,
      \`failureCount\` int NOT NULL DEFAULT 0,
      \`failureCodes\` json COMMENT 'Array of failure mode code strings',
      \`severityBreakdown\` json COMMENT '{trust_killing, conversion_killing, compliance_risk, polish_level}',
      \`createdAt\` timestamp DEFAULT CURRENT_TIMESTAMP,
      KEY \`idx_cqe_call\` (\`callId\`),
      KEY \`idx_cqe_healthy\` (\`healthy\`),
      KEY \`idx_cqe_created\` (\`createdAt\`)
    )
  `);
  console.log("[DB] call_quality_events table ready");
}

// ── Auth check ────────────────────────────────────────────────────────────────
function isAuthed(req) {
  if (!API_SECRET) return true;
  const auth = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const qs = new url.URL(req.url, "http://x").searchParams;
  return auth === API_SECRET || qs.get("secret") === API_SECRET;
}

// ── JSON response helpers ─────────────────────────────────────────────────────
function safeJson(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "object") return val; // already parsed by mysql2
  try { return JSON.parse(val); } catch { return fallback; }
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

function percentile(arr, pct) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * pct / 100)] ?? null;
}
function stats(arr) {
  return {
    count: arr.length,
    p50: percentile(arr, 50),
    p95: percentile(arr, 95),
    p99: percentile(arr, 99),
    avg: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null,
  };
}

// ── Router ────────────────────────────────────────────────────────────────────
async function handle(req, res) {
  const parsed = new url.URL(req.url, "http://x");
  const path = parsed.pathname;
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Authorization,Content-Type" });
    res.end();
    return;
  }

  // Health — no auth required
  if (path === "/api/health" && method === "GET") {
    let dbOk = false, dbErr = null;
    try { await query("SELECT 1"); dbOk = true; } catch (e) { dbErr = e.message; }
    send(res, dbOk ? 200 : 503, {
      status: dbOk ? "ok" : "degraded",
      service: "voice-metrics-service",
      uptime: Math.round(process.uptime()),
      db: dbOk ? "connected" : `error: ${dbErr}`,
      ts: new Date().toISOString(),
    });
    return;
  }

  // Auth gate for all other routes
  if (!isAuthed(req)) { send(res, 401, { error: "Unauthorized" }); return; }

  // POST /metrics/event
  if (path === "/metrics/event" && method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const d = JSON.parse(body || "{}");
        if (!d.phase) { send(res, 400, { error: "phase required" }); return; }
        await query(
          "INSERT INTO `voice_metric_events` (`callId`,`sessionId`,`phase`,`msSinceCallStart`,`extra`) VALUES (?,?,?,?,?)",
          [d.callId || null, d.sessionId || null, String(d.phase),
           typeof d.msSinceCallStart === "number" ? d.msSinceCallStart : null,
           d.extra ? JSON.stringify(d.extra) : null]
        );

        // If this is a qa_result event, also write to call_quality_events for dashboard
        if (d.phase === "qa_result" && d.callId && d.extra) {
          const ex = d.extra;
          try {
            await query(
              "INSERT INTO `call_quality_events` (`callId`,`sessionId`,`healthy`,`failureCount`,`failureCodes`,`severityBreakdown`) VALUES (?,?,?,?,?,?)",
              [
                d.callId,
                d.sessionId || null,
                ex.healthy === true ? 1 : 0,
                typeof ex.failureCount === "number" ? ex.failureCount : 0,
                ex.codes ? JSON.stringify(ex.codes) : JSON.stringify([]),
                ex.severity_breakdown ? JSON.stringify(ex.severity_breakdown) : null,
              ]
            );
          } catch (qErr) {
            // Non-critical — still return 201 for the metric event
            console.error("[QA] Failed to write call_quality_events:", qErr.message);
          }
        }

        send(res, 201, { ok: true });
      } catch (e) { send(res, 500, { error: e.message }); }
    });
    return;
  }

  // GET /metrics/summary
  if (path === "/metrics/summary" && method === "GET") {
    const hours = Math.min(168, parseInt(parsed.searchParams.get("hours") || "24") || 24);
    try {
      const latRows = await query(
        "SELECT JSON_EXTRACT(extra,'$.ms') AS ms FROM `voice_metric_events` WHERE phase='latency_stt_final_to_tts_first' AND createdAt>=NOW()-INTERVAL ? HOUR AND extra IS NOT NULL LIMIT 2000",
        [hours]
      );
      const latMs = latRows.map(r => Number(r.ms)).filter(v => isFinite(v) && v > 0);

      const phases = await query(
        "SELECT phase, COUNT(*) AS cnt FROM `voice_metric_events` WHERE createdAt>=NOW()-INTERVAL ? HOUR GROUP BY phase ORDER BY cnt DESC LIMIT 30",
        [hours]
      );
      const [callRow] = await query("SELECT COUNT(DISTINCT callId) AS n FROM `voice_metric_events` WHERE createdAt>=NOW()-INTERVAL ? HOUR", [hours]);
      const [budgetRow] = await query("SELECT COUNT(*) AS n FROM `voice_metric_events` WHERE phase='latency_budget_exceeded' AND createdAt>=NOW()-INTERVAL ? HOUR", [hours]);
      const [turnRow] = await query("SELECT COUNT(*) AS n FROM `voice_metric_events` WHERE phase='tts_first_clause_streaming' AND createdAt>=NOW()-INTERVAL ? HOUR", [hours]);

      send(res, 200, {
        generatedAt: new Date().toISOString(),
        windowHours: hours,
        uniqueCalls: callRow?.n ?? 0,
        totalTurns: turnRow?.n ?? 0,
        latencyBudgetExceeded: budgetRow?.n ?? 0,
        sttToTtsFirstMs: stats(latMs),
        phaseBreakdown: phases,
      });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // GET /metrics/calls
  if (path === "/metrics/calls" && method === "GET") {
    const hours = Math.min(168, parseInt(parsed.searchParams.get("hours") || "24") || 24);
    const limit = Math.min(200, parseInt(parsed.searchParams.get("limit") || "50") || 50);
    try {
      const rows = await query(
        "SELECT callId, COUNT(*) AS eventCount, MIN(createdAt) AS firstAt, MAX(createdAt) AS lastAt FROM `voice_metric_events` WHERE callId IS NOT NULL AND createdAt>=NOW()-INTERVAL ? HOUR GROUP BY callId ORDER BY lastAt DESC LIMIT ?",
        [hours, limit]
      );
      send(res, 200, { calls: rows, hours, total: rows.length });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // GET /metrics/quality
  // Returns call quality summary from the guardrail QA tagger.
  // Query params: hours (default 24), limit (default 100), healthy (true|false)
  if (path === "/metrics/quality" && method === "GET") {
    const hours = Math.min(720, parseInt(parsed.searchParams.get("hours") || "24") || 24);
    const limit = Math.min(500, parseInt(parsed.searchParams.get("limit") || "100") || 100);
    const healthyFilter = parsed.searchParams.get("healthy");
    try {
      // Overall summary
      const [totalRow] = await query(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN healthy=0 THEN 1 ELSE 0 END) AS unhealthy, SUM(healthy) AS healthy FROM `call_quality_events` WHERE createdAt>=NOW()-INTERVAL ? HOUR",
        [hours]
      );

      // Failure code frequency
      const bucketRows = await query(
        `SELECT phase, COUNT(*) AS cnt FROM \`voice_metric_events\` WHERE phase LIKE 'qa_failure:%' AND createdAt>=NOW()-INTERVAL ? HOUR GROUP BY phase ORDER BY cnt DESC LIMIT 20`,
        [hours]
      );

      // Per-call quality detail
      let sql = "SELECT callId, sessionId, healthy, failureCount, failureCodes, severityBreakdown, createdAt FROM `call_quality_events` WHERE createdAt>=NOW()-INTERVAL ? HOUR";
      const sqlParams = [hours];
      if (healthyFilter === "false") { sql += " AND healthy=0"; }
      else if (healthyFilter === "true") { sql += " AND healthy=1"; }
      sql += " ORDER BY createdAt DESC LIMIT ?";
      sqlParams.push(limit);
      const callRows = await query(sql, sqlParams);

      // Parse JSON columns
      const calls = callRows.map(r => ({
        callId: r.callId,
        sessionId: r.sessionId,
        healthy: r.healthy === 1,
        failureCount: r.failureCount,
        failureCodes: safeJson(r.failureCodes, []),
        severityBreakdown: safeJson(r.severityBreakdown, {}),
        createdAt: r.createdAt,
      }));

      // Failure code breakdown (normalized)
      const buckets = bucketRows.map(r => ({
        code: String(r.phase).replace("qa_failure:", ""),
        count: r.cnt,
      }));

      send(res, 200, {
        hours,
        summary: {
          total: Number(totalRow?.total ?? 0),
          healthy: Number(totalRow?.healthy ?? 0),
          unhealthy: Number(totalRow?.unhealthy ?? 0),
          healthRate: totalRow?.total > 0
            ? Math.round((totalRow.healthy / totalRow.total) * 100)
            : null,
        },
        failureBuckets: buckets,
        calls,
      });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // GET /metrics/calls/:callId
  const callMatch = path.match(/^\/metrics\/calls\/([^/]+)$/);
  if (callMatch && method === "GET") {
    const callId = decodeURIComponent(callMatch[1]);
    try {
      const rows = await query(
        "SELECT * FROM `voice_metric_events` WHERE callId=? ORDER BY msSinceCallStart ASC, id ASC LIMIT 500",
        [callId]
      );
      if (!rows.length) { send(res, 404, { error: "Call not found" }); return; }
      send(res, 200, { callId, events: rows });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // GET /metrics/latency/histogram
  if (path === "/metrics/latency/histogram" && method === "GET") {
    const hours = Math.min(168, parseInt(parsed.searchParams.get("hours") || "24") || 24);
    const buckets = [200, 300, 400, 500, 600, 700, 800, 1000, 1200, 1500, 2000, Infinity];
    try {
      const rows = await query(
        "SELECT JSON_EXTRACT(extra,'$.ms') AS ms FROM `voice_metric_events` WHERE phase='latency_stt_final_to_tts_first' AND createdAt>=NOW()-INTERVAL ? HOUR AND extra IS NOT NULL LIMIT 5000",
        [hours]
      );
      const values = rows.map(r => Number(r.ms)).filter(v => isFinite(v) && v > 0);
      let prev = 0;
      const histogram = buckets.map(ceil => {
        const label = ceil === Infinity ? `>${prev}ms` : `${prev}–${ceil}ms`;
        const count = values.filter(v => v > prev && v <= ceil).length;
        const pct = values.length ? Math.round(count / values.length * 100) : 0;
        prev = ceil;
        return { bucket: label, count, pct };
      });
      send(res, 200, { windowHours: hours, total: values.length, histogram });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // 404
  send(res, 404, {
    error: "Not found",
    endpoints: ["GET /api/health","GET /metrics/summary","GET /metrics/calls","GET /metrics/calls/:callId","GET /metrics/latency/histogram","GET /metrics/quality","POST /metrics/event"],
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  if (DATABASE_URL) {
    try { await ensureTable(); }
    catch (e) { console.warn("[STARTUP] DB init warning:", e.message); }
  } else {
    console.warn("[STARTUP] DATABASE_URL not set");
  }

  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); }
    catch (e) { send(res, 500, { error: "Internal error" }); }
  });

  server.listen(PORT, () => {
    console.log(`[voice-metrics-service] Listening on port ${PORT}`);
    console.log(`  Health:  http://localhost:${PORT}/api/health`);
    console.log(`  DB:      ${DATABASE_URL ? "configured" : "MISSING"}`);
    console.log(`  Auth:    ${API_SECRET ? "enabled" : "open"}`);
  });
}

start().catch(e => { console.error("[FATAL]", e); process.exit(1); });
