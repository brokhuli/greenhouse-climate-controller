-- Preserve profiles that an operator has assigned; the foreign-key restriction protects
-- assignment history if a migration rollback is attempted on a live installation.
DELETE FROM crop_profiles
WHERE id IN ('tomato-standard', 'cucumber-standard', 'lettuce-standard')
  AND NOT EXISTS (
    SELECT 1
    FROM profile_assignments
    WHERE profile_assignments.profile_id = crop_profiles.id
  );
