-- Fresh cloud planner. Existing desktop SQLite files are deliberately not imported.
create table public.planner_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ai_enabled boolean not null default false,
  ai_revision bigint not null default 0,
  consent_version text,
  consent_recorded_at timestamptz
);
create table public.planner_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  outcome text not null check (length(trim(outcome)) between 1 and 500),
  planned_for date not null,
  slot smallint not null check (slot between 1 and 3),
  estimated_minutes integer not null check (estimated_minutes between 1 and 60),
  actual_seconds bigint not null default 0 check (actual_seconds >= 0),
  status text not null default 'planned' check (status in ('planned', 'active', 'completed')),
  started_at bigint,
  completed_on date,
  created_at bigint not null default extract(epoch from now())::bigint,
  is_priority boolean not null default false,
  unique (user_id, planned_for, slot),
  unique (user_id, id),
  check (started_at is null or status = 'active'),
  check ((status = 'completed') = (completed_on is not null))
);
create unique index planner_one_active on public.planner_tasks(user_id) where status = 'active';
create unique index planner_one_priority on public.planner_tasks(user_id, planned_for) where is_priority;
create index planner_completions on public.planner_tasks(user_id, completed_on) where status = 'completed';
create table public.planner_resources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  label text not null check (length(trim(label)) between 1 and 200),
  target text not null check (octet_length(target) between 1 and 8192),
  kind text not null check (kind in ('link', 'file')),
  foreign key (user_id, task_id) references public.planner_tasks(user_id, id) on delete cascade,
  check (kind <> 'link' or target ~* '^https?://[^/@[:space:]]+([/?#]|$)')
);
create index planner_resources_task on public.planner_resources(user_id, task_id);
create table public.planner_stops (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  reason text not null check (length(trim(reason)) between 1 and 1000),
  stopped_at bigint not null,
  stopped_on date not null,
  foreign key (user_id, task_id) references public.planner_tasks(user_id, id) on delete cascade
);
create index planner_stops_week on public.planner_stops(user_id, stopped_on, id);
create table public.planner_reviews (
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  primary key (user_id, week_start)
);

-- No direct client writes: even the owner must use the transactional RPC.
-- RLS also protects SELECT against cross-account reads.
alter table public.planner_accounts enable row level security;
alter table public.planner_tasks enable row level security;
alter table public.planner_resources enable row level security;
alter table public.planner_stops enable row level security;
alter table public.planner_reviews enable row level security;
create policy own_account on public.planner_accounts for select to authenticated using (user_id = (select auth.uid()));
create policy own_tasks on public.planner_tasks for select to authenticated using (user_id = (select auth.uid()));
create policy own_resources on public.planner_resources for select to authenticated using (user_id = (select auth.uid()));
create policy own_stops on public.planner_stops for select to authenticated using (user_id = (select auth.uid()));
create policy own_reviews on public.planner_reviews for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.planner_accounts, public.planner_tasks, public.planner_resources, public.planner_stops, public.planner_reviews from public, anon, authenticated;
grant select on public.planner_accounts, public.planner_tasks, public.planner_resources, public.planner_stops, public.planner_reviews to authenticated;
grant all on public.planner_accounts, public.planner_tasks, public.planner_resources, public.planner_stops, public.planner_reviews to service_role;

create function public.planner_task_json(p_task public.planner_tasks) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p_task.id, 'outcome', p_task.outcome, 'plannedFor', p_task.planned_for,
    'estimatedMinutes', p_task.estimated_minutes, 'actualSeconds', p_task.actual_seconds,
    'status', p_task.status, 'startedAt', p_task.started_at, 'completedOn', p_task.completed_on,
    'createdAt', p_task.created_at, 'isPriority', p_task.is_priority,
    'resources', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'label', r.label, 'target', r.target, 'kind', r.kind) order by r.id)
      from public.planner_resources r where r.task_id = p_task.id and r.user_id = p_task.user_id), '[]'::jsonb));
$$;

