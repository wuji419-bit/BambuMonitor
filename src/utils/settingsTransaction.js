export async function applySettingsTransaction({ startupChanged, applyStartup, commitLocal, rollbackStartup, rollbackLocal }) {
  let startupApplied = false;
  if (startupChanged) {
    await applyStartup();
    startupApplied = true;
  }
  try {
    return await commitLocal();
  } catch (error) {
    try { await rollbackLocal(); } catch { /* Preserve the original commit error. */ }
    if (startupApplied) {
      try { await rollbackStartup(); } catch { /* Best-effort remote rollback. */ }
    }
    throw error;
  }
}

export async function updateServerSettingsWhenReady({ runtime, ready, settings }) {
  if (!ready) throw new Error('服务器设置仍在加载');
  return runtime.settings.update(settings);
}
