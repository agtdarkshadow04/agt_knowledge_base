# Security policy

Report suspected vulnerabilities privately through the Alliance of Galactic Travellers support channel rather than opening a public issue with exploit details.

Never commit `.env` files, `POSTGRES_PASSWORD`, `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD`, `AGT_KNOWLEDGE_BASE_DB_PASSWORD`, database connection strings, backups (including ZIP archives downloaded from the admin panel's **Backup & restore**, and pre-restore backups in the backups volume, which contain the Admin and member password hashes and restricted articles), or user passwords. If one is exposed, rotate it immediately. Deleting the rows in `member_sessions` signs out every member; deleting the rows in `sessions` signs out the Admin. Remove `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` from `.env` once the Admin account exists.

The installation Admin is a separate account, stored in the `admin` table rather than with member accounts, that signs in only at `/admin` with its own cookie session. Member accounts (Editor and Moderator) can never gain administrator privileges, and the member session cookie is never accepted on admin routes (nor the Admin cookie on member routes).

The API is the authorization boundary. UI visibility is not considered an authorization control. Changes to authentication, the Admin session, role handling, protected-article rules, visibility, Markdown rendering, SQL construction, backup validation, or optimistic concurrency should include regression tests and a focused security review.
