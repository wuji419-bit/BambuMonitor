export function shouldLoadServerSettings(capabilities = {}, isPreviewMode = false) {
  return Boolean(capabilities.serverSettings && !isPreviewMode);
}

export function getPreviewViewMode(search = '') {
  const mode = new URLSearchParams(String(search)).get('mode');
  return mode === 'compact' || mode === 'mini' ? mode : 'full';
}
