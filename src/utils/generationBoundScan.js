export async function runGenerationBoundScan({ scan, expectedGeneration, isCurrent, buildSnapshot, mergeSnapshot, onError }) {
  try {
    const scanned = await scan();
    if (!isCurrent(expectedGeneration)) return false;
    const snapshot = buildSnapshot(scanned);
    if (!isCurrent(expectedGeneration)) return false;
    await mergeSnapshot(snapshot);
    return true;
  } catch (error) {
    if (isCurrent(expectedGeneration)) onError?.(error);
    return false;
  }
}
