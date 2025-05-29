-- Drop audit_log table and its indexes
DROP INDEX IF EXISTS idx_audit_log_user_id;
DROP INDEX IF EXISTS idx_audit_log_event_type;
DROP INDEX IF EXISTS idx_audit_log_timestamp;
DROP TABLE IF EXISTS audit_log; 