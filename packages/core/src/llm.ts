import OpenAI from "openai";
import { z } from "zod";
import { loadPrompt } from "./prompts";
import { deterministicEvaluation } from "./scoring";
import type { ArchetypeDefinition, JobListing, ModeName, ProfilePack, ScoringConfig } from "./types";

interface ModeContext {
  archetypes: ArchetypeDefinition[];
  scoring: ScoringConfig;
  profile: ProfilePack;
}

export class OpenAIOrchestrator {
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini") {
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.model = model;
  }

  async runStructured<T>(mode: ModeName, input: unknown, schema: z.ZodType<T>, context: ModeContext): Promise<T> {
    if (this.client == null) {
      return this.mock(mode, input, schema, context);
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: mode === "offer-evaluator" ? 0.2 : 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: loadPrompt(mode) },
        { role: "user", content: JSON.stringify(input, null, 2) }
      ]
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    return schema.parse(JSON.parse(raw));
  }

  private async mock<T>(mode: ModeName, input: unknown, schema: z.ZodType<T>, context: ModeContext): Promise<T> {
    switch (mode) {
      case "offer-evaluator": {
        const report = deterministicEvaluation(input as JobListing, context.archetypes, context.scoring, context.profile);
        return schema.parse(report);
      }
      default:
        return schema.parse(input);
    }
  }
}
