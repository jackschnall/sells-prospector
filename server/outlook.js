// ─────────────────────────────────────────────────────────────────────────────
// Outlook Calendar Integration Stub
//
// Returns safe defaults when not configured. Once Microsoft Graph credentials
// are set via env vars, swap in real OAuth2 + Graph API calls.
// ─────────────────────────────────────────────────────────────────────────────

function isConfigured() {
  return !!(
    process.env.OUTLOOK_CLIENT_ID &&
    process.env.OUTLOOK_CLIENT_SECRET &&
    process.env.OUTLOOK_TENANT_ID
  );
}

function getAuthUrl() {
  return null;
}

async function handleCallback(/* code */) {
  return { ok: false, error: 'Outlook not configured' };
}

async function getCalendarEvents(/* accessToken, start, end */) {
  return [];
}

async function createEvent(/* accessToken, event */) {
  return { ok: false, error: 'Outlook not configured' };
}

// ─── Express routes ─────────────────────────────────────────────────────────

function registerOutlookRoutes(app) {
  app.get('/api/outlook/status', (req, res) => {
    res.json({
      configured: isConfigured(),
      connected: false,
    });
  });

  app.get('/api/outlook/auth', (req, res) => {
    const url = getAuthUrl();
    if (!url) return res.status(503).json({ error: 'Outlook not configured' });
    res.redirect(url);
  });

  app.get('/api/outlook/callback', async (req, res) => {
    const result = await handleCallback(req.query.code);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  app.get('/api/outlook/events', async (req, res) => {
    if (!isConfigured()) return res.json({ events: [], configured: false });
    const events = await getCalendarEvents();
    res.json({ events });
  });
}

module.exports = {
  isConfigured,
  getAuthUrl,
  handleCallback,
  getCalendarEvents,
  createEvent,
  registerOutlookRoutes,
};
