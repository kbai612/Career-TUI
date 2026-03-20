import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { sanitizeCompensationText } from "./compensation";
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

  close(): void {
    this.sqlite.close();
  }

  private invalidateJobCache(): void {
    this.jobCache = null;
  }

  upsertJob(job: NormalizedJob): number {
    const now = new Date().toISOString();
    const sanitizedCompensation = sanitizeStoredCompensation(job.compensationText, job.salaryMin, job.salaryMax);
    const sanitizedJob: NormalizedJob = {
      ...job,
      compensationText: sanitizedCompensation.compensationText,
      salaryMin: sanitizedCompensation.salaryMin,
      salaryMax: sanitizedCompensation.salaryMax
    };
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
        posted_at = excluded.posted_at,
        remote_policy = excluded.remote_policy,
        compensation_text = excluded.compensation_text,
        salary_min = excluded.salary_min,
        salary_max = excluded.salary_max,
        employment_type = excluded.employment_type,
        external_id = excluded.external_id,
        raw_json = excluded.raw_json,
        normalized_json = excluded.normalized_json,
        updated_at = excluded.updated_at
    `);
    insert.run({
      fingerprint: sanitizedJob.fingerprint,
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

    const row = this.sqlite.prepare("select id from jobs where fingerprint = ?").get(sanitizedJob.fingerprint) as { id: number };
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
    const current = this.getJobRecord(jobId).job.status;
    assertTransition(current, nextStatus);
    this.sqlite.prepare("update jobs set status = ?, updated_at = ? where id = ?").run(nextStatus, new Date().toISOString(), jobId);
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

  saveRunSummary(summary: RunSummary): void {
    this.db.run(sql`insert into runs (mode, summary_json, created_at) values (${summary.mode}, ${JSON.stringify(summary)}, ${summary.completedAt})`);
  }
}
