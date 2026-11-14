import type { LiveChecks, LiveCheckedProduct, Product, RecallCheck, Verification } from '../types/index.ts';

// Runs the live-web checks for the products an offer would order: with a time budget, limited concurrency, and a
// failure or timeout that never fails the request but is reported by name. Pure apart from the injected checks,
// so tests can drive it with fakes. request.ts wires in verifyProduct and checkRecalls.

export interface LiveCheckDeps {
  verify: (productId: string) => Promise<Verification>;
  recalls: (product: Product) => Promise<RecallCheck>;
}

export async function runLiveChecks(
  products: Product[],
  deps: LiveCheckDeps,
  options: { budgetMs: number; concurrency: number }
): Promise<{ liveChecks: LiveChecks; notes: string[] }> {
  const deadline = Date.now() + options.budgetMs;
  const results: LiveCheckedProduct[] = products.map((p) => ({
    productId: p.id,
    name: p.nameEn ?? p.nameFi,
    verification: null,
    recall: null,
    skipped: [],
  }));

  /** Runs one check; a timeout or error is recorded on the product instead of thrown. */
  async function attempt<T>(label: string, into: LiveCheckedProduct, run: () => Promise<T>): Promise<T | null> {
    const fail = (reason: string) => {
      into.skipped.push(`${label} skipped for ${into.name}: ${reason}`);
      return null;
    };
    const left = deadline - Date.now();
    if (left <= 0) return fail(`the ${options.budgetMs / 1000} s time budget was used up`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after the ${options.budgetMs / 1000} s time budget`)), left);
        }),
      ]);
    } catch (err) {
      return fail((err instanceof Error ? err.message : String(err)).slice(0, 160));
    } finally {
      clearTimeout(timer);
    }
  }

  const jobs: (() => Promise<void>)[] = products.flatMap((product, i) => [
    async () => void (results[i].verification = await attempt('Live check', results[i], () => deps.verify(product.id))),
    async () => void (results[i].recall = await attempt('Recall check', results[i], () => deps.recalls(product))),
  ]);
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: options.concurrency }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await job();
    })
  );

  return { liveChecks: { products: results, budgetSeconds: options.budgetMs / 1000 }, notes: results.flatMap((r) => r.skipped) };
}
