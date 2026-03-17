import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { assertTransition } from "./state-machine";
import type { ApplicationDraft, ApplicationState, EvaluationReport, NormalizedJob, ResumeVariant, RunSummary, StoredJobRecord } from "./types";

export interface JobRecordWithArtifacts {
  job: StoredJobRecord;
  evaluation: EvaluationReport | null;
  resume: ResumeVariant | null;
  application: ApplicationDraft | null;
}

export class CareerOpsRepository {
  readonly sqlite: Database.Database;
  readonly db;

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

  upsertJob(job: NormalizedJob): number {
    const now = new Date().toISOString();
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
      fingerprint: job.fingerprint,
      portal: job.portal,
      source_url: job.sourceUrl,
      apply_url: job.applyUrl,
      company: job.company,
      title: job.title,
      location: job.location,
      posted_at: job.postedAt ?? null,
      remote_policy: job.remotePolicy ?? null,
      compensation_text: job.compensationText ?? null,
      salary_min: job.salaryMin ?? null,
      salary_max: job.salaryMax ?? null,
      employment_type: job.employmentType ?? null,
      external_id: job.externalId ?? null,
      raw_json: JSON.stringify(job),
      normalized_json: JSON.stringify(job),
      status: job.status,
      visit_count: job.visitedCount,
      created_at: now,
      updated_at: now
    });

    const row = this.sqlite.prepare("select id from jobs where fingerprint = ?").get(job.fingerprint) as { id: number };
    return row.id;
  }

  listJobs(): JobRecordWithArtifacts[] {
    const rows = this.sqlite.prepare(`
      select
        j.*,
        e.report_json as evaluation_json,
        r.variant_json as resume_json,
        a.draft_json as application_json
      from jobs j
      left join evaluations e on e.job_id = j.id
      left join resumes r on r.job_id = j.id
      left join applications a on a.job_id = j.id
      order by j.updated_at desc, j.id desc
    `).all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
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
        compensationText: (row.compensation_text as string | null) ?? undefined,
        salaryMin: (row.salary_min as number | null) ?? undefined,
        salaryMax: (row.salary_max as number | null) ?? undefined,
        employmentType: (row.employment_type as string | null) ?? undefined,
        externalId: (row.external_id as string | null) ?? undefined,
        rawJson: row.raw_json as string,
        normalizedJson: row.normalized_json as string,
        status: row.status as ApplicationState,
        visitCount: row.visit_count as number,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string
      },
      evaluation: row.evaluation_json ? JSON.parse(row.evaluation_json as string) as EvaluationReport : null,
      resume: row.resume_json ? JSON.parse(row.resume_json as string) as ResumeVariant : null,
      application: row.application_json ? JSON.parse(row.application_json as string) as ApplicationDraft : null
    }));
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
  }

  setVisitCount(jobId: number, visitCount: number): void {
    this.sqlite.prepare("update jobs set visit_count = ?, updated_at = ? where id = ?").run(visitCount, new Date().toISOString(), jobId);
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
  }

  saveRunSummary(summary: RunSummary): void {
    this.db.run(sql`insert into runs (mode, summary_json, created_at) values (${summary.mode}, ${JSON.stringify(summary)}, ${summary.completedAt})`);
  }
}
