# Security review – Birdcam public app

This document summarizes a security review of the Birdcam web application (public viewer, admin, API, WebSocket, and recordings).

---

## 1. Authentication and session

| Area | Status | Notes |
|------|--------|------|
| Session secret | OK | From `SESSION_SECRET` env or generated and stored in DB; not hardcoded. |
| Session cookie | OK | `httpOnly: true`, `sameSite: 'lax'`, `secure` when behind proxy. |
| Admin auth | OK | All `/admin/*` state-changing routes use `requireLogin` and CSRF where applicable. |
| Password storage | OK | bcrypt used for admin passwords. |
| Login/setup rate limit | OK | Configurable rate limits on `/admin/login` and `/admin/setup`. |

**Recommendation:** Ensure `SESSION_SECRET` is set in production (e.g. via env) so the app does not rely on the DB-stored secret alone if the DB is ever restored from backup elsewhere.

---

## 2. CSRF and same-origin

| Area | Status | Notes |
|------|--------|------|
| Admin forms | OK | CSRF token in session; one token per page; `verifyCsrf` on POSTs. |
| JSON API (star/delete) | Mitigated | `/api/admin/snapshots/:id/star` and `:id/delete` now use `requireSameOriginApi`: reject if `Origin` header is set and not same-origin. Reduces CSRF from other sites; same-origin requests (e.g. from the public page when logged in) still work. |

**Note:** Browsers send cookies with same-origin `fetch(..., { credentials: 'include' })`. The Origin check blocks cross-origin POSTs that would carry the session cookie.

---

## 3. Input validation and injection

| Area | Status | Notes |
|------|--------|------|
| SQL | OK | All DB access uses parameterized queries (better-sqlite3 prepared statements). No raw string concatenation into SQL. |
| Chat (WebSocket) | OK | `sanitizeChat()` escapes `& < > " '` before broadcast; length limits (30 nick, 500 text). |
| Chat (client) | OK | Rendered with `escapeHtml()` before `innerHTML`. |
| Snapshot upload | OK | Base64 decoded; size cap (5 MB); regex for `data:image/png;base64,...`; PNG magic-byte check before saving. |
| Snapshot nickname/camera | OK | Truncated (30 / 60 chars) and stored; server never echoes raw into HTML. |
| Admin settings | OK | Numeric settings clamped (e.g. rate limits); `site_name` truncated. |
| Recordings `:key` | OK | DELETE `/api/recordings/stream/:key` validates key with `^pb-\d+-\d+$`. |

---

## 4. Path traversal and file access

| Area | Status | Notes |
|------|--------|------|
| Snapshot delete (server) | Fixed | Before deleting a snapshot file, `filename` is validated with `path.basename()` and rejection of `..`. |
| Snapshot delete (admin) | Fixed | Same validation in admin route. |
| Snapshot serve | OK | `express.static(snapshotDir)` serves only under `snapshotDir`; Express resolves `..` and keeps path inside root. |
| HLS serve | OK | `express.static(streamManager.hlsDir)`; playback keys are server-generated (`pb-{id}-{ts}`). |
| Snapshot write | OK | Filename is server-generated (`snap_${Date.now()}_${random}.png`). |

---

## 5. Headers and CSP

| Area | Status | Notes |
|------|--------|------|
| Helmet | OK | Helmet enabled with CSP. |
| CSP | OK | `defaultSrc 'self'`; script/style/font/img/connect/media scoped to self and known CDNs (e.g. jsdelivr, fonts). `'unsafe-inline'` for script/style is required by current admin inline scripts. |
| Trust proxy | OK | Only when `reverse_proxy` setting is true; avoids client IP spoofing when not behind a proxy. |

**Recommendation:** If you add more admin or public JS, consider moving to non-inline scripts and tightening CSP (e.g. drop `'unsafe-inline'` where possible).

---

## 6. Rate limiting

| Area | Status | Notes |
|------|--------|------|
| Login | OK | Configurable window and max attempts. |
| Setup | OK | Configurable. |
| Snapshots | OK | Per-IP limit (e.g. 6 per 60 s), configurable. |
| Chat (WS) | OK | Per-connection message rate (e.g. 5 per 1 s), configurable. |

**Gap:** There is no global API rate limit. A single IP can hit `/api/cameras`, `/api/visit`, `/api/snapshots`, etc. without a cap. For a small/private deployment this is often acceptable; for a more public one, consider a general rate limit (e.g. per IP) for `/api/*`.

---

## 7. Visitor cookie

| Area | Status | Notes |
|------|--------|------|
| Purpose | OK | Used only to count unique visitors; no PII. |
| httpOnly | Fixed | Set to `true` so the cookie is not readable by JS (reduces impact of XSS). |
| SameSite / Secure | OK | `lax` and `secure` when behind proxy. |

---

## 8. Body parsing and DoS

| Area | Status | Notes |
|------|--------|------|
| JSON limit | OK | Single `express.json({ limit: '10mb' })`; duplicate unbounded `express.json()` removed so all JSON routes share the 10 MB limit. |
| Snapshot size | OK | 5 MB cap enforced in handler. |

---

## 9. Dependencies

| Area | Status | Notes |
|------|--------|------|
| Stack | OK | express, better-sqlite3, ws, helmet, express-rate-limit, bcryptjs, etc. |
| Audit | Recommended | Run `npm audit` regularly and address high/critical issues; pin versions in production. |

---

## 10. Operational and deployment

| Area | Status | Notes |
|------|--------|------|
| Secrets | OK | No credentials in repo; admin and RTSP credentials from env or DB. |
| DB file | OK | SQLite under `data/`; ensure volume permissions and backups. |
| HTTPS | Recommended | Run behind TLS (e.g. nginx); `secure` cookie and CSP are correct when `reverse_proxy` is true. |

---

## Summary of code changes made in this review

1. **Duplicate `express.json()`** – Removed the second, unbounded `express.json()` so the 10 MB limit applies to all JSON bodies.
2. **Visitor cookie** – Set `httpOnly: true` so XSS cannot read the visitor ID.
3. **Same-origin for admin API** – Added `requireSameOriginApi` for `POST /api/admin/snapshots/:id/star` and `POST /api/admin/snapshots/:id/delete` to reject cross-origin requests.
4. **Snapshot path traversal** – When deleting a snapshot (server and admin), validate `filename` with `path.basename()` and reject `..`.
5. **Recordings stream key** – Validate `:key` with `^pb-\d+-\d+$` on DELETE `/api/recordings/stream/:key`.
6. **PNG upload** – Verify PNG magic bytes before saving snapshot files.

No functional change to normal use: same-origin requests (including the public page when an admin is logged in) continue to work; only clearly invalid or cross-origin abuse is blocked.