-- Shared server-owned snapshot; deliberately excludes resource labels, URLs, paths and contents.
create function public.planner_activity(p_user uuid, p_week date) returns jsonb
language sql stable security definer set search_path = '' as $$
  with selected_stops as (
    select * from public.planner_stops where user_id = p_user and stopped_on between p_week and p_week + 6 order by id desc limit 200
  ), selected_tasks as (
    select t.* from public.planner_tasks t where t.user_id = p_user and
      (t.planned_for between p_week and p_week + 6 or t.completed_on between p_week and p_week + 6
       or exists (select 1 from selected_stops s where s.task_id = t.id))
  )
  select jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'outcome', outcome, 'plannedFor', planned_for,
      'completedOn', completed_on, 'status', status, 'estimatedMinutes', estimated_minutes, 'actualSeconds', actual_seconds) order by planned_for, id) from selected_tasks), '[]'::jsonb),
    'stops', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'taskId', task_id, 'reason', reason, 'stoppedOn', stopped_on) order by id) from selected_stops), '[]'::jsonb),
    'totalStops', (select count(*) from public.planner_stops where user_id = p_user and stopped_on between p_week and p_week + 6),
    'omittedStops', greatest(0, (select count(*) from public.planner_stops where user_id = p_user and stopped_on between p_week and p_week + 6) - 200));
$$;

