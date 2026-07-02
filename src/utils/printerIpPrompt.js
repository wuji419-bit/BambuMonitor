export function hasCloudStatus(printer = {}) {
  return printer.statusSource === 'cloud'
    || printer.connectionMode === 'cloud'
    || ['cloud_overview', 'cloud_offline'].includes(printer.status);
}

export function shouldPromptForPrinterIp(printer = {}) {
  if (hasCloudStatus(printer)) return false;
  return !printer.ip || printer.status === 'no_ip';
}
