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
    assert.equal(tools.length, 18);
    assert.ok(tools.some(t => t.name === 'campus_query_timetable'));
    const exporter = tools.find(t => t.name === 'campus_export_timetable');
    assert.equal(exporter.annotations.readOnlyHint, false);
    assert.equal(exporter.annotations.destructiveHint, false);
    assert.ok(exporter.inputSchema.properties.semesterStartDate);
    const invalidExport = await client.callTool({ name: 'campus_export_timetable', arguments: { semesterStartDate: '2026-09-15' } });
    assert.equal(invalidExport.isError, true);
    const invalidPath = await client.callTool({ name: 'campus_export_timetable', arguments: { outputDir: '../escape' } });
    assert.equal(invalidPath.structuredContent.status, 'invalid_input');
    assert.ok(tools.some(t => t.name === 'campus_prepare_book_request'));
    assert.ok(tools.some(t => t.name === 'campus_query_seats'));
    assert.ok(tools.some(t => t.name === 'campus_reserve_seat'));
    const recommendations = tools.find(t => t.name === 'campus_recommend_books');
    assert.equal(recommendations.annotations.readOnlyHint, true);
    assert.ok(recommendations.inputSchema.properties.browsePopular);
    const conflictingRecommendation = await client.callTool({ name: recommendations.name,
      arguments: { query: '测试图书', browsePopular: true } });
    assert.equal(conflictingRecommendation.structuredContent.status, 'invalid_query');
    assert.ok(tools.some(t => t.name === 'campus_open_book_request' && !t.annotations.readOnlyHint));
    const loans = tools.find(t => t.name === 'campus_query_my_loans');
    const renewal = tools.find(t => t.name === 'campus_check_renewal');
    const handoff = tools.find(t => t.name === 'campus_open_renewal_page');
    assert.equal(loans.annotations.readOnlyHint, true);
    assert.equal(renewal.annotations.readOnlyHint, true);
    assert.ok(renewal.inputSchema.properties.titles);
    assert.equal(handoff.annotations.readOnlyHint, false);
    assert.equal(handoff.annotations.destructiveHint, false);
    for (const args of [{}, { title: '测试书目', confirm: true }, { loanId: 'fixture-id' },
      { title: '测试书目', loanId: '00000000-0000-4000-8000-000000000000' }]) {
      const invalid = await client.callTool({ name: handoff.name, arguments: args });
      assert.equal(invalid.isError || invalid.structuredContent?.status === 'invalid_input', true);
    }
    const ambiguousRequest = await client.callTool({ name: 'campus_open_book_request', arguments: { query: '同名图书' } });
    assert.equal(ambiguousRequest.isError, true);
    const invalidReservation = await client.callTool({name:'campus_reserve_seat',arguments:{selectionId:'invalid',confirm:true}});
    assert.equal(invalidReservation.isError,true);
    const unconfirmed = await client.callTool({name:'campus_reserve_seat',arguments:{selectionId:'00000000-0000-4000-8000-000000000000'}});
    assert.equal(unconfirmed.isError,true);
    const invalidPreview = await client.callTool({ name: 'campus_prepare_book_request', arguments: { query: '' } });
    assert.equal(invalidPreview.isError, true);
    assert.equal(tools.some(t => /submit|confirm_book|cancel_book/.test(t.name)), false);
    assert.ok(tools.every(t => !/password|cookie|token/.test(JSON.stringify(t.inputSchema))));
    const settings = await client.callTool({ name: 'campus_get_preferences', arguments: {} });
    assert.equal(settings.structuredContent.status, 'ok');
    const extra = await client.callTool({ name: 'campus_set_preferences', arguments: { username: 'fixture-only' } });
    assert.equal(extra.isError, true);
    const result = await client.callTool({ name: 'campus_status', arguments: {} });
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.browserRunning, false);
    const rejected = await client.callTool({ name: 'campus_open_login', arguments: { service: 'https://evil.example/' } });
    assert.equal(rejected.isError, true);
    assert.equal(logs.includes('SECRET'), false);
  } finally { await client.close(); }
});
