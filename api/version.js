function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength || 120);
}

function getBuildId() {
  return [
    process.env.VERCEL_DEPLOYMENT_ID,
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.VERCEL_URL,
    process.env.npm_package_version,
    'development',
  ].map((value) => normalizeText(value, 120)).find(Boolean) || 'development';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  return res.status(200).json({
    buildId: getBuildId(),
    deploymentUrl: normalizeText(process.env.VERCEL_URL, 160),
  });
};