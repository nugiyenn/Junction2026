import 'server-only';

export interface OxylabsScrapeResult {
  url: string;
  statusCode: number;
  content: string;
  fetchedAt: string;
}

export async function fetchLiveWebData(targetUrl: string): Promise<OxylabsScrapeResult> {
  const username = process.env.OXYLABS_USERNAME;
  const password = process.env.OXYLABS_PASSWORD;

  if (!username || !password) {
    throw new Error('Missing OXYLABS_USERNAME or OXYLABS_PASSWORD');
  }

  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const response = await fetch('https://realtime.oxylabs.io/v1/queries', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      source: 'universal',
      url: targetUrl,
      render: 'html',
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Oxylabs error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const result = data.results?.[0];

  return {
    url: targetUrl,
    statusCode: result?.status_code ?? response.status,
    content: (result?.content ?? '').slice(0, 8000),
    fetchedAt: new Date().toISOString(),
  };
}