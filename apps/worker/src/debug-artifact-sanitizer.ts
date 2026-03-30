const REDACTED_VALUE = "[REDACTED]";
const REDACTED_GOOGLE_API_KEY = "[REDACTED_GOOGLE_API_KEY]";

const JSON_SECRET_PROPERTY_PATTERN =
  /("(?:(?:[^"\\]|\\.)*?(?:api[_-]?key|developer[_-]?key|token|secret|client[_-]?id|app[_-]?id|site[_-]?key|recaptcha[^"]*key))"\s*:\s*")([^"]*)(")/gi;

const HTML_SECRET_ATTRIBUTE_PATTERN =
  /(\bdata-(?:app-key|api-key|developer-key|client-id|app-id|sitekey|site-key|token)\s*=\s*["'])([^"']*)(["'])/gi;

const ASSIGNMENT_SECRET_PATTERN =
  /(\b(?:api[_-]?key|developer[_-]?key|token|secret|client[_-]?id|app[_-]?id|site[_-]?key|recaptcha[_-]?(?:site|invisible)?[_-]?key)\b\s*[:=]\s*["'])([^"']*)(["'])/gi;

const RECAPTCHA_QUERY_PARAM_PATTERN =
  /((?:https?:)?\/\/[^"'<>\\\s]*recaptcha[^"'<>\\\s]*(?:\?|&|&amp;)(?:render|k)=)([^&"'<>\\\s]+)/gi;

const GENERIC_SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:api_key|apikey|client_id|app_id|token|sitekey|site_key)=)([^&"'<>\\\s]+)/gi;

export function sanitizeDebugArtifactText(value: string): string {
  return value
    .replace(GOOGLE_API_KEY_PATTERN, REDACTED_GOOGLE_API_KEY)
    .replace(JSON_SECRET_PROPERTY_PATTERN, `$1${REDACTED_VALUE}$3`)
    .replace(HTML_SECRET_ATTRIBUTE_PATTERN, `$1${REDACTED_VALUE}$3`)
    .replace(ASSIGNMENT_SECRET_PATTERN, `$1${REDACTED_VALUE}$3`)
    .replace(RECAPTCHA_QUERY_PARAM_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(GENERIC_SENSITIVE_QUERY_PARAM_PATTERN, `$1${REDACTED_VALUE}`);
}

const GOOGLE_API_KEY_PATTERN = /AIza[0-9A-Za-z\-_]{20,}/g;
