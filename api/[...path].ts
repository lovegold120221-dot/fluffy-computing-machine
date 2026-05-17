import { NextApiRequest, NextApiResponse } from 'next';
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
  const targetUrl = `${BACKEND_URL}/api/${path.join('/')}${url?.includes('?') ? url.substring(url.indexOf('?')) : ''}`;

  try {
    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

    const fetchHeaders: Record<string, string> = {};
    if (headers['content-type']) fetchHeaders['Content-Type'] = headers['content-type'] as string;
    if (headers['authorization']) fetchHeaders['Authorization'] = headers['authorization'] as string;

    const response = await fetch(targetUrl, {
      method: method || 'GET',
      headers: fetchHeaders,
      body: body.length > 0 ? body : undefined,
    });

    const data = await response.text();
    res.status(response.status).setHeader('Content-Type', response.headers.get('Content-Type') || 'application/json').send(data);
  } catch (err: any) {
    res.status(502).json({ error: 'Backend proxy error', message: err.message });
  }
}
