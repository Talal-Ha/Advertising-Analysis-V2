import { put, list, del } from '@vercel/blob';

const PREFIX = 'reports/';
const MAX_FILE_BYTES = 3 * 1024 * 1024; // ~3MB raw file (base64 body stays under Vercel's 4.5MB limit)
const ALLOWED_EXT = /\.(xlsx|xls|csv)$/i;

// The token is BLOB_READ_WRITE_TOKEN by default, but a custom env-var prefix
// chosen when connecting the store changes the name — accept any match.
function getBlobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const key = Object.keys(process.env).find(k => k.endsWith('_READ_WRITE_TOKEN'));
  return key ? process.env[key] : null;
}

export default async function handler(req, res) {
  try {
    const token = getBlobToken();
    if (!token) {
      return res.status(503).json({ error: 'Storage is not configured yet. Connect a Blob store to this project in the Vercel dashboard.' });
    }

    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: PREFIX, limit: 500, token });
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
      const blob = await put(`${PREFIX}${Date.now()}-${safeName}`, buffer, {
        access: 'public',
        addRandomSuffix: false,
        token,
      });
      return res.status(200).json({
        url: blob.url,
        pathname: blob.pathname,
        name: safeName,
      });
    }

    if (req.method === 'DELETE') {
      const url = req.query?.url;
      if (!url) return res.status(400).json({ error: 'Missing url.' });
      // Only allow deleting blobs in the reports/ folder of this store
      if (!/\.blob\.vercel-storage\.com\//.test(url) || !url.includes('/' + PREFIX)) {
        return res.status(400).json({ error: 'Invalid report url.' });
      }
      await del(url, { token });
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error.' });
  }
}