create function public.planner_call(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  d date;
  n bigint := extract(epoch from now())::bigint;
  t public.planner_tasks%rowtype;
  a public.planner_accounts%rowtype;
  w date;
  activity jsonb;
  attempt public.ai_review_requests%rowtype;
  day_tasks jsonb;
  reports jsonb;
  task_day date;
  new_slot smallint;
  value text;
  minutes integer;
  enabled boolean;
  ai_available boolean;
  state text;
begin
  if u is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception using errcode = 'PT401', message = 'Sign in with your email to use PRO.';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception using errcode = 'PT400', message = 'Use a valid device timezone.';
  end if;
  if p_args is null or jsonb_typeof(p_args) <> 'object' or octet_length(p_args::text) > 20000 then
    raise exception using errcode = 'PT400', message = 'Invalid command arguments.';
  end if;
  d := (now() at time zone p_timezone)::date;
  insert into public.planner_accounts(user_id) values (u) on conflict do nothing;
  -- Serializes all planner changes for this user across windows/devices.
  select * into a from public.planner_accounts where user_id = u for update;

  if p_action = 'dashboard' then
    select coalesce(jsonb_agg(public.planner_task_json(x) order by x.created_at, x.id), '[]'::jsonb) into day_tasks from public.planner_tasks x where user_id = u and planned_for = d;
    return jsonb_build_object('today', d, 'tomorrow', d + 1, 'todayTasks', day_tasks,
      'tomorrowTasks', coalesce((select jsonb_agg(public.planner_task_json(x) order by x.created_at, x.id) from public.planner_tasks x where user_id = u and planned_for = d + 1), '[]'::jsonb),
      'activeTask', (select public.planner_task_json(x) from public.planner_tasks x where user_id = u and status = 'active'),
      'canPlanTomorrow', jsonb_array_length(day_tasks) > 0 and not exists(select 1 from public.planner_tasks where user_id = u and planned_for = d and status <> 'completed'),
      'completions', coalesce((select jsonb_agg(jsonb_build_object('day', completed_on, 'count', c) order by completed_on) from (select completed_on, count(*) c from public.planner_tasks where user_id = u and status = 'completed' group by completed_on) x), '[]'::jsonb),
      'serverNow', n);
  elsif p_action = 'set_weekly_ai_enabled' then
    if jsonb_typeof(p_args->'enabled') is distinct from 'boolean' then
      raise exception using errcode = 'PT400', message = 'Choose whether to enable weekly AI.';
    end if;
    enabled := (p_args->>'enabled')::boolean;
    if enabled and p_args->>'consentVersion' is distinct from 'weekly-ai-v1' then
      raise exception using errcode = 'PT400', message = 'Read and accept the current AI privacy notice.';
    end if;
    update public.planner_accounts set ai_enabled = enabled, ai_revision = ai_revision + 1,
      consent_version = case when enabled then 'weekly-ai-v1' else consent_version end,
      consent_recorded_at = case when enabled then now() else consent_recorded_at end
      where user_id = u and ai_enabled <> enabled;
    return public.planner_call('weekly_overview', '{}'::jsonb, p_timezone);
  elsif p_action = 'weekly_overview' then
    w := date_trunc('week', d::timestamp)::date - 7;
    activity := public.planner_activity(u, w);
    select * into attempt from public.ai_review_requests where user_id = u and week_start = w;
    select coalesce(jsonb_agg(report order by week_start desc), '[]'::jsonb) into reports
      from (select report, week_start from public.planner_reviews where user_id = u order by week_start desc limit 52) x;
    select coalesce((select c.enabled
      and coalesce((select attempts from public.ai_usage where period = 'day:' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD')), 0) < c.daily_attempt_limit
      and coalesce((select attempts from public.ai_usage where period = 'month:' || to_char(now() at time zone 'UTC', 'YYYY-MM')), 0) < c.monthly_attempt_limit
      from public.ai_controls c where id), false) into ai_available;
    state := case
      when not a.ai_enabled then 'disabled'
      when exists(select 1 from public.planner_reviews where user_id = u and week_start = w) then 'up_to_date'
      when jsonb_array_length(activity->'tasks') = 0 and jsonb_array_length(activity->'stops') = 0 then 'no_data'
      when not ai_available then 'unavailable'
      when attempt.status = 'running' and attempt.lease_until > now() then 'running'
      when attempt.status in ('failed', 'running') then 'failed'
      else 'pending' end;
    return jsonb_build_object('settings', jsonb_build_object('enabled', a.ai_enabled), 'model', 'gpt-4.1-mini',
      'available', ai_available, 'week', jsonb_build_object('start', w, 'end', w + 6, 'nextUpdate', w + 14),
      'status', state, 'error', case when state = 'failed' then 'The weekly review could not be generated. Retry allowance is limited; please try later.' else null end, 'reviews', reports);
  elsif p_action = 'create_task' then
    task_day := (p_args->>'day')::date;
    if task_day is null or task_day not in (d, d + 1) then
      raise exception using errcode = 'PT400', message = 'Plan tasks for today or tomorrow.';
    end if;
    if task_day = d + 1 and (not exists(select 1 from public.planner_tasks where user_id = u and planned_for = d)
      or exists(select 1 from public.planner_tasks where user_id = u and planned_for = d and status <> 'completed')) then
      raise exception using errcode = 'PT409', message = 'Finish today''s tasks before planning tomorrow.';
    end if;
    select s::smallint into new_slot from generate_series(1, 3) s where not exists(select 1 from public.planner_tasks where user_id = u and planned_for = task_day and slot = s) order by s limit 1;
    if new_slot is null then raise exception using errcode = 'PT409', message = 'Plan no more than three important tasks per day.'; end if;
    insert into public.planner_tasks(user_id, outcome, planned_for, slot, estimated_minutes, is_priority)
      values (u, trim(p_args->>'outcome'), task_day, new_slot, (p_args->>'estimatedMinutes')::integer, new_slot = 1) returning * into t;
    return public.planner_task_json(t);
  end if;

  select * into t from public.planner_tasks where id = (p_args->>'id')::uuid and user_id = u for update;
  if not found then raise exception using errcode = 'PT404', message = 'Task not found.'; end if;
  if p_action = 'rename_task' then
    update public.planner_tasks set outcome = trim(p_args->>'outcome') where id = t.id returning * into t;
  elsif p_action = 'change_estimate' then
    if t.status <> 'planned' then raise exception using errcode = 'PT409', message = 'Only unstarted tasks can change their estimate.'; end if;
    minutes := (p_args->>'minutes')::integer;
    update public.planner_tasks set estimated_minutes = minutes where id = t.id returning * into t;
  elsif p_action = 'prioritize_task' then
    if t.planned_for not in (d, d + 1) or exists(select 1 from public.planner_tasks where user_id = u and planned_for = t.planned_for and status <> 'planned') then
      raise exception using errcode = 'PT409', message = 'Choose the most important task before starting the day''s work.';
    end if;
    update public.planner_tasks set is_priority = false where user_id = u and planned_for = t.planned_for;
    update public.planner_tasks set is_priority = true where id = t.id returning * into t;
  elsif p_action = 'start_task' then
    if t.status <> 'planned' or t.planned_for <> d or exists(select 1 from public.planner_tasks where user_id = u and status = 'active') then
      raise exception using errcode = 'PT409', message = 'Only today''s planned tasks can start, with no other active task.';
    end if;
    if not t.is_priority and not exists(select 1 from public.planner_tasks where user_id = u and planned_for = d and is_priority and status = 'completed') then
      raise exception using errcode = 'PT409', message = 'Complete the most important task first.';
    end if;
    update public.planner_tasks set status = 'active', started_at = n where id = t.id returning * into t;
  elsif p_action in ('pause_task', 'stop_timer') then
    if t.status <> 'active' or t.started_at is null then raise exception using errcode = 'PT409', message = 'Only a running timer can be paused.'; end if;
    value := case when p_action = 'stop_timer' then 'Reason not provided' else trim(p_args->>'reason') end;
    insert into public.planner_stops(user_id, task_id, reason, stopped_at, stopped_on) values (u, t.id, value, n, d);
    update public.planner_tasks set actual_seconds = actual_seconds + greatest(0, n - started_at), started_at = null where id = t.id returning * into t;
  elsif p_action = 'save_pause_reason' then
    if t.status <> 'active' or t.started_at is not null then raise exception using errcode = 'PT409', message = 'The timer must be paused to save a reason.'; end if;
    update public.planner_stops set reason = trim(p_args->>'reason') where id = (select id from public.planner_stops where user_id = u and task_id = t.id order by id desc limit 1);
    if not found then raise exception using errcode = 'PT404', message = 'Stop entry not found.'; end if;
  elsif p_action = 'resume_task' then
    if t.status <> 'active' or t.started_at is not null then raise exception using errcode = 'PT409', message = 'Only a paused timer can be resumed.'; end if;
    update public.planner_tasks set started_at = n where id = t.id returning * into t;
  elsif p_action = 'complete_task' then
    if t.status <> 'active' then raise exception using errcode = 'PT409', message = 'Only active tasks can be completed.'; end if;
    update public.planner_tasks set actual_seconds = actual_seconds + case when started_at is null then 0 else greatest(0, n - started_at) end,
      status = 'completed', started_at = null, completed_on = d where id = t.id returning * into t;
  elsif p_action in ('add_task_link', 'attach_task_file') then
    if (select count(*) from public.planner_resources where user_id = u and task_id = t.id) >= 50 then
      raise exception using errcode = 'PT400', message = 'A task can have up to 50 resources.';
    end if;
    insert into public.planner_resources(user_id, task_id, label, target, kind) values
      (u, t.id, trim(p_args->>'label'), trim(p_args->>'target'), case when p_action = 'add_task_link' then 'link' else 'file' end);
  elsif p_action = 'remove_task_resource' then
    delete from public.planner_resources where user_id = u and task_id = t.id and id = (p_args->>'resourceId')::uuid;
  elsif p_action = 'get_task_resource' then
    return (select jsonb_build_object('kind', kind, 'target', target, 'label', label) from public.planner_resources where user_id = u and task_id = t.id and id = (p_args->>'resourceId')::uuid);
  else
    raise exception using errcode = 'PT400', message = 'Unsupported planner command.';
  end if;
  return public.planner_task_json(t);
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or check_violation or not_null_violation or numeric_value_out_of_range then
  raise exception using errcode = 'PT400', message = 'Invalid input. Check the title, date, duration, or resource.';
end;
$$;

alter table public.ai_review_requests add column activity jsonb;
alter table public.ai_review_requests add column consent_revision bigint;

-- Only the Edge Function can load inputs, reserve paid calls, or persist AI output.
create function public.planner_review_input(p_user_id uuid, p_timezone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.planner_accounts%rowtype; w date; activity jsonb;
begin
  select * into a from public.planner_accounts where user_id = p_user_id;
  if not found or not a.ai_enabled or a.consent_version is distinct from 'weekly-ai-v1' then return jsonb_build_object('disabled', true); end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then return jsonb_build_object('invalid', true); end if;
  w := date_trunc('week', (now() at time zone p_timezone))::date - 7;
  activity := public.planner_activity(p_user_id, w);
  return jsonb_build_object('consentVersion', 'weekly-ai-v1', 'weekStart', w, 'weekEnd', w + 6, 'activity', activity);
end;
$$;
create function public.reserve_planner_review(p_user_id uuid, p_week_start date, p_request_hash text, p_consent_version text, p_activity jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.planner_accounts%rowtype; claim jsonb;
begin
  select * into a from public.planner_accounts where user_id = p_user_id for update;
  if not found or not a.ai_enabled or a.consent_version is distinct from p_consent_version then return jsonb_build_object('outcome', 'disabled'); end if;
  claim := public.reserve_weekly_review(p_user_id, p_week_start, p_request_hash, p_consent_version);
  if claim->>'outcome' = 'reserved' then
    update public.ai_review_requests set activity = p_activity, consent_revision = a.ai_revision where id = (claim->>'id')::uuid;
  end if;
  return claim;
end;
$$;
create or replace function public.finish_weekly_review(p_id uuid, p_lease_token uuid, p_analysis jsonb, p_model text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.ai_review_requests%rowtype; a public.planner_accounts%rowtype;
begin
  select * into r from public.ai_review_requests where id = p_id;
  if not found then return false; end if;
  select * into a from public.planner_accounts where user_id = r.user_id for update;
  select * into r from public.ai_review_requests where id = p_id for update;
  if not a.ai_enabled or a.ai_revision <> r.consent_revision or r.activity is null
    or r.lease_token <> p_lease_token or r.status <> 'running' or r.lease_until <= now()
    or p_analysis is null or jsonb_typeof(p_analysis) <> 'object' or octet_length(p_analysis::text) > 65536
    or p_model is null or length(p_model) not between 1 and 120 then return false; end if;
  insert into public.planner_reviews(user_id, week_start, report) values (r.user_id, r.week_start,
    jsonb_build_object('weekStart', r.week_start, 'weekEnd', r.week_start + 6, 'generatedAt', extract(epoch from now())::bigint,
      'model', p_model, 'activity', r.activity, 'analysis', p_analysis)) on conflict do nothing;
  update public.ai_review_requests set status = 'succeeded', analysis = p_analysis, model = p_model, generated_at = now(), activity = null where id = p_id;
  return true;
end;
$$;
-- Inputs are no longer needed once a call fails; successful source snapshots live in planner_reviews.
create or replace function public.fail_weekly_review(p_id uuid, p_lease_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.ai_review_requests set status = 'failed', activity = null where id = p_id and lease_token = p_lease_token and status = 'running';
  return found;
end;
$$;
create or replace function public.purge_weekly_review_content() returns void
language sql security definer set search_path = '' as $$
  update public.ai_review_requests set analysis = null where analysis is not null and generated_at <= now() - interval '7 days';
  update public.ai_review_requests set activity = null where activity is not null and lease_until < now();
  delete from public.ai_review_requests where last_attempt_at < now() - interval '90 days';
  delete from public.ai_usage where period like 'day:%' and period < 'day:' || to_char((now() at time zone 'UTC') - interval '90 days', 'YYYY-MM-DD');
  delete from public.ai_usage where period like 'month:%' and period < 'month:' || to_char((now() at time zone 'UTC') - interval '1 year', 'YYYY-MM');
$$;

revoke all on function public.planner_task_json(public.planner_tasks), public.planner_activity(uuid, date) from public, anon, authenticated;
revoke all on function public.planner_call(text, jsonb, text) from public, anon;
grant execute on function public.planner_call(text, jsonb, text) to authenticated;
revoke all on function public.planner_review_input(uuid, text), public.reserve_planner_review(uuid, date, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.planner_review_input(uuid, text), public.reserve_planner_review(uuid, date, text, text, jsonb) to service_role;
