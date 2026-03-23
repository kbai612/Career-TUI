import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { sanitizeCompensationText } from "./compensation";
import { canonicalizeUrl } from "./discovery";
import { assertTransition } from "./state-machine";
import type {
  ApplicationDraft,
  ApplicationState,
  CareerSource,
  ContactDraft,
  DeepResearchReport,
  EvaluationReport,
  NormalizedJob,
  ResumeVariant,
  RunSummary,
  SourceSyncRun,
  StoredCareerSource,
  StoredJobRecord,
  TrainingAssessment
} from "./types";

export interface JobRecordWithArtifacts {
  job: StoredJobRecord;
  evaluation: EvaluationReport | null;
  resume: ResumeVariant | null;
  application: ApplicationDraft | null;
  research: DeepResearchReport | null;
  contact: ContactDraft | null;
}

function sanitizeStoredCompensation(compensationText: string | undefined, salaryMin?: number, salaryMax?: number): Pick<StoredJobRecord, "compensationText" | "salaryMin" | "salaryMax"> {
  const sanitizedText = sanitizeCompensationText(compensationText);
  if (compensationText != null && sanitizedText == null) {
    return {
      compensationText: undefined,
      salaryMin: undefined,
      salaryMax: undefined
    };
  }
  return {
    compensationText: sanitizedText,
    salaryMin,
    salaryMax
  };
}

function sanitizeStoredJson(json: string): string {
  try {
    const parsed = JSON.parse(json) as { compensationText?: string; salaryMin?: number; salaryMax?: number };
    const sanitized = sanitizeStoredCompensation(parsed.compensationText, parsed.salaryMin, parsed.salaryMax);
    if (
      parsed.compensationText === sanitized.compensationText
      && parsed.salaryMin === sanitized.salaryMin
      && parsed.salaryMax === sanitized.salaryMax
    ) {
      return json;
    }
    if (sanitized.compensationText == null) {
      delete parsed.compensationText;
    } else {
      parsed.compensationText = sanitized.compensationText;
    }
    if (sanitized.salaryMin == null) {
      delete parsed.salaryMin;
    } else {
      parsed.salaryMin = sanitized.salaryMin;
    }
    if (sanitized.salaryMax == null) {
      delete parsed.salaryMax;
    } else {
      parsed.salaryMax = sanitized.salaryMax;
    }
    return JSON.stringify(parsed);
  } catch {
    return json;
  }
}

function normalizeDedupeText(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeApplyUrlForStorage(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw.length === 0) {
    return "";
  }
  return canonicalizeUrl(raw);
}

function extractLinkedInJobSlugKey(value: string | undefined): string | null {
  const raw = (value ?? "").trim();
  if (raw.length === 0) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) {
      return null;
    }
    const match = url.pathname.match(/^\/jobs\/view\/([^/]+)\/?$/i);
    if (match == null) {
      return null;
    }
    const segment = decodeURIComponent(match[1]).trim().toLowerCase();
    if (segment.length === 0) {
      return null;
    }

    const slugWithId = segment.match(/^(.*?)-(\d{6,})$/);
    if (slugWithId?.[1] != null && slugWithId[1].trim().length > 0) {
      return normalizeDedupeText(slugWithId[1]);
    }
    return normalizeDedupeText(segment);
  } catch {
    return null;
  }
}

function pickLatestTimestamp(existing: string | null | undefined, incoming: string | null | undefined): string | null {
  if (!existing && !incoming) {
    return null;
  }
  if (!existing) {
    return incoming ?? null;
  }
  if (!incoming) {
    return existing;
  }

  const existingTs = Date.parse(existing);
  const incomingTs = Date.parse(incoming);
  const existingValid = Number.isFinite(existingTs);
  const incomingValid = Number.isFinite(incomingTs);

  if (existingValid && incomingValid) {
    return incomingTs > existingTs ? incoming : existing;
  }
  if (incomingValid) {
    return incoming;
  }
  if (existingValid) {
    return existing;
  }
  return incoming > existing ? incoming : existing;
}

