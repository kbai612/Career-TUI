import { describe, expect, it } from "vitest";
import { resolveLlmRuntimeConfig } from "../src/llm";

function env(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

describe("llm runtime config", () => {
  it("supports explicit openrouter provider configuration", () => {
    const config = resolveLlmRuntimeConfig(env({
      LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "or-key",
      OPENROUTER_MODEL: "openai/gpt-4.1-mini",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_SITE_URL: "https://career-ops.local",
      OPENROUTER_APP_NAME: "Career Ops"
    }));

    expect(config.provider).toBe("openrouter");
    expect(config.apiKey).toBe("or-key");
    expect(config.model).toBe("openai/gpt-4.1-mini");
    expect(config.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(config.defaultHeaders).toEqual({
      "HTTP-Referer": "https://career-ops.local",
      "X-Title": "Career Ops"
    });
  });

  it("falls back to openrouter when no provider is set and only OPENROUTER_API_KEY exists", () => {
    const config = resolveLlmRuntimeConfig(env({
      OPENROUTER_API_KEY: "or-key"
    }));

    expect(config.provider).toBe("openrouter");
    expect(config.apiKey).toBe("or-key");
    expect(config.model).toBe("deepseek/deepseek-chat-v3-0324");
    expect(config.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("resolves openai when only OPENAI_API_KEY is configured", () => {
    const config = resolveLlmRuntimeConfig(env({
      OPENAI_API_KEY: "openai-key",
      OPENAI_MODEL: "gpt-4.1-mini"
    }));

    expect(config.provider).toBe("openai");
    expect(config.apiKey).toBe("openai-key");
    expect(config.model).toBe("gpt-4.1-mini");
    expect(config.baseURL).toBeUndefined();
  });

  it("defaults to deepseek when nothing is configured", () => {
    const config = resolveLlmRuntimeConfig(env({}));

    expect(config.provider).toBe("deepseek");
    expect(config.apiKey).toBeUndefined();
    expect(config.model).toBe("deepseek-chat");
    expect(config.baseURL).toBe("https://api.deepseek.com");
  });

  it("ignores invalid LLM_PROVIDER and uses key-based fallback", () => {
    const config = resolveLlmRuntimeConfig(env({
      LLM_PROVIDER: "invalid-provider",
      OPENAI_API_KEY: "openai-key"
    }));

    expect(config.provider).toBe("openai");
    expect(config.apiKey).toBe("openai-key");
  });
});
