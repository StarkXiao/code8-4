import { useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineTrackDto } from '@froa/shared';

interface TimelineWaveProps {
  tracks: TimelineTrackDto[];
  height?: number;
  /** 时间轴范围（毫秒）；默认用最后一段的偏移 + 时长 */
  totalDurationMs?: number;
  /** 播放头：当前正在播的音频 id + 该音频内位置 */
  activeAudioId?: string | null;
  activeMs?: number;
  /** 点击某段：(audioId, 该段内毫秒) */
  onSeekTrack?: (audioId: string, localMs: number) => void;
}

/**
 * 整条口述时间轴的"拼接波形"。
 *
 * 注意它不拼音频文件（音频是只增不改的证据），只把各段已有的 peaks
 * 按 offsetMs 在视觉上首尾相接，并在段落之间画一条分隔线。
 * 点哪一段就把"段内位置"回传给页面，由全局播放器播对应音频 ——
 * 一条时间轴的观感，底下仍是 N 段独立、可单独回放的原声。
 */
export function TimelineWave({
  tracks,
  height = 110,
  totalDurationMs,
  activeAudioId,
  activeMs = 0,
  onSeekTrack,
}: TimelineWaveProps) {
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

  const total = useMemo(() => {
    if (totalDurationMs && totalDurationMs > 0) return totalDurationMs;
    const last = tracks[tracks.length - 1];
    return last ? last.offsetMs + last.durationMs : 0;
  }, [tracks, totalDurationMs]);

  /** 每段归一化到固定桶数，避免某段特别长时把短段挤没 */
  const BUCKETS = useMemo(() => {
    const target = Math.max(120, Math.floor(width / 4));
    return Math.max(24, Math.floor(target / Math.max(1, tracks.length)));
  }, [width, tracks.length]);

  const resampled = useMemo(() => {
    return tracks.map((track) => {
      const source = track.audio?.peaks ?? [];
      const buckets: number[] = [];
      for (let i = 0; i < BUCKETS; i += 1) {
        const start = Math.floor((i / BUCKETS) * source.length);
        const end = Math.max(start + 1, Math.floor(((i + 1) / BUCKETS) * source.length));
        let max = 0;
        for (let j = start; j < end && j < source.length; j += 1) max = Math.max(max, source[j] ?? 0);
        buckets.push(max);
      }
      return { track, buckets };
    });
  }, [tracks, BUCKETS]);

  if (!tracks.length || total <= 0) return null;

  const xOf = (ms: number) => (ms / total) * width;

  const handleClick = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!onSeekTrack) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const globalMs = ((event.clientX - rect.left) / rect.width) * total;
    const hit = tracks.find(
      (track) => globalMs >= track.offsetMs && globalMs < track.offsetMs + track.durationMs,
    );
    if (hit) onSeekTrack(hit.audioId, Math.max(0, globalMs - hit.offsetMs));
  };

  return (
    <div ref={containerRef} className="froa-timeline-wave" style={{ height, position: 'relative' }}>
      <canvas
        ref={(canvas) => {
          if (!canvas) return;
          const dpr = window.devicePixelRatio || 1;
          canvas.width = width * dpr;
          canvas.height = height * dpr;
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, width, height);
          const mid = height / 2;

          for (const { track, buckets } of resampled) {
            const startX = xOf(track.offsetMs);
            const trackWidth = Math.max(2, xOf(track.durationMs));
            const barWidth = trackWidth / BUCKETS;

            const isActive = track.audioId === activeAudioId;
            buckets.forEach((value, index) => {
              const amplitude = Math.max(1, value * (height / 2 - 6));
              ctx.fillStyle = isActive ? '#8c4a24' : '#c9a88c';
              ctx.fillRect(startX + index * barWidth, mid - amplitude, Math.max(1, barWidth - 1), amplitude * 2);
            });

            // 播放进度：仅当前段画深色覆盖
            if (isActive && track.durationMs > 0) {
              const playedWidth = trackWidth * Math.min(1, activeMs / track.durationMs);
              ctx.fillStyle = 'rgba(140, 74, 36, 0.35)';
              ctx.fillRect(startX, 0, playedWidth, height);
            }
          }

          // 段落分隔线
          ctx.strokeStyle = '#9c8b7d';
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          for (const track of tracks) {
            if (track.offsetMs === 0) continue;
            const x = xOf(track.offsetMs);
            ctx.beginPath();
            ctx.moveTo(x, 2);
            ctx.lineTo(x, height - 2);
            ctx.stroke();
          }
          ctx.setLineDash([]);

          // 全局播放头
          if (activeAudioId) {
            const currentTrack = tracks.find((t) => t.audioId === activeAudioId);
            if (currentTrack) {
              const x = xOf(currentTrack.offsetMs + Math.min(activeMs, currentTrack.durationMs));
              ctx.strokeStyle = '#d35400';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(x, 0);
              ctx.lineTo(x, height);
              ctx.stroke();
            }
          }
        }}
      />
      <div
        style={{ position: 'absolute', inset: 0, cursor: onSeekTrack ? 'pointer' : 'default' }}
        onPointerDown={handleClick}
        role="slider"
        aria-label="时间轴拼接波形"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        tabIndex={0}
      />
    </div>
  );
}
