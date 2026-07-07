import type { App } from "./appType.js";
import { z } from "zod";
import { request, type Dispatcher } from "undici";
import type { Container } from "../container.js";
import { buildCurl, maskHeaderValue, type CurlInput } from "../lib/curlBuilder.js";
import { REQUEST_METHODS, type ExtendedJobData, type JobSchedule, type RequestMethodValue } from "../types.js";

/**
 * Utility routes: curl export (convert a job's outbound request into a curl
 * command so operators can reproduce/debug the call externally).
 */
const curlSchema = z.object({
  url: z.string().url(),
  requestMethod: z.union([
    z.literal(0), z.literal(1), z.literal(2), z.literal(3),
    z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8),
  ]).optional(),
  extendedData: z.object({
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
  }).optional(),
  githubTokenId: z.string().optional(),
  requestTimeout: z.number().int().min(1).max(300).optional(),
});

const scheduleSchema = z.object({
  timezone: z.string().optional(),
  expiresAt: z.number().int().optional(),
  hours: z.array(z.number().int().min(-1).max(23)).optional(),
  mdays: z.array(z.number().int().min(-1).max(31)).optional(),
  minutes: z.array(z.number().int().min(-1).max(59)).optional(),
  months: z.array(z.number().int().min(-1).max(12)).optional(),
  wdays: z.array(z.number().int().min(-1).max(6)).optional(),
}).optional();

const requestMethodSchema = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3),
  z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8),
]).optional();

const jobCurlSchema = z.object({
  accountId: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  schedule: scheduleSchema,
  enabled: z.boolean().optional(),
  requestMethod: requestMethodSchema,
  extendedData: z.object({
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
  }).optional(),
  saveResponses: z.boolean().optional(),
  requestTimeout: z.number().int().min(1).max(300).optional(),
  githubTokenId: z.string().optional(),
});

function normalizeSchedule(schedule?: JobSchedule): Record<string, unknown> {
  return {
    timezone: schedule?.timezone ?? "UTC",
    expiresAt: schedule?.expiresAt ?? 0,
    hours: schedule?.hours ?? [-1],
    mdays: schedule?.mdays ?? [-1],
    minutes: schedule?.minutes ?? [-1],
    months: schedule?.months ?? [-1],
    wdays: schedule?.wdays ?? [-1],
  };
}

function maskJobBody(job: Record<string, unknown>) {
  const copy = structuredClone(job) as Record<string, unknown>;
  const headers = (copy.extendedData as ExtendedJobData | undefined)?.headers;
  if (headers) {
    for (const [name, value] of Object.entries(headers)) headers[name] = maskHeaderValue(name, value);
  }
  return copy;
}

async function withGithubToken(c: Container, extendedData: ExtendedJobData | undefined, githubTokenId?: string) {
  if (!githubTokenId) return extendedData;
  const token = await c.resources["github-tokens"].getRaw(githubTokenId);
  if (!token || token.type !== "github_token") throw new Error("GitHub token not found");
  return {
    ...extendedData,
    headers: {
      ...extendedData?.headers,
      authorization: `Bearer ${token.secret}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  };
}

function maskHeaders(headers: Record<string, string | string[] | undefined>) {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = maskHeaderValue(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return out;
}

export function registerCurlRoutes(app: App, c: Container) {
  app.post("/api/curl", async (req, reply) => {
    const parsed = curlSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    let extendedData: ExtendedJobData | undefined;
    try {
      extendedData = await withGithubToken(c, parsed.data.extendedData, parsed.data.githubTokenId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    const input: CurlInput = {
      url: parsed.data.url,
      requestMethod: parsed.data.requestMethod,
      extendedData,
    };
    const masked = buildCurl(input, { maskSecrets: true });
    const unmasked = buildCurl(input, { maskSecrets: false });
    return { masked, unmasked };
  });

  app.post("/api/curl/test-run", async (req, reply) => {
    const parsed = curlSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    let extendedData: ExtendedJobData | undefined;
    try {
      extendedData = await withGithubToken(c, parsed.data.extendedData, parsed.data.githubTokenId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    const started = Date.now();
    try {
      const method = (REQUEST_METHODS[parsed.data.requestMethod ?? 0] ?? "GET") as Dispatcher.HttpMethod;
      const response = await request(parsed.data.url, {
        method,
        headers: extendedData?.headers,
        body: method === "GET" || method === "HEAD" ? undefined : extendedData?.body,
        signal: AbortSignal.timeout((parsed.data.requestTimeout ?? 30) * 1000),
      });
      const text = await response.body.text();
      return {
        statusCode: response.statusCode,
        headers: maskHeaders(response.headers),
        bodySnippet: text.slice(0, 4000),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return reply.code(502).send({
        error: (err as Error).message,
        durationMs: Date.now() - started,
      });
    }
  });

  app.post("/api/curl/cronjob", async (req, reply) => {
    const parsed = jobCurlSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const account = await c.resources.accounts.getRaw(parsed.data.accountId);
    if (!account || account.type !== "cronjob_account") return reply.code(404).send({ error: "Cronjob account not found" });
    let extendedData: ExtendedJobData | undefined;
    try {
      extendedData = await withGithubToken(c, parsed.data.extendedData, parsed.data.githubTokenId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    const job: Record<string, unknown> = {
      title: parsed.data.title,
      url: parsed.data.url,
      schedule: normalizeSchedule(parsed.data.schedule),
    };
    if (parsed.data.requestMethod !== undefined) job.requestMethod = parsed.data.requestMethod;
    if (extendedData) job.extendedData = extendedData;
    if (parsed.data.saveResponses !== undefined) job.saveResponses = parsed.data.saveResponses;
    if (parsed.data.requestTimeout !== undefined) job.requestTimeout = parsed.data.requestTimeout;

    const base = c.config.cronjobApiBase.replace(/\/+$/, "");
    const createInput = (bodyJob: Record<string, unknown>): CurlInput => ({
      url: `${base}/jobs`,
      requestMethod: 4 as RequestMethodValue,
      extendedData: {
        headers: {
          authorization: `Bearer ${account.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ job: bodyJob }),
      },
    });
    const maskedCreate = buildCurl(createInput(maskJobBody(job)), { maskSecrets: true });
    const unmaskedCreate = buildCurl(createInput(job), { maskSecrets: false });
    if (parsed.data.enabled === false) return { masked: maskedCreate, unmasked: unmaskedCreate };

    const enableInput: CurlInput = {
      url: `${base}/jobs/<jobId>`,
      requestMethod: 8 as RequestMethodValue,
      extendedData: {
        headers: {
          authorization: `Bearer ${account.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ job: { enabled: true } }),
      },
    };
    return {
      masked: `${maskedCreate}\n\n# Sau khi lấy jobId từ response, thay <jobId> rồi chạy:\n${buildCurl(enableInput, { maskSecrets: true })}`,
      unmasked: `${unmaskedCreate}\n\n# Sau khi lấy jobId từ response, thay <jobId> rồi chạy:\n${buildCurl(enableInput, { maskSecrets: false })}`,
    };
  });

  /** Also export curl for an existing job. */
  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId/curl", async (req, reply) => {
    const meta = await c.jobs.get(req.params.jobId);
    if (!meta) return reply.code(404).send({ error: "not found" });
    const input: CurlInput = {
      url: meta.url,
      requestMethod: meta.requestMethod,
      extendedData: meta.extendedData,
    };
    const masked = buildCurl(input, { maskSecrets: true });
    const unmasked = buildCurl(input, { maskSecrets: false });
    return { masked, unmasked };
  });
}
