/**
 * 本地能力档案与分片判定（`ai_router/local_capability.py` 的 TS 对应）。
 */

import type { Modality } from '../../shared/types.js';
import type { LocalModelProfile } from './analyze.js';

/** 本地可承担的"分片型"工作：可切分的短产出，下放本地能显著省 token。 */
export const LOCAL_SHARD_KINDS = new Set(['copy', 'chat', 'code', 'analysis']);

/** 本地分片工作的输入 token 预算。 */
export const LOCAL_SHARD_INPUT_BUDGET = 1200;

/** 本地分片工作的输出 token 预算。 */
export const LOCAL_SHARD_OUTPUT_BUDGET = 900;

function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const char of text) {
    if (char >= '\u4e00' && char <= '\u9fff') cjk += 1;
  }
  return Math.round(cjk * 0.6 + (text.length - cjk) * 0.28) + 1;
}

export function canHandleShard(
  profile: LocalModelProfile,
  options: { upstreamText: string; expectedOutputTokens: number },
): { ok: boolean; reason: string } {
  const upstreamTokens = estimateTokens(options.upstreamText);

  if (upstreamTokens > LOCAL_SHARD_INPUT_BUDGET) {
    return {
      ok: false,
      reason: `上游材料约 ${upstreamTokens} tokens，超出本地分片预算 ${LOCAL_SHARD_INPUT_BUDGET}`,
    };
  }

  if (options.expectedOutputTokens > profile.maxReliableOutput) {
    return {
      ok: false,
      reason: `预计输出 ${options.expectedOutputTokens} tokens 超出 ${profile.name} 上限 ${profile.maxReliableOutput}`,
    };
  }

  return { ok: true, reason: '' };
}

// ============================================================
// 输出质量闸门
// ============================================================

export interface QualityVerdict {
  ok: boolean;
  reason: string;
  escalate: boolean;
}

const REFUSAL_MARKERS = [
  '我无法回答', '我不能回答', '无法完成该任务', '作为一个ai', '作为一个人工智能',
  '抱歉，我无法', '对不起，我无法', 'i cannot', "i can't help", 'as an ai language model',
];

/** 本地小模型的廉价质量闸门：空输出 / 过短 / 复读 / 拒答。 */
export function checkOutputQuality(
  output: string,
  options: { minChars?: number } = {},
): QualityVerdict {
  const minChars = options.minChars ?? 20;
  const text = (output ?? '').trim();

  if (!text) return { ok: false, reason: '输出为空', escalate: true };
  if (text.length < minChars) {
    return { ok: false, reason: `输出仅 ${text.length} 字，低于下限 ${minChars}`, escalate: true };
  }

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 4) {
    const unique = new Set(lines).size / lines.length;
    if (unique < 0.5) {
      return { ok: false, reason: `疑似复读（重复行占比 ${Math.round((1 - unique) * 100)}%）`, escalate: true };
    }
  }

  if (text.length >= 200) {
    const head = text.slice(0, 100);
    const occurrences = text.split(head).length - 1;
    if (occurrences >= 3) return { ok: false, reason: '内容高度重复', escalate: true };
  }

  const lowered = text.toLowerCase();
  if (REFUSAL_MARKERS.some((marker) => lowered.includes(marker))) {
    return { ok: false, reason: '模型拒答 / 输出元话语', escalate: true };
  }

  return { ok: true, reason: '', escalate: false };
}

export function modalitySupported(profile: LocalModelProfile, modality: Modality): boolean {
  return profile.modalities.includes(modality);
}
