export async function mapWithConcurrency(items = [], limit = 1, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (typeof worker !== 'function') throw new TypeError('worker must be a function');

  const concurrency = Math.max(1, Math.min(items.length, Math.floor(Number(limit)) || 1));
  const results = new Array(items.length);
  let cursor = 0;

  const runNext = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runNext()));
  return results;
}
