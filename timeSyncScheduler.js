const db = require('./db');
const onvif = require('./onvif');
const timeZone = require('./timeZone');

const HOUR_MS = 60 * 60 * 1000;
// Delay before the first sync after (re)scheduling, so streams/ONVIF are up first.
const INITIAL_SYNC_DELAY_MS = 60 * 1000;
// How often to check whether the camera's UTC offset changed (DST switch).
const OFFSET_CHECK_MS = 60 * 60 * 1000;
const scheduledJobs = new Map(); // cameraId -> { initial, interval, offsetCheck } timers
const lastSyncedOffset = new Map(); // cameraId -> UTC offset (minutes) sent at last sync

function clearJob(job) {
  clearTimeout(job.initial);
  clearInterval(job.interval);
  clearInterval(job.offsetCheck);
}

function scheduleTimeSync(cameraId, intervalHours) {
  if (scheduledJobs.has(cameraId)) {
    clearJob(scheduledJobs.get(cameraId));
    scheduledJobs.delete(cameraId);
  }

  intervalHours = Number(intervalHours) || 24;
  if (intervalHours < 1) intervalHours = 1;
  if (intervalHours > 168) intervalHours = 168;

  const run = () => {
    syncCameraTime(cameraId).catch((err) => {
      console.error(`[timeSync] Unexpected error syncing camera ${cameraId}:`, err.message);
    });
  };

  // Sync shortly after start too: the container is redeployed often, and an
  // interval-only timer restarts from zero each time, so it may never fire.
  // setInterval rather than cron: cron "*/N" in the hour field only works for N < 24 dividing 24
  // Re-sync as soon as the zone's offset changes (summer/winter time), since the
  // camera gets a fixed offset rather than DST rules.
  const checkOffset = () => {
    if (!lastSyncedOffset.has(cameraId)) return;
    const camera = db.getCamera(cameraId);
    if (!camera) return;
    const tz = timeZone.resolveTimeZone(camera.time_zone);
    const offset = timeZone.offsetMinutes(tz);
    if (offset !== lastSyncedOffset.get(cameraId)) {
      // Record now so later checks don't start another sync while this one runs;
      // if it fails, the regular interval retries.
      lastSyncedOffset.set(cameraId, offset);
      console.log(`[timeSync] UTC offset changed for camera ${cameraId} (${tz}), re-syncing`);
      run();
    }
  };

  const job = {
    initial: setTimeout(run, INITIAL_SYNC_DELAY_MS),
    interval: setInterval(run, intervalHours * HOUR_MS),
    offsetCheck: setInterval(checkOffset, OFFSET_CHECK_MS),
  };
  for (const t of Object.values(job)) {
    if (typeof t.unref === 'function') t.unref();
  }

  scheduledJobs.set(cameraId, job);
  console.log(`[timeSync] Scheduled time sync for camera ${cameraId} every ${intervalHours} hours (first sync in ${INITIAL_SYNC_DELAY_MS / 1000}s)`);
}

function stopTimeSync(cameraId) {
  if (scheduledJobs.has(cameraId)) {
    clearJob(scheduledJobs.get(cameraId));
    scheduledJobs.delete(cameraId);
    console.log(`[timeSync] Stopped time sync for camera ${cameraId}`);
  }
}

function stopAll() {
  for (const job of scheduledJobs.values()) {
    clearJob(job);
  }
  scheduledJobs.clear();
  console.log('[timeSync] Stopped all time sync jobs');
}

// Sets the camera clock to server time and its time zone to the camera's
// configured zone (or the server's). Throws on failure; returns what was set.
async function performTimeSync(camera) {
  const onvifCreds = db.getOnvifCredentials(camera);
  const cam = await onvif.createCam(camera.rtsp_host, onvifCreds.port, onvifCreds.username, onvifCreds.password);
  const beforeTime = await onvif.getSystemDateAndTime(cam);
  const serverTime = new Date();
  const tz = timeZone.resolveTimeZone(camera.time_zone);
  const posixTz = timeZone.posixFixedOffset(tz, serverTime);
  await onvif.setSystemDateAndTime(cam, serverTime, posixTz);
  lastSyncedOffset.set(camera.id, timeZone.offsetMinutes(tz, serverTime));
  return { beforeTime, serverTime, tz, posixTz };
}

async function syncCameraTime(cameraId) {
  const camera = db.getCamera(cameraId);
  if (!camera) {
    console.error(`[timeSync] Camera ${cameraId} not found`);
    return;
  }

  try {
    const { beforeTime, serverTime, tz, posixTz } = await performTimeSync(camera);
    const fmt = (d) => d ? d.toISOString() : 'unknown';
    console.log(`[timeSync] Camera ${cameraId} (${camera.display_name}): synced ${fmt(beforeTime)} -> ${fmt(serverTime)}, zone ${tz} (${posixTz})`);
  } catch (err) {
    console.error(`[timeSync] Failed to sync time for camera ${cameraId} (${camera.display_name}):`, err.message);
  }
}

function initializeFromDb() {
  const cameras = db.getCamerasWithTimeSyncEnabled();
  for (const camera of cameras) {
    const intervalHours = camera.time_sync_interval_hours || 24;
    scheduleTimeSync(camera.id, intervalHours);
  }
  console.log(`[timeSync] Initialized ${cameras.length} scheduled time sync job(s)`);
}

function restartScheduler(cameraId) {
  const camera = db.getCamera(cameraId);
  if (!camera) {
    stopTimeSync(cameraId);
    return;
  }

  if (camera.time_sync_enabled) {
    const intervalHours = camera.time_sync_interval_hours || 24;
    scheduleTimeSync(cameraId, intervalHours);
  } else {
    stopTimeSync(cameraId);
  }
}

module.exports = {
  scheduleTimeSync,
  stopTimeSync,
  stopAll,
  performTimeSync,
  syncCameraTime,
  initializeFromDb,
  restartScheduler,
};
