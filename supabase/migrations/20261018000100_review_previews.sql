-- On-demand current-week previews have independent account limits but share the provider budget.
-- Only quota/lease metadata is retained; preview activity and output are returned to the caller.
create table public.ai_review_previews (
  user_id uuid primary key references auth.users(id) on delete cascade,
  quota_day date not null,
  attempts integer not null check (attempts between 1 and 3),
  last_attempt_at timestamptz not null default now(),
  lease_token uuid not null,
  lease_until timestamptz not null,
  consent_revision bigint not null,
  status text not null check (status in ('running', 'succeeded', 'failed'))
);
alter table public.ai_review_previews enable row level security;
revoke all on public.ai_review_previews from public, anon, authenticated;
grant select, insert, update, delete on public.ai_review_previews to service_role;

create function public.planner_preview_input(p_user_id uuid, p_timezone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.planner_accounts%rowtype; d date; w date; activity jsonb;
begin
  select * into a from public.planner_accounts where user_id = p_user_id;
  if not found or not a.ai_enabled or a.consent_version is distinct from 'weekly-ai-v1' then return jsonb_build_object('disabled', true); end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then return jsonb_build_object('invalid', true); end if;
  d := (now() at time zone p_timezone)::date;
  w := date_trunc('week', d::timestamp)::date;
  activity := public.planner_activity(p_user_id, w);
  -- Exclude tomorrow's plan and any future-dated activity from a week-so-far review.
  activity := jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(t) from jsonb_array_elements(activity->'tasks') t
      where (t->>'plannedFor')::date <= d
        or (t->>'completedOn')::date <= d
        or exists(select 1 from jsonb_array_elements(activity->'stops') s where s->>'taskId' = t->>'id' and (s->>'stoppedOn')::date <= d)), '[]'::jsonb),
    'stops', coalesce((select jsonb_agg(s) from jsonb_array_elements(activity->'stops') s where (s->>'stoppedOn')::date <= d), '[]'::jsonb),
    'totalStops', (select count(*) from public.planner_stops where user_id = p_user_id and stopped_on between w and d),
    'omittedStops', greatest(0, (select count(*) from public.planner_stops where user_id = p_user_id and stopped_on between w and d)
      - (select count(*) from jsonb_array_elements(activity->'stops') s where (s->>'stoppedOn')::date <= d)));
  return jsonb_build_object('consentVersion', 'weekly-ai-v1', 'weekStart', w, 'weekEnd', d, 'activity', activity);
end;
$$;

create function public.reserve_review_preview(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.planner_accounts%rowtype; c public.ai_controls%rowtype; r public.ai_review_previews%rowtype;
  d date := (now() at time zone 'UTC')::date;
  day_key text := 'day:' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD');
  month_key text := 'month:' || to_char(now() at time zone 'UTC', 'YYYY-MM');
  token uuid := gen_random_uuid();
begin
  select * into a from public.planner_accounts where user_id = p_user_id for update;
  if not found or not a.ai_enabled or a.consent_version is distinct from 'weekly-ai-v1' then return jsonb_build_object('outcome', 'disabled'); end if;
  select * into c from public.ai_controls where id = true for update;
  if not found or not c.enabled then return jsonb_build_object('outcome', 'disabled'); end if;
  select * into r from public.ai_review_previews where user_id = p_user_id for update;
  if found then
    if r.status = 'running' and r.lease_until > now() then return jsonb_build_object('outcome', 'running'); end if;
    if r.last_attempt_at > now() - interval '10 minutes' or (r.quota_day = d and r.attempts >= 3) then
      return jsonb_build_object('outcome', 'rate_limited');
    end if;
  end if;
  insert into public.ai_usage(period) values (day_key), (month_key) on conflict do nothing;
  if (select attempts from public.ai_usage where period = day_key) >= c.daily_attempt_limit
    or (select attempts from public.ai_usage where period = month_key) >= c.monthly_attempt_limit then
    return jsonb_build_object('outcome', 'global_limit');
  end if;
  update public.ai_usage set attempts = attempts + 1 where period in (day_key, month_key);
  insert into public.ai_review_previews(user_id, quota_day, attempts, lease_token, lease_until, consent_revision, status)
    values (p_user_id, d, 1, token, now() + interval '3 minutes', a.ai_revision, 'running')
    on conflict (user_id) do update set quota_day = d,
      attempts = case when ai_review_previews.quota_day = d then ai_review_previews.attempts + 1 else 1 end,
      last_attempt_at = now(), lease_token = token, lease_until = now() + interval '3 minutes', consent_revision = a.ai_revision, status = 'running';
  return jsonb_build_object('outcome', 'reserved', 'id', p_user_id, 'leaseToken', token);
end;
$$;

create function public.finish_review_preview(p_id uuid, p_lease_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare a public.planner_accounts%rowtype;
begin
  select * into a from public.planner_accounts where user_id = p_id for update;
  if not found or not a.ai_enabled or a.consent_version is distinct from 'weekly-ai-v1' then return false; end if;
  update public.ai_review_previews set status = 'succeeded'
    where user_id = p_id and lease_token = p_lease_token and status = 'running' and lease_until > now() and consent_revision = a.ai_revision;
  return found;
end;
$$;

create function public.fail_review_preview(p_id uuid, p_lease_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.ai_review_previews set status = 'failed' where user_id = p_id and lease_token = p_lease_token and status = 'running';
  return found;
end;
$$;
revoke all on function public.planner_preview_input(uuid, text), public.reserve_review_preview(uuid), public.finish_review_preview(uuid, uuid), public.fail_review_preview(uuid, uuid) from public, anon, authenticated;
grant execute on function public.planner_preview_input(uuid, text), public.reserve_review_preview(uuid), public.finish_review_preview(uuid, uuid), public.fail_review_preview(uuid, uuid) to service_role;
