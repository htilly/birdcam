const db = require('../db');

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
        : req.body
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

module.exports = { auditLog };
