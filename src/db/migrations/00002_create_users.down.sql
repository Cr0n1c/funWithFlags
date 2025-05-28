-- Drop the trigger first
DROP TRIGGER IF EXISTS update_users_timestamp;

-- Drop the indexes
DROP INDEX IF EXISTS idx_users_username;
DROP INDEX IF EXISTS idx_users_email;
DROP INDEX IF EXISTS idx_users_role;

-- Drop the users table
DROP TABLE IF EXISTS users; 