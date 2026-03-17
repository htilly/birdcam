const crypto = require('crypto');

function requestIdMiddleware(req, res, next) {
  // Use existing X-Request-ID header or generate new one
  const requestId = req.get('X-Request-ID') || crypto.randomUUID();

  // Attach to request object for use in other middleware/routes
  req.requestId = requestId;

  // Return in response headers for client tracing
  res.setHeader('X-Request-ID', requestId);

  next();
}

module.exports = { requestIdMiddleware };
