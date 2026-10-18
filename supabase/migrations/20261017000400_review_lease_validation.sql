-- SQL NULL comparisons must fail closed. A NULL lease token previously made
-- the rejection predicate NULL rather than true, allowing an unmatched finish.
create or replace function public.finish_weekly_review(p_id uuid, p_lease_token uuid, p_analysis jsonb, p_model text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.ai_review_requests%rowtype; a public.planner_accounts%rowtype;
begin
  if p_lease_token is null then return false; end if;
  select * into r from public.ai_review_requests where id = p_id;
  if not found then return false; end if;
  select * into a from public.planner_accounts where user_id = r.user_id for update;
  select * into r from public.ai_review_requests where id = p_id for update;
  if a.ai_enabled is distinct from true or a.ai_revision is distinct from r.consent_revision or r.activity is null
    or r.lease_token is distinct from p_lease_token or r.status is distinct from 'running' or r.lease_until <= now()
    or p_analysis is null or jsonb_typeof(p_analysis) <> 'object' or octet_length(p_analysis::text) > 65536
    or p_model is null or length(p_model) not between 1 and 120 then return false; end if;
  insert into public.planner_reviews(user_id, week_start, report) values (r.user_id, r.week_start,
    jsonb_build_object('weekStart', r.week_start, 'weekEnd', r.week_start + 6, 'generatedAt', extract(epoch from now())::bigint,
      'model', p_model, 'activity', r.activity, 'analysis', p_analysis)) on conflict do nothing;
  update public.ai_review_requests set status = 'succeeded', analysis = p_analysis, model = p_model, generated_at = now(), activity = null where id = p_id;
  return true;
end;
$$;
revoke all on function public.finish_weekly_review(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.finish_weekly_review(uuid, uuid, jsonb, text) to service_role;
