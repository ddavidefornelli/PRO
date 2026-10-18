import { ApiError, type Analysis, type ReviewInput } from "./domain.ts";
import type { Dependencies, Reservation } from "./handler.ts";
import { generateReview, HTTP_TIMEOUT_MS, MAX_RESPONSE_BYTES, MODEL, readLimited } from "./provider.ts";

type Config = {
  url?: string;
  publicKey?: string;
  serviceKey?: string;
  openAiKey?: string;
  allowedOrigins?: string;
};
const unavailable = () => new ApiError(503, "unavailable", "Weekly AI is temporarily unavailable. Your planner is unaffected.");

/** All privileged platform access lives here; no service key reaches callers. */
export function platformDependencies(config: Config, fetcher: typeof fetch = fetch): Dependencies {
  const url = config.url?.replace(/\/$/, "");
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!url || !config.serviceKey) throw unavailable();
    const response = await fetcher(`${url}/rest/v1/rpc/${name}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    return JSON.parse(await readLimited(response.body, MAX_RESPONSE_BYTES)) as T;
  }

  return {
    async authenticate(token: string): Promise<string> {
      if (!url || !config.publicKey || !config.serviceKey || !config.openAiKey) throw unavailable();
      // Auth validates signature, expiry and the user. Never just decode the JWT,
      // and never trust a userId supplied in the request body.
      const response = await fetcher(`${url}/auth/v1/user`, {
        headers: { apikey: config.publicKey, Authorization: `Bearer ${token}` },
        redirect: "error", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          throw new ApiError(401, "unauthorized", "Your session has expired. Please sign in again.");
        }
        throw unavailable();
      }
      const user = JSON.parse(await readLimited(response.body, 32_768));
      if (user.role !== "authenticated" || user.is_anonymous === true || typeof user.email !== "string" || !user.email
        || typeof user.id !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id)) {
        throw new ApiError(401, "unauthorized", "A valid user session is required.");
      }
      return user.id;
    },
    loadInput: (userId: string, timezone: string) => rpc<unknown>("planner_review_input", { p_user_id: userId, p_timezone: timezone }),
    reserve(userId: string, input: ReviewInput, hash: string) {
      return rpc<Reservation>("reserve_planner_review", {
        p_user_id: userId, p_week_start: input.weekStart, p_request_hash: hash, p_consent_version: input.consentVersion,
        p_activity: input.activity,
      });
    },
    generate: (input: ReviewInput) => generateReview(input, config.openAiKey!, fetcher),
    finish: (id: string, token: string, analysis: Analysis) => rpc<boolean>("finish_weekly_review", {
      p_id: id, p_lease_token: token, p_analysis: analysis, p_model: MODEL,
    }),
    async fail(id: string, token: string) {
      await rpc<boolean>("fail_weekly_review", { p_id: id, p_lease_token: token });
    },
    now: () => new Date(),
    allowedOrigins: new Set((config.allowedOrigins ?? "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://127.0.0.1:1420")
      .split(",").map((origin) => origin.trim()).filter(Boolean)),
  };
}
