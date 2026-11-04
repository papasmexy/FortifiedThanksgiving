# Low-cost hosting and deployment

For about 200 seasonal participants, the recommended managed option remains **Render's smallest paid Node server plus a persistent disk**. Pricing checked on November 4, 2026: $7/month for 512 MB compute plus $0.25/month for a 1 GB disk, or **$7.25/month base**. Verify current pricing/terms before purchase; workspace upgrades, bandwidth, extra storage, taxes and domain costs may add charges.

An existing company-managed HTTPS host may have $0 incremental hosting cost and stronger organizational control. A company Azure Linux VM is another option: the verified East US compute-only rates were $0.0104/hour for B1s (about $7.59 at 730 hours) and $0.0207/hour for B1ms (about $15.11), plus disk, networking/IP, backups and administration. A 2 GB VM offers more memory headroom than the smallest Render service. These are not fixed quotes or an exhaustive cheapest-provider ranking.

The application now uses **room access codes and independent admin accounts, not Microsoft SSO**. No Entra app registration, tenant/client ID, certificate or external identity exchange is required.

## Render steps

1. Use a company-controlled account/workspace with MFA and only necessary administrators. Review the provider's data region, privacy contract, encryption, retention and infrastructure logging.
2. Connect only this GitHub repository and create a Blueprint from render.yaml. Review the paid Starter plan and disk. Auto-deploy is disabled so releases remain intentional.
3. Set BASE_URL to the service's actual HTTPS origin. The Blueprint generates three independent secrets: SESSION_SECRET, ADMIN_ENCRYPTION_KEY and ADMIN_SETUP_TOKEN. Keep protected recoverable copies of the admin encryption key and session secret; never paste them into chat or Git.
4. Mount the 1 GB disk at /var/data and keep DATA_DIR=/var/data, NODE_ENV=production and one application instance. Do not set OIDC/SSO variables; remove obsolete ones from any prior host. The service listens on the platform PORT behind exactly one trusted HTTPS proxy.
5. If the first deploy occurs before the actual BASE_URL is entered, finish the configuration and redeploy. The service must fail closed for missing security settings; do not use development mode as a workaround.
6. Open /admin on the deployed HTTPS site. Retrieve ADMIN_SETUP_TOKEN from the secure hosting dashboard, create the first administrator, and configure a TOTP authenticator. Verify your login works, then remove the setup token from the host. Invite your second admin privately from the administrator area; they choose their own password/authenticator.
7. Create the competition room, choose/save its shared code, keep approval enabled and distribute the room link/code privately. Test with fictional names first: approve a participant, submit a photo, vote, recover access and confirm the balance remains. Verify a pending/banned participant cannot view photos or vote and a different room cannot access this one.
8. Confirm HTTPS redirection, Secure/HttpOnly/SameSite cookies, blocked framing, CSRF and admin separation in the actual deployment. Disable request-body/header capture and keep form credentials out of logs/APM. The app uses no third-party analytics.
9. Verify backup and operator recovery through the host's protected shell. See README for npm run backup and npm run admin:recover. Downloaded results CSV is an oversight export, not a full backup. Test restoration separately; do not delete live data to test it.
10. Set a retention plan. Archive the room after the competition. Permanent purge is available only with explicit title/password/MFA confirmation; make a backup first and decide when backups/snapshots/audit data must also expire.

The template parses and local application tests run, but no Render account/control plane is connected and no paid resources or live deployment have been created here. A deployment API credential can be supplied securely through the optional RENDER_API_KEY environment requirement if you want the agent to provision through the provider API. Never paste API tokens into chat.

## Operational limits

Use one instance and durable local SQLite-compatible storage. Free static hosting cannot run this server; ephemeral free web disks lose contest state. Do not use SMB/NFS shares or independent replicas for the SQLite file. Image processing is serialized and can ask concurrent uploaders to retry. The smallest plan is a cost starting point, not a verified 200-simultaneous-user capacity guarantee.

Keep the admin encryption key stable. It protects both encrypted MFA secrets and keyed hashes of room/member/invitation codes. Startup refuses a changed key rather than silently breaking sign-in and competition identity. Provider administrators with filesystem/secrets access remain inside the trust boundary.

The new database is /var/data/rooms.sqlite with room-uploads alongside it. Existing app.sqlite/old uploads are not deleted or automatically imported; the previous local database was empty. On a brand-new Render disk the new app starts empty and needs first-admin enrollment.

## Sources

- https://render.com/pricing
- https://render.com/docs/disks
- https://render.com/docs/blueprint-spec
- https://render.com/docs/logging
- https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/
- https://prices.azure.com/api/retail/prices

A secure host does not make a shared code equivalent to identity verification. Read SECURITY.md for the admission and fairness boundary.
