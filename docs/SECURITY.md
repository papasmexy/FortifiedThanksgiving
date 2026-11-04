# Room and administrator security

The app no longer performs Microsoft SSO or any external login exchange. Participant access is based on a shared room code, self-entered name and a personal return key. Administrator access is separate and stronger. This is not an identity-verified corporate authentication system or a guarantee of complete security.

## Trust and privacy

- Anyone who knows a room code can request entry under a chosen name. The app cannot prove that a name is truthful or that two names are two people. Require approval and review against an external roster for meaningful competition integrity. Approval is enabled by default.
- Pending participants can see their room's welcome/status but not photos or entries. Only approved room participants and admins can view gallery data/photos. Turning off approval auto-approves new joins and intentionally makes the shared code the admission boundary.
- A room code can be forwarded. Rotate a leaked code; all existing sessions in that room must re-enter it. Their personal keys, submissions and votes are preserved.
- A registered name is unique within a room after Unicode/case/whitespace normalization. Reusing it from another device requires the participant's personal return key; the shared room code alone cannot take over that name.
- A remembered participant key stays in a Secure/HTTP-only host cookie in production. Sign-out clears it. Personal keys and admin invitations are shown once and must be shared/saved privately.
- Full participant names are now stored because they are explicitly part of this login and attribution design. Names, photos, submitted stories, room settings and vote records are employee-linked data. Other approved people in the same room can see names attached to published entries. Admins see membership and usage counts.
- Passwords, room codes, personal keys and invitations are never stored in plaintext in the app database. Admin passwords use salted scrypt (N=32768,r=8,p=3); bearer values use purpose-separated keyed HMAC hashes. Admin authenticator secrets are encrypted with AES-256-GCM under the stable admin master secret. Application logs do not record credentials or underlying exception details.
- The hosting provider still processes network traffic, stores the disk/backups and may log IPs and infrastructure metadata. Review its retention, region and vendor policies. Encrypt storage/backups and restrict account access. Images are re-encoded to strip metadata but visible faces/names/text remain.

## First administrator and second administrator

Production refuses to start without independent strong SESSION_SECRET and ADMIN_ENCRYPTION_KEY and an exact HTTPS BASE_URL. A fresh installation also requires a random ADMIN_SETUP_TOKEN of at least 32 characters. The first admin enters that token on /admin, chooses a 14–128 character password and enrolls a six-digit time-based authenticator. There is no shipped password, public registration route for arbitrary admins, or email delivery service.

The bootstrap token works only while there are zero admin accounts; a transaction prevents two first admins winning a race. Remove the bootstrap token from the host after setup. Keep it out of browser bookmarks, screenshots and chat.

The first admin can invite one other administrator. Each account has its own password and authenticator. Invitations are private one-use links (secret in the URL fragment, removed by the page), expire in 24 hours, and bind to a named admin username. Existing usernames can be invited for recovery instead of creating a third account. There are at most two admin records, including disabled accounts.

Sensitive actions require current password and a fresh authenticator code: administrator invitation/recovery, account enable/disable, password change, participant credential recovery and permanent room deletion. TOTP codes accept a one-step clock window and cannot be replayed. Maintain accurate host time. Registration itself signs the new admin in; wait for a fresh authenticator code before a sensitive action.

Admin sign-in is rate limited and locks a username for 15 minutes after five failed password/MFA attempts. The lockout survives a restart; IP limits do not. An attacker who knows a username may cause a temporary lockout, so keep a second admin and an operator recovery route. Admin sessions have an absolute eight-hour lifetime; disabled accounts and version changes invalidate sessions on subsequent requests. The last active admin cannot disable themselves.

If both admins are locked out or lose MFA, a trusted host operator uses the recovery script documented in README. This requires access to the database and original master key. The one-hour recovery invitation re-enrolls password/MFA on the existing account, invalidates prior sessions and preserves competitions. Losing the encryption key requires restoring the original key; do not delete the database to bypass the guard.

## Competition integrity

- Room membership is scoped in server sessions and checked against the database for every request. UUID knowledge alone grants no access.
- Entries and votes carry matching room/member foreign keys, preventing cross-room writes. A unique constraint allows one entry per participant and one vote per entry. A transaction and trigger enforce the three-vote budget even across simultaneous requests or new browser sessions.
- Opening/closing rooms, start times, submission/voting deadlines, approvals, bans and moderation are checked server-side. Upload authorization is checked again after image processing, so closing/banning during an upload cannot bypass the policy.
- Hidden/disqualified entries, content from non-approved participants and votes from non-approved voters are excluded from displayed results. The original records and spent vote budgets remain; moderation/recovery never silently refunds votes.
- Admin name corrections preserve the same participant ID, entries, personal key and used votes. Approval is not bulk identity verification: review names before using “approve all pending.”
- Audit events record administrator, operation, target IDs and time, not passwords, room codes or recovery keys. The UI shows the last 100 events; historical audit rows remain in the database until a separate retention procedure.
- CSV exports neutralize leading spreadsheet formula characters. Exports contain participant names and should be treated as sensitive.

## Web and upload controls

Secure/HTTP-only/SameSite=Lax host-only production cookies, session ID regeneration on login/enrollment, CSRF tokens and same-origin checks protect mutations. Admin credentials are never placed in room forms. No permissive CORS, third-party scripts, fonts or analytics are included. The CSP restricts scripts/assets and framing; HTTPS responses set HSTS and private responses are not cached.

The app must sit behind exactly one trusted HTTPS reverse proxy. Do not expose the Node port directly or broaden proxy trust to arbitrary clients. Local development binds loopback and allows first-admin setup without a bootstrap token; never publicly tunnel development mode.

Uploads require valid room authorization or administrator authentication. They are limited to one JPG/PNG/WebP, 8 MB and 25 megapixels, decoded/re-encoded to resized WebP, with metadata removed. One upload is processed at a time to bound memory on small servers. Busy uploads return a retryable 429. This is not DDoS protection or a guarantee that the smallest host handles every 200-person burst; use provider monitoring and upgrade as necessary.

## Maintenance, deletion and backups

Maintenance mode pauses participant APIs while preserving admin access and health checks. Closed rooms remain viewable but read-only; archived rooms reject participants. Permanent deletion requires archiving, typing the exact room title and password/MFA confirmation, then removes only that room's participants, entries, votes and photos. Audit rows remain. It is not reversible without a backup.

Make encrypted backups and test restores. Use the online SQLite backup script, keep the original master key separately, and avoid purges during a backup. Restore into an isolated environment with the same key and confirm counts, images, votes and administrator sign-in before replacing a live service. Sessions are excluded from backups, so users sign in again after restore. Set a company-approved retention deadline for live data, audit rows, backups and any provider snapshots.

## Validation limits

Automated tests cover the new room/admin flows, crypto reference vectors, takeover/replay attempts, room isolation, approvals/bans, concurrent voting, schedules, moderation, recovery, account revocation, CSV safety and guarded purge. Browser tests cover actual forms and responsive layouts using isolated fictional data. They do not establish provider compliance, verified identities, resistance to all attacks, or production capacity. Review the actual host, TLS, backups, logs and admission process before real employee use.
