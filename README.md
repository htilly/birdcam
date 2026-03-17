# Birdcam Live

![Birdcam Live](public/logo.png)

A single-Docker web app to view RTSP birdcam streams in the browser, with a kid-friendly UI and a chat sidebar. Admin portal (login required) lets you add multiple cameras with URL, username, and password. Try it live: https://bird.slowtv.nu/

## Live example

- https://bird.slowtv.nu/

## Quick start

1. **With Docker (local clone)**
   ```bash
   docker compose up -d
   ```
   Open http://localhost:3000 for the viewer, http://localhost:3000/admin for the admin portal.

2. **With Docker (build directly from GitHub, no clone)**
   ```bash
   docker compose -f docker-compose.github.yml up -d
   ```
   Uses [htilly/birdcam](https://github.com/htilly/birdcam) as the build context.

3. **First-time setup**
   - Go to http://localhost:3000/admin. You’ll be asked to create the first admin account (username + password).
   - After login, add a camera: display name and full RTSP URL (e.g. `rtsp://user:password@172.16.205.186:554/stream1`).
   - The public page will list cameras; pick one to watch and use the chat on the right.

4. **Optional: create admin via env**
   - In `docker-compose.yml`, set `ADMIN_USER` and `ADMIN_PASSWORD` (and optionally `SESSION_SECRET`), then run. The first admin is created on startup if the DB has no users.

## Local development (no Docker)

```bash
npm install
# Create data dir and optionally .env (ADMIN_USER, ADMIN_PASSWORD)
npm start
```

Requires Node 18+ and FFmpeg on your PATH.

## Project layout

- `server.js` – Express app, static files, `/hls`, `/api/cameras`, WebSocket chat, admin routes
- `db.js` – SQLite (users, cameras)
- `streamManager.js` – One FFmpeg process per camera → HLS in `hls/`
- `routes/admin.js` – Login, setup, camera CRUD
- `public/` – Viewer UI (video + camera tabs + chat)
- `public/admin/` – Admin styles

## Data

- SQLite file: `data/birdcam.db` (persisted via Docker volume `birdcam-data`).
- Camera credentials are stored in the DB; only admins can see or edit them.
