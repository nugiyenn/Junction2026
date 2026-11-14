import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { namesProduct, recallNoticeUrls } from '../src/lib/evidence.ts';
import { runLiveChecks } from '../src/lib/live-checks.ts';
import { createOxylabs } from '../src/lib/oxylabs.ts';
import { recallQuery, runRecallCheck, type RecallDeps } from '../src/lib/recall-core.ts';
import type { Product, RecallCheck, Verification } from '../src/types/index.ts';

const NOTICE = 'https://www.ruokavirasto.fi/elintarvikkeet/ohjeita-kuluttajille/takaisinvedot-2023-/moussetuotteissa-epaily-metallinpaloista/';
const OTHER = 'https://www.ruokavirasto.fi/elintarvikkeet/ohjeita-kuluttajille/takaisinvedot-2023-/kananmunien-takaisinveto/';
const INDEX = 'https://www.ruokavirasto.fi/elintarvikkeet/ohjeita-kuluttajille/takaisinvedot/';

const MOUSSE_PAGE =
  '# Moussetuotteissa epäily metallinpaloista\n\nValio Oy on ilmoittanut poistavansa myynnistä varotoimenpiteenä useita eriä mousse-tuotteita. ' +
  'Tuotteet voivat sisältää metallinpaloja. '.repeat(8);
const EGG_PAGE = '# Kananmunien takaisinveto\n\nKananmunissa on todettu salmonellaa tuotantotilalla. '.repeat(6);

const product = (over: Partial<Product> = {}) =>
  ({
    id: 'p1',
    nameFi: 'Valio Profeel suklaamousse 150 g',
    nameEn: 'Valio Profeel chocolate mousse 150 g',
    brand: 'Valio',
    gtin: '6408430001234',
    ...over,
  }) as Product;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** The real Oxylabs client over a mocked transport: search and scrape answer from a script and every request is recorded. */
function oxylabsDeps(pages: Record<string, string | null>, searchUrls: string[]) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const client = createOxylabs({
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body as string);
      requests.push({ path, body });
      if (path === '/v1/search') {
        return json({ results: searchUrls.map((u, i) => ({ title: `Title ${i}`, url: u, outline: [], metadata: { position: i + 1 } })), metadata: { request_id: 'req-search-1' } });
      }
      const markdown = pages[body.url as string] ?? null;
      return json({ results: markdown === null ? [] : [{ url: body.url, markdown }], metadata: { request_id: `req-scrape-${requests.length}` } });
    }) as unknown as typeof fetch,
    sleep: async () => {},
    apiKey: () => 'test-dummy-key-not-real',
    log: () => {},
  });
  return { requests, search: client.search, read: client.readPage };
}

describe('recallNoticeUrls', () => {
  it('keeps individual Ruokavirasto notices, best-ranked first, and drops index, statistics and other sites', () => {
    const hits = [
      { url: INDEX },
      { url: 'https://www.ruokavirasto.fi/elintarvikkeet/elintarvikeala/poikkeustilanteet/takaisinveto/elintarvikkeiden-takaisinvetojen-maarat' },
      { url: 'https://www.como.fi/uutiset/tietyt-ihmiset-voivat-saada-vatsanvaanteita/' },
      { url: NOTICE },
      { url: OTHER },
      { url: NOTICE },
    ];
    assert.deepEqual(recallNoticeUrls(hits, 5), [NOTICE, OTHER]);
    assert.deepEqual(recallNoticeUrls(hits, 1), [NOTICE]);
  });
});

describe('namesProduct', () => {
  it('needs the brand and another word of the product, so a different Valio product is not a match', () => {
    assert.ok(namesProduct('Valio Oy on poistamassa myynnistä mousse-tuotteita', product()));
    assert.equal(namesProduct('Valio Oy on poistamassa myynnistä mousse-tuotteita', product({ nameFi: 'Valio Eila maitojuoma 1 l', nameEn: 'Valio Eila milk drink 1 l' })), false);
    assert.equal(namesProduct('Mousse-tuotteissa metallinpaloja', product({ brand: 'Fazer' })), false);
  });
  it('matches on the GTIN alone', () => {
    assert.ok(namesProduct('Tuote GTIN 6408430001234, eränumero 1', product()));
  });
  it('without a brand needs two distinctive words', () => {
    const p = product({ brand: null, nameFi: 'Kaurajuoma kahviin 2,5 dl', nameEn: null });
    assert.ok(namesProduct('Kaurajuoma kahviin -tuotteessa säilyvyysongelma', p));
    assert.equal(namesProduct('Kaurajuoma ilman muuta', p), false);
  });
});

describe('recallQuery', () => {
  it('searches Ruokavirasto with the brand and the first words of the Finnish name', () => {
    assert.equal(recallQuery(product()), 'site:ruokavirasto.fi takaisinveto Valio Profeel suklaamousse');
  });
});