export class CareerOpsRepository {
  readonly sqlite: Database.Database;
  readonly db;
  private jobCache: JobRecordWithArtifacts[] | null = null;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.db = drizzle(this.sqlite);
    this.migrate();
    this.deduplicateJobsByCanonicalKey();
  }

  private migrate(): void {
    this.sqlite.exec(`
      create table if not exists jobs (
        id integer primary key autoincrement,
        fingerprint text not null unique,
        portal text not null,
        source_url text not null,
        apply_url text not null,
        company text not null,
        title text not null,
        location text not null,
        posted_at text,
        remote_policy text,
        compensation_text text,
        salary_min integer,
        salary_max integer,
        employment_type text,
        external_id text,
        raw_json text not null,
        normalized_json text not null,
        status text not null,
        visit_count integer not null default 0,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists evaluations (
        job_id integer primary key,
        report_json text not null,
        total_score real not null,
        recommended_action text not null,
        created_at text not null,
        updated_at text not null,
        foreign key(job_id) references jobs(id) on delete cascade
      );
      create table if not exists resumes (
        job_id integer primary key,
        variant_json text not null,
        file_path text not null,
        created_at text not null,
        updated_at text not null,
        foreign key(job_id) references jobs(id) on delete cascade
      );
      create table if not exists applications (
        job_id integer primary key,
        draft_json text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        foreign key(job_id) references jobs(id) on delete cascade
      );
      create table if not exists research_reports (
        job_id integer primary key,
        report_json text not null,
        created_at text not null,
        updated_at text not null,
        foreign key(job_id) references jobs(id) on delete cascade
      );
      create table if not exists contact_drafts (
        job_id integer primary key,
        draft_json text not null,
        created_at text not null,
        updated_at text not null,
        foreign key(job_id) references jobs(id) on delete cascade
      );
      create table if not exists training_assessments (
        id integer primary key autoincrement,
        source_key text not null unique,
        assessment_json text not null,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists career_sources (
        id integer primary key autoincrement,
        name text not null,
        source_url text not null unique,
        kind text not null,
        region_id text not null,
        active integer not null default 1,
        use_persistent_browser integer not null default 0,
        metadata_json text not null,
        last_synced_at text,
        last_status text not null default 'idle',
        created_at text not null,
        updated_at text not null
      );
      create table if not exists source_sync_runs (
        id integer primary key autoincrement,
        source_id integer not null,
        summary_json text not null,
        status text not null,
        created_at text not null,
        foreign key(source_id) references career_sources(id) on delete cascade
      );
      create table if not exists runs (
        id integer primary key autoincrement,
        mode text not null,
        summary_json text not null,
        created_at text not null
      );
    `);
  }

  private buildCanonicalJobKey(applyUrl: string | undefined, company: string | undefined, title: string | undefined): string {
    const canonicalApplyUrl = canonicalizeApplyUrlForStorage(applyUrl);
    const linkedInJobSlugKey = extractLinkedInJobSlugKey(canonicalApplyUrl);
    if (linkedInJobSlugKey != null && linkedInJobSlugKey.length > 0) {
      return `linkedin|${linkedInJobSlugKey}`;
    }

    const normalizedApplyUrl = normalizeDedupeText(canonicalApplyUrl);
    if (normalizedApplyUrl.length > 0) {
      return `url|${normalizedApplyUrl}`;
    }
    return `meta|${normalizeDedupeText(company)}|${normalizeDedupeText(title)}`;
  }

  private moveArtifactToKeep(table: "evaluations" | "resumes" | "applications" | "research_reports" | "contact_drafts", keepId: number, duplicateId: number): void {
    this.sqlite.prepare(`
      update ${table}
      set job_id = ?
      where job_id = ?
        and not exists (select 1 from ${table} where job_id = ?)
    `).run(keepId, duplicateId, keepId);
  }

  private deduplicateJobsByCanonicalKey(): void {
    const runDedupe = this.sqlite.transaction(() => {
      const rows = this.sqlite.prepare(`
        select id, apply_url, company, title, compensation_text, salary_min, salary_max, posted_at
        from jobs
        order by (posted_at is null), posted_at desc, updated_at desc, id desc
      `).all() as Array<{
        id: number;
        apply_url: string;
        company: string;
        title: string;
        compensation_text: string | null;
        salary_min: number | null;
        salary_max: number | null;
        posted_at: string | null;
      }>;
      const keptByKey = new Map<string, { id: number; postedAt: string | null; applyUrl: string }>();
      let removed = 0;

      for (const row of rows) {
        const canonicalApplyUrl = canonicalizeApplyUrlForStorage(row.apply_url);
        if (canonicalApplyUrl.length > 0 && canonicalApplyUrl !== row.apply_url) {
          this.sqlite.prepare("update jobs set apply_url = ? where id = ?").run(canonicalApplyUrl, row.id);
          row.apply_url = canonicalApplyUrl;
        }

        const key = this.buildCanonicalJobKey(canonicalApplyUrl, row.company, row.title);
        if (key === "meta||") {
          continue;
        }
        const keep = keptByKey.get(key);
        if (keep == null) {
          keptByKey.set(key, { id: row.id, postedAt: row.posted_at, applyUrl: canonicalApplyUrl });
          continue;
        }
        const mergedPostedAt = pickLatestTimestamp(keep.postedAt, row.posted_at);
        const mergedApplyUrl = keep.applyUrl.length > 0 ? keep.applyUrl : canonicalApplyUrl;
        keptByKey.set(key, { id: keep.id, postedAt: mergedPostedAt, applyUrl: mergedApplyUrl });

        this.sqlite.prepare(`
          update jobs
          set
            apply_url = case when ? <> '' then ? else apply_url end,
            compensation_text = coalesce(compensation_text, ?),
            salary_min = coalesce(salary_min, ?),
            salary_max = coalesce(salary_max, ?),
            posted_at = ?
          where id = ?
        `).run(
          mergedApplyUrl,
          mergedApplyUrl,
          row.compensation_text,
          row.salary_min,
          row.salary_max,
          mergedPostedAt,
          keep.id
        );

        this.moveArtifactToKeep("evaluations", keep.id, row.id);
        this.moveArtifactToKeep("resumes", keep.id, row.id);
        this.moveArtifactToKeep("applications", keep.id, row.id);
        this.moveArtifactToKeep("research_reports", keep.id, row.id);
        this.moveArtifactToKeep("contact_drafts", keep.id, row.id);

        this.sqlite.prepare("delete from jobs where id = ?").run(row.id);
        removed += 1;
      }

      return removed;
    });

    const removedCount = runDedupe();
    if (removedCount > 0) {
      this.invalidateJobCache();
    }
  }

  close(): void {
    this.sqlite.close();
  }

  private invalidateJobCache(): void {
    this.jobCache = null;
  }

  upsertJob(job: NormalizedJob): number {
    const now = new Date().toISOString();
    const sanitizedCompensation = sanitizeStoredCompensation(job.compensationText, job.salaryMin, job.salaryMax);
    const canonicalApplyUrl = canonicalizeApplyUrlForStorage(job.applyUrl);
    const sanitizedJob: NormalizedJob = {
      ...job,
      applyUrl: canonicalApplyUrl.length > 0 ? canonicalApplyUrl : job.applyUrl,
      compensationText: sanitizedCompensation.compensationText,
      salaryMin: sanitizedCompensation.salaryMin,
      salaryMax: sanitizedCompensation.salaryMax
    };
    let dedupeCandidate: { id: number; fingerprint: string } | undefined;
    if ((sanitizedJob.applyUrl ?? "").trim().length > 0) {
      dedupeCandidate = this.sqlite.prepare(`
        select id, fingerprint
        from jobs
        where apply_url = ?
        order by (posted_at is null), posted_at desc, updated_at desc, id desc
        limit 1
      `).get(
        sanitizedJob.applyUrl
      ) as { id: number; fingerprint: string } | undefined;

      if (dedupeCandidate == null) {
        const linkedInJobSlugKey = extractLinkedInJobSlugKey(sanitizedJob.applyUrl);
        if (linkedInJobSlugKey != null && linkedInJobSlugKey.length > 0) {
          const linkedInCandidates = this.sqlite.prepare(`
            select id, fingerprint, apply_url
            from jobs
            where lower(company) = lower(?)
              and lower(title) = lower(?)
              and lower(location) = lower(?)
              and lower(apply_url) like '%linkedin.com/jobs/view/%'
            order by (posted_at is null), posted_at desc, updated_at desc, id desc
            limit 20
          `).all(
            sanitizedJob.company,
            sanitizedJob.title,
            sanitizedJob.location
          ) as Array<{ id: number; fingerprint: string; apply_url: string }>;
          dedupeCandidate = linkedInCandidates.find((candidate) => extractLinkedInJobSlugKey(candidate.apply_url) === linkedInJobSlugKey);
        }
      }
    } else {
      dedupeCandidate = this.sqlite.prepare(`
        select id, fingerprint
        from jobs
        where lower(company) = lower(?)
          and lower(title) = lower(?)
        order by (posted_at is null), posted_at desc, updated_at desc, id desc
        limit 1
      `).get(
        sanitizedJob.company,
        sanitizedJob.title
      ) as { id: number; fingerprint: string } | undefined;
    }
    const targetFingerprint = dedupeCandidate?.fingerprint ?? sanitizedJob.fingerprint;
    const insert = this.sqlite.prepare(`
      insert into jobs (
        fingerprint, portal, source_url, apply_url, company, title, location, posted_at, remote_policy,
        compensation_text, salary_min, salary_max, employment_type, external_id, raw_json, normalized_json,
        status, visit_count, created_at, updated_at
      ) values (
        @fingerprint, @portal, @source_url, @apply_url, @company, @title, @location, @posted_at, @remote_policy,
        @compensation_text, @salary_min, @salary_max, @employment_type, @external_id, @raw_json, @normalized_json,
        @status, @visit_count, @created_at, @updated_at
      )
      on conflict(fingerprint) do update set
        portal = excluded.portal,
        source_url = excluded.source_url,
        apply_url = excluded.apply_url,
        company = excluded.company,
        title = excluded.title,
        location = excluded.location,
        posted_at = case
          when excluded.posted_at is null then jobs.posted_at
          when jobs.posted_at is null then excluded.posted_at
          when julianday(excluded.posted_at) is not null and julianday(jobs.posted_at) is not null and julianday(excluded.posted_at) > julianday(jobs.posted_at) then excluded.posted_at
          when julianday(excluded.posted_at) is null and julianday(jobs.posted_at) is null and excluded.posted_at > jobs.posted_at then excluded.posted_at
          when julianday(excluded.posted_at) is not null and julianday(jobs.posted_at) is null then excluded.posted_at
          else jobs.posted_at
        end,
        remote_policy = coalesce(excluded.remote_policy, jobs.remote_policy),
        compensation_text = coalesce(excluded.compensation_text, jobs.compensation_text),
        salary_min = coalesce(excluded.salary_min, jobs.salary_min),
        salary_max = coalesce(excluded.salary_max, jobs.salary_max),
        employment_type = coalesce(excluded.employment_type, jobs.employment_type),
        external_id = coalesce(excluded.external_id, jobs.external_id),
        raw_json = excluded.raw_json,
        normalized_json = excluded.normalized_json,
        updated_at = excluded.updated_at
    `);
    insert.run({
      fingerprint: targetFingerprint,
      portal: sanitizedJob.portal,
      source_url: sanitizedJob.sourceUrl,
      apply_url: sanitizedJob.applyUrl,
      company: sanitizedJob.company,
      title: sanitizedJob.title,
      location: sanitizedJob.location,
      posted_at: sanitizedJob.postedAt ?? null,
      remote_policy: sanitizedJob.remotePolicy ?? null,
      compensation_text: sanitizedJob.compensationText ?? null,
      salary_min: sanitizedJob.salaryMin ?? null,
      salary_max: sanitizedJob.salaryMax ?? null,
      employment_type: sanitizedJob.employmentType ?? null,
      external_id: sanitizedJob.externalId ?? null,
      raw_json: JSON.stringify(sanitizedJob),
      normalized_json: JSON.stringify(sanitizedJob),
      status: sanitizedJob.status,
      visit_count: sanitizedJob.visitedCount,
      created_at: now,
      updated_at: now
    });
    this.invalidateJobCache();

    const row = this.sqlite.prepare("select id from jobs where fingerprint = ?").get(targetFingerprint) as { id: number };
    return row.id;
  }

  upsertCareerSource(source: CareerSource): number {
    const now = new Date().toISOString();
    const existing = this.sqlite.prepare(`
      select id from career_sources
      where source_url = ?
         or (name = ? and kind = ? and region_id = ?)
      limit 1
    `).get(source.sourceUrl, source.name, source.kind, source.regionId) as { id: number } | undefined;

    if (existing) {
      this.sqlite.prepare(`
        update career_sources
        set
          name = ?,
          source_url = ?,
          kind = ?,
          region_id = ?,
          active = ?,
          use_persistent_browser = ?,
          metadata_json = ?,
          last_synced_at = ?,
          last_status = ?,
          updated_at = ?
        where id = ?
      `).run(
        source.name,
        source.sourceUrl,
        source.kind,
        source.regionId,
        source.active ? 1 : 0,
        source.usePersistentBrowser ? 1 : 0,
        JSON.stringify(source.metadata ?? {}),
        source.lastSyncedAt ?? null,
        source.lastStatus ?? "idle",
        now,
        existing.id
      );
      return existing.id;
    }

    this.sqlite.prepare(`
      insert into career_sources (
        name, source_url, kind, region_id, active, use_persistent_browser, metadata_json,
        last_synced_at, last_status, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.name,
      source.sourceUrl,
      source.kind,
      source.regionId,
      source.active ? 1 : 0,
      source.usePersistentBrowser ? 1 : 0,
      JSON.stringify(source.metadata ?? {}),
      source.lastSyncedAt ?? null,
      source.lastStatus ?? "idle",
      now,
      now
    );
    const row = this.sqlite.prepare("select id from career_sources where source_url = ?").get(source.sourceUrl) as { id: number };
    return row.id;
  }

  listCareerSources(options: { activeOnly?: boolean; regionId?: string } = {}): StoredCareerSource[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (options.activeOnly ?? true) {
      clauses.push("active = 1");
    }
    if (options.regionId) {
      clauses.push("region_id = ?");
      values.push(options.regionId);
    }
    const whereClause = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const rows = this.sqlite.prepare(`select * from career_sources ${whereClause} order by updated_at desc, id desc`).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as number,
      name: row.name as string,
      sourceUrl: row.source_url as string,
      kind: row.kind as CareerSource["kind"],
      regionId: row.region_id as string,
      active: (row.active as number) === 1,
      usePersistentBrowser: (row.use_persistent_browser as number) === 1,
      metadata: JSON.parse((row.metadata_json as string) || "{}") as Record<string, unknown>,
      metadataJson: row.metadata_json as string,
      lastSyncedAt: (row.last_synced_at as string | null) ?? undefined,
      lastStatus: ((row.last_status as string | null) ?? "idle") as StoredCareerSource["lastStatus"],
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    }));
  }

  getCareerSource(sourceId: number): StoredCareerSource {
    const match = this.listCareerSources({ activeOnly: false }).find((source) => source.id === sourceId);
    if (match == null) {
      throw new Error(`Unknown source id ${sourceId}`);
    }
    return match;
  }

  updateCareerSourceSync(sourceId: number, status: StoredCareerSource["lastStatus"], syncedAt: string): void {
    this.sqlite.prepare(`update career_sources set last_status = ?, last_synced_at = ?, updated_at = ? where id = ?`).run(status, syncedAt, syncedAt, sourceId);
  }

  saveSourceSyncRun(run: SourceSyncRun): void {
    this.sqlite.prepare(`insert into source_sync_runs (source_id, summary_json, status, created_at) values (?, ?, ?, ?)`)
      .run(run.sourceId, JSON.stringify(run), run.status, run.completedAt);
  }

  listJobs(): JobRecordWithArtifacts[] {
    if (this.jobCache != null) {
      return this.jobCache;
    }
    const rows = this.sqlite.prepare(`
      select
        j.*,
        e.report_json as evaluation_json,
        r.variant_json as resume_json,
        a.draft_json as application_json,
        rr.report_json as research_json,
        cd.draft_json as contact_json
      from jobs j
      left join evaluations e on e.job_id = j.id
      left join resumes r on r.job_id = j.id
      left join applications a on a.job_id = j.id
      left join research_reports rr on rr.job_id = j.id
      left join contact_drafts cd on cd.job_id = j.id
      order by j.updated_at desc, j.id desc
    `).all() as Array<Record<string, unknown>>;

    this.jobCache = rows.map((row) => {
      const sanitizedCompensation = sanitizeStoredCompensation(
        (row.compensation_text as string | null) ?? undefined,
        (row.salary_min as number | null) ?? undefined,
        (row.salary_max as number | null) ?? undefined
      );

      return {
        job: {
          id: row.id as number,
          fingerprint: row.fingerprint as string,
          portal: row.portal as string,
          sourceUrl: row.source_url as string,
          applyUrl: row.apply_url as string,
          company: row.company as string,
          title: row.title as string,
          location: row.location as string,
          postedAt: (row.posted_at as string | null) ?? undefined,
          remotePolicy: (row.remote_policy as string | null) ?? undefined,
          compensationText: sanitizedCompensation.compensationText,
          salaryMin: sanitizedCompensation.salaryMin,
          salaryMax: sanitizedCompensation.salaryMax,
          employmentType: (row.employment_type as string | null) ?? undefined,
          externalId: (row.external_id as string | null) ?? undefined,
          rawJson: sanitizeStoredJson(row.raw_json as string),
          normalizedJson: sanitizeStoredJson(row.normalized_json as string),
          status: row.status as ApplicationState,
          visitCount: row.visit_count as number,
          createdAt: row.created_at as string,
          updatedAt: row.updated_at as string
        },
        evaluation: row.evaluation_json ? JSON.parse(row.evaluation_json as string) as EvaluationReport : null,
        resume: row.resume_json ? JSON.parse(row.resume_json as string) as ResumeVariant : null,
        application: row.application_json ? JSON.parse(row.application_json as string) as ApplicationDraft : null,
        research: row.research_json ? JSON.parse(row.research_json as string) as DeepResearchReport : null,
        contact: row.contact_json ? JSON.parse(row.contact_json as string) as ContactDraft : null
      };
    });
    return this.jobCache;
  }

  refreshJobs(): JobRecordWithArtifacts[] {
    this.invalidateJobCache();
    return this.listJobs();
  }

  getJobRecord(jobId: number): JobRecordWithArtifacts {
    const match = this.listJobs().find((record) => record.job.id === jobId);
    if (match == null) {
      throw new Error(`Unknown job id ${jobId}`);
    }
    return match;
  }

  listJobsByStatus(statuses: ApplicationState[]): JobRecordWithArtifacts[] {
    return this.listJobs().filter((record) => statuses.includes(record.job.status));
  }

  updateJobStatus(jobId: number, nextStatus: ApplicationState): void {
    const now = new Date().toISOString();
    const current = this.getJobRecord(jobId).job.status;
    assertTransition(current, nextStatus);
    this.sqlite.prepare("update jobs set status = ?, updated_at = ? where id = ?").run(nextStatus, now, jobId);

    if (this.jobCache != null) {
      const cached = this.jobCache.find((record) => record.job.id === jobId);
      if (cached != null) {
        cached.job.status = nextStatus;
        cached.job.updatedAt = now;
        return;
      }
    }
    this.invalidateJobCache();
  }

  setVisitCount(jobId: number, visitCount: number): void {
    this.sqlite.prepare("update jobs set visit_count = ?, updated_at = ? where id = ?").run(visitCount, new Date().toISOString(), jobId);
    this.invalidateJobCache();
  }

  saveEvaluation(jobId: number, report: EvaluationReport): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      insert into evaluations (job_id, report_json, total_score, recommended_action, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(job_id) do update set
        report_json = excluded.report_json,
        total_score = excluded.total_score,
        recommended_action = excluded.recommended_action,
        updated_at = excluded.updated_at
    `).run(jobId, JSON.stringify(report), report.totalScore, report.recommendedAction, now, now);
    this.invalidateJobCache();
  }

  saveResume(jobId: number, variant: ResumeVariant): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      insert into resumes (job_id, variant_json, file_path, created_at, updated_at)
      values (?, ?, ?, ?, ?)
      on conflict(job_id) do update set
        variant_json = excluded.variant_json,
        file_path = excluded.file_path,
        updated_at = excluded.updated_at
    `).run(jobId, JSON.stringify(variant), variant.pdfPath, now, now);
    this.invalidateJobCache();
  }

  saveApplicationDraft(jobId: number, draft: ApplicationDraft): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      insert into applications (job_id, draft_json, status, created_at, updated_at)
      values (?, ?, ?, ?, ?)
      on conflict(job_id) do update set
        draft_json = excluded.draft_json,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(jobId, JSON.stringify(draft), draft.status, now, now);
    this.invalidateJobCache();
  }

  saveResearch(jobId: number, report: DeepResearchReport): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      insert into research_reports (job_id, report_json, created_at, updated_at)
      values (?, ?, ?, ?)
      on conflict(job_id) do update set
        report_json = excluded.report_json,
        updated_at = excluded.updated_at
    `).run(jobId, JSON.stringify(report), now, now);
    this.invalidateJobCache();
  }

  saveContactDraft(jobId: number, draft: ContactDraft): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      insert into contact_drafts (job_id, draft_json, created_at, updated_at)
      values (?, ?, ?, ?)
      on conflict(job_id) do update set
        draft_json = excluded.draft_json,
        updated_at = excluded.updated_at
    `).run(jobId, JSON.stringify(draft), now, now);
    this.invalidateJobCache();
  }

  saveTrainingAssessment(sourceKey: string, assessment: TrainingAssessment): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      insert into training_assessments (source_key, assessment_json, created_at, updated_at)
      values (?, ?, ?, ?)
      on conflict(source_key) do update set
        assessment_json = excluded.assessment_json,
        updated_at = excluded.updated_at
    `).run(sourceKey, JSON.stringify(assessment), now, now);
  }

  getTrainingAssessment(sourceKey: string): TrainingAssessment | null {
    const row = this.sqlite.prepare("select assessment_json from training_assessments where source_key = ?").get(sourceKey) as { assessment_json?: string } | undefined;
    return row?.assessment_json ? JSON.parse(row.assessment_json) as TrainingAssessment : null;
  }

  clearListings(): {
    jobs: number;
    evaluations: number;
    resumes: number;
    applications: number;
    researchReports: number;
    contactDrafts: number;
  } {
    const runCleanup = this.sqlite.transaction(() => {
      const contactDrafts = this.sqlite.prepare("delete from contact_drafts").run().changes;
      const researchReports = this.sqlite.prepare("delete from research_reports").run().changes;
      const applications = this.sqlite.prepare("delete from applications").run().changes;
      const resumes = this.sqlite.prepare("delete from resumes").run().changes;
      const evaluations = this.sqlite.prepare("delete from evaluations").run().changes;
      const jobs = this.sqlite.prepare("delete from jobs").run().changes;
      return {
        jobs,
        evaluations,
        resumes,
        applications,
        researchReports,
        contactDrafts
      };
    });
    const result = runCleanup();
    this.invalidateJobCache();
    return result;
  }

  saveRunSummary(summary: RunSummary): void {
    this.db.run(sql`insert into runs (mode, summary_json, created_at) values (${summary.mode}, ${JSON.stringify(summary)}, ${summary.completedAt})`);
  }
}
