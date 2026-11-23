import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'tongji-campus-local';
export const inject = ['dshHomePath'];

export function apply(ctx) {
  const dshHome = ctx.dshHomePath();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dataDir = process.env.TONGJI_CAMPUS_DATA_DIR || join(dshHome, 'tongji-campus-local');
  const env = { TONGJI_CAMPUS_DATA_DIR: dataDir };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

  ctx.provide('tongjiCampusRuntime', {
    mcp: {
      serverName: 'tongji_campus',
      transport: 'stdio',
      command: process.execPath,
      args: [join(root, 'src', 'server.mjs')],
      cwd: root,
      env,
    },
    skills: {
      providerName: name,
      includeDefaultRoots: false,
      dshHome,
      agentsHome: join(homedir(), '.agents'),
      customSkillDirs: [join(root, 'skills')],
      watch: false,
    },
  });
}
