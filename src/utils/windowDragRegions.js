export function dragRegionStyle(isLocked = false) {
  return {
    WebkitAppRegion: isLocked ? 'no-drag' : 'drag',
    cursor: isLocked ? 'default' : 'move',
  };
}

export function noDragRegionStyle() {
  return {
    WebkitAppRegion: 'no-drag',
  };
}
