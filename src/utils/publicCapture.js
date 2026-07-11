export function isPublicCaptureSearch(search = '') {
  return new URLSearchParams(search).get('capture') === 'public';
}

export function publicCameraAddress(ip, isPublicCapture = false) {
  if (isPublicCapture) return '本地摄像头';
  return ip ? `IP ${ip}` : '暂无本地 IP';
}
