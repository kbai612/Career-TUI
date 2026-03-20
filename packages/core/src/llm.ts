import OpenAI from "openai";
import { z } from "zod";
import { loadPrompt } from "./prompts";
import {
  buildDeepResearchReport,
  buildOfferComparison,
  buildOutreachDraft,
  buildTrainingAssessment,
  deterministicEvaluation
} from "./scoring";
import type { ArchetypeDefinition, EvaluationReport, JobListing, ModeName, ProfilePack, ScoringConfig } from "./types";

type LlmProvider = "deepseek" | "openrouter" | "openai";

interface LlmRuntimeConfig {
  provider: LlmProvider;
  apiKey?: string;
  model: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}

interface ModeContext {
  archetypes: ArchetypeDefinition[];
  scoring: ScoringConfig;
  profile: ProfilePack;
}

function readEnv(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveLlmProvider(env: NodeJS.ProcessEnv): LlmProvider {
  const explicit = readEnv(env.LLM_PROVIDER)?.toLowerCase();
  if (explicit === "deepseek" || explicit === "openrouter" || explicit === "openai") {
    return explicit;
  }
  if (readEnv(env.DEEPSEEK_API_KEY) != null) {
    return "deepseek";
  }
  if (readEnv(env.OPENROUTER_API_KEY) != null) {
    return "openrouter";
  }
  if (readEnv(env.OPENAI_API_KEY) != null) {
    return "openai";
  }
  return "deepseek";
}

export function resolveLlmRuntimeConfig(env: NodeJS.ProcessEnv = process.env): LlmRuntimeConfig {
  const provider = resolveLlmProvider(env);

  if (provider === "openrouter") {
    const defaultHeaders: Record<string, string> = {};
    const referer = readEnv(env.OPENROUTER_SITE_URL);
    const appName = readEnv(env.OPENROUTER_APP_NAME);
    if (referer != null) {
      defaultHeaders["HTTP-Referer"] = referer;
    }
    if (appName != null) {
      defaultHeaders["X-Title"] = appName;
    }

    return {
      provider,
      apiKey: readEnv(env.OPENROUTER_API_KEY),
      model: readEnv(env.OPENROUTER_MODEL) ?? "deepseek/deepseek-chat-v3-0324",
      baseURL: readEnv(env.OPENROUTER_BASE_URL) ?? "https://openrouter.ai/api/v1",
      defaultHeaders: Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined
    };
  }

  if (provider === "openai") {
    return {
      provider,
      apiKey: readEnv(env.OPENAI_API_KEY),
      model: readEnv(env.OPENAI_MODEL) ?? "gpt-4.1-mini",
      baseURL: readEnv(env.OPENAI_BASE_URL)
    };
  }

  return {
    provider: "deepseek",
    apiKey: readEnv(env.DEEPSEEK_API_KEY),
    model: readEnv(env.DEEPSEEK_MODEL) ?? "deepseek-chat",
    baseURL: readEnv(env.DEEPSEEK_BASE_URL) ?? "https://api.deepseek.com"
  };
}

export class OpenAIOrchestrator {
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(apiKey?: string, model?: string, baseURL?: string) {
    const runtimeConfig = resolveLlmRuntimeConfig();
    const resolvedApiKey = apiKey ?? runtimeConfig.apiKey;
    const resolvedBaseURL = baseURL ?? runtimeConfig.baseURL;

    this.model = model ?? runtimeConfig.model;

    if (resolvedApiKey == null) {
      this.client = null;
      return;
    }

    const options: ConstructorParameters<typeof OpenAI>[0] = { apiKey: resolvedApiKey };
    if (resolvedBaseURL != null) {
      options.baseURL = resolvedBaseURL;
    }
    if (runtimeConfig.defaultHeaders != null) {
      options.defaultHeaders = runtimeConfig.defaultHeaders;
    }

    this.client = new OpenAI(options);
  }

  async runStructured<T>(mode: ModeName, input: unknown, schema: z.ZodType<T>, context: ModeContext): Promise<T> {
    const liveModelModes: ModeName[] = ["offer-evaluator", "offer-report"];
    if (this.client == null || !liveModelModes.includes(mode)) {
      return this.mock(mode, input, schema, context);
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: mode === "offer-evaluator" || mode === "offer-report" || mode === "offer-comparison" ? 0.2 : 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: loadPrompt(mode) },
          { role: "user", content: JSON.stringify(input, null, 2) }
        ]
      });

      const raw = response.choices[0]?.message?.content ?? "{}";
      return schema.parse(JSON.parse(raw));
    } catch {
      return this.mock(mode, input, schema, context);
    }
  }

  private async mock<T>(mode: ModeName, input: unknown, schema: z.ZodType<T>, context: ModeContext): Promise<T> {
    switch (mode) {
      case "offer-evaluator":
      case "offer-report": {
        const report = deterministicEvaluation(input as JobListing, context.archetypes, context.scoring, context.profile);
        return schema.parse(report);
      }
      case "offer-comparison": {
        const comparison = buildOfferComparison(input as Array<{ jobId: number; company: string; title: string; report: EvaluationReport }>);
        return schema.parse(comparison);
      }
      case "company-research": {
        const payload = input as { jobId: number; job: JobListing; report: EvaluationReport };
        return schema.parse(buildDeepResearchReport(payload.jobId, payload.job, payload.report, context.profile));
      }
      case "contact-drafter": {
        const payload = input as { jobId: number; job: JobListing; report: EvaluationReport };
        return schema.parse(buildOutreachDraft(payload.jobId, payload.job, payload.report, context.profile));
      }
      case "training-evaluator": {
        const payload = input as { source: string };
        return schema.parse(buildTrainingAssessment(payload.source, context.archetypes, context.profile));
      }
      default:
        return schema.parse(input);
    }
  }
}
