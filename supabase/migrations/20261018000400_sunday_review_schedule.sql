-- Reviews become due Sunday at 16:00 in the device's IANA timezone.
-- Adding eight local hours moves that boundary onto Monday midnight without
-- treating a calendar day as a fixed 24-hour UTC interval (DST safe).
create function public.planner_review_schedule(p_timezone text, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  with schedule as (
    select date_trunc('week', (p_now at time zone p_timezone) + interval '8 hours')::date - 7 as week_start
  )
  select jsonb_build_object(
    'start', week_start,
    'end', week_start + 6,
    'nextUpdate', week_start + 13,
    'nextUpdateAt', ((week_start + 13) + time '16:00') at time zone p_timezone
  ) from schedule;
$$;
revoke all on function public.planner_review_schedule(text, timestamptz) from public, anon, authenticated;
grant execute on function public.planner_review_schedule(text, timestamptz) to service_role;

-- Quota identity follows the reviewed week, not the UTC week in which a request
-- happened. A Monday catch-up must not consume the next Sunday's allowance.
alter table public.ai_review_requests drop constraint ai_review_requests_user_id_quota_week_key;
update public.ai_review_requests set quota_week = week_start;
alter table public.ai_review_requests add constraint ai_review_requests_user_id_quota_week_key unique (user_id, quota_week);

do $$
declare definition text;
begin
  definition := pg_get_functiondef('public.planner_review_input(uuid,text)'::regprocedure);
  if position('w := date_trunc(''week'', (now() at time zone p_timezone))::date - 7;' in definition) = 0 then
    raise exception 'Unexpected review input schedule';
  end if;
  definition := replace(definition,
    'w := date_trunc(''week'', (now() at time zone p_timezone))::date - 7;',
    'w := (public.planner_review_schedule(p_timezone)->>''start'')::date;');
  execute definition;

  definition := pg_get_functiondef('public.planner_execute(text,jsonb,text)'::regprocedure);
  if position('w := date_trunc(''week'', d::timestamp)::date - 7;' in definition) = 0 then
    raise exception 'Unexpected review overview schedule';
  end if;
  definition := replace(definition, 'w := date_trunc(''week'', d::timestamp)::date - 7;',
    'w := (public.planner_review_schedule(p_timezone)->>''start'')::date;');
  definition := replace(definition,
    'jsonb_build_object(''start'', w, ''end'', w + 6, ''nextUpdate'', w + 14)',
    'public.planner_review_schedule(p_timezone)');
  execute definition;

  definition := pg_get_functiondef('public.reserve_weekly_review(uuid,date,text,text)'::regprocedure);
  -- Keep the UTC-boundary validation independent of the new quota identity.
  definition := replace(definition, 'v_quota_week - 7,',
    'date_trunc(''week'', v_now at time zone ''UTC'')::date - 7,');
  definition := replace(definition,
    'v_quota_week date := date_trunc(''week'', v_now at time zone ''UTC'')::date;',
    'v_quota_week date := p_week_start;');
  execute definition;
end;
$$;
