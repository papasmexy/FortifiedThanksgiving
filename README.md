# Fortified Thanksgiving

A company Thanksgiving photo contest with Microsoft Entra ID sign-in, one photo submission per employee, a private employee gallery, three votes per account, and a leaderboard. Real accounts use generated aliases and keyed contest IDs; the app does not retain Microsoft profile names, email addresses, raw directory IDs or tokens. These IDs are pseudonymous, not fully anonymous. Warm autumn styling includes a temporary typographic brand mark; replace `.brand-mark` in `public/index.html` with your company logo when available.

## Local development

Requires Node.js 24 (tested with 24.22.1) and npm. No external database is needed.

```sh
cd /workspace/FortifiedThanksgiving
npm ci
npm test
npm run dev
```

The development server listens on loopback port 3000. Choose one of four explicitly labeled fictional demo accounts. New installs have an empty gallery; submit a test photo to try the complete flow. Demo accounts are strictly for local testing and cannot be enabled with `NODE_ENV=production`. Do not publicly expose demo mode.

`npm test` starts isolated local HTTP servers and verifies authenticated access, CSRF protection, safe image decoding, one submission per account, duplicate votes, parallel vote requests across sessions, persistence across sign-out, independent vote budgets, vote totals, and unsafe production configuration. It also simulates Microsoft OIDC responses to test certificate-signed client authentication, signature/issuer/audience/expiry/nonce/state checks, PKCE, role/member restrictions, production POST callbacks, secure cookies, replay rejection and identity minimization. These checks require permission to bind local sockets. There is no transpilation/build step. Run `npm audit` before each release.

## Microsoft Entra ID setup

The integration code is implemented and tested against simulated responses; live SSO requires an administrator-provided app registration and has not been tested against your tenant. Follow [the full security and Entra setup instructions](docs/SECURITY.md) and [the hosting comparison and deployment guide](docs/HOSTING.md). A Render Blueprint is included in `render.yaml`; no paid resources have been created.

1. Create a **single-tenant** Web app registration with the exact owned HTTPS callback; use a separate registration for approved local SSO tests.
2. Enable **Assignment required**, define and assign the `Contest.Participant` app role only to approved member employees. Add the `acct` optional ID-token claim. Apply company MFA/Conditional Access policies. The app rejects guests and missing assignment claims.
3. Register a dedicated public RSA certificate in Entra; keep its matching private key in the host's secure secret-file facility. No shared client password, Graph permissions, email scope or offline/refresh-token access is used.
4. Configure the values below securely. Never commit credentials or paste them into chat. `npm start` reads an ignored `.env` when present. Preserve the identity secret for the contest's lifetime.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` for deployment |
| `BASE_URL` | Public HTTPS origin, e.g. `https://thanksgiving.company.com` |
| `OIDC_ISSUER` | `https://login.microsoftonline.com/TENANT_UUID/v2.0` using your directory tenant UUID |
| `OIDC_CLIENT_ID` | Application/client ID |
| `OIDC_PRIVATE_KEY_PATH` | Runtime-only path to the certificate's RSA PEM private key |
| `OIDC_CERT_THUMBPRINT` | Base64url-encoded SHA-256 thumbprint of the registered public certificate |
| `IDENTITY_SECRET` | Independent stable random secret, at least 32 characters; changing it would change contest IDs |
| `SESSION_SECRET` | Stable random secret, at least 32 characters |
| `DATA_DIR` | Persistent directory; default `./data` |
| `PORT` | Default `3000` |

Keep `DEMO_AUTH` unset for real SSO. Run `npm start`. Put the server behind **exactly one trusted HTTPS reverse proxy**, prevent direct public access to the Node port, and forward the original scheme. Allow outbound HTTPS to `login.microsoftonline.com` for OIDC discovery, signing keys and token exchange; browsers also need access to Microsoft's normal sign-in services. Never disable TLS verification. For an explicitly proxy-managed cloud runtime, Node 24 supports `NODE_USE_ENV_PROXY=1`; preserve its inherited proxy and CA settings. Do not set proxy overrides on an ordinary host that does not require them.

Verify with a real assigned employee: sign in, submit a dish, vote, sign out and back in, then verify that the same vote balance remains. Also verify that an unassigned account and an outside-company account are denied. This is a required rollout check, not covered by local demo tests.

## Contest rules and storage

- One submission per account, with a title, optional story, and one JPG/PNG/WebP photo (8 MB, 25 megapixels maximum). The server decodes the image, strips metadata by re-encoding, and stores a resized WebP.
- Every account has **three total votes for three different creations**. Votes are final. Voting for your own dish is currently allowed. There is no automatic reset, voting deadline, or second contest season in this initial version.
- A transaction, uniqueness constraint, and database trigger enforce vote rules. Refreshing, logging out, opening another browser, or issuing parallel requests does not replenish votes.
- Gallery data, vote totals, and photos require sign-in. The public landing page contains no employee content. Equal totals share a leaderboard rank; zero-vote entries appear too.
- SQLite, sessions, and uploaded photos live in `data/`, which is ignored by Git. Back up both the database and uploads consistently. Use a durable local disk and one application instance; do not scale this version across independent disks or deploy it on an ephemeral filesystem.
- The initial version has no admin moderation/removal interface, competition scheduling, or content review. Add those before a rollout if your company requires them. Company SSO protects account identity; it cannot decide whether someone should own multiple employee accounts. Submitted images/text can still identify people; metadata removal does not anonymize their visible content.

## Environment lifecycle

Dependencies and files can survive an environment snapshot; server processes do not. Restart with `npm run dev` for local demo work or `npm start` with configured Entra credentials. Use the existing checkout: each cloud task is isolated, so do not create a Git worktree unless explicitly requested.

The project is versioned on GitHub. Hosting provisioning, production deployment and environment publication are separate operations. Never claim real company SSO works until it has been tested against the live tenant.
