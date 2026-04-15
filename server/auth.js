// ─────────────────────────────────────────────────────────────────────────────
// Auth helpers (session-transport-agnostic)
//
// Phase 2 adds role enforcement + first-user auto-promote. Phase 3 will
// replace the cookie invite-link with Microsoft SSO — the middleware below
// only reads req.currentUser, so no changes needed in call sites when that
// swap happens. Keep this file small and focused.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('./db');

/**
 * If there are no admin users yet, promote the given user to admin.
 * Returns true if a promotion happened.
 */
async function promoteToAdminIfFirstUser(userId) {
  if (!userId) return false;
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE role = 'admin')::int AS admin_count FROM users`
  );
  const adminCount = rows[0]?.admin_count ?? 0;
  if (adminCount === 0) {
    await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [userId]);
    console.log(`[auth] First user auto-promoted to admin: ${userId}`);
    return true;
  }
  return false;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

function requireUser(req, res, next) {
  if (!req.currentUser) return res.status(401).json({ error: 'Auth required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.currentUser) return res.status(401).json({ error: 'Auth required' });
  if (req.currentUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

function isAdmin(user) {
  return !!user && user.role === 'admin';
}

module.exports = {
  promoteToAdminIfFirstUser,
  requireUser,
  requireAdmin,
  isAdmin,
};
