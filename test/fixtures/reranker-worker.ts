import fs from 'node:fs';
if (process.env.OHS_FIXTURE_PID_FILE) fs.writeFileSync(process.env.OHS_FIXTURE_PID_FILE, String(process.pid));
process.on('disconnect', () => process.exit(0));
process.on('message', (message: { modelName: string; type: string; id: number }) => {
  if (message.type === 'load' && message.modelName.startsWith('download-')) {
    process.send?.({ id: message.id, progress: 'download' });
    process.send?.({ id: message.id, download: { loaded: 25, total: 100 } });
    setTimeout(() => {
      process.send?.({ id: message.id, ok: message.modelName === 'download-success', value: true });
    }, 350);
    return;
  }
  if (message.modelName === 'crash') process.exit(2);
  if (message.modelName === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  if (message.modelName === 'error') {
    process.stderr.write('native backend diagnostic\n');
    process.send?.({ id: message.id, ok: false });
    return;
  }
  process.send?.({ id: message.id, ok: true, value: message.type === 'probe' ? true : [2, -1] });
});
