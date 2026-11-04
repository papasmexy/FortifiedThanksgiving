# Security and privacy boundary

No application can be guaranteed "entirely secure." This is an implementation and test record, not an independent penetration test, compliance certification, or proof of a correctly configured live tenant/provider.

## Data flow

1. The employee's browser goes directly to `login.microsoftonline.com` for the configured **single tenant**. Microsoft/your organization's identity policies handle passwords, MFA, federation and Conditional Access. The site never collects Microsoft passwords.
2. Microsoft sends a short-lived authorization code back to the registered app callback. In production this is a form POST, not a query parameter in an access-log URL.
3. The app server exchanges the code directly with the pinned Microsoft token endpoint over HTTPS, with PKCE and a certificate-signed PS256 client assertion. The private key remains on the app host; Entra holds its public certificate. There is no third-party authentication broker or Microsoft Graph call.
4. The server validates the ID-token signature using Microsoft's signing keys plus issuer, audience, expiry and nonce. It enforces the configured tenant, a valid object ID, `acct=0` (member) and the assigned `Contest.Participant` app role.
5. The server derives a keyed HMAC of the tenant/object ID, retains only that contest ID and a generated alias, then discards tokens and claims. The browser receives an opaque HTTP-only session cookie, not Microsoft tokens or a raw Microsoft ID.

Microsoft claims exist briefly in server memory as part of sign-in. The hosting service terminates TLS and administers the underlying infrastructure. Therefore "all SSO exchanges remain only inside Microsoft" is **not** a possible claim for a website you host elsewhere. The actual trust boundary is Microsoft, the employee's browser, and the company-controlled hosting account/provider. To keep that infrastructure under company governance, use company Azure or an approved internal host.

## What is stored

- **Persistent app state:** keyed contest IDs, generated `Home cook …` aliases, entries, sanitized photos and votes. Session rows hold the contest ID/alias and CSRF state. Temporary pending-login state includes random state/nonce and a PKCE verifier, not Microsoft tokens.
- **Not persisted by the application:** employee names, email addresses, raw tenant/object/subject IDs, Microsoft ID/access/refresh tokens, passwords, directory profiles or group memberships. No tokens are sent to analytics, browser storage or third-party auth providers. No analytics/tracking dependencies are included.
- **Necessary configuration:** the tenant UUID, public client/application ID, issuer, public certificate thumbprint, private signing key and two independent random secrets must exist on the app host. The claim that the host stores no organizational information whatsoever would be false: it needs this configuration to select and authenticate with your tenant.
- **User content:** photos/titles/stories can identify people or company details. Re-encoding strips metadata but does not anonymize faces, visible names or written text. The UI warns users not to include those. Uploaded content requires company sign-in to view.
- **Provider metadata:** the host and Microsoft can retain IP addresses, infrastructure/security events and other metadata under their policies. The app does not control those retention rules. Verify them contractually/configurationally.

These contest identifiers are **pseudonymous personal data**, not mathematically anonymous. They deliberately link the same account across sessions to stop repeat voting. A party possessing the secret and matching directory IDs could recreate that link. Use the same privacy/access/retention controls you would apply to other employee-linked data.

## Entra administrator setup

1. Register a company-owned **single-tenant Web application**. Set `signInAudience` to `AzureADMyOrg`; do not use `common`, `organizations` or consumer endpoints. Configure only the exact owned HTTPS `/auth/callback`; no wildcard redirects. Use a separate registration for local tests rather than adding local redirects to the production app.
2. Disable implicit/hybrid token flows and public client flows. The app uses authorization code + PKCE with a confidential client. Remove default `User.Read`/Graph permissions if present. The only requested scopes are `openid profile`; `profile` supplies the immutable `oid` used for the contest ID. Returned display claims are ignored and discarded.
3. Define an enabled app role named `Contest.Participant`, value exactly `Contest.Participant`, allowed member type **Users/Groups** (`allowedMemberTypes: ["User"]` in the application manifest). Enable **Assignment required** in Enterprise Applications, then explicitly assign approved employees to this role. Group assignment/Conditional Access capabilities depend on your Entra licensing; individual assignment is an alternative where supported. Do not assign guest or secondary accounts.
4. Add the `acct` optional claim to **ID tokens**. The app refuses missing/guest account type. In the application manifest merge this into existing optional claims, preserving other settings: `{"optionalClaims":{"idToken":[{"name":"acct","source":null,"essential":true,"additionalProperties":[]}]}}`. Do not replace your whole manifest with this fragment. The app checks the claim even if the identity provider ignores `essential`.
5. Apply the company's MFA/Conditional Access requirements to this enterprise app. The application does not override tenant policy or infer MFA from a browser session. Enforce compliant devices/location restrictions if required. Only IT can establish that those live policies apply.
6. Create a dedicated RSA certificate/key pair of at least 2048 bits (3072 recommended). Keep the private key in the host's secure secret-file facility; upload only the public certificate to Entra. The app uses a PS256 assertion and `x5t#S256` base64url SHA-256 thumbprint, with the token endpoint as audience, following Microsoft's current guidance. Prefer an organization-issued certificate; a dedicated self-signed certificate is acceptable to Entra when explicitly registered. Never send its private key through chat or Git.
7. Compute the public thumbprint with `openssl x509 -in entra-cert.pem -outform DER | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '='`. This prints a public thumbprint, not a key. Configure `OIDC_PRIVATE_KEY_PATH` to the PEM private key and `OIDC_CERT_THUMBPRINT` to that thumbprint. Assign an owner and a certificate expiry/rotation reminder. No shared OIDC client password is used.
8. Set `OIDC_ISSUER=https://login.microsoftonline.com/TENANT_UUID/v2.0`, `OIDC_CLIENT_ID` to the registration's UUID, `BASE_URL` to the exact HTTPS origin and `NODE_ENV=production`. Generate independent random `SESSION_SECRET` and `IDENTITY_SECRET` values (at least 32 characters each; e.g. 32 random bytes encoded base64url). Keep a recoverable protected copy of IDENTITY_SECRET; changing it changes contest identities, so startup refuses a mismatch.

