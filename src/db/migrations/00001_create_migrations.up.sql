-- Create migrations table to track database schema changes
CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    checksum TEXT,  -- Store hash of migration file for verification
    execution_time INTEGER,  -- Store execution time in milliseconds
    status TEXT DEFAULT 'success' CHECK (status IN ('success', 'failed', 'pending')),
    error_message TEXT  -- Store error message if migration failed
);

-- Create index on name for faster lookups
CREATE INDEX IF NOT EXISTS idx_migrations_name ON migrations(name);

-- Create index on executed_at for chronological queries
CREATE INDEX IF NOT EXISTS idx_migrations_executed_at ON migrations(executed_at);

-- Add trigger to prevent modification of critical fields in executed migrations
CREATE TRIGGER IF NOT EXISTS prevent_migration_modification
BEFORE UPDATE ON migrations
WHEN OLD.executed_at IS NOT NULL
BEGIN
    -- Allow updates to status, execution_time, and error_message
    -- but prevent changes to name and executed_at
    SELECT CASE
        WHEN NEW.name != OLD.name OR NEW.executed_at != OLD.executed_at
        THEN RAISE(ABORT, 'Cannot modify name or executed_at of executed migrations')
    END;
END; 