import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.js';
import './styles/global.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('找不到挂载点 #root，请检查 index.html 是否被正确加载。');
}

const root = createRoot(container);

root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
