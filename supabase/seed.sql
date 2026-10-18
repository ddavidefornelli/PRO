-- Local development only. Hosted migrations default to production limits.
-- This does not enable paid AI calls: ai_controls.enabled and user consent
-- must still be enabled separately.
update public.ai_controls set development_unlimited = true where id;
