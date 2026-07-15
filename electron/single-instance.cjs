function enforceSingleInstance(app, activateExistingWindow) {
  const ownsLock = app.requestSingleInstanceLock();
  if (!ownsLock) {
    app.quit();
    return false;
  }

  app.on('second-instance', () => {
    activateExistingWindow();
  });
  return true;
}

module.exports = { enforceSingleInstance };
