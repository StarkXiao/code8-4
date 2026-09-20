/**
 * 口述文本相似度。
 *
 * 用途：把同一道菜的多段口述排到同一条时间轴上时，自动找出"重复的表述"
 * （奶奶第一段说"放一点糖"，第二段又说了一遍"放一点点糖"）。
 *
 * 设计原则与模糊描述规则库一致：**只给建议，绝不替人下结论**。
 * 这里算出的只是"疑似重复"，必须由整理者逐组确认后，系统才会执行合并。
 *
 * 算法不追求学术最优，只追求"对中文口语够用、零依赖、前后端同构"：
 * 先按标点切句，再用字符 bigram 的 Dice 系数做句子级相似度。
 * 服务端用同一份代码跑检测（唯一真相），前端只负责展示。
 */

/** 中文 / 英文句子分隔符。换行也视为句子边界。 */
const SENTENCE_SPLIT = /[\n\r。！？!?；;]+/;

/**
 * 口语里几乎没有信息量的尾缀 / 发语词。
 * "放一点糖就行 / 放一点点糖啊 / 就是放一点糖嘛" 说的是同一件事，
 * 这些字不应该把相似度稀释下去。
 */
const SPOKEN_FILLERS = [
  '的时候',
  '就是说',
  '就是',
  '就行',
  '就好',
  '好了',
  '这样子',
  '那样子',
  '啊',
  '呀',
  '吧',
  '嘛',
  '呢',
  '哦',
  '呗',
  '哈',
  '哇',
];

/**
 * 归一化一句口述：
 * - 去掉所有空白与标点（"放 一点 糖。" === "放一点糖"）；
 * - 去掉口语尾缀 / 发语词，降低"就行 / 啊 / 的时候"这类差异的权重；
 * - 繁简 / 大小写在这里不处理，家庭口述场景基本碰不到。
 */
export function normalizeSpoken(text: string | null | undefined): string {
  let out = (text ?? '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
  for (const filler of SPOKEN_FILLERS) out = out.split(filler).join('');
  return out;
}

/** 切成句子，去掉空句与过短的碎片（单字不成"表述"）。 */
export function splitSentences(transcript: string | null | undefined, minLength = 2): string[] {
  if (!transcript) return [];
  return transcript
    .split(SENTENCE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => normalizeSpoken(part).length >= minLength);
}

function bigrams(normalized: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    grams.add(normalized.slice(i, i + 2));
  }
  // 单字句子没有 bigram，退化成单字集合，仍然可以比
  if (normalized.length === 1) grams.add(normalized);
  return grams;
}

/**
 * 两个字符串的相似度，0..1。
 *
 * 组合两种字符 bigram 指标，取加权平均：
 * - Dice 系数 2|A∩B|/(|A|+|B|)：对等长改写敏感；
 * - 重叠系数 |A∩B|/min(|A|,|B|)：长辈复述时常常加一堆前缀尾缀，
 *   核心几个字一样，Dice 会被稀释，重叠系数不会。
 *
 * 这是"疑似重复"的排序信号，不是结论 —— 最终永远由人裁定。
 */
