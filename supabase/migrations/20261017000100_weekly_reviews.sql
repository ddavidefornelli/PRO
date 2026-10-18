-- Private operational state only. Task inputs are never persisted here.
create table public.ai_controls (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  daily_attempt_limit integer not null default 150 check (daily_attempt_limit between 1 and 1000),
  monthly_attempt_limit integer not null default 600 check (monthly_attempt_limit between 1 and 10000)
);
insert into public.ai_controls (id) values (true);

create table public.ai_usage (
  period text primary key,
  attempts integer not null default 0 check (attempts >= 0)
);

create table public.ai_review_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  quota_week date not null,
  week_start date not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  consent_version text not null check (consent_version = 'weekly-ai-v1'),
  consent_recorded_at timestamptz not null default now(),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 3),
  lease_token uuid not null,
  lease_until timestamptz not null,
  last_attempt_at timestamptz not null default now(),
  analysis jsonb,
  model text,
  generated_at timestamptz,
  unique (user_id, quota_week),
  unique (user_id, week_start)
);

alter table public.ai_controls enable row level security;
alter table public.ai_usage enable row level security;
alter table public.ai_review_requests enable row level security;
-- No client policies: clients cannot inspect or alter budgets, consent, or cached reviews.
revoke all on public.ai_controls, public.ai_usage, public.ai_review_requests from public, anon, authenticated;
grant select, insert, update, delete on public.ai_controls, public.ai_usage, public.ai_review_requests to service_role;

