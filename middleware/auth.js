const db = require('../db');

function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/admin/login');
  }

  // Re-validate user exists in database (security review fix)
  const user = db.getDb().prepare('SELECT id FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    // User was deleted - invalidate session
    req.session.destroy();
    return res.redirect('/admin/login?msg=Session+invalid');
  }

  next();
}

function requireSetup(req, res, next) {
  const hasUser = db.getDb().prepare('SELECT 1 FROM users LIMIT 1').get();
  if (!hasUser) return next();
  res.redirect('/admin');
}

function requireNoSetup(req, res, next) {
  const hasUser = db.getDb().prepare('SELECT 1 FROM users LIMIT 1').get();
  if (hasUser) return next();
  res.redirect('/admin/setup');
}

module.exports = { requireLogin, requireSetup, requireNoSetup };
