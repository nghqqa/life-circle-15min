/** 服务端配置：全部经环境变量注入，真实 AK 永不进代码库 */

export interface ServerConfig {
  port: number;
  akBrowser: string;
  akServer: string;
  allowOrigins: string[];
  staticDir: string;
}

export function loadConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT ?? 8787),
    akBrowser: process.env.BAIDU_MAP_AK_BROWSER ?? '',
    akServer: process.env.BAIDU_MAP_AK_SERVER ?? '',
    allowOrigins: (process.env.ALLOW_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    staticDir: process.env.STATIC_DIR ?? 'dist'
  };
}
