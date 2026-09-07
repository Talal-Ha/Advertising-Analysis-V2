import { put, list, del, get } from '@vercel/blob';

const PREFIX = 'reports/';
const MAX_FILE_BYTES = 3 * 1024 * 1024; // ~3MB raw file (base64 body stays under Vercel's 4.5MB limit)
const ALLOWED_EXT = /\.(xlsx|xls|csv)$/i;

// Older stores inject BLOB_READ_WRITE_TOKEN (possibly under a custom prefix);
// newer stores bind via BLOB_STORE_ID and the SDK authenticates on its own.
function getBlobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const key = Object.keys(process.env).find(k => k.endsWith('_READ_WRITE_TOKEN'));
  return key ? process.env[key] : undefined;
}

export default async function handler(req, res) {
  try {
    const token = getBlobToken();
    const auth = token ? { token } : {};

    // Download proxy — works for private stores where blob URLs need auth
    if (req.method === 'GET' && req.query?.file) {
      const pathname = String(req.query.file);
      if (!pathname.startsWith(PREFIX)) return res.status(400).json({ error: 'Invalid file path.' });
      let result = null;
      try {
        result = await get(pathname, { access: 'private', ...auth });
      } catch (e) {
        result = null;
      }
      if (!result || !result.blob) {
        // Public store fallback: redirect to the blob's public URL
        const { blobs } = await list({ prefix: pathname, limit: 1, ...auth });
        if (blobs.length) { res.setHeader('Cache-Control', 'no-store'); return res.redirect(302, blobs[0].url); }
        return res.status(404).json({ error: 'File not found.' });
      }
      const buf = Buffer.from(await result.blob.arrayBuffer());
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(buf);
    }

    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: PREFIX, limit: 500, ...auth });
      const reports = blobs
        .map(b => ({
          url: b.url,
          pathname: b.pathname,
          name: b.pathname.slice(PREFIX.length).replace(/^\d+-/, ''),
          size: b.size,
          uploadedAt: b.uploadedAt,
        }))
        .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      return res.status(200).json({ reports });
    }

    if (req.method === 'POST') {
      const { name, data } = req.body || {};
      if (!name || !data) return res.status(400).json({ error: 'Missing file name or data.' });
      if (!ALLOWED_EXT.test(name)) return res.status(400).json({ error: 'Only .xlsx, .xls and .csv files can be saved.' });

      const buffer = Buffer.from(data, 'base64');
      if (!buffer.length) return res.status(400).json({ error: 'Empty file.' });
      if (buffer.length > MAX_FILE_BYTES) return res.status(413).json({ error: 'File is too large to save (max 3 MB).' });

      const safeName = name.replace(/[^\w.\- ()]/g, '_').slice(0, 120);
      const key = `${PREFIX}${Date.now()}-${safeName}`;
      let blob;
      try {
        blob = await put(key, buffer, { access: 'public', addRandomSuffix: false, ...auth });
      } catch (e) {
        if (/private store|private access/i.test(e.message || '')) {
          blob = await put(key, buffer, { access: 'private', addRandomSuffix: false, ...auth });
        } else {
          throw e;
        }
      }
      return res.status(200).json({
        url: blob.url,
        pathname: blob.pathname,
        name: safeName,
      });
    }

    if (req.method === 'DELETE') {
      const pathname = req.query?.file;
      if (pathname) {
        if (!String(pathname).startsWith(PREFIX)) return res.status(400).json({ error: 'Invalid file path.' });
        await del(String(pathname), auth);
        return res.status(200).json({ ok: true });
      }
      const url = req.query?.url;
      if (!url) return res.status(400).json({ error: 'Missing file.' });
      // Only allow deleting blobs in the reports/ folder of this store
      if (!/\.blob\.vercel-storage\.com\//.test(url) || !url.includes('/' + PREFIX)) {
        return res.status(400).json({ error: 'Invalid report url.' });
      }
      await del(url, auth);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    const msg = err.message || 'Server error.';
    if (/token|credential|unauthoriz|forbidden|access/i.test(msg)) {
      return res.status(503).json({ error: 'Storage is not reachable: ' + msg });
    }
    return res.status(500).json({ error: msg });
  }
}
