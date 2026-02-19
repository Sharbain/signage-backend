# Backend Fix Checklist (Applied)

## Applied in this audited bundle
- [x] **Global API auth**: `/api/*` now requires JWT except allowlisted routes.
- [x] **Consistent `req.user`**: JWT middleware loads `{ id, email, role }` from DB.
- [x] **Removed dev auth bypass** in `requireRole`.
- [x] **Device token auth**: device endpoints require `Authorization: Device <token>` (or `X-Device-Token`).
- [x] **Provisioning token minted** on `/api/screens/register` and stored hashed in `screens.password`.
- [x] **Uploads no longer public**: `/uploads/*` requires either Bearer JWT or a valid device token.
- [x] **Protected Puppeteer screenshot endpoint**: `/api/webpage-screenshot` now requires `admin` role.
- [x] **DeviceId input validation** to prevent path traversal/abuse.

## Still recommended (next)
- [ ] Add DB foreign keys + indexes via migrations.
- [ ] Move uploads to object storage + signed URLs.
- [ ] Add per-route rate limits for Puppeteer and device upload endpoints.
- [ ] Implement a proper device provisioning/rotation flow (claim codes + token rotation endpoint).
- [ ] Multi-tenant scoping enforced for all queries (org_id everywhere).
