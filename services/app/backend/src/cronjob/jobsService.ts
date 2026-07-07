import type { RtdbClient } from "../db/rtdb.js";
import type { Logger } from "../logger.js";
import type { AppConfig } from "../config/env.js";
import { CronjobClient, type RawCronJob } from "./client.js";
import { ResourceRepo } from "../lib/resourceRepo.js";
import type { CronJobMeta, JobLogEntry, RequestMethodValue, ExtendedJobData, JobSchedule } from "../types.js";

/**
 * Cronjob manager: wraps the per-account cronjob.org client and mirrors job
 * metadata + execution logs into RTDB. All frontend job operations go through
 * this service (never directly to cronjob.org).
 */
export class JobsService {
  constructor(
    private rtdb: RtdbClient,
    private accountsRepo: ResourceRepo,
    private githubTokensRepo: ResourceRepo,
    private config: Pick<AppConfig, "cronjobApiBase">,
    private logger: Logger,
  ) {}

  private async clientFor(accountId: string): Promise<CronjobClient> {
    const account = await this.accountsRepo.getRaw(accountId);
    if (!account) throw new Error(`account not found: ${accountId}`);
    return new CronjobClient({
      base: this.config.cronjobApiBase,
      apiKey: account.secret,
      logger: this.logger,
    });
  }

  private toMeta(accountId: string, raw: RawCronJob, prev?: CronJobMeta): CronJobMeta {
    return {
      id: String(raw.jobId),
      accountId,
      title: raw.title,
      url: raw.url,
      schedule: raw.schedule ?? prev?.schedule,
      enabled: raw.enabled,
      requestMethod: raw.requestMethod as RequestMethodValue | undefined ?? prev?.requestMethod,
      extendedData: raw.extendedData as ExtendedJobData | undefined ?? prev?.extendedData,
      saveResponses: raw.saveResponses ?? prev?.saveResponses,
      requestTimeout: raw.requestTimeout ?? prev?.requestTimeout,
      nextRunAt: raw.nextExecution ? raw.nextExecution * 1000 : prev?.nextRunAt,
      lastStatus: raw.lastStatus === 1 ? "ok" : raw.lastStatus ? "failed" : prev?.lastStatus,
      tags: prev?.tags ?? [],
      project: prev?.project,
      collection: prev?.collection,
      updatedAt: Date.now(),
    };
  }

  /** Pull all jobs for an account from cronjob.org into RTDB. */
  async sync(accountId: string): Promise<CronJobMeta[]> {
    const client = await this.clientFor(accountId);
    const { jobs: raw, someFailed } = await client.listJobs();
    if (someFailed) {
      this.logger.warn({ accountId }, "cronjob.org returned someFailed=true, list may be incomplete");
    }
    const out: CronJobMeta[] = [];
    for (const j of raw) {
      const prev = (await this.rtdb.get<CronJobMeta>(`jobs/${accountId}/${j.jobId}`)) ?? undefined;
      const meta = this.toMeta(accountId, j, prev);
      await this.rtdb.set(`jobs/${accountId}/${meta.id}`, meta);
      out.push(meta);
    }
    this.logger.info({ accountId, count: out.length }, "synced jobs from cronjob.org");
    return out;
  }

  async list(filter: {
    accountId?: string;
    tag?: string;
    project?: string;
    collection?: string;
  }): Promise<CronJobMeta[]> {
    const byAccount = (await this.rtdb.get<Record<string, Record<string, CronJobMeta>>>("jobs")) ?? {};
    let items: CronJobMeta[] = [];
    for (const [accId, jobs] of Object.entries(byAccount)) {
      if (filter.accountId && filter.accountId !== accId) continue;
      items.push(...Object.values(jobs));
    }
    if (filter.tag) items = items.filter((j) => (j.tags ?? []).includes(filter.tag!));
    if (filter.project) items = items.filter((j) => j.project === filter.project);
    if (filter.collection) items = items.filter((j) => j.collection === filter.collection);
    return items.sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  }

  private async findJob(jobId: string): Promise<CronJobMeta | null> {
    const byAccount = (await this.rtdb.get<Record<string, Record<string, CronJobMeta>>>("jobs")) ?? {};
    for (const jobs of Object.values(byAccount)) {
      if (jobs[jobId]) return jobs[jobId];
    }
    return null;
  }

  async get(jobId: string): Promise<CronJobMeta | null> {
    return this.findJob(jobId);
  }

