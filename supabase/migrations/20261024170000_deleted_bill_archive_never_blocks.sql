-- The deleted-bill archive must never get in the way of the real expense or its attachments. If recording the archive row fails for
-- any reason, the bill is still removed as before; the problem is only logged (a WARNING in the database log). Replaces the trigger
-- function from 20261024160000_deleted_bill_archive.sql.
CREATE OR REPLACE FUNCTION bill_archive.capture_deleted_bill() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, bill_archive AS $$
BEGIN
  BEGIN
    PERFORM bill_archive.snapshot_deleted_bill(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'bill_archive: could not record attachment % (%)', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION bill_archive.capture_deleted_bill() FROM PUBLIC, anon, authenticated, service_role;
