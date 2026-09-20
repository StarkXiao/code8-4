/**
 * 多段口述合并时间轴 —— 接口级闭环测试。
 *
 * 覆盖：
 *   上传多段口述 -> 创建合并提案（自动标出重复表述）
 *   -> 未确认完重复表述时合并被闸门拦下 -> 逐条确认/驳回 -> 合并成功
 *   -> 已合并的提案不可再改；同一食谱同时只允许一个待确认提案；
 *   权限边界（贡献者只读、非成员拒绝、跨食谱音频拒绝）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/db/client';

const app = createApp();

interface Session {
  token: string;
  userId: string;
}

async function register(email: string, displayName: string): Promise<Session> {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'froa12345', displayName })
    .expect(201);
  return {
    token: response.body.data.tokens.accessToken as string,
    userId: response.body.data.user.id as string,
  };
}

const auth = (session: Session) => ({ Authorization: `Bearer ${session.token}` });

function fakeWav(seconds = 1): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function uploadAudio(
  session: Session,
  recipeId: string,
  durationMs: number,
  transcript?: string,
): Promise<string> {
  const uploaded = await request(app)
    .post('/api/audio')
    .set(auth(session))
    .field('recipeId', recipeId)
    .field('kind', 'recipe_voice')
    .field('durationMs', String(durationMs))
    .attach('file', fakeWav(), { filename: 'voice.wav', contentType: 'audio/wav' })
    .expect(201);

  const audioId = uploaded.body.data.id as string;
  if (transcript !== undefined) {
    await request(app)
      .patch(`/api/audio/${audioId}/transcript`)
      .set(auth(session))
      .send({ transcript })
      .expect(200);
  }
  return audioId;
}

describe('多段口述合并到同一条时间轴', () => {
  let organizer: Session;
  let contributor: Session;
  let outsider: Session;
  let recipeId = '';
  let otherRecipeId = '';
  // 三段口述：a1 与 a2 有重复表述，a3 没有转写
  let audio1 = '';
  let audio2 = '';
  let audio3 = '';
  let audioOther = '';
  let mergeId = '';

  beforeAll(async () => {
    organizer = await register('merge-organizer@e2e.test', '整理者');
    contributor = await register('merge-contributor@e2e.test', '外婆');
    outsider = await register('merge-outsider@e2e.test', '路人');

    const ws = await request(app)
      .post('/api/workspaces')
      .set(auth(organizer))
      .send({ name: '合并测试厨房' })
      .expect(201);
    await request(app)
      .post('/api/workspaces/join')
      .set(auth(contributor))
      .send({ inviteCode: ws.body.data.inviteCode })
      .expect(201);

    const recipe = await request(app)
      .post('/api/recipes')
      .set(auth(organizer))
      .send({ workspaceId: ws.body.data.id, title: '红烧肉' })
      .expect(201);
    recipeId = recipe.body.data.id;

    const other = await request(app)
      .post('/api/recipes')
      .set(auth(organizer))
      .send({ workspaceId: ws.body.data.id, title: '清蒸鱼' })
      .expect(201);
    otherRecipeId = other.body.data.id;

    audio1 = await uploadAudio(organizer, recipeId, 30_000, '先炒糖色，放一点糖就行。中火炒到收汁。');
    audio2 = await uploadAudio(organizer, recipeId, 45_000, '肉先焯水。放一点糖就行。炖到用筷子能戳透。');
    audio3 = await uploadAudio(organizer, recipeId, 10_000); // 没转写：照常进时间轴，只是不参与比对
    audioOther = await uploadAudio(organizer, otherRecipeId, 20_000, '放一点糖就行。');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. 权限边界：贡献者只读，非成员一律拒绝', async () => {
    await request(app)
      .post(`/api/recipes/${recipeId}/timeline-merges`)
      .set(auth(contributor))
      .send({ audioIds: [audio1, audio2] })
      .expect(403);

    // 贡献者可以查看列表（合并结果对全家人可见）
    const list = await request(app)
      .get(`/api/recipes/${recipeId}/timeline-merges`)
      .set(auth(contributor))
      .expect(200);
    expect(list.body.data).toEqual([]);

    await request(app)
      .get(`/api/recipes/${recipeId}/timeline-merges`)
      .set(auth(outsider))
      .expect(403);
    await request(app)
      .post(`/api/recipes/${recipeId}/timeline-merges`)
      .set(auth(outsider))
      .send({ audioIds: [audio1, audio2] })
      .expect(403);
  });

  it('2. 参数校验：少于两段、跨食谱的音频都被拒绝', async () => {
    await request(app)
      .post(`/api/recipes/${recipeId}/timeline-merges`)
      .set(auth(organizer))
      .send({ audioIds: [audio1] })
      .expect(400);

    // 同一段选两次等于只选了一段
    await request(app)
      .post(`/api/recipes/${recipeId}/timeline-merges`)
      .set(auth(organizer))
      .send({ audioIds: [audio1, audio1] })
      .expect(400);

    // audioOther 属于另一张食谱，混进来必须拒绝
    const cross = await request(app)
      .post(`/api/recipes/${recipeId}/timeline-merges`)
      .set(auth(organizer))
      .send({ audioIds: [audio1, audioOther] })
      .expect(400);
    expect(cross.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('3. 创建提案：三段口述首尾相接排上时间轴，重复表述自动标为待确认', async () => {
    const created = await request(app)
      .post(`/api/recipes/${recipeId}/timeline-merges`)
      .set(auth(organizer))
      .send({ audioIds: [audio1, audio2, audio3] })
      .expect(201);

    const merge = created.body.data;
    mergeId = merge.id;
    expect(merge.status).toBe('reviewing');
    expect(merge.items).toHaveLength(3);
    // 默认布局：0 / 30000 / 75000，总时长 85000
    expect(merge.items.map((item: { offsetMs: number }) => item.offsetMs)).toEqual([0, 30_000, 75_000]);
    expect(merge.totalDurationMs).toBe(85_000);
    expect(merge.items[0].audio.id).toBe(audio1);

    // "放一点糖就行"在 a1、a2 里都说了 —— 应被标出且全部待确认
    expect(merge.duplicates).toHaveLength(1);
    const duplicate = merge.duplicates[0];
    expect(duplicate.status).toBe('pending');
    expect(duplicate.displayText).toContain('放一点糖');
    expect(duplicate.occurrences).toHaveLength(2);
    expect(duplicate.occurrences.map((o: { audioId: string }) => o.audioId).sort()).toEqual(
      [audio1, audio2].sort(),
    );
    expect(merge.counts).toEqual({
      items: 3,
      pendingDuplicates: 1,
      confirmedDuplicates: 0,
      dismissedDuplicates: 0,
    });
  });

  it('4. 还有待确认的重复表述时，合并被闸门拦下', async () => {
    const blocked = await request(app)
      .post(`/api/timeline-merges/${mergeId}/merge`)
      .set(auth(organizer))
      .expect(409);
    expect(blocked.body.error.code).toBe('TIMELINE_DUPLICATES_PENDING');
    expect(blocked.body.error.details.pending).toBe(1);
  });

  it('5. 人工确认重复表述后，合并放行；时间轴与标记都保留', async () => {
    const detail = await request(app)
      .get(`/api/timeline-merges/${mergeId}`)
      .set(auth(organizer))
      .expect(200);
    const duplicateId = detail.body.data.duplicates[0].id;

    const confirmed = await request(app)
      .post(`/api/timeline-duplicates/${duplicateId}/confirm`)
      .set(auth(organizer))
      .expect(200);
    expect(confirmed.body.data.counts.confirmedDuplicates).toBe(1);
    expect(confirmed.body.data.duplicates[0].resolvedBy).toBe(organizer.userId);

    const merged = await request(app)
      .post(`/api/timeline-merges/${mergeId}/merge`)
      .set(auth(organizer))
      .expect(200);
    expect(merged.body.data.status).toBe('merged');
    expect(merged.body.data.mergedAt).not.toBeNull();
    // 合并后时间轴与确认过的标记仍然完整可查
    expect(merged.body.data.items).toHaveLength(3);
    expect(merged.body.data.duplicates[0].status).toBe('confirmed');
  });

  it('6. 已合并的提案是终态：不能再改标记、调偏移、重复合并或放弃', async () => {
    const detail = await request(app)
      .get(`/api/timeline-merges/${mergeId}`)
      .set(auth(organizer))
      .expect(200);
    const duplicateId = detail.body.data.duplicates[0].id;
    const itemId = detail.body.data.items[0].id;

    await request(app)
      .post(`/api/timeline-duplicates/${duplicateId}/dismiss`)
      .set(auth(organizer))
      .expect(409);
    await request(app)
      .patch(`/api/timeline-merge-items/${itemId}`)
      .set(auth(organizer))
      .send({ offsetMs: 500 })
      .expect(409);
    await request(app).post(`/api/timeline-merges/${mergeId}/merge`).set(auth(organizer)).expect(409);
    await request(app).post(`/api/timeline-merges/${mergeId}/discard`).set(auth(organizer)).expect(409);
  });

  it('7. 待确认状态下可以调整各段在时间轴上的位置', async () => {
    const created = await request(app)
      .post(`/api/recipes/${recipeId}/timeline-merges`)
      .set(auth(organizer))
      .send({ audioIds: [audio1, audio2] })
      .expect(201);
    const secondMergeId = created.body.data.id;
    const itemId = created.body.data.items[1].id;

    const moved = await request(app)
      .patch(`/api/timeline-merge-items/${itemId}`)
      .set(auth(organizer))
      .send({ offsetMs: 40_000 })
      .expect(200);
    expect(moved.body.data.offsetMs).toBe(40_000);

    const detail = await request(app)
      .get(`/api/timeline-merges/${secondMergeId}`)
      .set(auth(organizer))
      .expect(200);
    // 总时长随偏移实时重算：40000 + 45000
    expect(detail.body.data.totalDurationMs).toBe(85_000);

    // 同一食谱同时只允许一个待确认的提案
    const dup = await request(app)
      .post(`/api/recipes/${recipeId}/timeline-merges`)
      .set(auth(organizer))
      .send({ audioIds: [audio1, audio2] })
      .expect(409);
    expect(dup.body.error.code).toBe('TIMELINE_MERGE_REVIEW_PENDING');

    // 驳回全部重复表述后放弃，之后可以再开新提案
    for (const duplicate of detail.body.data.duplicates as { id: string }[]) {
      await request(app)
        .post(`/api/timeline-duplicates/${duplicate.id}/dismiss`)
        .set(auth(organizer))
        .expect(200);
    }
    const discarded = await request(app)
      .post(`/api/timeline-merges/${secondMergeId}/discard`)
      .set(auth(organizer))
      .expect(200);
    expect(discarded.body.data.status).toBe('discarded');

    await request(app)
      .post(`/api/recipes/${recipeId}/timeline-merges`)
      .set(auth(organizer))
      .send({ audioIds: [audio2, audio3] })
      .expect(201);
  });

  it('8. 列表能区分待确认 / 已合并 / 已放弃，并带上确认进度', async () => {
    const list = await request(app)
      .get(`/api/recipes/${recipeId}/timeline-merges`)
      .set(auth(organizer))
      .expect(200);

    const byStatus = new Map<string, { counts: { pendingDuplicates: number } }>(
      list.body.data.map((merge: { status: string } & object) => [merge.status, merge]),
    );
    expect(byStatus.has('reviewing')).toBe(true);
    expect(byStatus.has('merged')).toBe(true);
    expect(byStatus.has('discarded')).toBe(true);
    // a2 与 a3 没有重复表述（a3 没转写），新提案里没有待确认项
    expect(byStatus.get('reviewing')!.counts.pendingDuplicates).toBe(0);
  });

  it('9. 合并过程写审计日志，谁确认的、谁合并的都查得到', async () => {
    const logs = await prisma.activityLog.findMany({
      where: { entityType: { in: ['timeline_merge', 'timeline_duplicate'] } },
      orderBy: { createdAt: 'asc' },
    });
    const actions = logs.map((log) => log.action);
    expect(actions).toContain('timeline_merge.create');
    expect(actions).toContain('timeline_duplicate.confirm');
    expect(actions).toContain('timeline_duplicate.dismiss');
    expect(actions).toContain('timeline_merge.merge');
    expect(actions).toContain('timeline_merge.discard');
    expect(logs.every((log) => log.actorId === organizer.userId)).toBe(true);
  });
});
