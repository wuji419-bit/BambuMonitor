export function isChamberSnapshotStream(stream) {
  return stream?.mode === 'chamber-image-mjpeg' && Boolean(stream?.snapshotUrl);
}

export function buildCameraFrameUrl(snapshotUrl, frame) {
  const rawUrl = String(snapshotUrl || '').trim();
  if (!rawUrl) return '';

  try {
    const url = new URL(rawUrl);
    url.searchParams.set('frame', String(frame));
    return url.toString();
  } catch {
    const [base, hash = ''] = rawUrl.split('#');
    const [path, search = ''] = base.split('?');
    const params = new URLSearchParams(search);
    params.set('frame', String(frame));
    const query = params.toString();
    return `${path}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;
  }
}
