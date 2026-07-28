-- Give the standard seeded crop profiles a crop-safe envelope. 000005 shipped them with targets
-- but no `bounds`, and without an envelope the Phase 3 optimizer has nothing to refine within, so
-- it holds the baseline ("no crop-safe bounds present") instead of planning (climate-optimizer
-- domain/constraints.go, orchestration/cycle.go). The seed migration itself cannot be re-run on an
-- already-migrated database (golang-migrate tracks the applied version), so the envelopes are added
-- here as a forward migration that reaches existing installs as well as fresh ones.
--
-- Each envelope is the stage's target ± a per-field margin, clamped to the field's generic physical
-- range — the same margins the profile editor seeds client-side (climate-frontend ProfileEditForm
-- defaultBound), so a profile saved through the UI and one backfilled here agree. Every envelope
-- contains its stage's own targets, satisfying the platform write-gate validation
-- (internal/api/validate_bounds.go validateStageBounds).
--
-- Guarded to pristine seeds only: a profile whose stages already carry any `bounds` (an operator
-- edited it — the UI always writes a full envelope on save) is left untouched. Only the `bounds`
-- key is added to each stage; targets are preserved.

UPDATE crop_profiles AS p
SET stages = (
  SELECT jsonb_agg(elem || jsonb_build_object('bounds',
    CASE elem->>'stage'
      WHEN 'propagation'                THEN '{"temperature_day_c":{"min":21,"max":27},"temperature_night_c":{"min":17,"max":23},"humidity_low_pct":{"min":60,"max":70},"humidity_high_pct":{"min":70,"max":80},"humidity_deadband_pct":{"min":3,"max":7},"co2_target_ppm":{"min":550,"max":850},"co2_vent_interlock_threshold_pct":{"min":10,"max":20},"vpd_target_kpa":{"min":0.6,"max":1.0},"dli_target_mol":{"min":9,"max":15},"zones":{"moisture_low_threshold":{"min":0.4,"max":0.6},"moisture_high_threshold":{"min":0.6,"max":0.8},"drain_period_secs":{"min":480,"max":720}}}'::jsonb
      WHEN 'vegetative'                 THEN '{"temperature_day_c":{"min":21,"max":27},"temperature_night_c":{"min":15,"max":21},"humidity_low_pct":{"min":55,"max":65},"humidity_high_pct":{"min":70,"max":80},"humidity_deadband_pct":{"min":3,"max":7},"co2_target_ppm":{"min":750,"max":1050},"co2_vent_interlock_threshold_pct":{"min":10,"max":20},"vpd_target_kpa":{"min":0.7,"max":1.1},"dli_target_mol":{"min":15,"max":21},"zones":{"moisture_low_threshold":{"min":0.3,"max":0.5},"moisture_high_threshold":{"min":0.5,"max":0.7},"drain_period_secs":{"min":180,"max":420}}}'::jsonb
      WHEN 'flowering-fruit-set'        THEN '{"temperature_day_c":{"min":20,"max":26},"temperature_night_c":{"min":15,"max":21},"humidity_low_pct":{"min":50,"max":60},"humidity_high_pct":{"min":65,"max":75},"humidity_deadband_pct":{"min":3,"max":7},"co2_target_ppm":{"min":850,"max":1150},"co2_vent_interlock_threshold_pct":{"min":10,"max":20},"vpd_target_kpa":{"min":0.8,"max":1.2},"dli_target_mol":{"min":17,"max":23},"zones":{"moisture_low_threshold":{"min":0.3,"max":0.5},"moisture_high_threshold":{"min":0.5,"max":0.7},"drain_period_secs":{"min":240,"max":480}}}'::jsonb
      WHEN 'fruit-development-ripening' THEN '{"temperature_day_c":{"min":19,"max":25},"temperature_night_c":{"min":14,"max":20},"humidity_low_pct":{"min":50,"max":60},"humidity_high_pct":{"min":60,"max":70},"humidity_deadband_pct":{"min":3,"max":7},"co2_target_ppm":{"min":850,"max":1150},"co2_vent_interlock_threshold_pct":{"min":10,"max":20},"vpd_target_kpa":{"min":0.9,"max":1.3},"dli_target_mol":{"min":19,"max":25},"zones":{"moisture_low_threshold":{"min":0.25,"max":0.45},"moisture_high_threshold":{"min":0.45,"max":0.65},"drain_period_secs":{"min":240,"max":480}}}'::jsonb
    END) ORDER BY ord)
  FROM jsonb_array_elements(p.stages) WITH ORDINALITY AS t(elem, ord)
)
WHERE p.id = 'tomato-standard'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.stages) AS e(elem) WHERE elem ? 'bounds');

