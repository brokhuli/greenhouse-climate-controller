-- Revert the envelope backfill: strip the crop-safe `bounds` from the standard seeded profiles,
-- returning them to the targets-only shape 000005 created. Scoped to the three standard ids; like
-- any down migration on live data this is lossy — it also drops an envelope an operator may have
-- added to one of these profiles after the backfill ran.
UPDATE crop_profiles AS p
SET stages = (
  SELECT jsonb_agg(elem - 'bounds' ORDER BY ord)
  FROM jsonb_array_elements(p.stages) WITH ORDINALITY AS t(elem, ord)
)
WHERE p.id IN ('tomato-standard', 'cucumber-standard', 'lettuce-standard');
