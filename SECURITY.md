# MONTÊ — Security Policy

## Scope

This policy covers the MONTÊ storefront, checkout, administrative panel, backend APIs, payment webhooks, Supabase integration, Cloudflare Worker deployment and CI/CD configuration.

## Security principles

- Never commit API keys, passwords, private keys, access tokens or service-role credentials.
- Treat all browser input as untrusted.
- Authorize sensitive operations on the server.
- Keep Supabase service-role credentials server-side only.
- Confirm payments with the payment provider before fulfilling orders.
- Keep webhook processing idempotent.
- Apply least privilege to database, storage and integrations.
- Do not expose customer data unless the requester is authorized.

## Secrets

Secrets must be stored in the hosting provider's secret/environment-variable facility, never in source code.

If a credential may have been exposed:
1. Rotate/revoke it immediately.
2. Review provider audit logs.
3. Remove exposed material from source/history where appropriate.
4. Deploy the replacement secret.
5. Verify old credentials no longer work.

Never paste secret values into issues, pull requests, logs or support messages.

## Dependency maintenance

- Keep backend/package-lock.json committed.
- Run npm ci for reproducible installs.
- Run npm audit before production releases.
- Review major-version updates for compatibility before merging.
- Dependabot monitors npm dependencies and GitHub Actions.

## Deploy security checklist

- [ ] Production secrets are configured only in the hosting platform.
- [ ] SUPABASE_SERVICE_ROLE_KEY is server-side only.
- [ ] Supabase RLS and policies have been reviewed.
- [ ] Admin authentication and authorization are working.
- [ ] Payment confirmation is provider-verified.
- [ ] Webhook processing is idempotent.
- [ ] Rate limits are active on sensitive/public-abuse endpoints.
- [ ] CORS allows only trusted origins.
- [ ] HTTPS/HSTS are active.
- [ ] Security headers are present.
- [ ] Production errors do not disclose secrets or stack traces.
- [ ] Git history contains no active credentials.
- [ ] Dependency/security checks pass.

## Reporting a vulnerability

Do not publish credentials or exploit details in a public issue. Provide the affected URL/endpoint/file, impact, severity, minimal reproduction steps, authentication requirements and evidence that no destructive action was performed.

Until a private security-reporting channel is configured, keep sensitive details private and contact the project owner directly.

## Credential rotation runbook

1. Identify the affected credential.
2. Revoke or rotate it at the provider.
3. Update the hosting secret.
4. Redeploy the affected service.
5. Test the integration.
6. Review recent logs/audit events for suspicious use.
7. Record the rotation without recording the secret value.
