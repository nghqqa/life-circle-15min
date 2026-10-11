import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App.js';
import '../style.css';

// 不开 StrictMode：dev 下 effect 双跑会让 init()/projectUi 重复绑定副作用
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#2f6fed', borderRadius: 8 } }}>
    <App />
  </ConfigProvider>
);
