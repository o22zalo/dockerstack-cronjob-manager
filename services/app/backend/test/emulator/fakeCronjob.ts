import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Fake cron-job.org REST server for integration/smoke tests. Implements the
 * subset the CronjobClient uses: list/get/create/update/delete/history.
 * Jobs are kept in-memory keyed by an incrementing jobId.
 */
export interface FakeJob {
  jobId: number;
  title: string;
  url: string;
  enabled: boolean;
  schedule?: unknown;
  requestMethod?: number;
  saveResponses?: boolean;
  requestTimeout?: number;
  extendedData?: { headers?: Record<string, string>; body?: string };
  nextExecution: number;
  lastStatus?: number;
}

export interface FakeCronjobServer {
  url: string;
  close: () => Promise<void>;
  jobs: Map<number, FakeJob>;
}

export async function startFakeCronjob(): Promise<FakeCronjobServer> {
  const jobs = new Map<number, FakeJob>();
  const history = new Map<number, unknown[]>();
  const folders = new Map<number, { folderId: number; title: string }>();
  let nextId = 1;
  let nextFolderId = 1;

  const readBody = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => resolve(buf ? JSON.parse(buf) : {}));
    });

  const server = http.createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // /jobs
    if (url === "/jobs" && method === "GET") {
      return send(200, { jobs: [...jobs.values()], someFailed: false });
    }
    if (url === "/jobs" && method === "PUT") {
      const body = await readBody(req);
      const j = body.job ?? {};
      const jobId = nextId++;
      const job: FakeJob = {
        jobId,
        title: j.title ?? "untitled",
        url: j.url ?? "",
        enabled: j.enabled ?? true,
        schedule: j.schedule,
        requestMethod: j.requestMethod,
        saveResponses: j.saveResponses,
        requestTimeout: j.requestTimeout,
        extendedData: j.extendedData,
        nextExecution: Math.floor(Date.now() / 1000) + 3600,
      };
      jobs.set(jobId, job);
      history.set(jobId, []);
      return send(200, { jobId, jobDetails: job });
    }

    // /jobs/:id, /jobs/:id/history, /jobs/:id/history/:identifier
    const m = url.match(/^\/jobs\/(\d+)(\/history(?:\/([^/]+))?)?$/);
    if (m) {
      const id = Number(m[1]);
      const identifier = m[3];
      const isHistory = Boolean(m[2]);
      const job = jobs.get(id);
      if (!job) return send(404, { error: "not found" });

      if (isHistory && identifier && method === "GET") {
        const items = history.get(id) ?? [];
        const item = items.find((h: any) => h.identifier === identifier);
        if (!item) return send(404, { error: "not found" });
        return send(200, { jobHistoryDetails: item });
      }

      if (isHistory && method === "GET") {
        const ts = Math.floor(Date.now() / 1000);
        return send(200, {
          history: [
            {
              identifier: "hist-1",
              jobId: id,
              date: ts - 60,
              datePlanned: ts - 65,
              jitter: 5000,
              url: job.url,
              status: job.lastStatus === 0 ? 0 : 1,
              statusText: job.lastStatus === 0 ? "Connection failed" : "OK",
              duration: 245,
              httpStatus: job.lastStatus === 0 ? 500 : 200,
              stats: { nameLookup: 1000, connect: 5000, appConnect: 0, preTransfer: 6000, startTransfer: 8000, total: 245000 },
            },
          ],
          predictions: [ts + 3600, ts + 7200, ts + 10800],
        });
      }
      if (method === "GET") return send(200, { jobDetails: job });
      if (method === "PATCH") {
        const body = await readBody(req);
        const patch = body.job ?? {};
        Object.assign(job, patch);
        jobs.set(id, job);
        return send(200, { jobId: id });
      }
      if (method === "DELETE") {
        jobs.delete(id);
        return send(200, { jobId: id });
      }
    }

    // /folders
    if (url === "/folders" && method === "GET") {
      return send(200, { folders: [...folders.values()] });
    }
    if (url === "/folders" && method === "PUT") {
      const body = await readBody(req);
      const f = body.folder ?? {};
      const folderId = nextFolderId++;
      folders.set(folderId, { folderId, title: f.title ?? "" });
      return send(200, { folderId });
    }

    // /folders/:id
    const fm = url.match(/^\/folders\/(\d+)$/);
    if (fm) {
      const fid = Number(fm[1]);
      const folder = folders.get(fid);
      if (!folder) return send(404, { error: "not found" });
      if (method === "GET") return send(200, { folderDetails: folder });
      if (method === "PATCH") {
        const body = await readBody(req);
        Object.assign(folder, body.folder ?? {});
        folders.set(fid, folder);
        return send(200, {});
      }
      if (method === "DELETE") {
        folders.delete(fid);
        return send(200, {});
      }
    }

    send(404, { error: "unknown route", url, method });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    jobs,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
