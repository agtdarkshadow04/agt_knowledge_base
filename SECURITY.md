# Security policy

Report suspected vulnerabilities privately through the Alliance of Galactic Travellers support channel rather than opening a public issue with exploit details.

Never commit `.env` files, `POSTGRES_PASSWORD`, `LOCAL_AUTH_SECRET`, database connection strings, database backups (including JSON backups downloaded from **Admin → Backup & restore**, which contain password hashes and restricted articles), or user passwords. If one is exposed, rotate it immediately. Changing `LOCAL_AUTH_SECRET` signs out every user.

The API is the authorization boundary. UI visibility is not considered an authorization control. Changes to authentication, role handling, protected-article rules, visibility, Markdown rendering, SQL construction, or optimistic concurrency should include regression tests and a focused security review.
