export const MINI_DEVICE_MIN_WIDTH = 190;

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function createMiniPage(inputDevices, availableWidth, requestedPage = 0) {
  const allDevices = Array.isArray(inputDevices) ? inputDevices : [];
  const width = Number(availableWidth);
  const rawCapacity = Number.isFinite(width) && width > 0
    ? Math.floor(width / MINI_DEVICE_MIN_WIDTH)
    : 1;
  const capacity = Math.max(
    1,
    Math.min(allDevices.length || 1, positiveInteger(rawCapacity, 1)),
  );
  const pageCount = Math.max(1, Math.ceil(allDevices.length / capacity));
  const requested = Math.trunc(Number(requestedPage)) || 0;
  const pageIndex = ((requested % pageCount) + pageCount) % pageCount;
  const start = pageIndex * capacity;

  return {
    capacity,
    pageCount,
    pageIndex,
    devices: allDevices.slice(start, start + capacity),
  };
}
