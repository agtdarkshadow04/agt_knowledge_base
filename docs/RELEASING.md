# Releasing AGT Knowledge Base

A release is the annotated tag `vX.Y.Z` on `main` plus a GitHub Release of the same name (VER-11). Agents prepare
releases but never publish one on their own: the maintainer asks for each release (VER-12).

## 1. The release PR

The release PR changes only the version's heading in `CHANGELOG.md`, from `## [X.Y.Z] - Unreleased` to
`## [X.Y.Z] - YYYY-MM-DD`. Its description carries:

- the dependency review (STACK-6): the `package-lock.json` changes since the last release (new packages, major
  version changes) and the output of `npm audit --omit=dev`;
- a link to a passing CI run of `npm run check` and `npm run test:e2e` on the release commit (TEST-6);
- the TEST-7 list below, ticked by the person who checked it;
- what TEST-8 and TEST-9 checked, and their results.

Do not tag while any of them fails: fix it in a new PR first.

## 2. Manual accessibility check (TEST-7)

Copy this list into the release PR and tick each item:

- [ ] Every public and admin flow works with the keyboard alone, with a visible focus indicator: browse and filter
  articles, read an article, sign in, write and edit an article, compare and restore revisions, manage tags, the
  settings dialog, and every admin tab (create, edit and delete a member, settings, logs, backup and restore,
  password change).
- [ ] A screen reader (NVDA with Firefox, or VoiceOver with Safari) announces the main flows, the dialogs and the
  status messages sensibly.
- [ ] Every colour pair added since the last release meets the A11Y-1 contrast ratios.
- [ ] The UI works at 200 % browser zoom, at the 2× text size, and with `prefers-reduced-motion` on (UI-11).
- [ ] Every locale renders, including Thai, Chinese, Hindi and Japanese in the fallback fonts (UI-3).

## 3. Installation smoke tests (TEST-8)

From a clean checkout of the release commit, following `README.md` exactly:

- **Docker Compose.** Create `config.yaml`, `.env` (with a setup password and a database password) and `.env.db`,
  run `docker compose up -d --build`, and wait until `docker compose ps` reports `knowledge-base` as `healthy`. Then
  `curl -fsS http://127.0.0.1:8081/api/health` succeeds, `curl -fsS http://127.0.0.1:8081/api/setup/status` reports
  `"adminExists":false` and `"setupPasswordConfigured":true`, and the port is published on `127.0.0.1` only
  (`docker compose port knowledge-base 8081`; the database has no published port). Finish with
  `docker compose down -v`. CI runs these checks on every pull request (the Docker Compose smoke test job); record
  that run.
- **Local installation.** On Ubuntu 24.04 or Debian 12/13 (a VM, or a container that runs systemd), follow the
  README's *Local installation* steps: `systemctl is-active agt-knowledge-base` reports `active`, the same `curl`
  checks pass, and `journalctl -u agt-knowledge-base` shows no errors.
- **Behind a proxy.** The server tests check that with `server.trustProxy` set, a request from the proxy address
  with `X-Forwarded-Proto: https` gets a `Secure` session cookie, and that without it the header is ignored
  (`server/test/server.test.ts`).

## 4. Upgrade and rollback test (TEST-9)

With at least the Docker method, following the README (VER-13):

1. Install the previous release tag and complete setup.
2. Create sample data: a member of each role, a tag, an article at each visibility level with revisions, pinned,
   protected and verified, and a dashboard setting. Download a backup.
3. Upgrade to the release commit as *Upgrading* says, and as the release's upgrade notes say for a major version
   (2.0.0: *Upgrading from 1.x to 2.0*).
4. Check that the data is intact, that the migrations ran (the Server log tab, or
   `docker compose logs knowledge-base`), and that the dashboard header shows the new version (VER-2).
5. Roll back as *Rolling back* says, and check that the previous version runs with the restored data.

## 5. Publishing (only when the maintainer asks)

After the release PR is merged:

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Then create the GitHub Release `vX.Y.Z` from the tag, with that version's `CHANGELOG.md` section as its body. Mark
release candidates (`-rc.N`) as pre-releases. Never move or delete a tag: a bad release is fixed by a new patch
release.
