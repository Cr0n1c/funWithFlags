-- Drop the trigger first
DROP TRIGGER IF EXISTS prevent_migration_modification;

-- Drop the indexes
DROP INDEX IF EXISTS idx_migrations_name;
DROP INDEX IF EXISTS idx_migrations_executed_at;

-- Drop the migrations table
DROP TABLE IF EXISTS migrations; 