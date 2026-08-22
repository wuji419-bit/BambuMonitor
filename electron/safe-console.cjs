const BROKEN_PIPE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);
const METHODS = ['log', 'info', 'warn', 'error', 'debug'];
const INSTALLED = Symbol('bambuMonitorSafeConsoleInstalled');
const installedStreams = new WeakSet();

function isBrokenPipeError(error) {
  if (!error) return false;
  if (BROKEN_PIPE_CODES.has(error.code)) return true;
  return /EPIPE|broken pipe|stream destroyed/i.test(String(error.message || ''));
}

function installSafeStream(stream) {
  if (!stream || typeof stream.on !== 'function' || installedStreams.has(stream)) return;
  installedStreams.add(stream);
  stream.on('error', (error) => {
    if (!isBrokenPipeError(error)) throw error;
  });
}

function installSafeConsole(
  target = console,
  streams = target === console ? [process.stdout, process.stderr] : [],
) {
  if (!target || target[INSTALLED]) return target;

  for (const stream of streams || []) installSafeStream(stream);

  for (const method of METHODS) {
    if (typeof target[method] !== 'function') continue;
    const original = target[method].bind(target);
    target[method] = (...args) => {
      try {
        return original(...args);
      } catch (error) {
        if (!isBrokenPipeError(error)) throw error;
        return undefined;
      }
    };
  }

  Object.defineProperty(target, INSTALLED, {
    value: true,
    enumerable: false,
  });

  return target;
}

module.exports = {
  installSafeConsole,
  isBrokenPipeError,
};
