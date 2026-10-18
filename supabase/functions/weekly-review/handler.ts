import { ApiError, type Analysis, fingerprint, MAX_REQUEST_BYTES, type ReviewInput, validateAnalysis, validateInput } from "./domain.ts";
import { MODEL, readLimited } from "./provider.ts";

export type Reservation =
  | { outcome: "reserved"; id: string; leaseToken: string }
  | { outcome: "cached"; analysis: Analysis; model: string; generatedAt: string }
  | { outcome: "disabled" | "invalid" | "running" | "rate_limited" | "weekly_limit" | "global_limit" | "conflict" | "expired" };
export type Dependencies = {
  authenticate: (token: string) => Promise<string>;
  loadInput: (userId: string, timezone: string, preview?: boolean) => Promise<unknown>;
  reserve: (userId: string, input: ReviewInput, hash: string, preview?: boolean) => Promise<Reservation>;
  generate: (input: ReviewInput) => Promise<Analysis>;
  finish: (id: string, token: string, analysis: Analysis, preview?: boolean) => Promise<boolean>;
  fail: (id: string, token: string, preview?: boolean) => Promise<void>;
  now: () => Date;
  allowedOrigins: Set<string>;
};

const RESERVATION_ERRORS = {
  disabled: [503, "Weekly AI is temporarily disabled."],
  invalid: [400, "The requested review week or consent version is invalid."],
  running: [409, "This weekly review is already being generated. Please check again shortly."],
  rate_limited: [429, "The review retry allowance has been reached. Please try later."],
  weekly_limit: [429, "Your free weekly review allowance has been used."],
  global_limit: [503, "The free AI allowance has been reached. Your planner is unaffected."],
  conflict: [409, "A review already exists for this week with different activity. It cannot be regenerated."],
  expired: [410, "The retry cache has expired. Saved account reviews are unaffected."],
} as const;

export function createHandler(deps: Dependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get("Origin");
    const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin", "X-Content-Type-Options": "nosniff" });
    if (origin && deps.allowedOrigins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
    const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
    let reservation: Extract<Reservation, { outcome: "reserved" }> | undefined;
    let preview = false;
    try {
      // CORS is only a browser policy. Authentication and DB quotas protect native requests too.
      if (origin && !deps.allowedOrigins.has(origin)) throw new ApiError(403, "origin_not_allowed", "This origin is not allowed.");
      if (request.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== "POST") {
        headers.set("Allow", "POST, OPTIONS");
        throw new ApiError(405, "method_not_allowed", "Use POST to request a weekly review.");
      }
      const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("Authorization") ?? "");
      if (!bearer || bearer[1].length > 8192) throw new ApiError(401, "unauthorized", "A signed-in user session is required.");
      const userId = await deps.authenticate(bearer[1]);
      if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        throw new ApiError(415, "invalid_content_type", "Use application/json.");
      }
      const declaredLength = request.headers.get("Content-Length");
      if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) {
        throw new ApiError(413, "payload_too_large", "The weekly activity exceeds the review size limit.");
      }
      let value: unknown;
      try { value = JSON.parse(await readLimited(request.body, MAX_REQUEST_BYTES)); }
      catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, "invalid_json", "A valid JSON body is required.");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => key !== "timezone" && key !== "preview")
        || ("preview" in value && typeof value.preview !== "boolean") || !("timezone" in value)
        || typeof value.timezone !== "string" || !value.timezone || value.timezone.length > 100) {
        throw new ApiError(400, "invalid_request", "Send your device timezone and optional preview flag. Review activity is loaded from your account.");
      }
      preview = "preview" in value && value.preview === true;
      const source = await deps.loadInput(userId, value.timezone, preview);
      if (source && typeof source === "object" && "disabled" in source) {
        throw new ApiError(403, "consent_required", "Enable weekly AI in your account before requesting a review.");
      }
      if (source && typeof source === "object" && "activity" in source) {
        const activity = source.activity as { tasks?: unknown[]; stops?: unknown[] };
        if (activity.tasks?.length === 0 && activity.stops?.length === 0) return respond(200, { noData: true });
      }
      const input = validateInput(source, deps.now(), preview);
      const claim = await deps.reserve(userId, input, await fingerprint(input), preview);
      if (claim.outcome === "cached") {
        return respond(200, { analysis: validateAnalysis(claim.analysis, input.activity), model: claim.model, generatedAt: claim.generatedAt, cached: true });
      }
      if (claim.outcome !== "reserved") {
        const [status, message] = RESERVATION_ERRORS[claim.outcome];
        throw new ApiError(status, claim.outcome, preview && claim.outcome === "rate_limited"
          ? "Preview limit reached. Allow 10 minutes between requests; at most 3 attempts per UTC day. Failed attempts count."
          : message);
      }
      reservation = claim;
      const analysis = validateAnalysis(await deps.generate(input), input.activity);
      if (!await deps.finish(claim.id, claim.leaseToken, analysis, preview)) {
        throw new ApiError(503, "save_failed", "The review could not be saved. Please retry later.");
      }
      reservation = undefined;
      if (preview) return respond(200, { review: {
        weekStart: input.weekStart, weekEnd: input.weekEnd, activity: input.activity,
        analysis, model: MODEL, generatedAt: Math.floor(deps.now().getTime() / 1000),
      } });
      return respond(200, { analysis, model: MODEL, generatedAt: deps.now().toISOString(), cached: false });
    } catch (error) {
      if (reservation) {
        try { await deps.fail(reservation.id, reservation.leaseToken, preview); } catch { /* The lease expires; keep the attempt charged. */ }
      }
      const safe = error instanceof ApiError ? error : new ApiError(503, "unavailable", "Weekly AI is temporarily unavailable. Your planner is unaffected.");
      if (safe.status === 429) headers.set("Retry-After", preview ? "600" : "3600");
      if (safe.code === "running") headers.set("Retry-After", "15");
      return respond(safe.status, { error: { code: safe.code, message: safe.message } });
    }
  };
}
