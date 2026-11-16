/**
 * The stable codes the backup routes report beside their English text, so the
 * admin dashboard can translate them (I18N-6). No imports: the browser's
 * translation tests read these lists.
 */

/** Why a backup archive was refused, as `params.reason` of `422 archive_rejected`, so clients can translate it (I18N-6). */
export const archiveRejectionReasons = [
  'too_large', 'not_zip', 'unsafe_zip', 'missing_manifest', 'invalid_manifest', 'legacy_format', 'not_a_backup',
  'newer_format', 'newer_schema', 'unlisted_file', 'missing_file', 'checksum_mismatch', 'schema_mismatch',
  'disallowed_entry', 'invalid_dump', 'missing_tables', 'invalid_admin',
] as const;

export type ArchiveRejectionReason = typeof archiveRejectionReasons[number];

/** The warnings a preview can give, with their English text. */
export const restoreWarnings = {
  log_tables_ignored: 'The dump contains log or control tables; they are ignored.',
  no_admin: 'The backup has no Admin account; first-run setup will be needed after the restore.',
} as const;

export type RestoreWarningCode = keyof typeof restoreWarnings;
