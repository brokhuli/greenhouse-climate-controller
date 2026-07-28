-- Starter crop profiles make the profile library useful on a new deployment without
-- taking ownership of operator-managed data. Existing profiles are never changed.
INSERT INTO crop_profiles (id, name, crop, stages)
VALUES
  (
    'tomato-standard',
    'Tomato — standard',
    'tomato',
    $$[
      {"stage":"propagation","targets":{"temperature_day_c":24,"temperature_night_c":20,"day_start":"06:00","day_end":"20:00","humidity_low_pct":65,"humidity_high_pct":75,"humidity_deadband_pct":5,"co2_target_ppm":700,"co2_vent_interlock_threshold_pct":15,"vpd_target_kpa":0.8,"dli_target_mol":12,"zones":[{"zone_id":"seedling-tray","moisture_low_threshold":0.5,"moisture_high_threshold":0.7,"drain_period_secs":600,"schedule":"07:00,11:00,15:00"}]}},
      {"stage":"vegetative","targets":{"temperature_day_c":24,"temperature_night_c":18,"day_start":"06:00","day_end":"20:00","humidity_low_pct":60,"humidity_high_pct":75,"humidity_deadband_pct":5,"co2_target_ppm":900,"co2_vent_interlock_threshold_pct":15,"vpd_target_kpa":0.9,"dli_target_mol":18,"zones":[{"zone_id":"bench-a","moisture_low_threshold":0.4,"moisture_high_threshold":0.6,"drain_period_secs":300,"schedule":"06:00,10:00,14:00,18:00"}]}},
      {"stage":"flowering-fruit-set","targets":{"temperature_day_c":23,"temperature_night_c":18,"day_start":"06:00","day_end":"20:00","humidity_low_pct":55,"humidity_high_pct":70,"humidity_deadband_pct":5,"co2_target_ppm":1000,"co2_vent_interlock_threshold_pct":15,"vpd_target_kpa":1,"dli_target_mol":20,"zones":[{"zone_id":"bench-a","moisture_low_threshold":0.4,"moisture_high_threshold":0.6,"drain_period_secs":360,"schedule":"06:00,10:00,14:00,18:00"}]}},
      {"stage":"fruit-development-ripening","targets":{"temperature_day_c":22,"temperature_night_c":17,"day_start":"06:00","day_end":"20:00","humidity_low_pct":55,"humidity_high_pct":65,"humidity_deadband_pct":5,"co2_target_ppm":1000,"co2_vent_interlock_threshold_pct":15,"vpd_target_kpa":1.1,"dli_target_mol":22,"zones":[{"zone_id":"bench-a","moisture_low_threshold":0.35,"moisture_high_threshold":0.55,"drain_period_secs":360,"schedule":"06:00,10:00,14:00,18:00"}]}}
    ]$$::jsonb
  ),
  (
    'cucumber-standard',
    'Cucumber — standard',
    'cucumber',
    $$[
      {"stage":"propagation","targets":{"temperature_day_c":26,"temperature_night_c":22,"day_start":"06:00","day_end":"20:00","humidity_low_pct":70,"humidity_high_pct":80,"humidity_deadband_pct":5,"co2_target_ppm":700,"co2_vent_interlock_threshold_pct":15,"vpd_target_kpa":0.7,"dli_target_mol":12,"zones":[{"zone_id":"seedling-tray","moisture_low_threshold":0.5,"moisture_high_threshold":0.7,"drain_period_secs":600,"schedule":"07:00,11:00,15:00"}]}},
      {"stage":"vegetative-vine-development","targets":{"temperature_day_c":25,"temperature_night_c":20,"day_start":"06:00","day_end":"20:00","humidity_low_pct":65,"humidity_high_pct":75,"humidity_deadband_pct":5,"co2_target_ppm":900,"co2_vent_interlock_threshold_pct":15,"vpd_target_kpa":0.9,"dli_target_mol":18,"zones":[{"zone_id":"bench-a","moisture_low_threshold":0.45,"moisture_high_threshold":0.65,"drain_period_secs":300,"schedule":"06:00,10:00,14:00,18:00"}]}},
      {"stage":"flowering-fruit-set","targets":{"temperature_day_c":25,"temperature_night_c":20,"day_start":"06:00","day_end":"20:00","humidity_low_pct":60,"humidity_high_pct":70,"humidity_deadband_pct":5,"co2_target_ppm":1000,"co2_vent_interlock_threshold_pct":15,"vpd_target_kpa":1,"dli_target_mol":22,"zones":[{"zone_id":"bench-a","moisture_low_threshold":0.45,"moisture_high_threshold":0.65,"drain_period_secs":360,"schedule":"06:00,10:00,14:00,18:00"}]}},
      {"stage":"production-harvest","targets":{"temperature_day_c":24,"temperature_night_c":19,"day_start":"06:00","day_end":"20:00","humidity_low_pct":60,"humidity_high_pct":70,"humidity_deadband_pct":5,"co2_target_ppm":1000,"co2_vent_interlock_threshold_pct":15,"vpd_target_kpa":1.1,"dli_target_mol":24,"zones":[{"zone_id":"bench-a","moisture_low_threshold":0.45,"moisture_high_threshold":0.65,"drain_period_secs":360,"schedule":"06:00,10:00,14:00,18:00"}]}}
    ]$$::jsonb
  ),
  (
    'lettuce-standard',
    'Lettuce — standard',
    'lettuce',
    $$[
      {"stage":"propagation","targets":{"temperature_day_c":21,"temperature_night_c":18,"day_start":"06:00","day_end":"20:00","humidity_low_pct":70,"humidity_high_pct":80,"humidity_deadband_pct":5,"co2_target_ppm":650,"co2_vent_interlock_threshold_pct":15,"vpd_target_kpa":0.6,"dli_target_mol":10,"zones":[{"zone_id":"seedling-tray","moisture_low_threshold":0.5,"moisture_high_threshold":0.7,"drain_period_secs":600,"schedule":"07:00,11:00,15:00"}]}},
      {"stage":"vegetative","targets":{"temperature_day_c":20,"temperature_night_c":17,"day_start":"06:00","day_end":"20:00","humidity_low_pct":60,"humidity_high_pct":70,"humidity_deadband_pct":5,"co2_target_ppm":800,"co2_vent_interlock_threshold_pct":15,"vpd_target_kpa":0.8,"dli_target_mol":14,"zones":[{"zone_id":"bench-a","moisture_low_threshold":0.4,"moisture_high_threshold":0.6,"drain_period_secs":300,"schedule":"06:00,10:00,14:00,18:00"}]}},
      {"stage":"finishing-harvest","targets":{"temperature_day_c":18,"temperature_night_c":16,"day_start":"06:00","day_end":"20:00","humidity_low_pct":55,"humidity_high_pct":65,"humidity_deadband_pct":5,"co2_target_ppm":800,"co2_vent_interlock_threshold_pct":15,"vpd_target_kpa":0.9,"dli_target_mol":15,"zones":[{"zone_id":"bench-a","moisture_low_threshold":0.4,"moisture_high_threshold":0.6,"drain_period_secs":360,"schedule":"06:00,10:00,14:00,18:00"}]}}
    ]$$::jsonb
  )
ON CONFLICT (id) DO NOTHING;
