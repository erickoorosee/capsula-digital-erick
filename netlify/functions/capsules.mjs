import { getStore } from '@netlify/blobs';

const capsules = getStore('capsules', { consistency: 'strong' });
const media = getStore('capsule-media', { consistency: 'strong' });

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body)
});

const cleanSlug = value =>
  (value || crypto.randomUUID().slice(0, 8))
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || crypto.randomUUID().slice(0, 8);

export const handler = async event => {
  try {
    const method = event.httpMethod || 'GET';
    const path = (event.path || '').replace(/^\/.netlify\/functions\/capsules\/?/, '');
    const parts = path.split('/').filter(Boolean);

    if (method === 'POST' && parts[0] === 'upload') {
      const input = JSON.parse(event.body || '{}');
      const match = String(input.dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      if (!match) return json(400, { error: 'Imagen no válida' });

      const bytes = Buffer.from(match[2], 'base64');
      if (bytes.length > 4 * 1024 * 1024) return json(413, { error: 'La imagen es demasiado grande' });

      const ext = match[1] === 'image/png' ? 'png' : match[1] === 'image/webp' ? 'webp' : 'jpg';
      const key = `photo-${Date.now()}-${crypto.randomUUID()}.${ext}`;
      await media.set(key, bytes, { metadata: { contentType: match[1] } });
      return json(200, { url: `/api/capsules/media/${encodeURIComponent(key)}` });
    }

    if (method === 'GET' && parts[0] === 'media' && parts[1]) {
      const key = decodeURIComponent(parts.slice(1).join('/'));
      const entry = await media.getWithMetadata(key, { type: 'arrayBuffer' });
      if (!entry) return json(404, { error: 'Imagen no encontrada' });
      return {
        statusCode: 200,
        headers: {
          'content-type': entry.metadata?.contentType || 'image/jpeg',
          'cache-control': 'public, max-age=31536000, immutable'
        },
        isBase64Encoded: true,
        body: Buffer.from(entry.data).toString('base64')
      };
    }

    if (method === 'POST' && parts.length === 0) {
      const data = JSON.parse(event.body || '{}');
      const slug = cleanSlug(data.slug);
      data.slug = slug;
      data.photos = Array.isArray(data.photos) ? data.photos.slice(0, 8) : [];
      data.updatedAt = new Date().toISOString();
      await capsules.setJSON(`capsule-${slug}`, data);
      return json(200, { ok: true, slug });
    }

    if (method === 'GET' && parts[0]) {
      const data = await capsules.get(`capsule-${parts[0]}`, { type: 'json' });
      return data ? json(200, data) : json(404, { error: 'No encontrada' });
    }

    if (method === 'GET') {
      const { blobs } = await capsules.list({ prefix: 'capsule-' });
      const rows = [];
      for (const blob of blobs) {
        const data = await capsules.get(blob.key, { type: 'json' });
        if (data) rows.push(data);
      }
      return json(200, rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
    }

    return json(405, { error: 'Método no permitido' });
  } catch (error) {
    return json(500, { error: error.message });
  }
};