UPDATE crop_profiles AS p
SET stages = (
  SELECT jsonb_agg(elem || jsonb_build_object('bounds',
    CASE elem->>'stage'
      WHEN 'propagation'                  THEN '{"temperature_day_c":{"min":23,"max":29},"temperature_night_c":{"min":19,"max":25},"humidity_low_pct":{"min":65,"max":75},"humidity_high_pct":{"min":75,"max":85},"humidity_deadband_pct":{"min":3,"max":7},"co2_target_ppm":{"min":550,"max":850},"co2_vent_interlock_threshold_pct":{"min":10,"max":20},"vpd_target_kpa":{"min":0.5,"max":0.9},"dli_target_mol":{"min":9,"max":15},"zones":{"moisture_low_threshold":{"min":0.4,"max":0.6},"moisture_high_threshold":{"min":0.6,"max":0.8},"drain_period_secs":{"min":480,"max":720}}}'::jsonb
      WHEN 'vegetative-vine-development'   THEN '{"temperature_day_c":{"min":22,"max":28},"temperature_night_c":{"min":17,"max":23},"humidity_low_pct":{"min":60,"max":70},"humidity_high_pct":{"min":70,"max":80},"humidity_deadband_pct":{"min":3,"max":7},"co2_target_ppm":{"min":750,"max":1050},"co2_vent_interlock_threshold_pct":{"min":10,"max":20},"vpd_target_kpa":{"min":0.7,"max":1.1},"dli_target_mol":{"min":15,"max":21},"zones":{"moisture_low_threshold":{"min":0.35,"max":0.55},"moisture_high_threshold":{"min":0.55,"max":0.75},"drain_period_secs":{"min":180,"max":420}}}'::jsonb
      WHEN 'flowering-fruit-set'           THEN '{"temperature_day_c":{"min":22,"max":28},"temperature_night_c":{"min":17,"max":23},"humidity_low_pct":{"min":55,"max":65},"humidity_high_pct":{"min":65,"max":75},"humidity_deadband_pct":{"min":3,"max":7},"co2_target_ppm":{"min":850,"max":1150},"co2_vent_interlock_threshold_pct":{"min":10,"max":20},"vpd_target_kpa":{"min":0.8,"max":1.2},"dli_target_mol":{"min":19,"max":25},"zones":{"moisture_low_threshold":{"min":0.35,"max":0.55},"moisture_high_threshold":{"min":0.55,"max":0.75},"drain_period_secs":{"min":240,"max":480}}}'::jsonb
      WHEN 'production-harvest'            THEN '{"temperature_day_c":{"min":21,"max":27},"temperature_night_c":{"min":16,"max":22},"humidity_low_pct":{"min":55,"max":65},"humidity_high_pct":{"min":65,"max":75},"humidity_deadband_pct":{"min":3,"max":7},"co2_target_ppm":{"min":850,"max":1150},"co2_vent_interlock_threshold_pct":{"min":10,"max":20},"vpd_target_kpa":{"min":0.9,"max":1.3},"dli_target_mol":{"min":21,"max":27},"zones":{"moisture_low_threshold":{"min":0.35,"max":0.55},"moisture_high_threshold":{"min":0.55,"max":0.75},"drain_period_secs":{"min":240,"max":480}}}'::jsonb
    END) ORDER BY ord)
  FROM jsonb_array_elements(p.stages) WITH ORDINALITY AS t(elem, ord)
)
WHERE p.id = 'cucumber-standard'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.stages) AS e(elem) WHERE elem ? 'bounds');

UPDATE crop_profiles AS p
SET stages = (
  SELECT jsonb_agg(elem || jsonb_build_object('bounds',
    CASE elem->>'stage'
      WHEN 'propagation'         THEN '{"temperature_day_c":{"min":18,"max":24},"temperature_night_c":{"min":15,"max":21},"humidity_low_pct":{"min":65,"max":75},"humidity_high_pct":{"min":75,"max":85},"humidity_deadband_pct":{"min":3,"max":7},"co2_target_ppm":{"min":500,"max":800},"co2_vent_interlock_threshold_pct":{"min":10,"max":20},"vpd_target_kpa":{"min":0.4,"max":0.8},"dli_target_mol":{"min":7,"max":13},"zones":{"moisture_low_threshold":{"min":0.4,"max":0.6},"moisture_high_threshold":{"min":0.6,"max":0.8},"drain_period_secs":{"min":480,"max":720}}}'::jsonb
      WHEN 'vegetative'          THEN '{"temperature_day_c":{"min":17,"max":23},"temperature_night_c":{"min":14,"max":20},"humidity_low_pct":{"min":55,"max":65},"humidity_high_pct":{"min":65,"max":75},"humidity_deadband_pct":{"min":3,"max":7},"co2_target_ppm":{"min":650,"max":950},"co2_vent_interlock_threshold_pct":{"min":10,"max":20},"vpd_target_kpa":{"min":0.6,"max":1.0},"dli_target_mol":{"min":11,"max":17},"zones":{"moisture_low_threshold":{"min":0.3,"max":0.5},"moisture_high_threshold":{"min":0.5,"max":0.7},"drain_period_secs":{"min":180,"max":420}}}'::jsonb
      WHEN 'finishing-harvest'   THEN '{"temperature_day_c":{"min":15,"max":21},"temperature_night_c":{"min":13,"max":19},"humidity_low_pct":{"min":50,"max":60},"humidity_high_pct":{"min":60,"max":70},"humidity_deadband_pct":{"min":3,"max":7},"co2_target_ppm":{"min":650,"max":950},"co2_vent_interlock_threshold_pct":{"min":10,"max":20},"vpd_target_kpa":{"min":0.7,"max":1.1},"dli_target_mol":{"min":12,"max":18},"zones":{"moisture_low_threshold":{"min":0.3,"max":0.5},"moisture_high_threshold":{"min":0.5,"max":0.7},"drain_period_secs":{"min":240,"max":480}}}'::jsonb
    END) ORDER BY ord)
  FROM jsonb_array_elements(p.stages) WITH ORDINALITY AS t(elem, ord)
)
WHERE p.id = 'lettuce-standard'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.stages) AS e(elem) WHERE elem ? 'bounds');
