import { useEffect, useMemo, useRef, useState } from 'react';
import type { AudioAttachmentDto, TimelineDuplicateStatus, TimelineDuplicateOccurrence } from '@froa/shared';

export interface MergedTimelineItem {
  audio: AudioAttachmentDto;
  offsetMs: number;
}

export interface MergedTimelineDuplicate {
  status: TimelineDuplicateStatus;
  occurrences: TimelineDuplicateOccurrence[];
}

interface MergedTimelineProps {
  items: MergedTimelineItem[];
  totalDurationMs: number;
  duplicates?: MergedTimelineDuplicate[];
  height?: number;
  /** 整条时间轴上的播放位置（毫秒） */
  playheadMs?: number;
  /** 点击时间轴：参数是合并时间轴上的毫秒位置 */
  onSeek?: (ms: number) => void;
}

/** 每段口述一个底色，方便看出"这一段是哪段录音" */
const BAND_COLORS = ['rgba(140, 74, 36, 0.07)', 'rgba(60, 110, 90, 0.08)'];
const PEAK_COLORS = ['#c9a88c', '#9db8a4'];
const DUPLICATE_COLORS: Record<TimelineDuplicateStatus, string | null> = {
  pending: 'rgba(214, 119, 34, 0.35)',
  confirmed: 'rgba(82, 148, 104, 0.35)',
  dismissed: null, // 已驳回的不高亮：人工说了"这不是重复"
};

/**
 * 合并时间轴：把多段口述的波形按各自偏移画到同一条轴上。
 *
 * 重复表述以高亮块标出（橙色 = 待确认，绿色 = 已确认重复），
 * 位置是按字符比例估算的，仅供定位参考。
 */
export function MergedTimeline({
  items,
  totalDurationMs,
  duplicates = [],
  height = 110,
  playheadMs,
  onSeek,
}: MergedTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setWidth(Math.max(200, Math.floor(rect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const offsetByAudioId = useMemo(
    () => new Map(items.map((item) => [item.audio.id, item.offsetMs])),
    [items],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || totalDurationMs <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const msToX = (ms: number) => (ms / totalDurationMs) * width;
    const mid = height / 2;

    // 1. 各段底色 + 波形
    items.forEach((item, index) => {
      const x = msToX(item.offsetMs);
      const w = msToX(item.offsetMs + item.audio.durationMs) - x;
      ctx.fillStyle = BAND_COLORS[index % BAND_COLORS.length]!;
      ctx.fillRect(x, 0, w, height);

      const peaks = item.audio.peaks;
      if (!peaks?.length || item.audio.durationMs <= 0) return;
      const barWidth = w / peaks.length;
      ctx.fillStyle = PEAK_COLORS[index % PEAK_COLORS.length]!;
      peaks.forEach((value, peakIndex) => {
        const amplitude = Math.max(1, value * (height / 2 - 6));
        ctx.fillRect(x + peakIndex * barWidth, mid - amplitude, Math.max(1, barWidth - 1), amplitude * 2);
      });
    });

    // 2. 重复表述高亮（估算位置）
    for (const duplicate of duplicates) {
      const color = DUPLICATE_COLORS[duplicate.status];
      if (!color) continue;
      ctx.fillStyle = color;
      for (const occurrence of duplicate.occurrences) {
        const offset = offsetByAudioId.get(occurrence.audioId);
        if (offset === undefined) continue;
        const x = msToX(offset + occurrence.estimatedStartMs);
        const w = Math.max(3, msToX(offset + occurrence.estimatedEndMs) - x);
        ctx.fillRect(x, 0, w, height);
      }
    }

    // 3. 段间分隔线
    ctx.fillStyle = 'rgba(90, 70, 50, 0.35)';
    items.forEach((item) => {
      if (item.offsetMs === 0) return;
      ctx.fillRect(msToX(item.offsetMs), 0, 1, height);
    });

    // 4. 播放头
    if (playheadMs !== undefined && playheadMs > 0) {
      ctx.fillStyle = '#8c4a24';
      ctx.fillRect(Math.min(width - 1, msToX(playheadMs)), 0, 2, height);
    }
  }, [items, duplicates, width, height, totalDurationMs, playheadMs, offsetByAudioId]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!onSeek || totalDurationMs <= 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    onSeek(Math.round(ratio * totalDurationMs));
  };

  return (
    <div
      ref={containerRef}
      className="froa-wave"
      style={{ height, cursor: onSeek ? 'pointer' : 'default' }}
      onPointerDown={handlePointerDown}
      role="img"
      aria-label="合并时间轴"
    >
      <canvas ref={canvasRef} style={{ height }} />
    </div>
  );
}