-- The control-row lock serializes reservations across all users. Limits count
-- attempted provider calls, including failures/timeouts; reservations are never refunded.
create function public.reserve_weekly_review(p_user_id uuid, p_week_start date, p_request_hash text, p_consent_version text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  v_today date := (v_now at time zone 'UTC')::date;
  v_quota_week date := date_trunc('week', v_now at time zone 'UTC')::date;
  v_day text := 'day:' || to_char(v_now at time zone 'UTC', 'YYYY-MM-DD');
  v_month text := 'month:' || to_char(v_now at time zone 'UTC', 'YYYY-MM');
  v_controls public.ai_controls%rowtype;
  v_request public.ai_review_requests%rowtype;
  v_token uuid := gen_random_uuid();
  v_attempts integer;
begin
  if p_user_id is null or p_week_start is null or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_consent_version is distinct from 'weekly-ai-v1' then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  -- At a UTC Monday boundary, the user's local date can be Sunday or Tuesday.
  -- Only the latest closed local week is accepted; no arbitrary historical generation.
  if extract(isodow from p_week_start) <> 1
     or p_week_start not in (
       date_trunc('week', (v_today - 1)::timestamp)::date - 7,
       v_quota_week - 7,
       date_trunc('week', (v_today + 1)::timestamp)::date - 7
     ) then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into v_controls from public.ai_controls where id = true for update;
  if not found or not v_controls.enabled then
    return jsonb_build_object('outcome', 'disabled');
  end if;

  select * into v_request from public.ai_review_requests
    where user_id = p_user_id and week_start = p_week_start for update;
  if found then
    if v_request.status = 'succeeded' then
      if v_request.request_hash <> p_request_hash then
        return jsonb_build_object('outcome', 'conflict');
      end if;
      if v_request.generated_at <= v_now - interval '7 days' or v_request.analysis is null then
        return jsonb_build_object('outcome', 'expired');
      end if;
      return jsonb_build_object('outcome', 'cached', 'analysis', v_request.analysis,
        'model', v_request.model, 'generatedAt', v_request.generated_at);
    end if;
    if v_request.status = 'running' and v_request.lease_until > v_now then
      return jsonb_build_object('outcome', 'running');
    end if;
    if v_request.attempts >= 3 or v_request.last_attempt_at > v_now - interval '1 hour' then
      return jsonb_build_object('outcome', 'rate_limited');
    end if;
    -- Old local-week requests cannot be retried to bypass a new UTC week's quota.
    if v_request.quota_week <> v_quota_week then
      return jsonb_build_object('outcome', 'weekly_limit');
    end if;
  else
    if exists (select 1 from public.ai_review_requests where user_id = p_user_id and quota_week = v_quota_week) then
      return jsonb_build_object('outcome', 'weekly_limit');
    end if;
  end if;

  insert into public.ai_usage (period) values (v_day), (v_month) on conflict do nothing;
  select attempts into v_attempts from public.ai_usage where period = v_day;
  if v_attempts >= v_controls.daily_attempt_limit then
    return jsonb_build_object('outcome', 'global_limit');
  end if;
  select attempts into v_attempts from public.ai_usage where period = v_month;
  if v_attempts >= v_controls.monthly_attempt_limit then
    return jsonb_build_object('outcome', 'global_limit');
  end if;
  update public.ai_usage set attempts = attempts + 1 where period in (v_day, v_month);

  if v_request.id is null then
    insert into public.ai_review_requests
      (user_id, quota_week, week_start, request_hash, consent_version, status, lease_token, lease_until)
    values (p_user_id, v_quota_week, p_week_start, p_request_hash, p_consent_version, 'running', v_token, v_now + interval '3 minutes')
    returning * into v_request;
  else
    update public.ai_review_requests set status = 'running', request_hash = p_request_hash,
      consent_version = p_consent_version, consent_recorded_at = v_now,
      attempts = attempts + 1, last_attempt_at = v_now,
      lease_token = v_token, lease_until = v_now + interval '3 minutes'
    where id = v_request.id returning * into v_request;
  end if;
  return jsonb_build_object('outcome', 'reserved', 'id', v_request.id, 'leaseToken', v_token);
end;
$$;

create function public.finish_weekly_review(p_id uuid, p_lease_token uuid, p_analysis jsonb, p_model text)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_analysis is null or jsonb_typeof(p_analysis) <> 'object'
     or octet_length(p_analysis::text) > 65536
     or p_model is null or length(p_model) not between 1 and 120 then
    return false;
  end if;
  update public.ai_review_requests set status = 'succeeded', analysis = p_analysis,
    model = p_model, generated_at = now()
  where id = p_id and lease_token = p_lease_token and status = 'running' and lease_until > now();
  return found;
end;
$$;

create function public.fail_weekly_review(p_id uuid, p_lease_token uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.ai_review_requests set status = 'failed'
    where id = p_id and lease_token = p_lease_token and status = 'running';
  return found;
end;
$$;

-- Run daily using Supabase Cron. Quota tombstones remain after content deletion.
create function public.purge_weekly_review_content()
returns void
language sql security definer set search_path = '' as $$
  update public.ai_review_requests set analysis = null
    where analysis is not null and generated_at <= now() - interval '7 days';
  delete from public.ai_review_requests where last_attempt_at < now() - interval '90 days';
  delete from public.ai_usage
    where period < 'day:' || to_char((now() at time zone 'UTC') - interval '90 days', 'YYYY-MM-DD')
      and period like 'day:%';
  delete from public.ai_usage
    where period < 'month:' || to_char((now() at time zone 'UTC') - interval '1 year', 'YYYY-MM')
      and period like 'month:%';
$$;

revoke all on function public.reserve_weekly_review(uuid, date, text, text) from public, anon, authenticated;
revoke all on function public.finish_weekly_review(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.fail_weekly_review(uuid, uuid) from public, anon, authenticated;
revoke all on function public.purge_weekly_review_content() from public, anon, authenticated;
grant execute on function public.reserve_weekly_review(uuid, date, text, text) to service_role;
grant execute on function public.finish_weekly_review(uuid, uuid, jsonb, text) to service_role;
grant execute on function public.fail_weekly_review(uuid, uuid) to service_role;
grant execute on function public.purge_weekly_review_content() to service_role;
