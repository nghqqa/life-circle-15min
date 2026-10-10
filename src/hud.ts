import type { ChannelName } from '../shared/types.js';

/** 分析进度 HUD：步骤、耗时、当前通道一目了然 */

const CHANNEL_LABEL: Record<ChannelName, string> = {
  server: '服务端',
  client: '浏览器端',
  mock: '合成兜底'
};

export class Hud {
  private steps: { name: string; status: 'wait' | 'doing' | 'done' | 'fail'; channel?: ChannelName; ms?: number }[] = [];
  private t0 = 0;

  start(title: string, stepNames: string[]) {
    this.steps = stepNames.map((name) => ({ name, status: 'wait' as const }));
    this.t0 = performance.now();
    const hud = document.getElementById('hud')!;
    hud.classList.remove('hidden');
    (document.getElementById('hud-title') as HTMLElement).innerHTML =
      '<span class="spinner" aria-hidden="true"></span>' + title;
    this.render();
  }

  doing(idx: number, note?: string) {
    this.steps[idx].status = 'doing';
    if (note) (document.getElementById('hud-note') as HTMLElement).textContent = note;
    this.render();
  }

  done(idx: number, channel: ChannelName, ms: number) {
    this.steps[idx].status = 'done';
    this.steps[idx].channel = channel;
    this.steps[idx].ms = ms;
    this.render();
  }

  fail(idx: number) {
    this.steps[idx].status = 'fail';
    this.render();
  }

  note(text: string) {
    (document.getElementById('hud-note') as HTMLElement).textContent = text;
  }

  finish() {
    setTimeout(() => document.getElementById('hud')!.classList.add('hidden'), 350);
  }

  private render() {
    const ul = document.getElementById('hud-steps')!;
    ul.innerHTML = this.steps
      .map((s, i) => {
        const mark = s.status === 'done' ? '✓' : s.status === 'doing' ? '▸' : s.status === 'fail' ? '×' : '·';
        const cls = s.status;
        const channel = s.channel ? `<span class="st-channel">${CHANNEL_LABEL[s.channel]}</span>` : '';
        const ms = s.ms != null ? `<span class="st-ms">${s.ms}ms</span>` : '';
        return `<li class="${cls}"><span>${mark} ${i + 1}. ${s.name}</span><span>${channel}${ms}</span></li>`;
      })
      .join('');
  }
}

export function banner(text: string, kind: 'warn' | 'info' = 'warn', timeoutMs = 6000) {
  const el = document.getElementById('banner')!;
  el.textContent = text;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), timeoutMs);
}

export { CHANNEL_LABEL };
