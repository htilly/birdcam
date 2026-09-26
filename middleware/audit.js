const db = require('../db');

// Body keys that must never be written to the audit log (e.g. `password`,
// `rtsp_password`, `onvif_password`, `_csrf`, `session_secret`, `token`).
const SENSITIVE_KEY_RE = /pass|secret|token|csrf|credential|private/i;

function redactSecrets(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : redactSecrets(v, depth + 1);
  }
  return out;
}

function auditLog(action) {
  return (req, res, next) => {
    // Capture request details
    const userId = req.session?.userId;
    const username = req.session?.username;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const requestId = req.requestId; // Will be available after request ID middleware

    // Build details object
    const details = {
      method: req.method,
      path: req.path,
      params: req.params,
      // Don't log passwords/secrets
      body: action.includes('password') || action.includes('login') || action.includes('setup')
        ? '[REDACTED]'
        : redactSecrets(req.body)
    };

    // Log audit entry
    try {
      db.addAuditLog(
        userId,
        username,
        action,
        JSON.stringify(details),
        ipAddress,
        requestId
      );
    } catch (err) {
      console.error('Audit logging failed:', err);
      // Don't block request on audit failure
    }

    next();
  };
}

module.exports = { auditLog, redactSecrets };
