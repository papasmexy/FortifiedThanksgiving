import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/application.js';
export { createApp };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const { app, db } = createApp();
  const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
  const server = app.listen(Number(process.env.PORT || 3000), host, () => console.log('Fortified Thanksgiving running on port ' + (process.env.PORT || 3000)));
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
