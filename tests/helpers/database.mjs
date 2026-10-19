import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

export const ALICE = "00000000-0000-4000-8000-000000000001";
export const BOB = "00000000-0000-4000-8000-000000000002";
export const uuid = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Actual migrations, not a JS reimplementation. No hosted credentials or network. */
export async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    insert into auth.users values ('${ALICE}'), ('${BOB}');
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid;
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
    $$;
    grant usage on schema auth to authenticated, anon;
  `);
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(file, dir), "utf8"));
  }
  const dates = (await db.query(`select
    (now() at time zone 'UTC')::date::text today,
    ((now() at time zone 'UTC')::date + 1)::text tomorrow,
    (public.planner_review_schedule('UTC')->>'start') week,
    floor(extract(epoch from now()))::bigint::text epoch`)).rows[0];
  async function as(user, work, role = "authenticated", claims = {}) {
    // The role and claims cannot leak into the next fixture, including after SQL errors.
    return db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role, is_anonymous: false, ...claims })]);
      await tx.exec(`set local role ${role}`);
      return work(tx);
    });
  }
  async function call(action, args = {}, user = ALICE, timezone = "UTC") {
    return as(user, async (tx) => (await tx.query("select public.planner_call($1, $2::jsonb, $3) result", [action, JSON.stringify(args), timezone])).rows[0].result);
  }
  async function reset() {
    await db.exec(`truncate public.planner_accounts, public.planner_tasks, public.planner_resources,
      public.planner_stops, public.planner_reviews, public.planner_receipts, public.ai_review_requests,
      public.ai_usage, public.ai_review_previews restart identity cascade;
      update public.ai_controls set enabled = true, daily_attempt_limit = 150, monthly_attempt_limit = 600;`);
  }
  const create = (outcome = "Ship a useful outcome", user = ALICE) => call("create_task", { outcome, day: dates.today, estimatedMinutes: 30 }, user);
  return { db, dates, call, as, reset, create };
}

export function seededRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
