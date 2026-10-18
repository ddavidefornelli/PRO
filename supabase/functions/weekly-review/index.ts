import { createHandler } from "./handler.ts";
import { platformDependencies } from "./platform.ts";

Deno.serve(createHandler(platformDependencies({
  url: Deno.env.get("SUPABASE_URL"),
  publicKey: Deno.env.get("SUPABASE_ANON_KEY"),
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  openAiKey: Deno.env.get("OPENAI_API_KEY"),
  allowedOrigins: Deno.env.get("ALLOWED_ORIGINS"),
})));
