import {
  detectDuplicateStatements,
  splitSentences,
  type AudioTimelineDto,
} from '@froa/shared';
import type { PrismaClient } from '@prisma/client';
import { parseJson } from '../lib/json';

/**
 * 时间轴整理逻辑（与路由无关的纯数据操作）。
 *
 * 不变量：
 * 1. 音频只增不改 —— 时间轴只做"排序 + 偏移 + 重复裁定"，绝不拼接或删除音频；
 * 2. 偏移（offsetMs）永远由"前面各段时长累加"得到，不信任客户端传入；
 * 3. 重复检测的唯一真相在 packages/shared（前后端同构），服务端只在这里调用；
 * 4. 机器只标记，人来裁定 —— 没有逐组人工结论，时间轴不允许合并。
 */

type Db = PrismaClient;

export interface OrderedTrack {
  audioId: string;
  durationMs: number;
  orderIndex: number;
}

/** 按 orderIndex 计算每段在合并时间轴上的偏移与全轴总时长。 */
export function computeOffsets(tracks: OrderedTrack[]): {
  offsets: Map<string, number>;
  totalDurationMs: number;
} {
  const sorted = [...tracks].sort((a, b) => a.orderIndex - b.orderIndex);
  const offsets = new Map<string, number>();
  let cursor = 0;
  for (const track of sorted) {
    offsets.set(track.audioId, cursor);
    cursor += Math.max(0, track.durationMs);
  }
  return { offsets, totalDurationMs: cursor };
}

interface AudioForScan {
  id: string;
  transcript: string | null;
}

/**
 * 对当前时间轴成员跑一次重复检测。
 * 没有转写（或太短）的音频段自动跳过 —— 没文字就没法比，
 * 页面上会提示"先转写再扫描"，而不是静默给出空结果。
 */
export function scanTracksForDuplicates(audios: AudioForScan[], threshold?: number) {
  return detectDuplicateStatements(
    audios.map((audio) => ({ audioId: audio.id, transcript: audio.transcript })),
    threshold ? { threshold } : {},
  );
}

export { splitSentences };

/**
 * 组合定稿转写。
 *
 * 规则（全部可从数据追溯，不做任何"智能改写"）：
 * - 按轨道顺序逐段处理；
 * - 对每一段，逐句判断这句是否落在某个"确认重复"组里且不是被保留的成员 ——
 *   是则跳过（在时间轴上它仍占位置，只是合并文稿里不重复出现）；
 * - 被标"不是重复"或没进任何组的句子原样保留；
 * - 尚未裁定的组不应该走到这里（合并接口有闸门），双保险起见当作保留。
 */
export function composeMergedTranscript(params: {
  orderedAudioIds: string[];
  transcripts: Map<string, string | null>;
  reviewedGroups: { members: string; status: string; keepAudioId: string | null }[];
}): string {
  const { orderedAudioIds, transcripts, reviewedGroups } = params;

  // 对于每组"确认重复"，记录除保留音频外、句子被归一化后命中即应跳过的集合。
  // 直接按 (audioId, 原句) 匹配：members 存的是检测快照里的原句。
  const droppedByAudio = new Map<string, Set<string>>();
  for (const group of reviewedGroups) {
    if (group.status !== 'duplicate' || !group.keepAudioId) continue;
    const members = parseJson<{ audioId: string; sentence: string }[]>(group.members, []);
    for (const member of members) {
      if (member.audioId === group.keepAudioId) continue;
      const set = droppedByAudio.get(member.audioId) ?? new Set<string>();
      set.add(member.sentence);
      droppedByAudio.set(member.audioId, set);
    }
  }

  const blocks: string[] = [];
  for (const audioId of orderedAudioIds) {
    const transcript = transcripts.get(audioId);
    if (!transcript || !transcript.trim()) continue;

    const dropped = droppedByAudio.get(audioId);
    const kept = splitSentences(transcript).filter((sentence) => {
      if (!dropped) return true;
      // 快照原句可能与当前转写有空白差异，做一次宽松比较
      for (const raw of dropped) {
        if (raw.trim() === sentence.trim()) return false;
      }
      return true;
    });

    if (kept.length) blocks.push(kept.join('。'));
  }

  return blocks.join('\n\n');
}

/** 合并闸门口径：有多少组还没人工结论 */
export function pendingReviewCount(timeline: AudioTimelineDto): number {
  return timeline.pendingReviewCount
    ?? (timeline.duplicateGroups ?? []).filter((group) => group.status === 'pending').length;
}
