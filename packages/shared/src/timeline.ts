import type { TimelineDuplicateOccurrence } from './types';

/**
 * 多段口述的重复表述检测与时间轴布局。
 *
 * 设计定位与规则库（rules.ts）一致：这里只做"标出来"，结论永远由人下 ——
 * 检测出的重复表述全部是 pending 状态，必须经人工逐条确认或驳回后才允许合并。
 *
 * 转写文本没有词级时间戳（manual 模式下就是一段纯文本），
 * 因此重复片段的时间位置按"字符位置 ÷ 全文长度 × 音频时长"等比估算，
 * 在 UI 上会明确标注为估算位置。
 */

/** 短于这个长度的子句没有比对意义（"嗯""好的"这类会满天都是） */
export const DUPLICATE_MIN_CLAUSE_LENGTH = 4;
/** 单个合并提案最多标出的重复组数，防止两段完全重录的口述刷出几百条 */
export const DUPLICATE_MAX_GROUPS = 50;
/** 每组最多保留的出现次数 */
export const DUPLICATE_MAX_OCCURRENCES = 20;

/**
 * 口述里的口头禅。归一化时先去掉它们，否则
 * "然后放一点糖" 和 "放一点糖" 会被当成两句不同的话。
 * 注意按从长到短匹配，避免 "然后呢" 被 "然后" 截断后留下残字。
 */
const FILLER_WORDS = [
  '然后呢',
  '这样的话',
  '就是说',
  '然后',
  '那个',
  '这个',
  '嗯嗯',
  '嗯',
  '啊',
  '呃',
  '哦',
  '噢',
  '反正',
  '你看',
];

const KEEP_CHAR = /[一-鿿㐀-䶿a-z0-9]/;

export interface NormalizeResult {
  /** 只保留汉字与字母数字、去掉口头禅后的比对用文本 */
  normalized: string;
  /** normalized[i] 在原文中的字符下标（用于回推原文与时间位置） */
  originIndex: number[];
}

/** 归一化口述文本：去口头禅、去标点空白、小写化，并保留到原文的下标映射 */
export function normalizeNarration(text: string): NormalizeResult {
  const source = text ?? '';
  const normalized: string[] = [];
  const originIndex: number[] = [];

  let i = 0;
  outer: while (i < source.length) {
    for (const filler of FILLER_WORDS) {
      if (source.startsWith(filler, i)) {
        i += filler.length;
        continue outer;
      }
    }
    const char = source[i]!.toLowerCase();
    if (KEEP_CHAR.test(char)) {
      normalized.push(char);
      originIndex.push(i);
    }
    i += 1;
  }

  return { normalized: normalized.join(''), originIndex };
}

export interface NarrationClause {
  /** 原始子句（去掉首尾空白，保留内部标点） */
  text: string;
  /** 在原文中的字符区间 [startChar, endChar) */
  startChar: number;
  endChar: number;
}

const CLAUSE_SEPARATOR = /[，。！？；：、…—~～\n\r,.!?;:]/;

/** 把一段转写切成子句。口述整理的最小单位是"一句话"，重复也比对到句级 */
export function splitNarrationClauses(text: string): NarrationClause[] {
  const source = text ?? '';
  const clauses: NarrationClause[] = [];
  let start = 0;

  const push = (end: number) => {
    let lo = start;
    let hi = end;
    while (lo < hi && /\s/.test(source[lo]!)) lo += 1;
    while (hi > lo && /\s/.test(source[hi - 1]!)) hi -= 1;
    if (hi > lo) clauses.push({ text: source.slice(lo, hi), startChar: lo, endChar: hi });
  };

  for (let i = 0; i < source.length; i += 1) {
    if (CLAUSE_SEPARATOR.test(source[i]!)) {
      push(i);
      start = i + 1;
    }
  }
  push(source.length);
  return clauses;
}

export interface DuplicateDetectionInput {
  audioId: string;
  transcript: string | null | undefined;
  durationMs: number;
}

export interface DuplicateCandidate {
  /** 归一化后的重复文本（比对键） */
  normalizedText: string;
  /** 展示用原文（从第一处出现里截出来的原话） */
  displayText: string;
  occurrences: TimelineDuplicateOccurrence[];
}

interface ClauseOccurrence {
  audioId: string;
  transcriptLength: number;
  durationMs: number;
  clause: NarrationClause;
  normalized: string;
  originIndex: number[];
}

