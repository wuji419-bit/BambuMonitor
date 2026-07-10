export function acceptsConnectionGeneration(currentGeneration, expectedGeneration) {
  return expectedGeneration == null || currentGeneration === expectedGeneration;
}

export function beginConnectionGeneration(currentGeneration) {
  return Number.isSafeInteger(currentGeneration) ? currentGeneration + 1 : 1;
}
