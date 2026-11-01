-- E7-R11: audit_trail is append-only. DDL only: existing rows are not touched, so the migration
-- cannot fail on data. If it fails anyway (e.g. the app's DB user does not own audit_trail), see
-- MIGRATION.md "Kalau migration gagal" (prisma migrate resolve --rolled-back).
--
-- Allowed exceptions:
--   * a transaction that ran SELECT set_config('entaris.audit_purge', 'on', true) first
--     (data reset, the old service-token scrub, test cleanup);
--   * DELETE of a demo-data row (via = 'demo'), used by "Hapus data uji coba".
-- via is read through to_jsonb(OLD): that column comes from a loose SQL file that runs after
-- `prisma migrate deploy`, so on a fresh database it does not exist yet when this function is made.

CREATE OR REPLACE FUNCTION entaris_audit_trail_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('entaris.audit_purge', true) = 'on' THEN
    IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NULL; -- TRUNCATE (statement level): the return value is ignored
  END IF;
  IF TG_OP = 'DELETE' AND to_jsonb(OLD) ->> 'via' = 'demo' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_trail is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Audit rows are never changed or deleted. A data reset sets entaris.audit_purge for its own transaction.';
END;
$$;

DROP TRIGGER IF EXISTS audit_trail_append_only_row ON audit_trail;
CREATE TRIGGER audit_trail_append_only_row
  BEFORE UPDATE OR DELETE ON audit_trail
  FOR EACH ROW EXECUTE FUNCTION entaris_audit_trail_append_only();

DROP TRIGGER IF EXISTS audit_trail_append_only_truncate ON audit_trail;
CREATE TRIGGER audit_trail_append_only_truncate
  BEFORE TRUNCATE ON audit_trail
  FOR EACH STATEMENT EXECUTE FUNCTION entaris_audit_trail_append_only();
