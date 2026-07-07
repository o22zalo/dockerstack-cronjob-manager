import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { createServer } from "node:http";
import { loadConfig } from "../../src/config/env.js";
import { createLogger } from "../../src/logger.js";
import { buildContainer } from "../../src/container.js";
import { buildServer } from "../../src/server.js";
import { MemoryRtdb } from "../../src/db/memoryRtdb.js";
import { startFakeCronjob, type FakeCronjobServer } from "../emulator/fakeCronjob.js";
import type { Container } from "../../src/container.js";
import type { App } from "../../src/routes/appType.js";

/**
 * Smoke test for new business flows: providers (GitHub/Azure fetch via
 * saved tokens), curl export, task tracker, and app logs.
 *
 * Since we cannot call real GitHub/Azure from CI, provider routes that
 * require outbound HTTP are tested for correct 404/wiring.  The actual
 * provider client logic is validated by the types + build passing.
 */
const SECRET = "biz-secret";
const handlersDir = path.resolve(__dirname, "../../handlers");
const auth = { "x-api-secret": SECRET };

let app: App;
let container: Container;
let fake: FakeCronjobServer;

beforeAll(async () => {
  fake = await startFakeCronjob();
  const config = loadConfig(
    {
      API_SECRET: SECRET,
      FIREBASE_DB_URL: "x",
      CRONJOB_API_BASE: fake.url,
      EXEC_HANDLERS_DIR: handlersDir,
      LOG_LEVEL: "silent",
    },
    { allowNone: true },
  );
  container = buildContainer(config, createLogger({ ...config, logLevel: "silent" }), new MemoryRtdb());
  await container.queue.start();
  app = buildServer(container);
  await app.ready();
});

afterAll(async () => {
  container.queue.stop();
  await app.close();
  await fake.close();
});

describe("Business: Task Tracker CRUD", () => {
  it("create → list → patch → delete task", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: auth,
      payload: { title: "Fix login bug", kind: "bug", priority: "high", tags: ["frontend"] },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;
    expect(create.json().title).toBe("Fix login bug");

    const list = await app.inject({ method: "GET", url: "/api/tasks", headers: auth });
    expect(list.json().length).toBeGreaterThanOrEqual(1);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      headers: auth,
      payload: { status: "in_progress" },
    });
    expect(patch.json().status).toBe("in_progress");

    const del = await app.inject({ method: "DELETE", url: `/api/tasks/${id}`, headers: auth });
    expect(del.json().deleted).toBe(true);
  });

  it("export tasks as markdown", async () => {
    await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: auth,
      payload: { title: "Export test task", kind: "task" },
    });
    const md = await app.inject({ method: "GET", url: "/api/tasks/export/markdown", headers: auth });
    expect(md.json().markdown).toContain("Export test task");
  });
});

