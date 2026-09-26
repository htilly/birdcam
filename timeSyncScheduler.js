const db = require('./db');
const onvif = require('./onvif');

const HOUR_MS = 60 * 60 * 1000;
const scheduledJobs = new Map(); // cameraId -> interval timer

function scheduleTimeSync(cameraId, intervalHours) {
  if (scheduledJobs.has(cameraId)) {
    clearInterval(scheduledJobs.get(cameraId));
    scheduledJobs.delete(cameraId);
  }

  intervalHours = Number(intervalHours) || 24;
  if (intervalHours < 1) intervalHours = 1;
  if (intervalHours > 168) intervalHours = 168;

  // setInterval rather than cron: cron "*/N" in the hour field only works for N < 24 dividing 24
  const timer = setInterval(() => {
    syncCameraTime(cameraId).catch((err) => {
      console.error(`[timeSync] Unexpected error syncing camera ${cameraId}:`, err.message);
    });
  }, intervalHours * HOUR_MS);
  if (typeof timer.unref === 'function') timer.unref();

  scheduledJobs.set(cameraId, timer);
  console.log(`[timeSync] Scheduled time sync for camera ${cameraId} every ${intervalHours} hours`);
}

function stopTimeSync(cameraId) {
  if (scheduledJobs.has(cameraId)) {
    clearInterval(scheduledJobs.get(cameraId));
    scheduledJobs.delete(cameraId);
    console.log(`[timeSync] Stopped time sync for camera ${cameraId}`);
  }
}

function stopAll() {
  for (const timer of scheduledJobs.values()) {
    clearInterval(timer);
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
