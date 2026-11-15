#!/usr/bin/env node
// 测试用假 Codex CLI：完整 --help（含 -c 与 --skip-git-repo-check）。运行即成功。
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv.includes('--help')) {
  process.stdout.write(
    'codex-cli 0.1.0\n'
    + 'Usage: codex exec [options]\n'
    + '  -s, --sandbox <s>        sandbox mode\n'
    + '  -m, --model <m>          model\n'
    + '  -c, --config <c>         config string\n'
    + '  -o, --output <o>         output file\n'
    + '  --skip-git-repo-check    skip git repo check\n'
    + '  --json                   json output\n'
    + '  --ephemeral\n'
    + '  --color <c>\n',
  );
  process.exit(0);
}

let outPath = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '-o') { outPath = argv[i + 1]; break; }
}

let data = '';
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => {
  const head = (data.trim().split('\n')[0]) || 'no-prompt';
  if (outPath) writeFileSync(outPath, `codex done: ${head}\n`, 'utf8');
  try { writeFileSync('gcw_fixture_out.txt', 'ok\n'); } catch { /* 忽略 */ }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
