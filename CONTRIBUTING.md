# Contributing

Thanks for helping improve the AGT Knowledge Base.

## Getting started

1. Install Node.js 22 or newer and Docker (for PostgreSQL).
2. Follow **Local development** in [README.md](README.md) to install dependencies, start PostgreSQL, and run the API and frontend.

## Making a change

- Branch from `main` and open pull requests against `main`. Never target, push to, or rebase the `staging` branch: it is frozen for an existing deployment.
- Keep each pull request focused on one change, and reference the related issue (`Refs #123`) in the commit body.
- Write short, imperative commit subjects, for example `Add AGT-standard visibility levels`.
- Follow the conventions and change checklists in [AGENTS.md](AGENTS.md). They apply to human contributors too, for example the steps for adding an API route or a database migration.
- Update [README.md](README.md) when a change affects setup, configuration, roles and permissions, or user-visible behavior.

## Checks

Run these before opening a pull request. CI runs the same checks and also builds the Docker images.

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Changes to authentication, roles, article visibility or protection, Markdown rendering, SQL, or version conflict handling must include regression tests.

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
