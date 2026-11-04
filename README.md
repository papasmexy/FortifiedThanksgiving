# Fortified Thanksgiving

A company Thanksgiving photo contest with Microsoft Entra ID sign-in, one photo submission per employee, a private employee gallery, three votes per account, and a leaderboard. Warm autumn styling includes a temporary typographic brand mark; replace `.brand-mark` in `public/index.html` with your company logo when available.

## Local development

Requires Node.js 24 (tested with 24.22.1) and npm. No external database is needed.

```sh
cd /workspace/FortifiedThanksgiving
npm ci
npm test
npm run dev
```

The development server listens on port 3000. Choose one of four explicitly labeled demo accounts. New installs have an empty gallery; submit a real photo to try the complete flow. Demo accounts are strictly for local testing and cannot be enabled with `NODE_ENV=production`.

`npm test` starts isolated local HTTP servers and verifies authenticated access, CSRF protection, safe image decoding, one submission per account, duplicate votes, parallel vote requests across sessions, persistence across sign-out, independent vote budgets, vote totals, and unsafe production configuration. These checks require permission to bind local sockets. There is no transpilation/build step.

## Microsoft Entra ID setup

The integration code is implemented; live SSO requires an administrator-provided app registration and has not been tested against your tenant.

1. Create a **single tenant** Web app registration in Microsoft Entra ID. Register `https://YOUR_HOST/auth/callback` as its redirect URI. For an approved local SSO test, also register `http://localhost:3000/auth/callback`.
2. In the Enterprise Application, enable **Assignment required** and assign only the employees/group participating in the contest. Do not assign guest or secondary accounts. Three votes are enforced per validated company identity, so directory account provisioning remains part of abuse prevention.
3. Add the email optional ID-token claim if needed. The app uses `email` or `preferred_username` for its exact company-domain check and the validated issuer plus subject for persistent identity. No Microsoft Graph permissions are needed.
4. Create a client secret. Keep its value in a secure runtime secret store or an ignored local `.env` file. Never commit it or paste it into chat. Generate a separate stable random session secret of at least 32 characters.
5. Configure the values below in the deployment environment (or copy `.env.example` to `.env` locally). `npm start` reads `.env` when it exists.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` for deployment |
| `BASE_URL` | Public HTTPS origin, e.g. `https://thanksgiving.company.com` |
| `OIDC_ISSUER` | `https://login.microsoftonline.com/TENANT_UUID/v2.0` using your directory tenant UUID |
| `OIDC_CLIENT_ID` | Application/client ID |
| `OIDC_CLIENT_SECRET` | App registration secret value, provided securely |
| `COMPANY_EMAIL_DOMAIN` | Exact employee email domain without `@` |
| `SESSION_SECRET` | Stable random secret, at least 32 characters |
| `DATA_DIR` | Persistent directory; default `./data` |
| `PORT` | Default `3000` |

Keep `DEMO_AUTH` unset for real SSO. Run `npm start`. Put the server behind **exactly one trusted HTTPS reverse proxy**, prevent direct public access to the Node port, and forward the original scheme. Allow outbound HTTPS to `login.microsoftonline.com` for OIDC discovery and token exchange; browsers also need access to Microsoft's normal sign-in services. Never disable TLS verification.

Verify with a real assigned employee: sign in, submit a dish, vote, sign out and back in, then verify that the same vote balance remains. Also verify that an unassigned account and an outside-company account are denied. This is a required rollout check, not covered by local demo tests.

## Contest rules and storage

- One submission per account, with a title, optional story, and one JPG/PNG/WebP photo (8 MB, 25 megapixels maximum). The server decodes the image, strips metadata by re-encoding, and stores a resized WebP.
- Every account has **three total votes for three different creations**. Votes are final. Voting for your own dish is currently allowed. There is no automatic reset, voting deadline, or second contest season in this initial version.
- A transaction, uniqueness constraint, and database trigger enforce vote rules. Refreshing, logging out, opening another browser, or issuing parallel requests does not replenish votes.
- Gallery data, vote totals, and photos require sign-in. The public landing page contains no employee content. Equal totals share a leaderboard rank; zero-vote entries appear too.
- SQLite, sessions, and uploaded photos live in `data/`, which is ignored by Git. Back up both the database and uploads consistently. Use a durable local disk and one application instance; do not scale this version across independent disks or deploy it on an ephemeral filesystem.
- The initial version has no admin moderation/removal interface, competition scheduling, or content review. Add those before a rollout if your company requires them. Company SSO protects account identity; it cannot decide whether someone should own multiple employee accounts.

## Environment lifecycle

Dependencies and files can survive an environment snapshot; server processes do not. Restart with `npm run dev` for local demo work or `npm start` with configured Entra credentials. Use the existing checkout: each cloud task is isolated, so do not create a Git worktree unless explicitly requested.

The initial project was created locally. No commit, push, production deployment, or environment publication is performed automatically.
