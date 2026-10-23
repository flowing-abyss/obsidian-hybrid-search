export function registerProcessHandlers(): void {
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason);
  });
}
