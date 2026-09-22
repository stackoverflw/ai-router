/**
 * 底部状态条：永远可见的一行 HUD。
 *
 * 左侧是各依赖项状态点，中间是当前路由模式，右侧是本次会话的 LOCAL / CLOUD token 累计。
 */

import type { JSX } from 'react';

import type { ProviderStatus } from '../../shared/types.js';
import type { SessionTotals } from '../hooks/useExecution.js';
import { formatTokens } from '../utils.js';

export interface StatusBarProps {
  providerStatus: ProviderStatus | null;
  /** 当前默认模型（哨兵值代表云端接管）。 */
  localModel: string;
  cloudModel: string;
  totals: SessionTotals;
  running: boolean;
  /** 是否正在下载模型。 */
  pulling: boolean;
}

function Item({
  dotClass,
  label,
  value,
}: {
  dotClass: string;
  label: string;
  value: string;
}): JSX.Element {
  return (
    <span className="statusbar-item">
      <span className={`dot ${dotClass}`} />
      <span>{label}</span>
      <span style={{ color: 'var(--text)' }}>{value}</span>
    </span>
  );
}

export function StatusBar(props: StatusBarProps): JSX.Element {
  const { providerStatus, localModel, cloudModel, totals, running, pulling } = props;

  const cloudMode = localModel === '__cloud__';
  const modeLabel = running ? '执行中' : cloudMode ? '云端接管' : '本地优先';

  return (
    <footer className="statusbar">
      <Item
        dotClass={providerStatus?.ollamaRunning ? 'dot-ok' : providerStatus?.ollamaInstalled ? 'dot-warn' : 'dot-off'}
        label="OLLAMA"
        value={providerStatus?.ollamaRunning ? 'ONLINE' : providerStatus?.ollamaInstalled ? 'IDLE' : 'ABSENT'}
      />
      <span className="statusbar-sep" />
      <Item
        dotClass={providerStatus?.cloudConfigured ? 'dot-ok' : 'dot-warn'}
        label="CLOUD"
        value={providerStatus?.cloudConfigured ? 'READY' : 'UNSET'}
      />
      <span className="statusbar-sep" />
      <Item
        dotClass={providerStatus?.ffmpegAvailable ? 'dot-ok' : 'dot-off'}
        label="FFMPEG"
        value={providerStatus?.ffmpegAvailable ? 'OK' : 'N/A'}
      />
      <span className="statusbar-sep" />
      <span className="statusbar-item">
        <span className={`dot ${running ? 'dot-ok dot-pulse' : 'dot-off'}`} />
        <span>ROUTE MODE</span>
        <span style={{ color: cloudMode ? 'var(--amber)' : 'var(--cyan)' }}>{modeLabel}</span>
      </span>
      {pulling ? (
        <>
          <span className="statusbar-sep" />
          <span className="statusbar-item">
            <span className="dot dot-warn dot-pulse" />
            <span>PULLING</span>
          </span>
        </>
      ) : null}

      <span className="statusbar-spacer" />

      <span className="statusbar-item">
        <span>MODEL</span>
        <span style={{ color: 'var(--text)' }}>
          {cloudMode ? cloudModel || '未配置' : localModel || '未设置'}
        </span>
      </span>
      <span className="statusbar-sep" />
      <span className="statusbar-item">
        <span>RUNS</span>
        <span style={{ color: 'var(--text)' }}>{totals.runs}</span>
      </span>
      <span className="statusbar-sep" />
      <span className="token-counter">
        <span>LOCAL</span>
        <span className="token-value">{formatTokens(totals.localTokens)}</span>
        <span>/</span>
        <span>CLOUD</span>
        <span className="token-value is-cloud">{formatTokens(totals.cloudTokens)}</span>
        <span>/</span>
        <span>SAVED</span>
        <span className="token-value">{formatTokens(totals.savedTokens)}</span>
      </span>
    </footer>
  );
}

export default StatusBar;