interface CandidateGroup {
  key: string;
  members: ClauseOccurrence[];
}

/**
 * 检测多段口述里的重复表述。
 *
 * 算法：子句级归一化分组 + 子串归并。
 * 先按归一化文本精确分组；之后若某组的键是另一组键的子串（"放一点糖" vs "放一点糖就行"），
 * 把它们并到更短的那个键下 —— 更短的键就是两句话真正共同的部分。
 * 只有出现在 ≥2 段不同口述里的组才会被标出来。
 */
export function detectDuplicatePhrases(
  audios: DuplicateDetectionInput[],
): DuplicateCandidate[] {
  const occurrences: ClauseOccurrence[] = [];

  for (const audio of audios) {
    const transcript = audio.transcript ?? '';
    if (!transcript.trim()) continue;
    for (const clause of splitNarrationClauses(transcript)) {
      const { normalized, originIndex } = normalizeNarration(clause.text);
      if (normalized.length < DUPLICATE_MIN_CLAUSE_LENGTH) continue;
      occurrences.push({
        audioId: audio.audioId,
        transcriptLength: transcript.length,
        durationMs: Math.max(0, audio.durationMs),
        clause,
        normalized,
        originIndex,
      });
    }
  }

  // 按键长升序处理：短键先成组，长句来了之后会被归并到短键上
  const groups: CandidateGroup[] = [];
  const sorted = [...occurrences].sort((a, b) => a.normalized.length - b.normalized.length);

  for (const occurrence of sorted) {
    const group = groups.find(
      (candidate) =>
        candidate.key.includes(occurrence.normalized) ||
        occurrence.normalized.includes(candidate.key),
    );
    if (!group) {
      groups.push({ key: occurrence.normalized, members: [occurrence] });
      continue;
    }
    if (occurrence.normalized.length < group.key.length) {
      // 新键更短且是旧键的子串：旧键的所有成员仍然包含新键，收缩是安全的
      group.key = occurrence.normalized;
    }
    group.members.push(occurrence);
  }

  const candidates: DuplicateCandidate[] = [];

  for (const group of groups) {
    const distinctAudios = new Set(group.members.map((member) => member.audioId));
    if (distinctAudios.size < 2) continue;

    const seen = new Set<string>();
    const groupOccurrences: TimelineDuplicateOccurrence[] = [];

    for (const member of group.members) {
      const at = member.normalized.indexOf(group.key);
      if (at < 0) continue;
      const startChar = member.clause.startChar + member.originIndex[at]!;
      const lastNormalized = member.originIndex[at + group.key.length - 1];
      if (lastNormalized === undefined) continue;
      const endChar = member.clause.startChar + lastNormalized + 1;

      const dedupeKey = `${member.audioId}:${startChar}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const ratio = member.transcriptLength > 0 ? 1 / member.transcriptLength : 0;
      groupOccurrences.push({
        audioId: member.audioId,
        text: member.clause.text,
        startChar,
        endChar,
        estimatedStartMs: Math.round(startChar * ratio * member.durationMs),
        estimatedEndMs: Math.round(endChar * ratio * member.durationMs),
      });
      if (groupOccurrences.length >= DUPLICATE_MAX_OCCURRENCES) break;
    }

    if (new Set(groupOccurrences.map((item) => item.audioId)).size < 2) continue;

    const first = groupOccurrences[0]!;
    candidates.push({
      normalizedText: group.key,
      displayText: first.text,
      occurrences: groupOccurrences,
    });
    if (candidates.length >= DUPLICATE_MAX_GROUPS) break;
  }

  // 出现次数多的、文本长的排前面：它们最可能是真正需要人工看一眼的重复
  return candidates.sort(
    (a, b) =>
      b.occurrences.length - a.occurrences.length ||
      b.normalizedText.length - a.normalizedText.length,
  );
}

export interface TimelineLayoutItem {
  audioId: string;
  orderIndex: number;
  offsetMs: number;
}

/** 默认布局：按给定顺序首尾相接拼到同一条时间轴上 */
export function layoutTimelineItems(audios: { id: string; durationMs: number }[]): TimelineLayoutItem[] {
  let cursor = 0;
  return audios.map((audio, index) => {
    const item = { audioId: audio.id, orderIndex: index, offsetMs: cursor };
    cursor += Math.max(0, audio.durationMs);
    return item;
  });
}
