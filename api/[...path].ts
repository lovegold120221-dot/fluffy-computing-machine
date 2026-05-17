import type { VercelRequest, VercelResponse } from '@vercel/node';

const BACKEND_URL = process.env.BACKEND_URL || 'http://168.231.78.113:3000';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { method, url, headers } = req;
  const path = (req.query.path as string[]) || [];
  const queryString = url?.includes('?') ? url.substring(url.indexOf('?')) : '';
  const targetUrl = `${BACKEND_URL}/api/${path.join('/')}${queryString}`;

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    const fetchHeaders: Record<string, string> = {};
    if (headers['content-type']) fetchHeaders['Content-Type'] = headers['content-type'] as string;
    if (headers['authorization']) fetchHeaders['Authorization'] = headers['authorization'] as string;

    const response = await fetch(targetUrl, {
      method: method || 'GET',
      headers: fetchHeaders,
      body: body.length > 0 ? body : undefined,
    });

    const data = await response.text();
    res.status(response.status)
      .setHeader('Content-Type', response.headers.get('Content-Type') || 'application/json')
      .send(data);
  } catch (err: any) {
    res.status(502).json({ error: 'Backend proxy error', message: err.message });
  }
}