  async create(input: {
    accountId: string;
    title: string;
    url: string;
    schedule?: JobSchedule;
    enabled?: boolean;
    requestMethod?: RequestMethodValue;
    extendedData?: ExtendedJobData;
    saveResponses?: boolean;
    requestTimeout?: number;
    githubTokenId?: string;
    tags?: string[];
    project?: string;
    collection?: string;
  }): Promise<CronJobMeta> {
    // Resolve GitHub token if provided, inject into extendedData headers
    let extendedData = input.extendedData;
    if (input.githubTokenId) {
      const token = await this.githubTokensRepo.getRaw(input.githubTokenId);
      if (!token || token.type !== "github_token") throw new Error(`GitHub token not found: ${input.githubTokenId}`);
      extendedData = {
        ...extendedData,
        headers: {
          ...extendedData?.headers,
          authorization: `Bearer ${token.secret}`,
          accept: "application/vnd.github.v3+json",
        },
      };
    }
    const client = await this.clientFor(input.accountId);
    const { jobId } = await client.createJob({
      title: input.title,
      url: input.url,
      enabled: input.enabled ?? true,
      schedule: input.schedule,
      requestMethod: input.requestMethod,
      extendedData,
      saveResponses: input.saveResponses,
      requestTimeout: input.requestTimeout,
    });
    // Fetch full job details to get read-only fields (nextExecution, etc.)
    const raw = await client.getJob(jobId);
    const meta: CronJobMeta = {
      id: String(jobId),
      accountId: input.accountId,
      title: input.title,
      url: input.url,
      schedule: input.schedule,
      enabled: raw?.enabled ?? (input.enabled ?? true),
      requestMethod: input.requestMethod,
      extendedData: input.extendedData,
      saveResponses: input.saveResponses,
      requestTimeout: input.requestTimeout,
      nextRunAt: raw?.nextExecution ? raw.nextExecution * 1000 : undefined,
      lastStatus: raw?.lastStatus === 1 ? "ok" : raw?.lastStatus ? "failed" : undefined,
      tags: input.tags ?? [],
      project: input.project,
      collection: input.collection,
      updatedAt: Date.now(),
    };
    await this.rtdb.set(`jobs/${input.accountId}/${meta.id}`, meta);
    return meta;
  }

  async patch(jobId: string, patch: {
    title?: string;
    url?: string;
    schedule?: JobSchedule;
    requestMethod?: RequestMethodValue;
    extendedData?: ExtendedJobData;
    saveResponses?: boolean;
    requestTimeout?: number;
    tags?: string[];
    project?: string;
    collection?: string;
  }): Promise<CronJobMeta | null> {
    const meta = await this.findJob(jobId);
    if (!meta) return null;
    const client = await this.clientFor(meta.accountId);
    await client.updateJobDetailed(jobId, {
      title: patch.title,
      url: patch.url,
      schedule: patch.schedule,
      requestMethod: patch.requestMethod,
      extendedData: patch.extendedData,
      saveResponses: patch.saveResponses,
      requestTimeout: patch.requestTimeout,
    });
    const updated: CronJobMeta = {
      ...meta,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      ...(patch.requestMethod !== undefined ? { requestMethod: patch.requestMethod } : {}),
      ...(patch.extendedData !== undefined ? { extendedData: patch.extendedData } : {}),
      ...(patch.saveResponses !== undefined ? { saveResponses: patch.saveResponses } : {}),
      ...(patch.requestTimeout !== undefined ? { requestTimeout: patch.requestTimeout } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.project !== undefined ? { project: patch.project } : {}),
      ...(patch.collection !== undefined ? { collection: patch.collection } : {}),
      updatedAt: Date.now(),
    };
    await this.rtdb.set(`jobs/${meta.accountId}/${jobId}`, updated);
    return updated;
  }

  async setEnabled(jobId: string, enabled: boolean): Promise<CronJobMeta | null> {
    const meta = await this.findJob(jobId);
    if (!meta) return null;
    const client = await this.clientFor(meta.accountId);
    await client.setEnabled(jobId, enabled);
    const updated = { ...meta, enabled, updatedAt: Date.now() };
    await this.rtdb.set(`jobs/${meta.accountId}/${jobId}`, updated);
    this.logger.info({ jobId, enabled }, "toggled job");
    return updated;
  }

  async remove(jobId: string): Promise<boolean> {
    const meta = await this.findJob(jobId);
    if (!meta) return false;
    const client = await this.clientFor(meta.accountId);
    await client.deleteJob(jobId);
    await this.rtdb.remove(`jobs/${meta.accountId}/${jobId}`);
    this.logger.info({ jobId }, "deleted job");
    return true;
  }

  /** Fetch execution history from cronjob.org and mirror into RTDB /logs/jobs. */
  async logs(jobId: string): Promise<JobLogEntry[]> {
    const meta = await this.findJob(jobId);
    if (!meta) return [];
    const client = await this.clientFor(meta.accountId);
    const { history: raw } = await client.getJobLogs(jobId);
    const entries: JobLogEntry[] = raw.map((r) => ({
      id: String(r.identifier),
      jobId,
      timestamp: r.date * 1000,
      status: r.status === 1 ? "ok" : "failed",
      statusCode: r.httpStatus,
      duration: r.duration,
      responseSnippet: r.statusText,
      failReason: r.status === 1 ? undefined : r.statusText,
    }));
    for (const e of entries) {
      await this.rtdb.set(`logs/jobs/${jobId}/${e.id}`, e);
    }
    return entries.sort((a, b) => b.timestamp - a.timestamp);
  }
}
