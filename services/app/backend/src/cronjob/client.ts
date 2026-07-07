import { request } from "undici";
import type { Logger } from "../logger.js";
import type { RequestMethodValue, ExtendedJobData, JobSchedule } from "../types.js";

/**
 * Thin wrapper over the cron-job.org REST API (https://api.cron-job.org).
 * Each call is made with a per-account API key (stored in RTDB /accounts).
 *
 * The base URL is configurable so tests can point at the fake emulator server.
 */
export interface CronjobClientOptions {
  base: string;
  apiKey: string;
  logger?: Logger;
  retries?: number;
}

export interface RawCronJob {
  jobId: number | string;
  title: string;
  url: string;
  enabled: boolean;
  schedule?: unknown;
  nextExecution?: number | null;
  lastStatus?: number;
  requestMethod?: number;
  saveResponses?: boolean;
  requestTimeout?: number;
  extendedData?: {
    headers?: Record<string, string>;
    body?: string;
  };
}

export interface CronJobLogItem {
  identifier: string;
  jobId: number | string;
  date: number;
  datePlanned: number;
  jitter: number;
  url: string;
  duration: number;
  status: number; // 1 = ok
  statusText: string;
  httpStatus: number;
  stats?: {
    nameLookup: number;
    connect: number;
    appConnect: number;
    preTransfer: number;
    startTransfer: number;
    total: number;
  };
  sslCertExpiry?: number;
}

export interface Folder {
  folderId: number;
  title: string;
}

export interface ListJobsResult {
  jobs: RawCronJob[];
  someFailed: boolean;
}

export interface GetJobLogsResult {
  history: CronJobLogItem[];
  predictions: number[];
}

export interface CreateJobInput {
  title: string;
  url: string;
  enabled?: boolean;
  schedule?: JobSchedule;
  requestMethod?: RequestMethodValue;
  extendedData?: ExtendedJobData;
  saveResponses?: boolean;
  requestTimeout?: number;
}

export interface UpdateJobInput {
  title?: string;
  url?: string;
  enabled?: boolean;
  schedule?: JobSchedule;
  requestMethod?: RequestMethodValue;
  extendedData?: ExtendedJobData;
  saveResponses?: boolean;
  requestTimeout?: number;
}

export class CronjobClient {
  private base: string;
  private apiKey: string;
  private logger?: Logger;
  private retries: number;

