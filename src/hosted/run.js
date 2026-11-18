/** Starts the hosted connector from the environment (`sf host serve`). */

import { loadConfig } from './config.js';
import { openStore } from './store.js';
import { createHostedServer } from './server.js';

/** Starts the server from the environment; resolves once it listens. */
export async function runHost({ env = process.env, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const config = loadConfig(env);
  // Files created from here on (database, -wal, -shm, schema cache) are private to the service user.
  process.umask(0o077);
  const store = openStore(config.dataDir);
  const server = createHostedServer({ config, store, log: (line) => log(`sf-host: ${line}`) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bind, resolve);
  });
  server.warmup().catch((e) => log(`sf-host: could not load the protocol schema yet (${e.message}); retrying on the first request`));
  const { port } = server.address();
  log(`sf-host: ${config.name} listening on ${config.bind}:${port}, public URL ${config.publicUrl}, MCP ${config.publicUrl}/mcp`);
  log(`sf-host: invites ${config.inviteRequired ? 'required' : 'not required'}${config.readOnly ? ', read-only' : ''}, data in ${config.dataDir}`);
  if (config.publicUrl.startsWith('http:')) log('sf-host: WARNING: http public URL - for local tests only');
  if (config.redirectHosts.includes('*')) log('sf-host: WARNING: SF_HOST_REDIRECT_HOSTS=* accepts any redirect host - any site can then ask your users for access under a name of its choice');
  if (config.cimdHosts.includes('*')) log('sf-host: WARNING: SF_HOST_CIMD_HOSTS=* fetches client metadata documents from any public host');

  process.on('unhandledRejection', (e) => log(`sf-host: unhandled rejection: ${e?.name ?? 'Error'}`));
  process.on('uncaughtException', (e) => log(`sf-host: uncaught exception: ${e?.name ?? 'Error'}`));
  const stop = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return server;
}
