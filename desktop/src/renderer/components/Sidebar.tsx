/**
 * 左侧图标栏：对话 / 下载 / 设置。
 *
 * 宽度固定 72px，图标为 1px 描边的内联 SVG（不引入任何图标库）。
 */

import type { JSX } from 'react';

import type { ViewKey } from '../utils.js';

interface SidebarProps {
  view: ViewKey;
  onChange: (view: ViewKey) => void;
  /** 是否有正在进行的模型下载，用于在下载按钮上打点。 */
  hasActivePull: boolean;
}

function ChatIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5.5h16v10.5H12l-5 3.5v-3.5H4z" />
      <path d="M8 9.5h8M8 12.5h5" strokeWidth="0.75" />
    </svg>
  );
}

function DownloadIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5v10.5" />
      <path d="M7.5 10l4.5 4.5 4.5-4.5" />
      <path d="M4.5 18.5h15" />
      <path d="M4.5 20.5h15" strokeWidth="0.6" opacity="0.45" />
    </svg>
  );
}

function SettingsIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9" />
    </svg>
  );
}

function PulseIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12h4l2.5-6 3.5 12 2.5-6h6.5" />
    </svg>
  );
}

const ITEMS: Array<{ key: ViewKey; label: string; render: () => JSX.Element }> = [
  { key: 'chat', label: '对话', render: ChatIcon },
  { key: 'downloads', label: '下载', render: DownloadIcon },
  { key: 'settings', label: '设置', render: SettingsIcon },
];

export function Sidebar({ view, onChange, hasActivePull }: SidebarProps): JSX.Element {
  return (
    <nav className="sidebar" aria-label="主导航">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark">AR</span>
        <span className="micro" style={{ fontSize: '8px', letterSpacing: '0.12em' }}>
          ROUTER
        </span>
      </div>

      <div className="sidebar-nav">
        {ITEMS.map((item) => {
          const active = item.key === view;
          return (
            <button
              key={item.key}
              type="button"
              className={`nav-item${active ? ' is-active' : ''}`}
              onClick={() => onChange(item.key)}
              aria-current={active ? 'page' : undefined}
              title={item.label}
            >
              {item.render()}
              <span className="nav-label">{item.label}</span>
              {item.key === 'downloads' && hasActivePull ? (
                <span
                  className="dot dot-warn dot-pulse"
                  style={{ position: 'absolute', top: '6px', right: '6px' }}
                />
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="sidebar-spacer" />

      <div className="sidebar-foot">
        <span style={{ color: 'rgba(94,234,212,.55)' }}>
          <PulseIcon />
        </span>
        <span className="micro" style={{ fontSize: '8px', letterSpacing: '0.1em' }}>
          V0.7.0
        </span>
      </div>
    </nav>
  );
}
