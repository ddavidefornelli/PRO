-- Production remains limited. Only a database administrator can enable this
-- switch; it is not accepted from request bodies or public client configuration.
alter table public.ai_controls add column development_unlimited boolean not null default false;
comment on column public.ai_controls.development_unlimited is
  'Development databases only: bypass AI cooldowns and usage caps, not consent or leases.';

alter table public.ai_review_requests drop constraint ai_review_requests_attempts_check;
alter table public.ai_review_requests add constraint ai_review_requests_attempts_check check (attempts >= 1);
alter table public.ai_review_previews drop constraint ai_review_previews_attempts_check;
alter table public.ai_review_previews add constraint ai_review_previews_attempts_check check (attempts >= 1);

-- Preserve the existing reservation/lease logic and permissions. Patch only the
-- quota predicates, failing the migration if the expected function has changed.
do $$
declare
  definition text;
  predicate text;
begin
  definition := pg_get_functiondef('public.reserve_weekly_review(uuid,date,text,text)'::regprocedure);
  foreach predicate in array array[
    'v_request.attempts >= 3 or v_request.last_attempt_at > v_now - interval ''1 hour''',
    'v_request.quota_week <> v_quota_week',
    'exists (select 1 from public.ai_review_requests where user_id = p_user_id and quota_week = v_quota_week)',
    'v_attempts >= v_controls.daily_attempt_limit',
    'v_attempts >= v_controls.monthly_attempt_limit'
  ] loop
    if position('if ' || predicate || ' then' in definition) = 0 then
      raise exception 'Unexpected weekly reservation definition: %', predicate;
    end if;
    definition := replace(definition, 'if ' || predicate || ' then',
      'if not v_controls.development_unlimited and (' || predicate || ') then');
  end loop;
  execute definition;

  definition := pg_get_functiondef('public.reserve_review_preview(uuid)'::regprocedure);
  predicate := 'r.last_attempt_at > now() - interval ''10 minutes'' or (r.quota_day = d and r.attempts >= 3)';
  if position('if ' || predicate || ' then' in definition) = 0 then
    raise exception 'Unexpected preview cooldown definition';
  end if;
  definition := replace(definition, 'if ' || predicate || ' then',
    'if not c.development_unlimited and (' || predicate || ') then');
  predicate := '(select attempts from public.ai_usage where period = day_key) >= c.daily_attempt_limit
    or (select attempts from public.ai_usage where period = month_key) >= c.monthly_attempt_limit';
  if position('if ' || predicate || ' then' in definition) = 0 then
    raise exception 'Unexpected preview quota definition';
  end if;
  definition := replace(definition, 'if ' || predicate || ' then',
    'if not c.development_unlimited and (' || predicate || ') then');
  execute definition;

  definition := pg_get_functiondef('public.planner_execute(text,jsonb,text)'::regprocedure);
  predicate := 'c.enabled
      and coalesce((select attempts from public.ai_usage where period = ''day:'' || to_char(now() at time zone ''UTC'', ''YYYY-MM-DD'')), 0) < c.daily_attempt_limit
      and coalesce((select attempts from public.ai_usage where period = ''month:'' || to_char(now() at time zone ''UTC'', ''YYYY-MM'')), 0) < c.monthly_attempt_limit';
  if position(predicate in definition) = 0 then
    raise exception 'Unexpected review availability definition';
  end if;
  definition := replace(definition, predicate, 'c.enabled and (c.development_unlimited or (' || predicate || '))');
  definition := replace(definition, '''available'', ai_available,',
    '''developmentUnlimited'', coalesce((select development_unlimited from public.ai_controls where id), false), ''available'', ai_available,');
  definition := replace(definition, 'The weekly review could not be generated. Retry allowance is limited; please try later.',
    'The weekly review could not be generated. Please try again later.');
  execute definition;
end;
$$;
