-- Planning tomorrow no longer depends on completing today's plan.
-- Preserve the current dispatcher, including queue protocol and review scheduling.
do $$
declare
  definition text;
  restriction text := $restriction$    if task_day = d + 1 and (not exists(select 1 from public.planner_tasks where user_id = u and planned_for = d)
      or exists(select 1 from public.planner_tasks where user_id = u and planned_for = d and status <> 'completed')) then
      raise exception using errcode = 'PT409', message = 'Finish today''s tasks before planning tomorrow.';
    end if;
$restriction$;
  availability text := $availability$'canPlanTomorrow', jsonb_array_length(day_tasks) > 0 and not exists(select 1 from public.planner_tasks where user_id = u and planned_for = d and status <> 'completed')$availability$;
begin
  definition := pg_get_functiondef('public.planner_execute(text,jsonb,text)'::regprocedure);
  if position(restriction in definition) = 0 or position(availability in definition) = 0 then
    raise exception 'Unexpected tomorrow planning rules';
  end if;
  definition := replace(definition, restriction, '');
  definition := replace(definition, availability, '''canPlanTomorrow'', true');
  execute definition;
end;
$$;
