import { normalizeSerial } from './printerSync.js';

function getInventoryKeys(printer = {}) {
  return [printer.cloudId, printer.dev_id, printer.id]
    .map(normalizeSerial)
    .filter(Boolean);
}

function findCurrentPrinter(currentPrinters, syncedPrinter) {
  const syncedKeys = new Set(getInventoryKeys(syncedPrinter));
  return currentPrinters.find((printer) => (
    getInventoryKeys(printer).some((key) => syncedKeys.has(key))
  ));
}

function preferSyncedValue(currentValue, syncedValue) {
  return syncedValue !== undefined && syncedValue !== null && syncedValue !== ''
    ? syncedValue
    : currentValue;
}

export function reconcilePrinterInventory(currentPrinters = [], syncedPrinters = []) {
  return syncedPrinters.map((syncedPrinter) => {
    const currentPrinter = findCurrentPrinter(currentPrinters, syncedPrinter);
    if (!currentPrinter) return { ...syncedPrinter };

    const merged = { ...syncedPrinter, ...currentPrinter };
    const authoritativeFields = ['dev_id', 'cloudId', 'name', 'model', 'modelCode', 'accessCode', 'ip'];
    authoritativeFields.forEach((field) => {
      const value = preferSyncedValue(currentPrinter[field], syncedPrinter[field]);
      if (value === undefined) delete merged[field];
      else merged[field] = value;
    });

    if (syncedPrinter.cloudOnline !== undefined) {
      merged.cloudOnline = syncedPrinter.cloudOnline;
    }

    return merged;
  });
}

export function getRemovedPrinterIds(currentPrinters = [], syncedPrinters = []) {
  const syncedKeys = new Set(syncedPrinters.flatMap(getInventoryKeys));
  return currentPrinters
    .filter((printer) => !getInventoryKeys(printer).some((key) => syncedKeys.has(key)))
    .map((printer) => printer.dev_id)
    .filter(Boolean);
}
