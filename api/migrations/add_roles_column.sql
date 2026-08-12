-- Multiple roles per user: `roles` is a comma-separated set; `role` stays the
-- primary (highest-privilege) role for display and seat counting.
-- Run once against the live D1 (errors harmlessly if the column already exists):
--   cd api
--   npx wrangler d1 execute lms-pooled --remote --file migrations/add_roles_column.sql
ALTER TABLE accounts ADD COLUMN roles TEXT;
