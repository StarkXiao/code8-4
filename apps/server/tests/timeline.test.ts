/**
 * 口述时间轴集成测试。
 *
 * 覆盖用户故事：
 *   同一道菜分两段录 -> 排到同一条时间轴 -> 扫描自动标出重复表述
 *   -> 没确认就合并被闸门拦下 -> 逐组人工裁定 -> 写说明后合并定稿
 *   -> 合并文稿里重复句只保留首选句、每段原声仍可追溯
 *
 * 另外回归：跨食谱音频不能加入、贡献者不能下结论、乐观锁、定稿后改轨道被拒、重开。
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

async function register(email: string, displayName: string, role: 'owner' | 'contributor' = 'owner'): Promise<Session> {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'froa12345', displayName })
    .expect(201);
  const session = {
    token: response.body.data.tokens.accessToken as string,
    userId: response.body.data.user.id as string,
  };
  if (role === 'contributor') {
    // 调用方在加入空间后自行用，这里仅注册
  }
  return session;
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

async function uploadVoice(
  session: Session,
  recipeId: string,
  transcript: string,
  durationMs = 1000,
): Promise<string> {
  const uploaded = await request(app)
    .post('/api/audio')
    .set(auth(session))
    .field('recipeId', recipeId)
    .field('kind', 'recipe_voice')
    .field('durationMs', String(durationMs))
    .field('peaks', JSON.stringify([0.1, 0.5, 0.9, 0.4]))
    .attach('file', fakeWav(), { filename: 'voice.wav', contentType: 'audio/wav' })
    .expect(201);

  const audioId = uploaded.body.data.id as string;
  await request(app)
    .patch(`/api/audio/${audioId}/transcript`)
    .set(auth(session))
    .send({ transcript, transcriptStatus: 'done' })
    .expect(200);
  return audioId;
}

describe('口述时间轴：多段口述合并与重复表述人工确认', () => {
  let organizer: Session;
  let grandma: Session;
  let outsider: Session;
  let workspaceId = '';
  let recipeId = '';
  let otherRecipeId = '';
  let audio1 = '';
  let audio2 = '';
  let timelineId = '';
  let groupId = '';

  beforeAll(async () => {
    organizer = await register('tl-organizer@e2e.test', '整理者');
    grandma = await register('tl-grandma@e2e.test', '外婆');
    outsider = await register('tl-outsider@e2e.test', '外人');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. 建空间、拉外婆进来（贡献者）、建两张食谱', async () => {
    const ws = await request(app)
      .post('/api/workspaces')
      .set(auth(organizer))
      .send({ name: '时间轴测试厨房' })
      .expect(201);
    workspaceId = ws.body.data.id;

    await request(app)
      .post('/api/workspaces/join')
      .set(auth(grandma))
      .send({ inviteCode: ws.body.data.inviteCode })
      .expect(201);
    // 加入者默认就是 contributor（见 seed/join 逻辑），用成员列表确认
    const members = await request(app)
      .get(`/api/workspaces/${workspaceId}/members`)
      .set(auth(organizer))
      .expect(200);
    const grandmaMember = members.body.data.find((m: { userId: string }) => m.userId === grandma.userId);
    expect(grandmaMember.role).toBe('contributor');

    const recipe = await request(app)
      .post('/api/recipes')
      .set(auth(organizer))
      .send({ workspaceId, title: '红烧肉' })
      .expect(201);
    recipeId = recipe.body.data.id;

    const other = await request(app)
      .post('/api/recipes')
      .set(auth(organizer))
      .send({ workspaceId, title: '糖醋排骨' })
      .expect(201);
    otherRecipeId = other.body.data.id;
  });

  it('2. 外婆分两段录同一道菜，两段里都提到了糖的用量', async () => {
    audio1 = await uploadVoice(
      organizer,
      recipeId,
      '先把五花肉切块冷水下锅。炒糖色的时候放一点糖就行。然后中火炖半个小时。',
      1000,
    );
    audio2 = await uploadVoice(
      organizer,
      recipeId,
      '炒糖色放一点点糖啊。出锅之前再大火收汁。',
      2000,
    );
    expect(audio1).not.toBe(audio2);
  });

  it('3. 创建时间轴并把两段口述按顺序排上去，偏移按时长累加', async () => {
    const created = await request(app)
      .post(`/api/recipes/${recipeId}/timelines`)
      .set(auth(organizer))
      .send({ title: '外婆两次口述合并', audioIds: [audio1, audio2] })
      .expect(201);

    timelineId = created.body.data.id;
    expect(created.body.data.status).toBe('building');
    const tracks = created.body.data.tracks;
    expect(tracks).toHaveLength(2);
    expect(tracks[0].audioId).toBe(audio1);
    expect(tracks[0].offsetMs).toBe(0);
    expect(tracks[1].audioId).toBe(audio2);
    expect(tracks[1].offsetMs).toBe(1000);
    expect(created.body.data.duplicateGroups).toEqual([]);
  });

  it('4. 不能把另一道菜（或不存在）的音频拖进时间轴', async () => {
    const otherAudio = await uploadVoice(organizer, otherRecipeId, '这是糖醋排骨的口述。', 500);
    const res = await request(app)
      .post(`/api/timelines/${timelineId}/tracks`)
      .set(auth(organizer))
      .send({ audioIds: [otherAudio] })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');

    await request(app)
      .post(`/api/timelines/${timelineId}/tracks`)
      .set(auth(organizer))
      .send({ audioIds: ['does-not-exist'] })
      .expect(400);
  });

  it('5. 空间外的人看不到时间轴', async () => {
    await request(app)
      .get(`/api/timelines/${timelineId}`)
      .set(auth(outsider))
      .expect(403);
  });

  it('6. 扫描重复表述：糖的两句被自动标到同一组，状态进入"待确认"', async () => {
    const res = await request(app)
      .post(`/api/timelines/${timelineId}/scan-duplicates`)
      .set(auth(organizer))
      .send({})
      .expect(200);

    expect(res.body.data.status).toBe('reviewing');
    const groups = res.body.data.duplicateGroups;
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const sugar = groups.find((g: { members: { sentence: string }[] }) =>
      g.members.some((m) => m.sentence.includes('糖')),
    );
    expect(sugar).toBeTruthy();
    expect(sugar.status).toBe('pending');
    const memberAudioIds = new Set(sugar.members.map((m: { audioId: string }) => m.audioId));
    expect(memberAudioIds.has(audio1)).toBe(true);
    expect(memberAudioIds.has(audio2)).toBe(true);
    groupId = sugar.id;
  });

  it('7. 没逐组确认就合并 —— 必须被闸门拦下', async () => {
    const res = await request(app)
      .post(`/api/timelines/${timelineId}/merge`)
      .set(auth(organizer))
      .send({ changeNote: '我直接合了不想看' })
      .expect(409);
    expect(res.body.error.code).toBe('TIMELINE_HAS_PENDING_REVIEW');
    expect(res.body.error.details.pendingGroupIds).toContain(groupId);
  });

  it('8. 贡献者（外婆）不能替人下结论：裁定与合并都被拒绝', async () => {
    await request(app)
      .post(`/api/timelines/${timelineId}/duplicates/${groupId}/review`)
      .set(auth(grandma))
      .send({ status: 'duplicate', keepAudioId: audio1 })
      .expect(403);

    await request(app)
      .post(`/api/timelines/${timelineId}/merge`)
      .set(auth(grandma))
      .send({ changeNote: '外婆也想合并一下' })
      .expect(403);
  });

  it('9. 确认重复但不指定保留哪一句 —— 拒绝', async () => {
    const res = await request(app)
      .post(`/api/timelines/${timelineId}/duplicates/${groupId}/review`)
      .set(auth(organizer))
      .send({ status: 'duplicate' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('10. 整理者逐组人工裁定：确认是重复，保留第一段的说法', async () => {
    const res = await request(app)
      .post(`/api/timelines/${timelineId}/duplicates/${groupId}/review`)
      .set(auth(organizer))
      .send({ status: 'duplicate', keepAudioId: audio1, note: '就是同一件事，第二段是顺口重复' })
      .expect(200);

    const reviewed = res.body.data.duplicateGroups.find((g: { id: string }) => g.id === groupId);
    expect(reviewed.status).toBe('duplicate');
    expect(reviewed.keepAudioId).toBe(audio1);
    expect(reviewed.reviewedBy).toBe(organizer.userId);
    expect(res.body.data.pendingReviewCount).toBe(0);
  });

  it('11. 合并说明太短不允许（与发布版本同一口径）', async () => {
    const res = await request(app)
      .post(`/api/timelines/${timelineId}/merge`)
      .set(auth(organizer))
      .send({ changeNote: '好了' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('12. 写清取舍说明后合并定稿：重复句只保留首选句，两段原文都仍可追溯', async () => {
    const res = await request(app)
      .post(`/api/timelines/${timelineId}/merge`)
      .set(auth(organizer))
      .send({ changeNote: '糖的用量两句重复，保留第一次口述的说法；其余按时间顺序拼接。' })
      .expect(200);

    expect(res.body.data.status).toBe('merged');
    expect(res.body.data.mergedBy).toBe(organizer.userId);
    expect(res.body.data.totalDurationMs).toBe(3000);

    const transcript: string = res.body.data.mergedTranscript;
    // 第一段三句都在
    expect(transcript).toContain('五花肉切块');
    expect(transcript).toContain('放一点糖就行');
    expect(transcript).toContain('中火炖半个小时');
    // 第二段里重复的糖句被去掉，非重复句保留
    expect(transcript).not.toContain('放一点点糖啊');
    expect(transcript).toContain('大火收汁');

    // 轨道没有被物理改动：两段原声与偏移都还在，证据链完整
    expect(res.body.data.tracks).toHaveLength(2);
    expect(res.body.data.tracks[0].audio.id).toBe(audio1);
    expect(res.body.data.tracks[1].audio.id).toBe(audio2);
  });

  it('13. 定稿后轨道被锁：想改顺序 / 加段落都被拒绝，必须先重开', async () => {
    await request(app)
      .post(`/api/timelines/${timelineId}/reorder`)
      .set(auth(organizer))
      .send({ orderedAudioIds: [audio2, audio1] })
      .expect(409);

    const extra = await uploadVoice(organizer, recipeId, '后来又补录了一句。', 300);
    const add = await request(app)
      .post(`/api/timelines/${timelineId}/tracks`)
      .set(auth(organizer))
      .send({ audioIds: [extra] })
      .expect(409);
    expect(add.body.error.code).toBe('TIMELINE_INVALID_TRANSITION');
  });

  it('14. 乐观锁：拿着旧时间戳重开会收到 409', async () => {
    const detail = await request(app)
      .get(`/api/timelines/${timelineId}`)
      .set(auth(organizer))
      .expect(200);
    const stale = detail.body.data.updatedAt;

    // 先用旧时间戳重开成功一次
    await request(app)
      .post(`/api/timelines/${timelineId}/reopen`)
      .set(auth(organizer))
      .send({ reason: '发现还得补一段', expectedUpdatedAt: stale })
      .expect(200);

    // 再用同一个旧时间戳合并（update 路径也走乐观锁），应当冲突
    const conflict = await request(app)
      .post(`/api/timelines/${timelineId}/merge`)
      .set(auth(organizer))
      .send({ changeNote: '拿旧时间戳强行合并', expectedUpdatedAt: stale })
      .expect(409);
    expect(conflict.body.error.code).toBe('EDIT_CONFLICT');
  });

  it('15. 重开后已有的人工裁定保留；重新扫描只清理待确认组', async () => {
    const res = await request(app)
      .post(`/api/timelines/${timelineId}/scan-duplicates`)
      .set(auth(organizer))
      .send({ replacePending: true })
      .expect(200);

    const reviewed = res.body.data.duplicateGroups.find((g: { id: string }) => g.id === groupId);
    expect(reviewed).toBeTruthy();
    expect(reviewed.status).toBe('duplicate');
  });

  it('16. 全部确认后可以再次合并；单段时间轴不允许合并', async () => {
    // 把新扫描产生的 pending 组逐组判为"不是重复"
    const detail = await request(app)
      .get(`/api/timelines/${timelineId}`)
      .set(auth(organizer))
      .expect(200);
    for (const group of detail.body.data.duplicateGroups) {
      if (group.status !== 'pending') continue;
      await request(app)
        .post(`/api/timelines/${timelineId}/duplicates/${group.id}/review`)
        .set(auth(organizer))
        .send({ status: 'distinct', note: '其实是两句不同的话' })
        .expect(200);
    }

    await request(app)
      .post(`/api/timelines/${timelineId}/merge`)
      .set(auth(organizer))
      .send({ changeNote: '补充了一句口述，复核完成，重新定稿。' })
      .expect(200);

    // 单段时间轴：创建后直接合并应被业务校验拒绝
    const single = await uploadVoice(organizer, otherRecipeId, '只有一段口述。', 400);
    const tl = await request(app)
      .post(`/api/recipes/${otherRecipeId}/timelines`)
      .set(auth(organizer))
      .send({ title: '单段', audioIds: [single] })
      .expect(201);
    const res = await request(app)
      .post(`/api/timelines/${tl.body.data.id}/merge`)
      .set(auth(organizer))
      .send({ changeNote: '只有一段也想合并试试看会怎样' })
      .expect(400);
    expect(res.body.error.message).toContain('两段');
  });
});