describe('runRecallCheck (mocked Oxylabs and model)', () => {
  const extractWith = (recalls: { text: string; evidence: string }[]): RecallDeps['extract'] => async () => ({ recalls, model: 'stub-model' });

  it('keeps a match whose quote is on the page and names the product', async () => {
    const ox = oxylabsDeps({ [NOTICE]: MOUSSE_PAGE }, [INDEX, NOTICE]);
    const out = await runRecallCheck(product(), {
      ...ox,
      extract: extractWith([{ text: 'Metal pieces', evidence: 'Valio Oy on ilmoittanut poistavansa myynnistä varotoimenpiteenä useita eriä mousse-tuotteita.' }]),
    });
    assert.equal(out.status, 'match');
    assert.equal(out.matches[0].sourceUrl, NOTICE);
    assert.equal(out.searchRequestId, 'req-search-1');
    assert.deepEqual(ox.requests.map((r) => r.path), ['/v1/search', '/v1/scrape']);
    assert.equal(ox.requests[0].body.location, 'FI');
  });

  it('drops a quote the model invented, and one that does not name the product', async () => {
    const ox = oxylabsDeps({ [NOTICE]: MOUSSE_PAGE }, [NOTICE]);
    const out = await runRecallCheck(product(), {
      ...ox,
      extract: extractWith([
        { text: 'Invented', evidence: 'Valio Oy on poistanut suklaamousse-tuotteen listeria-epäilyn vuoksi.' },
        { text: 'Not about the product', evidence: 'Tuotteet voivat sisältää metallinpaloja.' },
      ]),
    });
    assert.equal(out.status, 'none_found');
    assert.deepEqual(out.matches, []);
  });

  it('none_found still records the query, request ids and the sources searched', async () => {
    const ox = oxylabsDeps({ [OTHER]: EGG_PAGE }, [INDEX, OTHER]);
    const out = await runRecallCheck(product(), { ...ox, extract: extractWith([]) });
    assert.equal(out.status, 'none_found');
    assert.equal(out.query, recallQuery(product()));
    assert.equal(out.searchRequestId, 'req-search-1');
    const read = out.sources.find((s) => s.url === OTHER);
    assert.ok(read?.readable && read.requestId?.startsWith('req-scrape'));
    assert.ok(out.sources.some((s) => s.url === INDEX && !s.readable));
  });

  it('is unreadable when notices were found but none could be read', async () => {
    const ox = oxylabsDeps({ [NOTICE]: null }, [NOTICE]);
    const out = await runRecallCheck(product(), { ...ox, extract: extractWith([]) });
    assert.equal(out.status, 'unreadable');
    assert.match(out.sources[0].note ?? '', /unreadable/);
  });

  it('a notice that has been removed (a rendered 404 page) is no live recall: none found, and the model is not asked', async () => {
    const gone = '404 - Ruokavirasto Etusivu 404 404 - Taisimme ajautua umpikujaan Sivua ei valitettavasti löytynyt. '.repeat(3);
    const ox = oxylabsDeps({ [NOTICE]: gone }, [NOTICE]);
    let called = false;
    const out = await runRecallCheck(product(), {
      ...ox,
      extract: async () => {
        called = true;
        return { recalls: [], model: 'x' };
      },
    });
    assert.equal(out.status, 'none_found');
    assert.match(out.summary, /1 removed/);
    assert.equal(called, false);
  });

  it('does not call the model when no notice page is found', async () => {
    const ox = oxylabsDeps({}, [INDEX]);
    let called = false;
    const out = await runRecallCheck(product(), {
      ...ox,
      extract: async () => {
        called = true;
        return { recalls: [], model: 'x' };
      },
    });
    assert.equal(out.status, 'none_found');
    assert.equal(called, false);
  });
});

describe('runLiveChecks', () => {
  const verification = { productId: 'p1', status: 'confirmed' } as Verification;
  const recall = { productId: 'p1', status: 'none_found' } as RecallCheck;
  const products = [product({ id: 'p1' }), product({ id: 'p2' }), product({ id: 'p3' })];
  const options = { budgetMs: 200, concurrency: 2 };

  it('returns every check and no notes when all succeed', async () => {
    const out = await runLiveChecks(products, { verify: async () => verification, recalls: async () => recall }, options);
    assert.equal(out.notes.length, 0);
    assert.ok(out.liveChecks.products.every((p) => p.verification && p.recall));
    assert.equal(out.liveChecks.budgetSeconds, 0.2);
  });

  it('a failing check becomes a visible note and does not stop the others', async () => {
    const out = await runLiveChecks(
      products,
      {
        verify: async (id) => {
          if (id === 'p2') throw new Error('Oxylabs: rate limit');
          return verification;
        },
        recalls: async () => recall,
      },
      options
    );
    assert.deepEqual(out.notes, ['Live check skipped for Valio Profeel chocolate mousse 150 g: Oxylabs: rate limit']);
    assert.equal(out.liveChecks.products[1].verification, null);
    assert.ok(out.liveChecks.products[1].recall);
  });

  it('a check that outlives the budget is reported as timed out, and later ones are not started', async () => {
    const started: string[] = [];
    const never = () => new Promise<never>(() => {});
    const out = await runLiveChecks(
      products,
      {
        verify: async (id) => {
          started.push(id);
          return never();
        },
        recalls: async () => recall,
      },
      { budgetMs: 50, concurrency: 1 }
    );
    assert.match(out.notes[0], /^Live check skipped for .*timed out/);
    // p2 and p3 verifications start after the budget is gone, so they are skipped without a call.
    assert.deepEqual(started, ['p1']);
    assert.equal(out.notes.length, products.length * 2);
  });

  it('runs at most `concurrency` checks at once', async () => {
    let active = 0;
    let peak = 0;
    const slow = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return verification;
    };
    await runLiveChecks(products, { verify: slow, recalls: async () => (await slow(), recall) }, { budgetMs: 2000, concurrency: 2 });
    assert.equal(peak, 2);
  });
});
