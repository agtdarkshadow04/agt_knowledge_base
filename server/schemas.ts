import { Type, type TSchema } from '@sinclair/typebox';

/**
 * TypeBox schemas of every route (API-10). Request schemas describe the shape
 * (types, required properties, no extra properties); the semantic rules
 * (lengths, formats, cross-field checks) run afterwards in the shared Zod
 * validators of `src/lib/validation.ts`. Response schemas must list every
 * field a route returns: Fastify's serializer drops undeclared ones.
 */

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T, options?: string | { description: string; deprecated?: boolean }) =>
  Type.Object(properties, { additionalProperties: false, ...(typeof options === 'string' ? { description: options } : options ?? {}) });

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const Timestamp = Type.String({ format: 'date-time', description: 'ISO 8601 UTC, ending in Z.' });
const Id = Type.String({ description: 'Lowercase UUID. A malformed ID answers 404 (API-5).' });

// --- Errors (API-6) -------------------------------------------------------

export const errorCodes = [
  'invalid_request', 'validation_failed', 'unknown_setting',
  'invalid_setting', 'no_changes', 'tag_not_orphaned', 'file_required',
  'unauthorized', 'invalid_credentials', 'invalid_setup_password',
  'csrf', 'forbidden', 'public_browsing_closed',
  'not_found',
  'conflict', 'defined_in_config', 'setup_complete',
  'setup_password_missing',
  'file_too_large', 'body_too_large',
  'multipart_required',
  'archive_rejected',
  'iam_disabled', 'app_access_denied', 'managed_by_iam',
  'iam_unavailable', 'iam_bad_gateway', 'iam_timeout',
  'rate_limited',
  'internal',
  'maintenance',
] as const;

const fieldCodes = [
  'required', 'too_long', 'too_short', 'out_of_range', 'too_many', 'invalid_format', 'invalid_url', 'not_allowed',
  'duplicate', 'mismatch', 'same_as_setup_password',
];

const Params = Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
  description: 'Values the translated message needs, e.g. `{ retryAfterSeconds }`, `{ maxBytes }` or `{ key }`.',
});

