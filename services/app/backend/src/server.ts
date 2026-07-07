import Fastify from "fastify";
import cors from "@fastify/cors";
import type { Container } from "./container.js";
import type { App } from "./routes/appType.js";
import { registerResourceRoutes } from "./routes/resources.js";
import { registerTaxonomyRoutes } from "./routes/taxonomy.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerExecRoutes } from "./routes/exec.js";
import type { JobLogEntry, ExecLog } from "./types.js";

/**
 * Build the Fastify app. Every /api route is guarded by the API-secret
 * middleware (spec §6): frontend attaches x-api-secret; missing/wrong → 401.
 * The frontend never talks to cronjob.org/providers directly.
 */
export function buildServer(c: Container): App {
  const app = Fastify({
    logger: c.logger as never,
    genReqId: () =>
      `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  }) as unknown as App;

  void app.register(cors, { origin: true });

  // Global error handler — log all unhandled route errors to file
  app.setErrorHandler((err, req, reply) => {
    req.log.error({
      err,
      reqId: req.id,
      method: req.method,
      url: req.url,
      body: req.body,
    }, "unhandled route error");
    reply.code(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500).send({ error: err.message });
  });

  // Log every completed request
  app.addHook("onResponse", (req, reply, done) => {
    req.log.info({
      reqId: req.id,
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      responseTime: Math.round(reply.elapsedTime),
    }, "request completed");
    done();
  });

  // API secret guard for everything under /api
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api")) return;
    const provided = req.headers["x-api-secret"];
    if (provided !== c.config.apiSecret) {
      req.log.warn({ reqId: req.id, path: req.url }, "API secret rejected");
      return reply.code(401).send({ error: "invalid or missing x-api-secret" });
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    rtdb: c.config.firebase.mode,
    time: Date.now(),
  }));

  registerResourceRoutes(app, c);
  registerTaxonomyRoutes(app, c);
  registerJobRoutes(app, c);
  registerExecRoutes(app, c);

  // Aggregate logs endpoints for the Logs UI.
  app.get<{ Querystring: { jobId?: string } }>("/api/logs/jobs", async (req) => {
    if (req.query.jobId) {
      const byId = (await c.rtdb.get<Record<string, JobLogEntry>>(`logs/jobs/${req.query.jobId}`)) ?? {};
      return Object.values(byId).sort((a, b) => b.timestamp - a.timestamp);
    }
    const all = (await c.rtdb.get<Record<string, Record<string, JobLogEntry>>>("logs/jobs")) ?? {};
    const flat: JobLogEntry[] = [];
    for (const entries of Object.values(all)) flat.push(...Object.values(entries));
    return flat.sort((a, b) => b.timestamp - a.timestamp).slice(0, 200);
  });

  app.get("/api/logs/exec", async () => {
    const all = (await c.rtdb.get<Record<string, ExecLog>>("logs/exec")) ?? {};
    return Object.values(all).sort((a, b) => b.startedAt - a.startedAt).slice(0, 200);
  });

  return app;
}
