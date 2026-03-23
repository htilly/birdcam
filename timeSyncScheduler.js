const cron = require('node-cron');
const db = require('./db');
const onvif = require('./onvif');

const scheduledJobs = new Map();

function scheduleTimeSync(cameraId, intervalHours) {
  if (scheduledJobs.has(cameraId)) {
    scheduledJobs.get(cameraId).stop();
    scheduledJobs.delete(cameraId);
  }

  if (intervalHours < 1) intervalHours = 1;
  if (intervalHours > 168) intervalHours = 168;

  const cronExpression = `0 */${intervalHours} * * *`;

  const job = cron.schedule(cronExpression, async () => {
    await syncCameraTime(cameraId);
  }, {
    scheduled: true,
    timezone: 'UTC'
  });

  scheduledJobs.set(cameraId, job);
  console.log(`[timeSync] Scheduled time sync for camera ${cameraId} every ${intervalHours} hours`);
}

function stopTimeSync(cameraId) {
  if (scheduledJobs.has(cameraId)) {
    scheduledJobs.get(cameraId).stop();
    scheduledJobs.delete(cameraId);
    console.log(`[timeSync] Stopped time sync for camera ${cameraId}`);
  }
}

function stopAll() {
  for (const [cameraId, job] of scheduledJobs) {
    job.stop();
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