export function textSimilarity(a: string, b: string): number {
  const left = normalizeSpoken(a);
  const right = normalizeSpoken(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  // 短串被长串包含的大部分时也算高相似（"一点糖" 是 "放一点糖就行" 的核心）
  if (left.length >= 2 && right.length >= 2) {
    const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
    if (longer.includes(shorter) && shorter.length >= 4) {
      return Math.max(0.85, shorter.length / longer.length);
    }
  }

  const ga = bigrams(left);
  const gb = bigrams(right);
  let overlapCount = 0;
  for (const gram of ga) if (gb.has(gram)) overlapCount += 1;
  if (overlapCount === 0) return 0;

  // 单 / 双字句的 bigram 太少，重叠系数容易虚高：要求短侧至少 3 个 bigram 才采信
  const minSize = Math.min(ga.size, gb.size);
  const dice = (2 * overlapCount) / (ga.size + gb.size);
  if (minSize < 3) return dice;

  const overlap = overlapCount / minSize;
  return Number((0.55 * dice + 0.45 * overlap).toFixed(3));
}

export interface DuplicateMember {
  /** 这句话出自哪段口述（时间轴上的成员音频） */
  audioId: string;
  /** 原句（未归一化），直接展示给人看 */
  sentence: string;
}

export interface DuplicateGroup {
  /** 组内每一句，按加入顺序排列 */
  members: DuplicateMember[];
  /** 组内两两相似度的最小值，即"最不像的两句有多像" */
  score: number;
}

export interface DetectOptions {
  /** 达到该相似度才认为疑似重复，默认 0.55（对中文口语偏宽容，宁可多报让人否决） */
  threshold?: number;
  /** 单组最多保留几句，避免一段车轱辘话刷出几十条 */
  maxGroupSize?: number;
}

/**
 * 在多段口述中检测重复表述。
 *
 * 输入是若干段"音频 + 转写"，输出是若干个**疑似重复组**：
 * 每组至少两句、且必须来自**不同的音频段**
 *（同一段录音里自己重复两遍不属于"多段口述合并"要处理的问题）。
 *
 * 归并策略用并查集：A~B、B~C 会被并成同一组，即使 A、C 本身不够像 ——
 * 人看到整组再判断，比机器硬切更可靠。
 */
export function detectDuplicateStatements(
  segments: { audioId: string; transcript: string | null | undefined }[],
  options: DetectOptions = {},
): DuplicateGroup[] {
  const { threshold = 0.55, maxGroupSize = 12 } = options;

  interface Node extends DuplicateMember {
    key: number;
  }

  const nodes: Node[] = [];
  for (const segment of segments) {
    for (const sentence of splitSentences(segment.transcript)) {
      nodes.push({ key: nodes.length, audioId: segment.audioId, sentence });
    }
  }

  const parent = nodes.map((node) => node.key);
  const find = (key: number): number => {
    let root = key;
    while (parent[root] !== root) {
      const next = parent[root];
      if (next === undefined) break;
      root = next;
    }
    let cursor = key;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      if (next === undefined) break;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    parent[rootA] = rootB;
  };

  // 记录"够像"的配对即可，并查集负责把传递性的重复（A~B、B~C）并成一组
  for (let i = 0; i < nodes.length; i += 1) {
    const left = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const right = nodes[j]!;
      // 关键约束：只跨音频段配对
      if (left.audioId === right.audioId) continue;
      const score = textSimilarity(left.sentence, right.sentence);
      if (score < threshold) continue;
      union(left.key, right.key);
    }
  }

  const buckets = new Map<number, Node[]>();
  for (const node of nodes) {
    const root = find(node.key);
    const bucket = buckets.get(root) ?? [];
    bucket.push(node);
    buckets.set(root, bucket);
  }

  const groups: DuplicateGroup[] = [];
  for (const bucket of buckets.values()) {
    const audioIds = new Set(bucket.map((node) => node.audioId));
    if (bucket.length < 2 || audioIds.size < 2) continue;

    // 组分数 = 组内跨音频句子两两相似度的最小值（"最不像的两句有多像"）。
    // 经并查集并组后 A、C 可能本身不够阈值，按真实相似度计，分数低就排在后面等人多看一眼。
    let score: number | null = null;
    for (let i = 0; i < bucket.length; i += 1) {
      const memberA = bucket[i]!;
      for (let j = i + 1; j < bucket.length; j += 1) {
        const memberB = bucket[j]!;
        if (memberA.audioId === memberB.audioId) continue;
        const pair = textSimilarity(memberA.sentence, memberB.sentence);
        score = score === null ? pair : Math.min(score, pair);
      }
    }

    groups.push({
      members: bucket.slice(0, maxGroupSize).map(({ audioId, sentence }) => ({ audioId, sentence })),
      score: Number((score ?? 0).toFixed(3)),
    });
  }

  // 最像的组排在最前面
  return groups.sort((a, b) => b.score - a.score);
}