The private key is readable only by the runtime's service identity and authorized platform administrators. Do not enable a request/body logger, APM body capture, or error formatter that records sign-in requests/tokens. Application errors are deliberately generic and do not print underlying identity-provider messages.

## Implemented protections

- Strict single-tenant Microsoft issuer and endpoint origin; no user-controlled issuer/redirect/next URL.
- Explicit RS256 validation of Microsoft's ID-token signatures and PS256 certificate client authentication; library checks state, nonce, token audience/expiry and PKCE.
- Exact app-role/member checks rather than email-domain authorization. No Graph/directory-reading permission, email scope or offline access/refresh-token request.
- Session fixation protection through ID regeneration; Secure/HttpOnly/host-only production cookies; one-hour sessions. A temporary `SameSite=None; Secure` cookie supports Microsoft's cross-site POST callback; the regenerated authenticated cookie returns to `SameSite=Lax`.
- App CSRF tokens for mutations; the OIDC callback instead uses state+nonce+PKCE. Production rejects GET callbacks. No permissive CORS.
- Database transactions, uniqueness and a trigger enforce three votes and one vote per entry. Identity survives a session/browser change. An explicit startup check prevents accidentally changing identity keys or silently resetting legacy SSO voters.
- Sign-in and per-account API rate limits; one image upload/processing slot at a time; request/header timeouts. Size, type and decoded pixel limits; metadata removal and WebP re-encoding. Busy uploads ask the user to retry. This is not DDoS protection; provider controls and monitoring are still required.
- Same-origin resources, restrictive CSP, HSTS, no-referrer policy, no caching of private responses and no third-party fonts/tracking. Photos/API require authentication; `/healthz` exposes only readiness.
- Production refuses demo accounts, weak/missing secrets and insecure origin settings. Development binds loopback by default. Do not put public port-forwarding/tunnels in front of demo mode.

## Limits and required rollout checks

Authentication verifies accounts, not human uniqueness. Two valid assigned company accounts can receive two budgets; IT must control assignment and account provisioning. Removing a role does not immediately revoke an already issued local session: sessions last up to one hour. Local sign-out destroys the app session but does not sign the employee out of Microsoft or other company apps.

Test against the actual tenant: valid assigned member, unassigned member, guest, outside tenant, expired certificate, revoked assignment after session expiry, and your MFA/device policy. Inspect the live cookies, HTTPS redirection, access control for photos, provider logging, backup restoration and data-retention procedure. Automated tests use a locally simulated Microsoft issuer/keys, not Microsoft's real service. A security specialist should review the deployment if company policy requires it.

Legacy accounts created by the original email/name-based version are not deleted or automatically remapped. If real SSO data already exists, startup refuses the incompatible identity scheme until an explicit migration preserves its votes/submissions. Existing local demo data is preserved.

## Official guidance

- https://learn.microsoft.com/en-us/entra/identity-platform/security-best-practices-for-app-registration
- https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials
- https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation
- https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference
- https://github.com/panva/openid-client

Dependency audit during this change found vulnerable libvips-related components in the original sharp release. The dependency was upgraded to sharp 0.35.5; rerun `npm audit` on every release. A zero-advisory result only describes the advisory database at the time of the check.
