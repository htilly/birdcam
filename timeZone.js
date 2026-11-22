// Time zone helpers for camera time sync.
//
// Cameras get a fixed-offset POSIX TZ string (e.g. "CET-1" in winter, "CEST-2"
// in summer) instead of one with DST rules: cheap ONVIF cameras tend to ignore
// or mis-parse DST rules, so the scheduler re-syncs whenever the offset changes.

function serverTimeZone() {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The camera's configured zone, falling back to the server's zone.
function resolveTimeZone(tz) {
  if (isValidTimeZone(tz)) return tz;
  const server = serverTimeZone();
  return isValidTimeZone(server) ? server : 'UTC';
}

function listTimeZones() {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}

function tzPart(tz, date, locale, timeZoneName) {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value;
}

// Minutes east of UTC for tz at date (Stockholm: 60 in winter, 120 in summer).
function offsetMinutes(tz, date = new Date()) {
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(tzPart(tz, date, 'en-US', 'longOffset'));
  if (!m) return 0; // "GMT" alone means +00:00
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -mins : mins;
}

// POSIX TZ with a fixed offset, e.g. "CET-1", "CEST-2", "UTC-5:30", "UTC0".
// POSIX offsets are west-positive, so the sign is the inverse of UTC+X.
function posixFixedOffset(tz, date = new Date()) {
  const off = offsetMinutes(tz, date);
  const abbr = tzPart(tz, date, 'en-GB', 'short');
  const name = /^[A-Za-z]{3,6}$/.test(abbr) ? abbr : 'UTC';
  const abs = Math.abs(off);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  const sign = off > 0 ? '-' : '';
  return `${name}${sign}${hh}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
}

module.exports = {
  serverTimeZone,
  isValidTimeZone,
  resolveTimeZone,
  listTimeZones,
  offsetMinutes,
  posixFixedOffset,
};
