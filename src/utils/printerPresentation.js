const JOB_STATUSES = new Set([
  'printing',
  'paused',
  'drying',
  'preparing',
  'idle',
  'finished',
  'error',
]);

const CONNECTION_STATES = new Set([
  'connecting',
  'online',
  'reconnecting',
  'offline',
  'error',
]);

export function getPrinterJobStatus(printer = {}) {
  if (JOB_STATUSES.has(printer.jobStatus)) return printer.jobStatus;
  if (JOB_STATUSES.has(printer.status)) return printer.status;
  if (JOB_STATUSES.has(printer.lastJobStatus)) return printer.lastJobStatus;
  return '';
}

export function getPrinterConnectionState(printer = {}) {
  if (CONNECTION_STATES.has(printer.connectionState)) return printer.connectionState;
  if (printer.cloudOnline === false) return 'offline';

  if (['disconnected', 'cloud_offline'].includes(printer.status)) return 'offline';
  if (printer.status === 'error') return 'error';
  if (printer.status === 'connecting') return 'connecting';

  return printer.status || printer.cloudOnline === true ? 'online' : 'connecting';
}

export function getPrinterSummary(printers = []) {
  const summary = {
    total: printers.length,
    online: 0,
    printing: 0,
    reconnecting: 0,
    attention: 0,
  };

  printers.forEach((printer) => {
    const connectionState = getPrinterConnectionState(printer);
    const jobStatus = getPrinterJobStatus(printer);

    if (connectionState === 'online') summary.online += 1;
    if (jobStatus === 'printing') summary.printing += 1;
    if (connectionState === 'reconnecting') summary.reconnecting += 1;
    if (
      ['reconnecting', 'offline', 'error'].includes(connectionState)
      || ['paused', 'error'].includes(jobStatus)
    ) {
      summary.attention += 1;
    }
  });

  return summary;
}

function getDisplayPriority(printer) {
  const connectionState = getPrinterConnectionState(printer);
  const jobStatus = getPrinterJobStatus(printer);

  if (['offline', 'error'].includes(connectionState)) return 0;
  if (['paused', 'error'].includes(jobStatus)) return 1;
  if (['reconnecting', 'connecting'].includes(connectionState)) return 2;
  if (['printing', 'drying', 'preparing'].includes(jobStatus)) return 3;
  if (jobStatus === 'finished') return 5;
  return 4;
}

export function sortPrintersForDisplay(printers = []) {
  return printers
    .map((printer, index) => ({ printer, index }))
    .sort((left, right) => (
      getDisplayPriority(left.printer) - getDisplayPriority(right.printer)
      || left.index - right.index
    ))
    .map(({ printer }) => printer);
}
