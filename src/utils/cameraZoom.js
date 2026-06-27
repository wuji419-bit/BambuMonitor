import { isChamberSnapshotStream } from './cameraFrame.js';

export function buildCameraZoomState({ key, printer, stream, imageState } = {}) {
  const isSnapshotStream = isChamberSnapshotStream(stream);
  const imageUrl = isSnapshotStream ? stream?.snapshotUrl : stream?.url;
  const canZoom = Boolean(key && stream?.success && imageUrl && imageState?.status !== 'error');

  return {
    key: key || '',
    canZoom,
    imageUrl: canZoom ? imageUrl : '',
    isSnapshotStream,
    isReady: imageState?.status === 'ready',
    title: printer?.name || 'Camera',
    ip: printer?.ip || '',
  };
}
