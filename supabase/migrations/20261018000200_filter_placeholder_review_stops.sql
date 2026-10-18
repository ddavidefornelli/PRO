-- Placeholder stops are implementation artifacts, not explanations for the AI.
-- Keep the raw log intact, but filter before limiting and counting review inputs.
create or replace function public.planner_activity(p_user uuid, p_week date) returns jsonb
language sql stable security definer set search_path = '' as $$
  with eligible_stops as (
    select * from public.planner_stops
    where user_id = p_user and stopped_on between p_week and p_week + 6
      and reason <> 'Reason not provided'
  ), selected_stops as (
    select * from eligible_stops order by id desc limit 200
  ), selected_tasks as (
    select t.* from public.planner_tasks t where t.user_id = p_user and
      (t.planned_for between p_week and p_week + 6 or t.completed_on between p_week and p_week + 6
       or exists (select 1 from selected_stops s where s.task_id = t.id))
  )
  select jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'outcome', outcome, 'plannedFor', planned_for,
      'completedOn', completed_on, 'status', status, 'estimatedMinutes', estimated_minutes, 'actualSeconds', actual_seconds) order by planned_for, id) from selected_tasks), '[]'::jsonb),
    'stops', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'taskId', task_id, 'reason', reason, 'stoppedOn', stopped_on) order by id) from selected_stops), '[]'::jsonb),
    'totalStops', (select count(*) from eligible_stops),
    'omittedStops', greatest(0, (select count(*) from eligible_stops) - 200));
$$;

-- Preview counts must use the same filter as the shared activity snapshot.
create or replace function public.planner_preview_input(p_user_id uuid, p_timezone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.planner_accounts%rowtype; d date; w date; activity jsonb;
begin
  select * into a from public.planner_accounts where user_id = p_user_id;
  if not found or not a.ai_enabled or a.consent_version is distinct from 'weekly-ai-v1' then return jsonb_build_object('disabled', true); end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then return jsonb_build_object('invalid', true); end if;
  d := (now() at time zone p_timezone)::date;
  w := date_trunc('week', d::timestamp)::date;
  activity := public.planner_activity(p_user_id, w);
  activity := jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(t) from jsonb_array_elements(activity->'tasks') t
      where (t->>'plannedFor')::date <= d
        or (t->>'completedOn')::date <= d
        or exists(select 1 from jsonb_array_elements(activity->'stops') s where s->>'taskId' = t->>'id' and (s->>'stoppedOn')::date <= d)), '[]'::jsonb),
    'stops', coalesce((select jsonb_agg(s) from jsonb_array_elements(activity->'stops') s where (s->>'stoppedOn')::date <= d), '[]'::jsonb),
    'totalStops', (select count(*) from public.planner_stops where user_id = p_user_id and stopped_on between w and d
      and reason <> 'Reason not provided'),
    'omittedStops', greatest(0, (select count(*) from public.planner_stops where user_id = p_user_id and stopped_on between w and d
      and reason <> 'Reason not provided')
      - (select count(*) from jsonb_array_elements(activity->'stops') s where (s->>'stoppedOn')::date <= d)));
  return jsonb_build_object('consentVersion', 'weekly-ai-v1', 'weekStart', w, 'weekEnd', d, 'activity', activity);
end;
$$;
