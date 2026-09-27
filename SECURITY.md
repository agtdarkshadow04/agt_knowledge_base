# Security policy

Report suspected vulnerabilities privately through the Alliance of Galactic Travellers support channel rather than opening a public issue with exploit details.

Never commit `.env`, AWS credentials, Cognito passwords, database connection strings, or exported Secrets Manager values. Rotate any credential immediately if it is exposed.

The API is the authorization boundary. UI visibility is not considered an authorization control. Changes to role handling, protected-article rules, Markdown rendering, SQL construction, or optimistic concurrency should include regression tests and a focused security review.