  constructor(opts: CronjobClientOptions) {
    this.base = opts.base.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.logger = opts.logger;
    this.retries = opts.retries ?? 2;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.base}${path}`;
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        if (bodyStr) {
          this.logger?.info({ url, method, body: bodyStr.slice(0, 2000) }, "cronjob.org request");
        }
        const res = await request(url, {
          method: method as never,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: bodyStr,
        });
        const text = await res.body.text();
        if (res.statusCode >= 400) {
          this.logger?.warn(
            { url, method, status: res.statusCode, responseBody: text.slice(0, 1000) },
            "cronjob.org error response",
          );
        }
        if (res.statusCode >= 400 && res.statusCode < 500) {
          throw Object.assign(
            new Error(`cronjob.org ${res.statusCode}: ${text.slice(0, 500)}`),
            { retryable: false },
          );
        }
        if (res.statusCode >= 500) {
          throw Object.assign(
            new Error(`cronjob.org ${res.statusCode}: ${text.slice(0, 500)}`),
            { retryable: true },
          );
        }
        return (text ? JSON.parse(text) : {}) as T;
      } catch (err) {
        lastErr = err;
        const isRetryable = (err as any).retryable !== false;
        this.logger?.warn({ url, attempt, err: (err as Error).message }, "cronjob.org call failed");
        if (!isRetryable || attempt >= this.retries) break;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async listJobs(): Promise<ListJobsResult> {
    const res = await this.call<ListJobsResult>("GET", "/jobs");
    return { jobs: res.jobs ?? [], someFailed: res.someFailed ?? false };
  }

  async getJob(jobId: string | number): Promise<RawCronJob | null> {
    const res = await this.call<{ jobDetails: RawCronJob }>("GET", `/jobs/${jobId}`);
    return res.jobDetails ?? null;
  }

  private normalizeSchedule(schedule?: JobSchedule): Record<string, unknown> {
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

  async createJob(input: CreateJobInput): Promise<{ jobId: number | string }> {
    const job: Record<string, unknown> = {
      title: input.title,
      url: input.url,
      schedule: this.normalizeSchedule(input.schedule),
    };
    if (input.requestMethod !== undefined) job.requestMethod = input.requestMethod;
    if (input.extendedData) job.extendedData = input.extendedData;
    if (input.saveResponses !== undefined) job.saveResponses = input.saveResponses;
    if (input.requestTimeout !== undefined) job.requestTimeout = input.requestTimeout;

    const res = await this.call<{ jobId: number | string }>(
      "PUT",
      "/jobs",
      { job },
    );
    if (input.enabled) {
      await this.call("PATCH", `/jobs/${res.jobId}`, { job: { enabled: true } });
    }
    return { jobId: res.jobId };
  }

  async updateJob(jobId: string | number, patch: Partial<RawCronJob>): Promise<void> {
    await this.call("PATCH", `/jobs/${jobId}`, { job: patch });
  }

  async updateJobDetailed(jobId: string | number, input: UpdateJobInput): Promise<void> {
    const job: Record<string, unknown> = {};
    if (input.title !== undefined) job.title = input.title;
    if (input.url !== undefined) job.url = input.url;
    if (input.enabled !== undefined) job.enabled = input.enabled;
    if (input.schedule !== undefined) job.schedule = this.normalizeSchedule(input.schedule);
    if (input.requestMethod !== undefined) job.requestMethod = input.requestMethod;
    if (input.extendedData !== undefined) job.extendedData = input.extendedData;
    if (input.saveResponses !== undefined) job.saveResponses = input.saveResponses;
    if (input.requestTimeout !== undefined) job.requestTimeout = input.requestTimeout;

    await this.call("PATCH", `/jobs/${jobId}`, { job });
  }

  async setEnabled(jobId: string | number, enabled: boolean): Promise<void> {
    await this.updateJob(jobId, { enabled });
  }

  async deleteJob(jobId: string | number): Promise<void> {
    await this.call("DELETE", `/jobs/${jobId}`);
  }

  async getJobLogs(jobId: string | number): Promise<GetJobLogsResult> {
    const res = await this.call<GetJobLogsResult>("GET", `/jobs/${jobId}/history`);
    return { history: res.history ?? [], predictions: res.predictions ?? [] };
  }

  async getJobHistoryDetail(jobId: string | number, identifier: string): Promise<CronJobLogItem> {
    const res = await this.call<{ jobHistoryDetails: CronJobLogItem }>(
      "GET",
      `/jobs/${jobId}/history/${identifier}`,
    );
    return res.jobHistoryDetails;
  }

  // --- Folder APIs ---

  async listFolders(): Promise<Folder[]> {
    const res = await this.call<{ folders: Folder[] }>("GET", "/folders");
    return res.folders ?? [];
  }

  async getFolder(folderId: number): Promise<Folder | null> {
    const res = await this.call<{ folderDetails: Folder }>("GET", `/folders/${folderId}`);
    return res.folderDetails ?? null;
  }

  async createFolder(title: string): Promise<{ folderId: number }> {
    return this.call<{ folderId: number }>("PUT", "/folders", { folder: { title } });
  }

  async updateFolder(folderId: number, patch: Partial<Folder>): Promise<void> {
    await this.call("PATCH", `/folders/${folderId}`, { folder: patch });
  }

  async deleteFolder(folderId: number): Promise<void> {
    await this.call("DELETE", `/folders/${folderId}`);
  }
}
