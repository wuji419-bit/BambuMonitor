export function hasCloudStatus(printer = {}) {
  return printer.statusSource === 'cloud'
    || printer.connectionMode === 'cloud'
    || ['cloud_overview', 'cloud_offline'].includes(printer.status);
}

export function hasPrinterLocalAddress(printer = {}) {
  return Boolean(printer.ip || printer.hasLocalAddress);
}

export function shouldPromptForPrinterIp(printer = {}) {
  if (hasCloudStatus(printer)) return false;
  if (printer.hasLocalAddress === true) return false;
  return !printer.ip || printer.status === 'no_ip';
}
