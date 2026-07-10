const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function normalizePrinterAddress(value) { return String(value || '').trim(); }

export function isValidPrinterAddress(value) {
  const address = normalizePrinterAddress(value);
  if (!address || /[\s/?#]/.test(address)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return address.split('.').every((part) => Number(part) <= 255);
  if (address.includes(':')) {
    if (!/^[0-9a-f:]+$/i.test(address)) return false;
    try { return Boolean(new URL(`http://[${address}]`).hostname); } catch { return false; }
  }
  return address.length <= 253 && address.includes('.') && address.split('.').every((label) => HOST_LABEL.test(label));
}

export function cachePrinterAddress(cache, printer, address) {
  const next = { ...(cache || {}) };
  next[printer.cloudId || printer.dev_id] = address;
  next[printer.dev_id] = address;
  const nameKey = String(printer.name || '').trim().toLowerCase().replace(/\s+/g, '');
  if (nameKey) next[nameKey] = address;
  return next;
}
