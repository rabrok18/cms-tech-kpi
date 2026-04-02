// netlify/functions/github.js
// Proxies GitHub API calls using server-side env vars — token never exposed to browser

exports.handler = async function(event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const owner  = process.env.GH_OWNER;
  const repo   = process.env.GH_REPO;
  const token  = process.env.GH_TOKEN;
  const path   = process.env.GH_PATH  || 'data.json';
  const branch = process.env.GH_BRANCH || 'main';
  const siteUrl= process.env.SITE_URL  || '';

  if (!owner || !repo || !token) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Missing GitHub env vars. Set GH_OWNER, GH_REPO, GH_TOKEN in Netlify.' })
    };
  }

  const ghHeaders = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  // ── GET — fetch current data.json ────────────────────────────
  if (event.httpMethod === 'GET') {
    // Also return config so admin can populate fields
    const r = await fetch(`${apiBase}?ref=${branch}&t=${Date.now()}`, { headers: ghHeaders });
    if (!r.ok && r.status !== 404) {
      return { statusCode: r.status, headers: CORS, body: await r.text() };
    }
    const ghData = r.ok ? await r.json() : null;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        file: ghData,
        config: { owner, repo, branch, path, siteUrl }
      })
    };
  }

  // ── PUT — write data.json ─────────────────────────────────────
  if (event.httpMethod === 'PUT') {
    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

    const { content, sha, message } = body;
    if (!content) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing content' }) };

    // Fetch fresh SHA right before commit
    const freshR = await fetch(`${apiBase}?ref=${branch}&t=${Date.now()}`, { headers: ghHeaders });
    const freshSha = freshR.ok ? (await freshR.json()).sha : sha;

    const putBody = {
      message: message || `chore: update KPI data [${new Date().toISOString().slice(0,10)}]`,
      content,
      branch,
    };
    if (freshSha) putBody.sha = freshSha;

    const putR = await fetch(apiBase, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify(putBody),
    });

    const putData = await putR.json();

    // Retry once on SHA mismatch
    if (!putR.ok && (putData.message || '').includes('does not match')) {
      const retryR = await fetch(`${apiBase}?ref=${branch}&t=${Date.now()}`, { headers: ghHeaders });
      const retrySha = retryR.ok ? (await retryR.json()).sha : null;
      if (retrySha) putBody.sha = retrySha;
      const retryPut = await fetch(apiBase, {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify(putBody),
      });
      return { statusCode: retryPut.status, headers: CORS, body: await retryPut.text() };
    }

    return { statusCode: putR.status, headers: CORS, body: JSON.stringify(putData) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
