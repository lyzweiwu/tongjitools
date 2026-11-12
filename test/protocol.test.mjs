import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('real stdio handshake discovers tools, calls status and rejects invalid service without a browser', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/server.mjs')], stderr: 'pipe' });
  const client = new Client({ name: 'tongji-local-test', version: '1.0.0' });
  let logs = '';
  transport.stderr?.on('data', chunk => { logs += chunk; });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    assert.ok(tools.some(t => t.name === 'campus_query_timetable'));
    assert.ok(tools.every(t => !/password|cookie|token/.test(JSON.stringify(t.inputSchema))));
    const result = await client.callTool({ name: 'campus_status', arguments: {} });
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.browserRunning, false);
    const rejected = await client.callTool({ name: 'campus_open_login', arguments: { service: 'https://evil.example/' } });
    assert.equal(rejected.isError, true);
    assert.equal(logs.includes('SECRET'), false);
  } finally { await client.close(); }
});
