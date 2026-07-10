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
