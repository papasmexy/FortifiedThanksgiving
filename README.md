# Fortified Thanksgiving — room competitions

A Thanksgiving photo contest with **full-name + shared room-code entry** and a separate **password + authenticator** admin area. Microsoft SSO has been removed. Each room has its own participants, one submission per participant, three final votes on different entries, gallery and leaderboard.

## Run locally

Node.js 24 is required. From this checkout:

```sh
npm ci
npm test
npm run dev
```

The server binds loopback port 3000. In your local browser, open the site and choose **Organizer sign in** (the /admin route). On a new local development database, create the first admin username/password, add its manual secret to a TOTP authenticator app, and confirm the current six-digit code. There is **no default admin password**. Never expose development mode through a public tunnel.

Then create a room, assign or generate its shared code, save that code, and distribute its /r/ROOM_ID link and code privately. Room codes are case-insensitive, 10–64 characters, and cannot be retrieved later: rotate a forgotten code.

For browser acceptance testing, install the development dependencies and a Chromium browser, then run `npm run test:browser`. In this cloud environment use `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser`. Elsewhere Playwright can install Chromium with `npx playwright install chromium`. Browser tests create isolated temporary data and fictional admins; they do not change a real contest.

## Organizer workflow

- **Rooms:** create/edit welcome text, join/submission/voting switches, start/deadline dates, and active/draft/closed/archived state. New rooms require approval and start with submissions open and voting closed.
- **Participants:** review/approve names, mark pending, ban, correct names and recover lost personal sign-in keys. Approval is required to view photos, submit or vote unless disabled for new joins.
- **Content:** review images, edit titles/stories, hide or disqualify entries, and restore them. Hidden/disqualified entries and unapproved/banned participants' contributions are excluded from public results. Used votes are not refunded.
- **Oversight:** live results, tied ranks, CSV export with spreadsheet formula protection, and the last 100 admin audit events.
- **Site:** change the site title, footer message, company logo and maintenance notice.
- **Admins:** up to two independent accounts, private 24-hour single-use invitations, enable/disable the other account, change your own password and issue account-recovery invitations. Sensitive actions require your password and a fresh authenticator code.
- **Retention:** archive a competition to stop access, then optionally purge it with its exact title plus password/MFA confirmation. Purging is permanent and deletes that room's participants, entries, photos and votes. Export and back up first.

Admin access does not automatically create a participant identity. Use a separate browser profile/private window if you also enter the competition.

## Participant workflow and fairness

Enter your **full name + room code**. First-time entry creates a personal sign-in key shown once; save it securely. This browser remembers it in an HTTP-only cookie. A returning name on another device or after signing out also needs that personal key. The organizer can issue a replacement without resetting entries/votes. Two people with the same name need distinguishing names or initials agreed with the organizer.

A shared code and typed name **do not prove identity**. Someone can invent another name or forward the code. New rooms therefore require approval by default; organizers should check names against their expected participants before approving. Approval can be disabled explicitly for low-stakes rooms. The app enforces three votes per approved participant, not three votes per verified human. Voting for your own entry is currently allowed.

Closing submissions/voting and deadlines are checked on the server, not only in the interface. Codes, bans and administrator revocations take effect on subsequent requests. Rotating a room code signs participants out of that room but preserves their accounts, submissions and used votes.

## Production hosting

See [hosting and deployment](docs/HOSTING.md) and [security/operations](docs/SECURITY.md). A paid Render Blueprint is included; no hosting resources are created just by committing it.

Required production configuration:

| Variable | Purpose |
| --- | --- |
| NODE_ENV | production |
| BASE_URL | Exact public HTTPS origin; no path or trailing query |
| SESSION_SECRET | Stable random secret, at least 32 characters |
| ADMIN_ENCRYPTION_KEY | Independent stable random secret, at least 32 characters; protects MFA secrets and code/key hashes |
| ADMIN_SETUP_TOKEN | Random first-admin bootstrap token, at least 32 characters; needed until the first admin is created |
| DATA_DIR | Durable local disk directory; default ./data |
| PORT | Platform-provided port; default 3000 |

Do not put credentials in Git or chat. On Render, generated values live in secure environment settings. Retrieve the first-admin setup token there, enter it only on your HTTPS admin setup form, and remove it from the host after enrollment. No Microsoft app registration, OIDC keys, tenant IDs, SSO credentials, or external login provider is required.

Keep ADMIN_ENCRYPTION_KEY stable and backed up separately. Losing it means room-code/member-key hashes and encrypted MFA secrets cannot be recovered normally. Startup refuses changed keys instead of silently breaking identity or resetting votes.

## Backups and administrator recovery

`npm run backup -- /protected/NEW-backup-directory` uses SQLite's online backup API and copies immutable photos. Do not run room purges while backing up. It requires a new destination outside DATA_DIR, excludes active sessions, and never includes the encryption key. Store the backup encrypted and protect it as employee data.

If both admins lose their passwords/authenticators, a trusted hosting operator with the **original encryption key** can run `npm run admin:recover -- EXISTING_USERNAME` in the protected host shell. It prints a sensitive one-use recovery invitation valid for one hour. Open it privately, enroll a new password/authenticator, and discard the link. Do not paste recovery links into chat or logs. Recovery preserves rooms, entries and votes.

## Storage and limits

The new app uses data/rooms.sqlite and data/room-uploads. The former SSO database data/app.sqlite and its photo directory are left untouched. Inspection before this change found zero legacy users, entries or votes, so no migration was needed. The old implementation remains in Git history.

One app instance and durable SQLite-compatible local storage are required. Do not deploy independent replicas or use SQLite on SMB/NFS storage. Room names, participant full names, photos and votes are now intentionally stored: the old claim that the app stores no names no longer applies. Only admit people whose data your organization is authorized to process.

Each cloud task is isolated. Use the existing checkout; do not create a Git worktree unless explicitly requested. Runtime processes must restart after environment restoration. Environment publication and website deployment are separate operations.