export const FieldErrorSchema = Type.Object({
  field: Type.String({ description: 'The request property, dotted for nested ones (e.g. `tagIds.2`).' }),
  code: Type.String({ description: `One of: ${fieldCodes.map((code) => `\`${code}\``).join(', ')}.` }),
  message: Type.String(),
  params: Type.Optional(Params),
}, { $id: 'FieldError' });

export const ErrorBodySchema = Type.Object({
  error: Type.String({ description: `Stable snake_case code. One of: ${errorCodes.map((code) => `\`${code}\``).join(', ')}.` }),
  message: Type.String({ description: 'English text for humans and logs.' }),
  params: Type.Optional(Params),
  fields: Type.Optional(Type.Array(Type.Ref('FieldError'))),
  code: Type.String({ deprecated: true, description: 'The 1.x UPPER_SNAKE_CASE code. Use `error`; removed in 3.0.0.' }),
  issues: Type.Optional(Type.Array(Type.Unknown(), { deprecated: true, description: 'The 1.x validation issues. Use `fields`; removed in 3.0.0.' })),
}, { $id: 'ErrorBody' });

// --- Shared resources -----------------------------------------------------

export const Visibility = Type.Union([
  Type.Literal('Public'), Type.Literal('Internal'), Type.Literal('Admin'),
  Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4), Type.Literal(5),
], { description: 'Legacy text level or AGT numeric level 0–5.' });

const Role = Type.Union([Type.Literal('Editor'), Type.Literal('Moderator')]);

export const Tag = object({ id: Id, name: Type.String(), color: Type.String({ description: '`#RRGGBB`' }) });

const articleFields = {
  id: Id,
  title: Type.String(),
  tags: Type.Array(Tag),
  visibility: Visibility,
  isPinned: Type.Boolean(),
  isProtected: Type.Boolean(),
  isVerified: Type.Boolean(),
  createdAt: Timestamp,
  createdBy: Type.String(),
  createdByName: Type.String(),
  modifiedAt: Timestamp,
  modifiedBy: Type.String(),
  modifiedByName: Type.String(),
  version: Type.Integer({ minimum: 1 }),
};

export const ArticleSummary = object({ ...articleFields, excerpt: Type.String() });
export const Article = object({ ...articleFields, content: Type.String({ description: 'Markdown, stored exactly as written.' }) });

export const ArticleList = object({
  items: Type.Array(ArticleSummary),
  nextCursor: nullable(Type.String({ description: 'Pass as `cursor` to get the next page; null on the last page.' })),
  total: Type.Integer({ minimum: 0, description: 'How many articles match the filters.' }),
  page: Type.Optional(Type.Integer({ deprecated: true, description: 'Only with the deprecated `page` parameter; removed in 3.0.0.' })),
  pageSize: Type.Optional(Type.Integer({ deprecated: true, description: 'Only with the deprecated `page` parameter; removed in 3.0.0.' })),
  totalPages: Type.Optional(Type.Integer({ deprecated: true, description: 'Only with the deprecated `page` parameter; removed in 3.0.0.' })),
});

export const Revision = object({
  articleId: Id,
  title: Type.String(),
  content: Type.String(),
  tags: Type.Array(Tag),
  visibility: Visibility,
  isPinned: Type.Boolean(),
  isProtected: Type.Boolean(),
  isVerified: Type.Boolean(),
  revisedAt: Timestamp,
  revisedBy: Type.String(),
  revisedByName: Type.String(),
  version: Type.Integer({ minimum: 1 }),
});

export const TagOrphan = object({
  articleId: Id,
  articleTitle: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  missingTagIds: Type.Array(Id),
});

export const PublicSettings = object({
  site: object({ title: Type.String(), subtitle: Type.String(), supportUrl: Type.String() }),
  articles: object({ defaultVisibility: Visibility }),
  access: object({ allowPublicBrowsing: Type.Boolean() }),
  iam: object({ signIn: Type.Boolean({ description: 'Members can sign in with their AGT account: `iam.enabled` is on and AGT IAM is configured.' }) }),
});

export const LegacyPublicSettings = object({
  applicationName: Type.String(),
  applicationSubtitle: Type.String(),
  defaultVisibility: Visibility,
  allowPublicBrowsing: Type.Boolean(),
  version: Type.Integer(),
});

const SecurityLevel = Type.Integer({
  minimum: 0,
  maximum: 5,
  description: 'Security level on the AGT scale (#70): the member reads and may assign article visibility levels up to this one (legacy Public 0, Internal 1, Admin 5).',
});

const AuthSource = Type.Union([Type.Literal('local'), Type.Literal('agt_iam')], {
  description: '`local`: a username or email and a password; `agt_iam`: the member\'s AGT account.',
});

export const MemberUser = object({
  sub: Type.String(),
  username: Type.String({ description: 'The local username, or the Traveller Name of an AGT member.' }),
  displayName: Type.String(),
  email: Type.Optional(Type.String()),
  role: Role,
  securityLevel: SecurityLevel,
  authSource: AuthSource,
});

export const SetupStatus = object({
  adminExists: Type.Boolean(),
  setupPasswordConfigured: Type.Boolean({ description: 'AGT_KNOWLEDGE_BASE_SETUP_PASSWORD is set (AUTH-5).' }),
  required: Type.Boolean({ deprecated: true, description: 'The 1.x name of `!adminExists`. Removed in 3.0.0.' }),
});

export const AdminSession = object({
  username: Type.String(),
  setupPasswordStillSet: Type.Boolean({ description: 'AGT_KNOWLEDGE_BASE_SETUP_PASSWORD is still set and should be removed (AUTH-6).' }),
  setupPasswordSet: Type.Boolean({ deprecated: true, description: 'The 1.x name of `setupPasswordStillSet`. Removed in 3.0.0.' }),
  version: Type.String({ description: 'The app version (VER-2).' }),
});

export const LocalUser = object({
  id: Id,
  username: Type.String({ description: 'The local username, or the Traveller Name of an AGT member.' }),
  displayName: Type.String(),
  email: Type.Optional(Type.String()),
  role: Role,
  securityLevel: SecurityLevel,
  isActive: Type.Boolean(),
  authSource: AuthSource,
  agtTravellerId: Type.Optional(Type.String({ description: 'The AGT traveller ID of an AGT member.' })),
  iamPermission: Type.Optional(Type.String({ description: 'The AGT IAM permission tier at the member\'s last sign-in.' })),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const LocalUserList = object({
  items: Type.Array(LocalUser),
  page: Type.Integer(),
  pageSize: Type.Integer(),
  total: Type.Integer(),
  totalPages: Type.Integer(),
});

export const AdminStats = object({
  totalArticles: Type.Integer(),
  publicArticles: Type.Integer(),
  internalArticles: Type.Integer(),
  adminArticles: Type.Integer(),
  pinnedArticles: Type.Integer(),
  protectedArticles: Type.Integer(),
  verifiedArticles: Type.Integer(),
  articleRevisions: Type.Integer(),
  canonicalTags: Type.Integer(),
  orphanedTagReferences: Type.Integer(),
});

const LegacySettingSource = Type.Union([Type.Literal('file'), Type.Literal('dashboard'), Type.Literal('default')]);
const settingView = <T extends TSchema>(value: T) => object({ key: Type.String(), value, source: LegacySettingSource });
const SettingValue = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

export const SettingState = object({
  key: Type.String({ description: 'Dotted key, as in config.yaml (`site.title`).' }),
  value: SettingValue,
  source: Type.Union([Type.Literal('config'), Type.Literal('dashboard'), Type.Literal('default')]),
  locked: Type.Boolean({ description: 'Set in config.yaml, so the dashboard cannot change it.' }),
  default: SettingValue,
  description: Type.String(),
});

export const AdminSettings = object({
  states: Type.Array(SettingState, { description: 'Every dashboard setting with its effective value and source (CFG-7).' }),
  iam: object({
    enabled: Type.Boolean({ description: 'The effective `iam.enabled` setting.' }),
    available: Type.Boolean({ description: 'Enabled and configured: members can sign in with their AGT account.' }),
    missing: Type.Array(Type.Union([Type.Literal('baseUrl'), Type.Literal('appId'), Type.Literal('apiKey')]), {
      description: 'What AGT sign-in still needs: `iam.baseUrl`, `iam.appId` in config.yaml, or AGT_KNOWLEDGE_BASE_IAM_API_KEY.',
    }),
  }, 'AGT IAM sign-in status.'),
  version: Type.Integer({ deprecated: true, description: 'Always 1; settings no longer carry a version. Removed in 3.0.0.' }),
  settings: Type.Object({
    applicationName: settingView(Type.String()),
    applicationSubtitle: settingView(Type.String()),
    defaultVisibility: settingView(Visibility),
    allowPublicBrowsing: settingView(Type.Boolean()),
    backupMaxBytes: settingView(Type.Integer()),
    backupMaxEntries: settingView(Type.Integer()),
    backupMaxUncompressedBytes: settingView(Type.Integer()),
  }, { additionalProperties: false, ...{ deprecated: true, description: 'The 1.x view; use `states`. Removed in 3.0.0.' } }),
});

const DiffLine = object({ kind: Type.Union([Type.Literal(' '), Type.Literal('-'), Type.Literal('+')]), text: Type.String() });

const restorePreviewFields = {
  createdAt: Timestamp,
  appVersion: Type.String(),
  formatVersion: Type.Integer({ description: 'The archive format version (BAK-7).' }),
  schemaVersion: object({
    backup: Type.Integer({ description: 'The schema version of the backup; older ones are migrated by the restore.' }),
    current: Type.Integer({ description: 'This installation\'s schema version.' }),
  }),
  migrations: object(
    { backup: Type.Array(Type.String()), upgrade: Type.Array(Type.String()) },
    { deprecated: true, description: 'The 1.x view of `schemaVersion` as migration ids. Removed in 3.0.0.' },
  ),
  counts: Type.Record(Type.String(), Type.Integer()),
  config: object({
    included: Type.Boolean(),
    content: nullable(Type.String()),
    diff: nullable(Type.Array(DiffLine)),
    identical: Type.Boolean(),
  }),
  ignoredSettings: Type.Array(Type.String(), { description: 'Dashboard settings in the backup that config.yaml defines; a restore drops them.' }),
  warnings: Type.Array(Type.String(), { description: 'English text of each warning.' }),
  warningCodes: Type.Array(Type.Union([Type.Literal('log_tables_ignored'), Type.Literal('no_admin')]), { description: 'The warnings as codes, for translation: `log_tables_ignored`, `no_admin`.' }),
};

export const RestorePreview = object(restorePreviewFields);
export const RestoreReport = object({
  ...restorePreviewFields,
  preRestoreBackup: nullable(Type.String({ description: 'The pre-restore backup in `storage.backupsDir`; null for a recovery restore.' })),
});

export const Health = object({ status: Type.Union([Type.Literal('ok'), Type.Literal('maintenance')], { description: '`maintenance` while a restore runs or has failed (BAK-8).' }) });

const binary = { schema: { type: 'string', format: 'binary' } };

// --- Logs (LOG-7, LOG-10, LOG-18) -------------------------------------------------

const Details = Type.Record(Type.String(), Type.Unknown(), { description: 'A JSON summary; never secrets or bulk content (LOG-9, LOG-14).' });

export const ServerLogEntry = object({
  id: Id,
  at: Timestamp,
  level: Type.Union(['info', 'warn', 'error', 'fatal'].map((level) => Type.Literal(level))),
  source: Type.String({ description: 'The subsystem: `startup`, `shutdown`, `config`, `migrations`, `retention`, `backup`, `http`, `auth`, `security` or `server`.' }),
  message: Type.String(),
  requestId: nullable(Type.String()),
  details: Details,
});

export const AuditLogEntry = object({
  id: Id,
  at: Timestamp,
  lastAt: Timestamp,
  count: Type.Integer({ description: 'Identical failures within 60 seconds are counted in one entry (LOG-11).' }),
  actorType: Type.Union([Type.Literal('admin'), Type.Literal('member'), Type.Literal('anonymous')]),
  actor: nullable(Type.String()),
  ipHash: nullable(Type.String({ description: 'Pseudonymous client address (LOG-12); never the raw IP.' })),
  client: Type.Union([Type.Literal('web'), Type.Literal('api')]),
  action: Type.String({ description: 'The route\'s operationId.' }),
  method: Type.String(),
  route: Type.String(),
  targetType: nullable(Type.String()),
  targetId: nullable(Type.String()),
  outcome: Type.Union(['success', 'denied', 'rate_limited', 'failure'].map((outcome) => Type.Literal(outcome))),
  statusCode: Type.Integer(),
  requestId: nullable(Type.String()),
  details: Details,
});

const nextCursor = nullable(Type.String({ description: 'Pass as `cursor` to get the next page; null on the last page.' }));
export const ServerLogList = object({ items: Type.Array(ServerLogEntry), nextCursor });
export const AuditLogList = object({ items: Type.Array(AuditLogEntry), nextCursor });
export const ServerLogSummary = object({
  unseenWarnings: Type.Integer(),
  unseenErrors: Type.Integer({ description: 'Unseen `error` and `fatal` entries.' }),
});

const logPageQuery = {
  from: Type.Optional(Type.String({ description: 'ISO 8601; entries at or after.' })),
  to: Type.Optional(Type.String({ description: 'ISO 8601; entries before.' })),
  q: Type.Optional(Type.String({ description: 'Text to search for.' })),
  limit: Type.Optional(Type.String({ description: '1–200, default 50.' })),
  cursor: Type.Optional(Type.String()),
};
const formatQuery = { format: Type.Optional(Type.String({ description: '`jsonl` (default) or `csv`.' })) };
const serverLogFilters = {
  level: Type.Optional(Type.String({ description: 'Minimum level: `info`, `warn`, `error` or `fatal`.' })),
  source: Type.Optional(Type.String()),
  ...logPageQuery,
};
const auditLogFilters = {
  actorType: Type.Optional(Type.String({ description: '`admin`, `member` or `anonymous`.' })),
  action: Type.Optional(Type.String()),
  outcome: Type.Optional(Type.String({ description: '`success`, `denied`, `rate_limited` or `failure`.' })),
  targetType: Type.Optional(Type.String()),
  targetId: Type.Optional(Type.String()),
  ...logPageQuery,
};
export const ServerLogQuery = object(serverLogFilters);
export const ServerLogExportQuery = object({ ...serverLogFilters, ...formatQuery });
export const AuditLogQuery = object(auditLogFilters);
export const AuditLogExportQuery = object({ ...auditLogFilters, ...formatQuery });

/** A log export: JSON Lines or CSV, streamed (LOG-22). */
export const LogExport = {
  description: 'The log entries as JSON Lines or CSV.',
  content: { 'application/x-ndjson': binary, 'text/csv': binary },
} as unknown as TSchema;

export const NoContent = Type.Null({ description: 'No content.' });


/** A backup download: the ZIP archive, not JSON. */
export const BackupArchive = { description: 'The backup ZIP archive.', content: { 'application/zip': binary } } as unknown as TSchema;

/**
 * The restore upload (BAK-1): `multipart/form-data` with the `backup` file and
 * `action`. The parts are read as a stream, so Fastify validates no parsed
 * body; `RestoreUploadDocument` is what the OpenAPI document shows.
 */
export const RestoreUpload = {
  description: 'The backup ZIP archive and the action.',
  content: { 'multipart/form-data': { schema: {} } },
} as unknown as TSchema;

export const RestoreUploadDocument = {
  description: 'The backup ZIP archive and the action.',
  required: true,
  content: {
    'multipart/form-data': {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['preview', 'restore'], description: '`preview` validates only; `restore` replaces the data.' },
          backup: { type: 'string', format: 'binary', description: 'The backup ZIP archive, at most `backup.maxZipBytes`.' },
        },
        required: ['action', 'backup'],
      },
    },
  },
};

/** A deprecated backup upload: the request body is the ZIP archive itself. */
export const BackupUpload = {
  description: 'The backup ZIP archive.',
  content: { 'application/zip': { schema: {} }, 'application/octet-stream': { schema: {} } },
} as unknown as TSchema;

// --- Requests -------------------------------------------------------------

const text = (description?: string) => Type.String(description ? { description } : {});

export const IdParams = object({ id: Id });
export const TagIdParams = object({ tagId: Id });
export const ArticleTagParams = object({ id: Id, tagId: Id });
export const RevisionParams = object({ id: Id, version: Type.String({ description: 'A revision version, a positive integer.' }) });
export const UserIdParams = object({ userId: Id });

// AUTH-5: passwords at most 1024 characters, usernames at most 64 (254 for a member's email address).
const password = (description?: string) => Type.String({ maxLength: 1024, ...(description ? { description } : {}) });
export const Credentials = object({ username: Type.String({ maxLength: 254, description: 'The Admin username, or a member\'s username or email address.' }), password: password() });
// Issue #30: AGT IAM allows 42 characters each; the shared validator counts code points.
export const IamCredentials = object({
  travellerName: Type.String({ maxLength: 84, description: 'The AGT Traveller Name, 1–42 characters.' }),
  password: Type.String({ maxLength: 84, description: 'The AGT password, 1–42 characters; sent only to AGT IAM, never stored.' }),
});
export const AdminSetupBody = object({
  setupPassword: password('AGT_KNOWLEDGE_BASE_SETUP_PASSWORD.'),
  username: Type.String({ maxLength: 64, description: '1–64 characters after trimming.' }),
  password: password('12–1024 characters with a lowercase letter, an uppercase letter, a number and a symbol; not the setup password.'),
  passwordConfirmation: Type.Optional(password('When sent, must equal `password`.')),
});
export const AdminPasswordBody = object({ currentPassword: password(), password: password(), passwordConfirmation: Type.Optional(password('When sent, must equal `password`.')) });

export const ArticleWriteBody = object({
  title: text('3–180 characters.'),
  content: text('Markdown, 20–250,000 characters; no raw HTML, JSX or MDX imports.'),
  tagIds: Type.Array(Id, { description: 'At most 12 distinct tag IDs.' }),
  visibility: Type.Optional(Visibility),
  version: Type.Optional(Type.Integer({ description: 'The version being replaced (required on update).' })),
});
export const ProtectionBody = object({ isProtected: Type.Boolean(), version: Type.Integer() });
export const PinningBody = object({ isPinned: Type.Boolean(), version: Type.Integer() });
export const VerificationBody = object({ isVerified: Type.Boolean(), version: Type.Integer() });
export const RestoreRevisionBody = object({ currentVersion: Type.Integer() });
export const TagWriteBody = object({ name: text('1–40 characters.'), color: text('Canonical `#RRGGBB`.') });

export const VersionQuery = object({ version: Type.Optional(text('The article version, a positive integer.')) });

export const ArticleListQuery = object({
  search: Type.Optional(text()),
  tagId: Type.Optional(text()),
  visibility: Type.Optional(text('`all`, `public`, `internal`, `admin` or `0`–`5`.')),
  pinned: Type.Optional(text('`all` or `pinned`.')),
  protection: Type.Optional(text('`all`, `protected` or `unprotected`.')),
  verification: Type.Optional(text('`all`, `verified` or `unverified`.')),
  sort: Type.Optional(text('`createdAt`, `modifiedAt` or `title`.')),
  direction: Type.Optional(text('`asc` or `desc`.')),
  limit: Type.Optional(text('1–200, default 50 (API-8).')),
  cursor: Type.Optional(text('The `nextCursor` of the previous page.')),
  page: Type.Optional(Type.String({ deprecated: true, description: 'Deprecated page number; use `cursor`. Removed in 3.0.0.' })),
  pageSize: Type.Optional(Type.String({ deprecated: true, description: 'Deprecated page size; use `limit`. Removed in 3.0.0.' })),
});

export const TagListQuery = object({ search: Type.Optional(text()) });

export const UserListQuery = object({
  search: Type.Optional(text()),
  role: Type.Optional(text('`all`, `Editor` or `Moderator`.')),
  active: Type.Optional(text('`all`, `active` or `inactive`.')),
  page: Type.Optional(text()),
  pageSize: Type.Optional(text()),
});

export const UserCreateBody = object({
  username: text(),
  displayName: text(),
  email: Type.Optional(text()),
  role: text('`Editor` or `Moderator`.'),
  securityLevel: Type.Optional(Type.Integer({ description: '0-5, default 0 (Public).' })),
  password: text(),
});
export const UserUpdateBody = object({
  username: text(),
  displayName: text(),
  email: Type.Optional(text()),
  role: text('`Editor` or `Moderator`.'),
  securityLevel: Type.Optional(Type.Integer({ description: '0-5; left out, the current level stays. A change ends the member\'s sessions.' })),
  isActive: Type.Boolean(),
}, 'For an AGT member only `isActive` can change: send the other fields as they are (or leave out `securityLevel`), or the request is refused with `409 managed_by_iam`.');
export const UserPasswordBody = object({ password: text() });

const legacyInput = <T extends TSchema>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()], { deprecated: true, description: 'Deprecated 1.x field; use `values`. Removed in 3.0.0.' }));
export const SettingsWriteBody = object({
  values: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: 'Dotted setting keys with their new values; `null` resets a key to its default (CFG-8).',
  })),
  version: Type.Optional(Type.Integer({ deprecated: true, description: 'Deprecated 1.x field; use `values`. Removed in 3.0.0.' })),
  applicationName: legacyInput(Type.String()),
  applicationSubtitle: legacyInput(Type.String()),
  defaultVisibility: legacyInput(Visibility),
  allowPublicBrowsing: legacyInput(Type.Boolean()),
  backupMaxBytes: legacyInput(Type.Integer()),
  backupMaxEntries: legacyInput(Type.Integer()),
  backupMaxUncompressedBytes: legacyInput(Type.Integer()),
}, 'Send `values`. The whole request is refused if a key is unknown, set in config.yaml, or invalid.');

export const RestoreActionQuery = object({ action: Type.Optional(text('`preview` or `restore`.')) });
