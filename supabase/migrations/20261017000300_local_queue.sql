-- A receipt and its planner mutation commit atomically. Keep receipts for the lifetime
-- of the account: expiring them would allow an old desktop outbox to execute twice.
create table public.planner_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  input jsonb not null,
  result jsonb not null,
  primary key (user_id, request_id)
);
alter table public.planner_receipts enable row level security;
revoke all on public.planner_receipts from public, anon, authenticated;
grant all on public.planner_receipts to service_role;

alter table public.planner_accounts add column last_event_at bigint not null default 0;
alter table public.planner_accounts add column revision bigint not null default 0;

alter function public.planner_call(text, jsonb, text) rename to planner_execute;
revoke all on function public.planner_execute(text, jsonb, text) from public, anon, authenticated;

-- Preserve the existing validation/rules without duplicating the large dispatcher.
-- Only the private executor can see these internal arguments. The public wrapper
-- below strips client-supplied internals and validates the event time before use.
do $$
declare definition text;
begin
  definition := pg_get_functiondef('public.planner_execute(text,jsonb,text)'::regprocedure);
  if position('n bigint := extract(epoch from now())::bigint;' in definition) = 0
    or position('insert into public.planner_tasks(user_id, outcome, planned_for, slot, estimated_minutes, is_priority)' in definition) = 0
    or position('insert into public.planner_resources(user_id, task_id, label, target, kind) values' in definition) = 0 then
    raise exception 'Planner executor changed; review the queue migration before applying.';
  end if;
  -- A batch can create all three tasks in the same second. Preserve planning order.
  definition := replace(definition, 'order by x.created_at, x.id', 'order by x.slot');
  definition := replace(definition,
    'n bigint := extract(epoch from now())::bigint;',
    'n bigint := coalesce((p_args->>''_eventTime'')::bigint, extract(epoch from now())::bigint);');
  definition := replace(definition,
    'd := (now() at time zone p_timezone)::date;',
    'd := (to_timestamp(n) at time zone p_timezone)::date;');
  definition := replace(definition,
    'insert into public.planner_tasks(user_id, outcome, planned_for, slot, estimated_minutes, is_priority)',
    'insert into public.planner_tasks(id, user_id, outcome, planned_for, slot, estimated_minutes, is_priority)');
  definition := replace(definition,
    'values (u, trim(p_args->>''outcome''), task_day, new_slot, (p_args->>''estimatedMinutes'')::integer, new_slot = 1)',
    'values (coalesce((p_args->>''_entityId'')::uuid, gen_random_uuid()), u, trim(p_args->>''outcome''), task_day, new_slot, (p_args->>''estimatedMinutes'')::integer, new_slot = 1)');
  definition := replace(definition,
    'insert into public.planner_resources(user_id, task_id, label, target, kind) values' || chr(10) || '      (u, t.id,',
    'insert into public.planner_resources(id, user_id, task_id, label, target, kind) values' || chr(10) || '      (coalesce((p_args->>''_entityId'')::uuid, gen_random_uuid()), u, t.id,');
  execute definition;
end;
$$;

create function public.planner_call(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  v_request_id uuid;
  event_time bigint;
  last_event bigint;
  current_revision bigint;
  clean_args jsonb;
  fingerprint jsonb;
  receipt public.planner_receipts%rowtype;
  response jsonb;
begin
  if u is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception using errcode = 'PT401', message = 'Sign in with your email to use PRO.';
  end if;
  if p_args is null or jsonb_typeof(p_args) <> 'object' or octet_length(p_args::text) > 20000 then
    raise exception using errcode = 'PT400', message = 'Invalid command arguments.';
  end if;
  if p_action = 'queue_protocol' then return jsonb_build_object('version', 1); end if;
  clean_args := p_args - array['_requestId', '_at', '_eventTime', '_entityId', '_accountKey', '_revision'];
  if not (p_args ? '_requestId') then
    response := public.planner_execute(p_action, clean_args, p_timezone);
    if p_action in ('create_task', 'rename_task', 'change_estimate', 'prioritize_task',
      'start_task', 'pause_task', 'stop_timer', 'save_pause_reason', 'resume_task',
      'complete_task', 'add_task_link', 'attach_task_file', 'remove_task_resource') then
      update public.planner_accounts set last_event_at = greatest(last_event_at, extract(epoch from now())::bigint), revision = revision + 1 where user_id = u returning revision into current_revision;
      response := response || jsonb_build_object('serverRevision', current_revision);
    elsif p_action = 'dashboard' then
      response := response || jsonb_build_object('revision', (select revision from public.planner_accounts where user_id = u));
    end if;
    return response;
  end if;
  if p_action not in ('create_task', 'rename_task', 'change_estimate', 'prioritize_task',
    'start_task', 'pause_task', 'stop_timer', 'save_pause_reason', 'resume_task',
    'complete_task', 'add_task_link', 'remove_task_resource') then
    raise exception using errcode = 'PT400', message = 'This action cannot be queued.';
  end if;
  v_request_id := (p_args->>'_requestId')::uuid;
  event_time := (p_args->>'_at')::bigint;
  if v_request_id is null or event_time is null then
    raise exception using errcode = 'PT400', message = 'Missing queue identity or event time.';
  end if;
  fingerprint := jsonb_build_object('action', p_action, 'args', clean_args, 'timezone', p_timezone, 'at', event_time, 'revision', p_args->'_revision');
  insert into public.planner_accounts(user_id) values (u) on conflict do nothing;
  select last_event_at, revision into last_event, current_revision from public.planner_accounts where user_id = u for update;
  select * into receipt from public.planner_receipts where user_id = u and request_id = v_request_id;
  if found then
    if receipt.input <> fingerprint then
      raise exception using errcode = 'PT409', message = 'Queue identity was reused for a different action.';
    end if;
    return receipt.result;
  end if;
  -- Replays of committed actions above still succeed after this age limit.
  if event_time > extract(epoch from now()) + 120 or event_time < extract(epoch from now()) - 2592000 then
    raise exception using errcode = 'PT409', message = 'The queued action is over 30 days old or the device clock is incorrect. Review pending changes.';
  end if;
  if p_args ? '_revision' and ((p_args->>'_revision') is null or (p_args->>'_revision')::bigint <> current_revision) then
    raise exception using errcode = 'PT409', message = 'The planner changed on another device. Review pending changes.';
  end if;
  if event_time < last_event then
    raise exception using errcode = 'PT409', message = 'The planner changed on another device after this action. Review pending changes.';
  end if;
  if p_action in ('stop_timer', 'pause_task', 'complete_task') and exists (
    select 1 from public.planner_tasks where user_id = u and id = (clean_args->>'id')::uuid and started_at > event_time
  ) then
    raise exception using errcode = 'PT409', message = 'This timer was started more recently on another device. Review pending changes.';
  end if;
  response := public.planner_execute(p_action, clean_args || jsonb_build_object('_eventTime', event_time, '_entityId', v_request_id), p_timezone);
  update public.planner_accounts set last_event_at = event_time, revision = revision + 1 where user_id = u returning revision into current_revision;
  response := response || jsonb_build_object('serverRevision', current_revision);
  insert into public.planner_receipts(user_id, request_id, input, result) values (u, v_request_id, fingerprint, response);
  return response;
exception when invalid_text_representation or numeric_value_out_of_range or unique_violation then
  raise exception using errcode = 'PT400', message = 'Invalid or conflicting queued action. Review pending changes.';
end;
$$;
revoke all on function public.planner_call(text, jsonb, text) from public, anon;
grant execute on function public.planner_call(text, jsonb, text) to authenticated;
