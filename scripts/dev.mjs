import { spawn } from 'node:child_process';
import fs from 'node:fs';

// 轻量 .env 加载（不覆盖已有环境变量）
function loadDotEnv() {
  try {
    const raw = fs.readFileSync('.env', 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* 无 .env 时忽略 */
  }
}
loadDotEnv();

const procs = [];

function run(name, cmd, args, color) {
  const p = spawn(cmd, args, { shell: true, env: process.env, cwd: process.cwd() });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    stream.on('data', (d) => {
      const text = d.toString();
      out.write(text.split('\n').filter((l) => l.trim()).map((l) => tag + l).join('\n') + '\n');
    });
  };
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => process.stdout.write(tag + `exited (${code})\n`));
  procs.push(p);
}

run('server', 'npx', ['tsx', 'watch', 'server/src/index.ts'], '36');
run('web', 'npx', ['vite', '--port', '5173'], '35');

const killAll = () => procs.forEach((p) => p.kill());
process.on('SIGINT', () => {
  killAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  killAll();
  process.exit(0);
});
