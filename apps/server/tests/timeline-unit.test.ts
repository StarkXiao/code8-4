import { describe, expect, it } from 'vitest';
import { detectDuplicateStatements, normalizeSpoken, splitSentences, textSimilarity } from '@froa/shared';

describe('口述文本归一化与切句', () => {
  it('去掉空白与标点，便于口语差异比较', () => {
    expect(normalizeSpoken(' 放一点 糖。！')).toBe('放一点糖');
    expect(normalizeSpoken(null)).toBe('');
  });

  it('按中英文句读与换行切分，丢弃碎片', () => {
    const sentences = splitSentences('先炒糖色。\n放一点糖就行！然后中火收汁?');
    expect(sentences).toEqual(['先炒糖色', '放一点糖就行', '然后中火收汁']);
  });
});

describe('句子相似度', () => {
  it('完全相同得 1', () => {
    expect(textSimilarity('放一点糖', '放一点糖')).toBe(1);
  });

  it('一两个字之差仍高度相似', () => {
    expect(textSimilarity('放一点糖', '放一点点糖')).toBeGreaterThan(0.55);
  });

  it('意思不同的工序句不应误判', () => {
    expect(textSimilarity('先把五花肉切块', '最后大火收汁十分钟')).toBeLessThan(0.3);
  });

  it('短串被长串包含时给高相似（核心说法重复）', () => {
    expect(textSimilarity('炖到筷子能戳透', '肉要炖到筷子能戳透才行')).toBeGreaterThanOrEqual(0.85);
  });
});

describe('跨音频重复表述检测', () => {
  it('能把两段口述里的同义重复归成一组', () => {
    const groups = detectDuplicateStatements([
      { audioId: 'a1', transcript: '先炒糖色。放一点糖就行。中火炖半小时。' },
      { audioId: 'a2', transcript: '放一点点糖啊。出锅前撒葱花。' },
    ]);

    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    const audioIds = new Set(group.members.map((member) => member.audioId));
    expect(audioIds.has('a1')).toBe(true);
    expect(audioIds.has('a2')).toBe(true);
    expect(group.score).toBeGreaterThan(0.55);
  });

  it('同一段录音里的重复不报告 —— 只处理"多段"之间的重复', () => {
    const groups = detectDuplicateStatements([
      { audioId: 'a1', transcript: '放一点糖。放一点糖。再说一遍放一点糖。' },
    ]);
    expect(groups).toHaveLength(0);
  });

  it('没有任何重复时返回空数组', () => {
    const groups = detectDuplicateStatements([
      { audioId: 'a1', transcript: '五花肉切块冷水下锅。' },
      { audioId: 'a2', transcript: '小火炒出糖色再下肉。' },
    ]);
    expect(groups).toHaveLength(0);
  });

  it('传递性重复（A~B、B~C）会并成同一组', () => {
    const groups = detectDuplicateStatements(
      [
        { audioId: 'a1', transcript: '炖到筷子能轻松戳透。' },
        { audioId: 'a2', transcript: '要炖到筷子能戳透才行。' },
        { audioId: 'a3', transcript: '炖到筷子能戳穿。' },
      ],
      { threshold: 0.34 },
    );
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const merged = groups.find((group) => new Set(group.members.map((m) => m.audioId)).size === 3);
    expect(merged).toBeTruthy();
  });

  it('阈值越高越严格', () => {
    const segments = [
      { audioId: 'a1', transcript: '放一点糖就行。' },
      { audioId: 'a2', transcript: '糖放一点点就好。' },
    ];
    expect(detectDuplicateStatements(segments, { threshold: 0.4 }).length).toBeGreaterThan(0);
    expect(detectDuplicateStatements(segments, { threshold: 0.98 })).toHaveLength(0);
  });

  it('缺少转写的段落被安全跳过', () => {
    expect(() =>
      detectDuplicateStatements([
        { audioId: 'a1', transcript: null },
        { audioId: 'a2', transcript: undefined },
        { audioId: 'a3', transcript: '放一点糖。放一点糖。' },
      ]),
    ).not.toThrow();
  });
});
