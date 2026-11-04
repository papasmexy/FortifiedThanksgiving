# Hosting recommendation and deployment

Reviewed 2026-11-04 for about 200 employees in a seasonal contest. There is no universal "most secure and cheapest" provider: account governance, access controls, patching, backups, region, and the company's vendor policy determine the security boundary.

| Option | Cost basis in USD | Fit |
| --- | --- | --- |
| Existing company-managed server | Potentially $0 additional hosting; IT time, storage, backups and electricity still cost money | Best cost/control if IT already maintains a suitable HTTPS Node 24 host. Keep SQLite on local durable disk. A laptop is fine for local testing, not an unattended employee service. |
| **Render paid web service + disk** | **$7/month for 512 MB compute + $0.25/month for a 1 GB disk = $7.25/month base** | Lowest-cost managed option verified here for this unchanged single-instance SQLite architecture. Managed TLS, encrypted disks and snapshots. Use a company-owned account with MFA and only necessary members. |
| Company Azure subscription, Linux VM | East US B1s: $0.0104/hour ≈ $7.59/month; B1ms: $0.0207/hour ≈ $15.11/month, at 730 hours | Compute only: add managed disk, networking/public IP, backups and any support/monitoring costs. Better organizational ownership; more OS/TLS/backup administration. The 2 GB B1ms offers more memory headroom than Render Starter. Obtain an Azure calculator quote for the actual region and configuration. |

Render pricing assumes its $0 Hobby workspace and smallest paid compute; verify that current workspace terms meet company requirements. Extra bandwidth, workspace features, additional storage, taxes, custom-domain registration and future pricing changes can increase the bill. There is no load-test guarantee that the $7 server will meet a burst of 200 simultaneous employees. Image processing is serialized and busy uploads return a retryable 429; upgrade if production metrics require it.

Free static hosting/GitHub Pages cannot run this server. Free web instances without persistent disk are unsuitable for the voting database and uploaded photos. Do not put SQLite on an Azure Files/SMB/NFS share or run independent application replicas against independent disks. Serverless Azure hosting would require a storage/backend redesign, so its possible low consumption bill is not an apples-to-apples price for this version.

## Recommended low-cost deployment: Render

The checked-in `render.yaml` describes the paid service; it does not create or pay for anything by itself. No hosting account is connected to this cloud task, so nothing has been provisioned or deployed.

1. Use a **company-controlled Render account/workspace**, enable MFA, choose an approved data region and review its DPA, access/log retention and subprocessors. The template currently uses Ohio; change it before deployment if company policy requires another region. If third-party TLS termination/access is unacceptable, choose company Azure or an internal host instead.
2. Connect only `papasmexy/FortifiedThanksgiving` through Render's GitHub integration. Create a Blueprint using `render.yaml`. Review the $7 paid plan and 1 GB disk charge. Automatic deploys are disabled to keep releases intentional.
3. Configure the single-tenant Microsoft application following `SECURITY.md`. Obtain the service's actual HTTPS hostname from Render, then use that exact origin for `BASE_URL` and register its `/auth/callback` in Entra. If the first deploy runs before the final URL/key is configured, it must fail closed; finish configuration and redeploy. Never enable demo mode to bypass a deployment failure.
4. Set the prompted tenant-specific `OIDC_ISSUER`, public `OIDC_CLIENT_ID`, and certificate thumbprint. Add `entra-private-key.pem` as a **secret file** in the Render dashboard; its runtime path is `/etc/secrets/entra-private-key.pem`. Do not put the private key in Git, a chat message, a Blueprint value, or a build log. Upload only the matching public certificate to Entra.
5. Preserve Render's generated `SESSION_SECRET` and `IDENTITY_SECRET` in company-approved secret management. They must differ. **Do not regenerate IDENTITY_SECRET during a contest.** It keeps account IDs stable; startup refuses a changed identity key/tenant rather than resetting votes.
6. Verify `NODE_ENV=production`, no `DEMO_AUTH`, `DATA_DIR=/var/data`, exactly one instance and the disk attached. Runtime state belongs on `/var/data`; build/test state is temporary. The server binds the platform-provided `PORT`. Render terminates HTTPS; the Node port must not be exposed by any extra direct route.
7. Deploy. `/healthz` must return `{"ok":true}`. Test an assigned employee login, an unassigned employee, a guest and an outside tenant. Verify privacy data and three-vote enforcement using test accounts before uploading real employee content. Require HTTPS and review the live cookie attributes and security headers. Verify HTTP is redirected to HTTPS by the platform.
8. Review provider/proxy logging: disable body/header capture for `/auth/callback`; never export authorization headers, cookies, codes, tokens or form bodies. Application logs intentionally omit these. Production uses `form_post` to avoid codes in URL logs, but a TLS-terminating provider can still see traffic and keeps infrastructure metadata such as IPs. Do not represent this as zero data processing by the host.
9. Keep a verified backup of the SQLite database plus immutable photo files before releasing changes. Render's automatic disk snapshots provide another recovery layer; they are not a substitute for testing recovery. Use SQLite's online backup API or stop the app before copying the database and its WAL state. Store backups encrypted with restricted access. Restore only into an isolated environment and verify entries, photos and vote counts.
10. Have IT document the contest's retention deadline. At its end, revoke assignments and remove contest data/backups according to company policy through an explicit administrative procedure. The app deliberately has no automatic destructive reset.

The template has not been deployed or validated against Render's control plane because hosting credentials are unavailable. No real Entra tenant integration has been tested either. Local automated and browser checks exercise the app, not the hosting provider's configuration.

## Company Azure alternative

For greater control, use a company-managed Linux VM with encrypted local managed disk, corporate backup/monitoring, patching, managed administrative access and a hardened HTTPS reverse proxy. Restrict inbound rules to the approved employee network/VPN if practical; never expose SQLite or Node directly. Use a company-owned DNS name and TLS certificate, a non-root service account, restrictive secret-file permissions, and only one trusted proxy hop (the app's current proxy configuration). Prefer existing company-managed infrastructure over a new one-off VM when possible.

Azure identity and a subscription are not connected to this task. A secure Azure deployment needs an approved region/network/domain and administrator access; it has not been provisioned. A Microsoft-hosted VM is still application infrastructure: tokens reach your app, not only the Microsoft login service.

## Official sources

- Render compute, disk and workspace pricing: https://render.com/pricing
- Render disks, snapshots and encryption: https://render.com/docs/disks
- Render logging and retention: https://render.com/docs/logging
- Render Blueprint fields: https://render.com/docs/blueprint-spec
- Azure Linux VM pricing: https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/
- Live Azure retail price API used for East US Linux B-series rates: https://prices.azure.com/api/retail/prices

Rates are observations on the review date, not a guarantee or fixed quote. Azure price evidence was fetched from Microsoft's public retail API; Render prices were read from its official pricing page.
