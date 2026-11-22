const db = require('./db');
const onvif = require('./onvif');

const HOUR_MS = 60 * 60 * 1000;
// Delay before the first sync after (re)scheduling, so streams/ONVIF are up first.
const INITIAL_SYNC_DELAY_MS = 60 * 1000;
const scheduledJobs = new Map(); // cameraId -> { initial, interval } timers

function clearJob(job) {
  clearTimeout(job.initial);
  clearInterval(job.interval);
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
  const job = {
    initial: setTimeout(run, INITIAL_SYNC_DELAY_MS),
    interval: setInterval(run, intervalHours * HOUR_MS),
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

async function syncCameraTime(cameraId) {
  const camera = db.getCamera(cameraId);
  if (!camera) {
    console.error(`[timeSync] Camera ${cameraId} not found`);
    return;
  }

  try {
    const host = camera.rtsp_host;
    const onvifCreds = db.getOnvifCredentials(camera);
    const cam = await onvif.createCam(host, onvifCreds.port, onvifCreds.username, onvifCreds.password);
    const beforeTime = await onvif.getSystemDateAndTime(cam);
    const serverTime = new Date();
    await onvif.setSystemDateAndTime(cam, serverTime);
    const fmt = (d) => d ? d.toLocaleString('sv-SE') : 'unknown';
    console.log(`[timeSync] Camera ${cameraId} (${camera.display_name}): synced ${fmt(beforeTime)} -> ${fmt(serverTime)}`);
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
  syncCameraTime,
  initializeFromDb,
  restartScheduler,
};
