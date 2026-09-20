import { describe, expect, it } from 'vitest';
import {
  detectDuplicatePhrases,
  layoutTimelineItems,
  normalizeNarration,
  splitNarrationClauses,
} from '@froa/shared';

describe('口述文本归一化', () => {
  it('去掉标点、空白与口头禅，保留到原文的下标映射', () => {
    const { normalized, originIndex } = normalizeNarration('然后，放一点糖就行！');
    expect(normalized).toBe('放一点糖就行');
    // 映射回原文：第一个字"放"在原文第 3 位（"然后，"之后）
    expect(originIndex[0]).toBe(3);
  });

  it('长口头禅优先匹配，不会留下残字', () => {
    expect(normalizeNarration('然后呢加盐').normalized).toBe('加盐');
    expect(normalizeNarration('那个这个先炒糖色').normalized).toBe('先炒糖色');
  });
});

describe('子句切分', () => {
  it('按中英文标点与换行切句，并记录原文区间', () => {
    const text = '先炒糖色，放一点糖就行。\n中火炒到收汁';
    const clauses = splitNarrationClauses(text);
    expect(clauses.map((c) => c.text)).toEqual(['先炒糖色', '放一点糖就行', '中火炒到收汁']);
    expect(text.slice(clauses[1]!.startChar, clauses[1]!.endChar)).toBe('放一点糖就行');
  });
});

describe('重复表述检测', () => {
  it('两段口述说了一样的话会被标出来，并给出各自的出现位置', () => {
    const candidates = detectDuplicatePhrases([
      { audioId: 'a1', transcript: '先炒糖色，放一点糖就行，中火收汁', durationMs: 30_000 },
      { audioId: 'a2', transcript: '肉先焯水。放一点糖就行，别糊锅', durationMs: 60_000 },
    ]);

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.normalizedText).toBe('放一点糖就行');
    expect(candidate.occurrences).toHaveLength(2);
    expect(candidate.occurrences.map((o) => o.audioId).sort()).toEqual(['a1', 'a2']);
    // 时间是按字符位置等比估算的：第二段里这句话靠后，估算时间也更靠后
    const [first, second] = candidate.occurrences;
    expect(first!.estimatedStartMs).toBeLessThan(30_000);
    expect(second!.estimatedStartMs).toBeGreaterThan(0);
  });

  it('一句话是另一句的一部分时，归并到共同部分', () => {
    const candidates = detectDuplicatePhrases([
      { audioId: 'a1', transcript: '放一点糖', durationMs: 10_000 },
      { audioId: 'a2', transcript: '这里放一点糖就行', durationMs: 10_000 },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.normalizedText).toBe('放一点糖');
    expect(candidates[0]!.occurrences).toHaveLength(2);
  });

  it('口头禅差异不会造成漏报', () => {
    const candidates = detectDuplicatePhrases([
      { audioId: 'a1', transcript: '然后中火炒到收汁', durationMs: 10_000 },
      { audioId: 'a2', transcript: '中火炒到收汁', durationMs: 10_000 },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.normalizedText).toBe('中火炒到收汁');
  });

  it('只在同一段口述里重复不算数 —— 合并关心的是跨段重复', () => {
    const candidates = detectDuplicatePhrases([
      { audioId: 'a1', transcript: '放一点糖。等一下，放一点糖。', durationMs: 10_000 },
      { audioId: 'a2', transcript: '先焯水再下锅', durationMs: 10_000 },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('太短的子句不参与比对，没有转写的段落被跳过', () => {
    const candidates = detectDuplicatePhrases([
      { audioId: 'a1', transcript: '加盐。好。嗯。', durationMs: 10_000 },
      { audioId: 'a2', transcript: '加盐。行。', durationMs: 10_000 },
      { audioId: 'a3', transcript: null, durationMs: 10_000 },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('多组重复按出现次数与长度排序', () => {
    const candidates = detectDuplicatePhrases([
      { audioId: 'a1', transcript: '放一点糖就行。中火炒到收汁。', durationMs: 10_000 },
      { audioId: 'a2', transcript: '放一点糖就行。中火炒到收汁。', durationMs: 10_000 },
      { audioId: 'a3', transcript: '中火炒到收汁就行', durationMs: 10_000 },
    ]);

    expect(candidates.length).toBeGreaterThanOrEqual(2);
    // "中火炒到收汁"出现在三段里，应排在最前
    expect(candidates[0]!.normalizedText).toBe('中火炒到收汁');
    expect(candidates[0]!.occurrences.length).toBeGreaterThanOrEqual(3);
  });
});

describe('时间轴默认布局', () => {
  it('各段按顺序首尾相接', () => {
    const layout = layoutTimelineItems([
      { id: 'a', durationMs: 1000 },
      { id: 'b', durationMs: 2500 },
      { id: 'c', durationMs: 500 },
    ]);
    expect(layout).toEqual([
      { audioId: 'a', orderIndex: 0, offsetMs: 0 },
      { audioId: 'b', orderIndex: 1, offsetMs: 1000 },
      { audioId: 'c', orderIndex: 2, offsetMs: 3500 },
    ]);
  });
});
