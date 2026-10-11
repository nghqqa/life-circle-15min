import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { createApiRouter, createAnalysisRouter } from './routes.js';
import { IpLimiter } from './ratelimit.js';
import { renderShareHtml, saveShare } from './share.js';
import { usageSnapshot } from './usage.js';

const cfg = loadConfig();
const app = express();
const ipLimiter = new IpLimiter();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' })); // 审查修复：256kb 会让默认规模报告分享触发 413

// 每 IP 基础限流
app.use('/api', (req, res, next) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  if (!ipLimiter.allow(ip)) {
    res.status(200).json({ status: -1, message: '请求过于频繁，请稍后再试' });
    return;
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 0, uptime: process.uptime() });
});

// /api/config：仅暴露浏览器端 AK（浏览器端 AK 属公开设计），服务端 AK 永不下发
app.get('/api/config', (_req, res) => {
  res.json({
    status: 0,
    browserAk: cfg.akBrowser,
    hasServerAk: cfg.akServer.length >= 16,
    mock: cfg.akBrowser.length < 16 && cfg.akServer.length < 16,
    version: '0.1.0'
  });
});

app.use('/api/baidu', createApiRouter(cfg));
app.use('/api', createAnalysisRouter(cfg));

// №18 审查修复：分享创建与只读页面挂在 app 层——原先在 /api/baidu 路由器内，
// 实际路径变成 /api/baidu/share 与 /api/baidu/s/:id，前端 /api/share 与 /s/:id 均 404
app.post('/api/share', (req, res) => {
  const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  const out = saveShare(text);
  if ('error' in out) {
    res.status(400).json({ status: -1, message: out.error });
    return;
  }
  res.json({ status: 0, id: out.id, url: `/s/${out.id}` });
});

app.get('/s/:id', (req, res) => {
  res.send(renderShareHtml(String(req.params.id)));
});

// №13 调用预算面板：本地进程计数（非平台账户余额）
app.get('/api/usage', (_req, res) => {
  res.json({ status: 0, usage: usageSnapshot() });
});

// 生产模式：托管前端构建产物
const staticDir = path.isAbsolute(cfg.staticDir) ? cfg.staticDir : path.resolve(process.cwd(), cfg.staticDir);
if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

app.listen(cfg.port, () => {
  console.log(`[life-circle] server on http://localhost:${cfg.port}`);
  console.log(`[life-circle] browserAk: ${cfg.akBrowser ? 'configured' : 'MISSING (demo mode)'}, serverAk: ${cfg.akServer ? 'configured' : 'MISSING (proxy disabled)'}`);
});