describe("Business: App Log write + read", () => {
  it("write backend log and read it back", async () => {
    const write = await app.inject({
      method: "POST",
      url: "/api/logs/app",
      headers: auth,
      payload: { action: "test.action", message: "Test log entry", level: "info" },
    });
    expect(write.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/api/logs/app", headers: auth });
    expect(Array.isArray(list.json())).toBe(true);
    expect(list.json().length).toBeGreaterThanOrEqual(1);
    const entry = list.json().find((e: any) => e.action === "test.action");
    expect(entry).toBeDefined();
    expect(entry.scope).toBe("frontend"); // POST from "frontend" scope
  });

  it("clear app logs", async () => {
    const del = await app.inject({ method: "DELETE", url: "/api/logs/app", headers: auth });
    expect(del.json().cleared).toBe(true);
  });
});

describe("Business: cURL Export", () => {
  it("builds masked curl from input", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/curl",
      headers: auth,
      payload: {
        url: "https://api.github.com/repos/o/r/actions/workflows/d.yml/dispatches",
        requestMethod: 1,
        extendedData: {
          headers: { authorization: "Bearer ghp_1234567890abcdef", accept: "application/json" },
          body: '{"ref":"main"}',
        },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().masked).toContain("curl");
    expect(r.json().masked).toContain("****cdef");
    expect(r.json().masked).not.toContain("ghp_1234567890abcdef");
    expect(r.json().unmasked).toContain("ghp_1234567890abcdef");
  });

  it("builds GitHub target curl with saved token", async () => {
    const token = await app.inject({
      method: "POST", url: "/api/github-tokens", headers: auth,
      payload: { label: "gh-curl-token", secret: "ghp_saved_token_1234" },
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/curl",
      headers: auth,
      payload: {
        url: "https://api.github.com/repos/o/r/actions/workflows/d.yml/dispatches",
        requestMethod: 1,
        githubTokenId: token.json().id,
        extendedData: { body: "{\"ref\":\"main\"}" },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().masked).toContain("authorization: Bearer ****1234");
    expect(r.json().masked).toContain("x-github-api-version: 2022-11-28");
    expect(r.json().unmasked).toContain("ghp_saved_token_1234");
  });

  it("builds cron-job.org create curl with account API key", async () => {
    const acc = await app.inject({
      method: "POST", url: "/api/accounts", headers: auth,
      payload: { label: "cron-curl-account", secret: "cron_api_key_1234" },
    });
    const token = await app.inject({
      method: "POST", url: "/api/github-tokens", headers: auth,
      payload: { label: "gh-cron-curl-token", secret: "ghp_cron_target_1234" },
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/curl/cronjob",
      headers: auth,
      payload: {
        accountId: acc.json().id,
        title: "[GitHub] repo: deploy.yml",
        url: "https://api.github.com/repos/o/r/actions/workflows/deploy.yml/dispatches",
        requestMethod: 1,
        schedule: { minutes: [58] },
        saveResponses: true,
        githubTokenId: token.json().id,
        extendedData: { body: "{\"ref\":\"main\"}" },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().masked).toContain("/jobs");
    expect(r.json().masked).toContain("authorization: Bearer ****1234");
    expect(r.json().masked).toContain("\"schedule\":{\"timezone\":\"UTC\",\"expiresAt\":0");
    expect(r.json().masked).toContain("\"authorization\":\"Bearer ****1234\"");
    expect(r.json().masked).not.toContain("ghp_cron_target_1234");
    expect(r.json().masked).toContain("<jobId>");
    expect(r.json().unmasked).toContain("cron_api_key_1234");
    expect(r.json().unmasked).toContain("ghp_cron_target_1234");
  });

  it("test-runs target request with saved GitHub token", async () => {
    const seen: { method?: string; auth?: string; body?: string } = {};
    const target = createServer((req, res) => {
      seen.method = req.method;
      seen.auth = req.headers.authorization;
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.body = body;
        res.setHeader("x-token", "secret-response-token");
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    try {
      const address = target.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const token = await app.inject({
        method: "POST", url: "/api/github-tokens", headers: auth,
        payload: { label: "gh-test-run-token", secret: "ghp_test_run_1234" },
      });
      const r = await app.inject({
        method: "POST",
        url: "/api/curl/test-run",
        headers: auth,
        payload: {
          url: `http://127.0.0.1:${port}/dispatches`,
          requestMethod: 1,
          githubTokenId: token.json().id,
          extendedData: { body: "{\"ref\":\"main\"}" },
        },
      });
      expect(r.statusCode).toBe(200);
      expect(seen.method).toBe("POST");
      expect(seen.auth).toBe("Bearer ghp_test_run_1234");
      expect(seen.body).toBe("{\"ref\":\"main\"}");
      expect(r.json().bodySnippet).toBe("ok");
      expect(r.json().headers["x-token"]).toBe("****oken");
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("builds curl for existing job", async () => {
    // Create account + job first
    const acc = await app.inject({
      method: "POST", url: "/api/accounts", headers: auth,
      payload: { label: "curl-acct", secret: "curl-key" },
    });
    const accountId = acc.json().id;
    const job = await app.inject({
      method: "POST", url: "/api/jobs", headers: auth,
      payload: { accountId, title: "curl-job", url: "https://example.com/hook" },
    });
    const jobId = job.json().id;
    const r = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/curl`, headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json().masked).toContain("curl");
  });

  it("injects saved GitHub token headers when creating dispatch job", async () => {
    const acc = await app.inject({
      method: "POST", url: "/api/accounts", headers: auth,
      payload: { label: "gh-cron-acct", secret: "cron-key" },
    });
    const token = await app.inject({
      method: "POST", url: "/api/github-tokens", headers: auth,
      payload: { label: "gh-token", secret: "ghp_live_token" },
    });
    const job = await app.inject({
      method: "POST", url: "/api/jobs", headers: auth,
      payload: {
        accountId: acc.json().id,
        title: "[GitHub] repo: ci.yml",
        url: "https://api.github.com/repos/o/r/actions/workflows/ci.yml/dispatches",
        requestMethod: 1,
        extendedData: { body: '{"ref":"main"}' },
        githubTokenId: token.json().id,
      },
    });
    expect(job.statusCode).toBe(201);
    const fakeJob = fake.jobs.get(Number(job.json().id));
    expect(fakeJob?.extendedData?.headers?.authorization).toBe("Bearer ghp_live_token");
    expect(fakeJob?.extendedData?.headers?.accept).toBe("application/vnd.github+json");
    expect(fakeJob?.extendedData?.headers?.["x-github-api-version"]).toBe("2022-11-28");
    expect(job.json().extendedData?.headers).toBeUndefined();
  });
});

describe("Business: Provider routes wiring", () => {
  it("GitHub token verify returns 404 for unknown token", async () => {
    const r = await app.inject({
      method: "GET", url: "/api/github-tokens/nonexistent/verify", headers: auth,
    });
    expect(r.statusCode).toBe(404);
  });

  it("GitHub repos returns 404 for unknown token", async () => {
    const r = await app.inject({
      method: "GET", url: "/api/github-tokens/nonexistent/repos", headers: auth,
    });
    expect(r.statusCode).toBe(404);
  });

  it("Azure PAT verify returns 404 for unknown pat", async () => {
    const r = await app.inject({
      method: "GET", url: "/api/azure-pats/nonexistent/verify?organization=test", headers: auth,
    });
    expect(r.statusCode).toBe(404);
  });

  it("Azure pipelines returns 400 without project", async () => {
    // Create an azure pat first
    const pat = await app.inject({
      method: "POST", url: "/api/azure-pats", headers: auth,
      payload: { label: "az-pat", secret: "az-secret", meta: { organization: "testorg" } },
    });
    const id = pat.json().id;
    const r = await app.inject({
      method: "GET", url: `/api/azure-pats/${id}/pipelines?organization=testorg`, headers: auth,
    });
    expect(r.statusCode).toBe(400);
  });
});
