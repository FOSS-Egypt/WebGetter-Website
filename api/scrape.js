const axios = require('axios');
const cheerio = require('cheerio');
const JSZip = require('jszip');
const { URL } = require('url');
const path = require('path');

const MAX_ASSETS = 40; // kept low: serverless functions have a time limit
const FETCH_TIMEOUT = 8000;
const USER_AGENT = 'Mozilla/5.0 (WebGetter-Web/1.0)';

function safeName(url) {
  const u = new URL(url);
  let name = u.pathname.split('/').filter(Boolean).pop() || 'index.html';
  if (!path.extname(name)) name += '.html';
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function fetchBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: FETCH_TIMEOUT,
    headers: { 'User-Agent': USER_AGENT },
    validateStatus: (s) => s < 400,
  });
  return res.data;
}

async function scrapeSite(targetUrl, mode, onProgress) {
  const base = new URL(targetUrl);
  const files = {};

  onProgress({ type: 'step', label: `fetching:${targetUrl}`, done: 0, total: 1 });
  const htmlBuf = await fetchBuffer(targetUrl);
  const html = htmlBuf.toString('utf8');
  files['index.html'] = Buffer.from(html, 'utf8');
  onProgress({ type: 'step', label: 'html:done', done: 1, total: 1 });

  if (mode !== 'full') return files;

  const $ = cheerio.load(html);
  const assetUrls = [];

  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) assetUrls.push({ url: href, kind: 'css' });
  });
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) assetUrls.push({ url: src, kind: 'js' });
  });
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) assetUrls.push({ url: src, kind: 'img' });
  });

  const seen = new Set();
  const toFetch = [];
  for (const asset of assetUrls) {
    if (toFetch.length >= MAX_ASSETS) break;
    let abs;
    try {
      abs = new URL(asset.url, base).href;
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    toFetch.push({ abs, kind: asset.kind });
  }

  const total = toFetch.length;
  onProgress({ type: 'total_assets', total });

  let done = 0;
  for (const { abs, kind } of toFetch) {
    try {
      const data = await fetchBuffer(abs);
      const folder = kind === 'css' ? 'css' : kind === 'js' ? 'js' : 'images';
      files[`${folder}/${safeName(abs)}`] = Buffer.from(data);
      done++;
      onProgress({ type: 'step', label: `asset:ok:${abs}`, done, total });
    } catch {
      done++;
      onProgress({ type: 'step', label: `asset:fail:${abs}`, done, total });
    }
  }

  return files;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try {
      body = JSON.parse(req.body || '{}');
    } catch {
      body = {};
    }
  }

  const targetUrl = body.url;
  const mode = body.mode === 'full' ? 'full' : 'basic';

  if (!targetUrl) {
    res.status(400).json({ error: 'Missing url' });
    return;
  }

  try {
    const parsed = new URL(targetUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('bad protocol');
  } catch {
    res.status(400).json({ error: 'Invalid URL — include http:// or https://' });
    return;
  }

  // Stream newline-delimited JSON: progress events, then one final event
  // carrying the base64-encoded zip. This lets the frontend show a real
  // progress bar instead of waiting on a single opaque response.
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  if (res.flushHeaders) res.flushHeaders();

  const write = (obj) => res.write(JSON.stringify(obj) + '\n');

  try {
    const files = await scrapeSite(targetUrl, mode, write);

    write({ type: 'zipping' });
    const zip = new JSZip();
    for (const [relPath, buf] of Object.entries(files)) {
      zip.file(relPath, buf);
    }
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    write({ type: 'done', zipBase64: zipBuf.toString('base64'), fileCount: Object.keys(files).length });
    res.end();
  } catch (err) {
    write({ type: 'error', error: err.message || 'Failed to fetch site' });
    res.end();
  }
};
