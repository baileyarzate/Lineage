import { resolve } from 'node:path';
import { createLineageServer } from './server.ts';

const dataDir = resolve(process.env.LINEAGE_DATA ?? 'data');
const port = Number(process.env.PORT ?? 4747);

const { server, keys } = createLineageServer(dataDir);
server.listen(port, '127.0.0.1', () => {
	console.log(`Lineage server listening on http://localhost:${port}`);
	console.log(`Dashboard: http://localhost:${port}/#key=${keys.adminKey}`);
	console.log(`Data:      ${dataDir}`);
});
