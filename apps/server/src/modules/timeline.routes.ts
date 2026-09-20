import { Router } from 'express';
import {
  addTimelineTracksSchema,
  createTimelineSchema,
  mergeTimelineSchema,
  reopenTimelineSchema,
  reorderTimelineTracksSchema,
  reviewDuplicateSchema,
  scanTimelineSchema,
  updateTimelineSchema,
} from '@froa/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';
import { asyncHandler, created, send } from '../lib/http';
import { newId } from '../lib/ids';
import { assertNotStale } from '../lib/concurrency';
import { parseJson, stringifyJson } from '../lib/json';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { assertRecipeRole } from '../services/access';
import { logActivity } from '../services/activity';
import { emitToWorkspace } from '../realtime/hub';
import {
  toDuplicateGroupDto,
  toTimelineDto,
  toTimelineTrackDto,
} from '../services/serialize';
import {
  composeMergedTranscript,
  computeOffsets,
  scanTracksForDuplicates,
} from '../services/timeline';

/**
 * 口述时间轴路由。
 *
 * 一条时间轴 = 同一道菜的多段口述（tracks，按顺序排好、带偏移）
 * + 自动标出的疑似重复组（duplicateGroups，逐组等人工确认）。
 *
 * 权限口径与全站一致：
 * - 旁观者可看；贡献者可摆音频、发起扫描；
 * - "下结论"类动作（裁定重复 / 合并定稿 / 重开）要求整理者及以上，
 *   贡献者只负责把声音留下来。
 */

export const timelineRouter: Router = Router();

timelineRouter.use(requireAuth);

/* ------------------------------------------------------------------ */
/* 加载与校验辅助                                                      */
/* ------------------------------------------------------------------ */

async function loadTimelineOrThrow(timelineId: string) {
  const timeline = await prisma.audioTimeline.findUnique({ where: { id: timelineId } });
  if (!timeline) throw new ApiError('TIMELINE_NOT_FOUND', '时间轴不存在');
  return timeline;
}

async function assertTimelineAccess(
  userId: string,
  timelineId: string,
  required: 'viewer' | 'contributor' | 'editor',
) {
  const timeline = await loadTimelineOrThrow(timelineId);
  const access = await assertRecipeRole(userId, timeline.recipeId, required);
  return { timeline, access };
}

/** 组装详情：轨道（含音频）+ 重复组（成员音频展开） */
async function buildTimelineDetail(timelineId: string) {
  const timeline = await loadTimelineOrThrow(timelineId);

  const tracks = await prisma.timelineTrack.findMany({
    where: { timelineId },
    orderBy: { orderIndex: 'asc' },
    include: { audio: true },
  });

  const groups = await prisma.timelineDuplicateGroup.findMany({
    where: { timelineId },
    orderBy: [{ status: 'asc' }, { score: 'desc' }],
  });

  const audioById = new Map(tracks.map((track) => [track.audioId, track.audio]));

  return {
    timeline,
    detail: toTimelineDto(timeline, {
      tracks: tracks.map((track) => toTimelineTrackDto(track, track.audio)),
      duplicateGroups: groups.map((group) => toDuplicateGroupDto(group, audioById)),
    }),
  };
}

/**
 * 轨道顺序 / 成员变化后：
 * 1. 重算全部偏移（不信客户端给的 offset）；
 * 2. pending 重复组已失效（引用的句子位置/成员可能变了），一律清掉；
 *    已人工裁定的组保留——那是人的结论，重扫也不覆盖。
 */
async function recomputeTracks(tx: Prisma.TransactionClient, timelineId: string) {
  const tracks = await tx.timelineTrack.findMany({
    where: { timelineId },
    orderBy: { orderIndex: 'asc' },
  });
  const { offsets, totalDurationMs } = computeOffsets(
    tracks.map((track) => ({
      audioId: track.audioId,
      durationMs: track.durationMs,
      orderIndex: track.orderIndex,
    })),
  );

  for (const track of tracks) {
    await tx.timelineTrack.update({
      where: { id: track.id },
      data: { offsetMs: offsets.get(track.audioId) ?? 0 },
    });
  }

  // 成员变化后，pending 组一律失效（引用的句子位置/成员可能变了）；
  // 已人工裁定的组原则上保留（那是人的结论），但如果它引用的音频已被移出
  // 时间轴，结论失去落点，也必须回炉重看 —— 否则合并时会保留一个幽灵选择。
  const currentAudioIds = new Set(tracks.map((track) => track.audioId));
  const allGroups = await tx.timelineDuplicateGroup.findMany({
    where: { timelineId },
    select: { id: true, status: true, members: true },
  });
  const staleIds = allGroups
    .filter((group) => {
      if (group.status === 'pending') return true;
      const members = parseJson<{ audioId: string }[]>(group.members, []);
      return members.some((member) => !currentAudioIds.has(member.audioId));
    })
    .map((group) => group.id);
  if (staleIds.length) {
    await tx.timelineDuplicateGroup.deleteMany({ where: { id: { in: staleIds } } });
  }

  await tx.audioTimeline.update({
    where: { id: timelineId },
    data: {
      // 成员变了，定稿不再有效，回到整理中
      status: 'building',
      mergedTranscript: null,
      mergedAt: null,
      mergedBy: null,
      totalDurationMs,
    },
  });

  return totalDurationMs;
}

/* ------------------------------------------------------------------ */
/* 列表 / 创建 / 详情 / 更新                                           */
/* ------------------------------------------------------------------ */

timelineRouter.get(
  '/recipes/:recipeId/timelines',
  asyncHandler(async (req, res) => {
    const { recipeId } = req.params;
    await assertRecipeRole(req.auth!.userId, recipeId!, 'viewer');

    const timelines = await prisma.audioTimeline.findMany({
      where: { recipeId: recipeId! },
      orderBy: { updatedAt: 'desc' },
    });
    send(res, timelines.map((timeline) => toTimelineDto(timeline)));
  }),
);

timelineRouter.post(
  '/recipes/:recipeId/timelines',
  validateBody(createTimelineSchema),
  asyncHandler(async (req, res) => {
    const { recipeId } = req.params;
    const access = await assertRecipeRole(req.auth!.userId, recipeId!, 'contributor');
    const { title, audioIds } = req.body as { title: string; audioIds?: string[] };

    // 引用的音频必须全部属于这张食谱（不能把别道菜的口述拖进来）
    if (audioIds?.length) {
      const audios = await prisma.audioAttachment.findMany({
        where: { id: { in: audioIds } },
        select: { id: true, recipeId: true, deletedAt: true },
      });
      const owned = new Set(
        audios.filter((audio) => audio.recipeId === recipeId).map((audio) => audio.id),
      );
      const outsiders = audioIds.filter((id) => !owned.has(id));
      if (outsiders.length) {
        throw new ApiError('VALIDATION_FAILED', '只能把这张食谱自己的口述加入时间轴', { outsiders });
      }
    }

    const timelineId = newId();

    const timeline = await prisma.$transaction(async (tx) => {
      const created = await tx.audioTimeline.create({
        data: {
          id: timelineId,
          recipeId: recipeId!,
          title,
          status: 'building',
          createdBy: req.auth!.userId,
        },
      });

      if (audioIds?.length) {
        // 去重，保持入参顺序
        const uniqueIds = [...new Set(audioIds)];
        const audios = await tx.audioAttachment.findMany({ where: { id: { in: uniqueIds } } });
        const durationById = new Map(audios.map((audio) => [audio.id, audio.durationMs]));

        await tx.timelineTrack.createMany({
          data: uniqueIds.map((audioId, index) => ({
            id: newId(),
            timelineId,
            audioId,
            orderIndex: index,
            durationMs: durationById.get(audioId) ?? 0,
          })),
        });
        const { offsets, totalDurationMs } = computeOffsets(
          uniqueIds.map((audioId, index) => ({
            audioId,
            orderIndex: index,
            durationMs: durationById.get(audioId) ?? 0,
          })),
        );
        for (const [audioId, offsetMs] of offsets) {
          await tx.timelineTrack.updateMany({ where: { timelineId, audioId }, data: { offsetMs } });
        }
        await tx.audioTimeline.update({ where: { id: timelineId }, data: { totalDurationMs } });
      }

      return created;
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline.create',
      entityType: 'audio_timeline',
      entityId: timeline.id,
      after: { title, trackCount: audioIds?.length ?? 0 },
    });

    emitToWorkspace(access.workspaceId, 'timeline:created', { recipeId: recipeId!, timelineId });
    const { detail } = await buildTimelineDetail(timelineId);
    created(res, detail);
  }),
);

timelineRouter.get(
  '/timelines/:timelineId',
  asyncHandler(async (req, res) => {
    const { timelineId } = req.params;
    await assertTimelineAccess(req.auth!.userId, timelineId!, 'viewer');
    const { detail } = await buildTimelineDetail(timelineId!);
    send(res, detail);
  }),
);

timelineRouter.patch(
  '/timelines/:timelineId',
  validateBody(updateTimelineSchema),
  asyncHandler(async (req, res) => {
    const { timelineId } = req.params;
    const { timeline, access } = await assertTimelineAccess(req.auth!.userId, timelineId!, 'contributor');
    const body = req.body as { title?: string; expectedUpdatedAt?: string };

    assertNotStale(timeline.updatedAt, body.expectedUpdatedAt, {
      current: toTimelineDto(timeline),
    });

    const updated = await prisma.audioTimeline.update({
      where: { id: timelineId! },
      data: { ...(body.title !== undefined ? { title: body.title } : {}) },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline.update',
      entityType: 'audio_timeline',
      entityId: updated.id,
      after: { title: updated.title },
    });

    const { detail } = await buildTimelineDetail(timelineId!);
    send(res, detail);
  }),
);

/* ------------------------------------------------------------------ */
/* 轨道：加入 / 移除 / 重排                                            */
/* ------------------------------------------------------------------ */

timelineRouter.post(
  '/timelines/:timelineId/tracks',
  validateBody(addTimelineTracksSchema),
  asyncHandler(async (req, res) => {
    const { timelineId } = req.params;
    const { timeline, access } = await assertTimelineAccess(req.auth!.userId, timelineId!, 'contributor');
    if (timeline.status === 'merged') {
      throw new ApiError('TIMELINE_INVALID_TRANSITION', '已定稿的时间轴请先"重开"，再调整口述段落');
    }

    const { audioIds, beforeOrderIndex } = req.body as {
      audioIds: string[];
      beforeOrderIndex?: number;
    };

    const audios = await prisma.audioAttachment.findMany({
      where: { id: { in: [...new Set(audioIds)] } },
      select: { id: true, recipeId: true, durationMs: true },
    });
    const valid = audios.filter((audio) => audio.recipeId === timeline.recipeId);
    if (valid.length !== new Set(audioIds).size) {
      throw new ApiError('VALIDATION_FAILED', '只能加入这张食谱自己的口述');
    }

    const existing = await prisma.timelineTrack.findMany({
      where: { timelineId: timelineId! },
      select: { audioId: true },
    });
    const existingIds = new Set(existing.map((track) => track.audioId));
    const fresh = [...new Set(audioIds)].filter((id) => !existingIds.has(id));
    if (!fresh.length) {
      throw new ApiError('TIMELINE_AUDIO_CONFLICT', '所选口述都已经在时间轴上了');
    }

    await prisma.$transaction(async (tx) => {
      const allTracks = await tx.timelineTrack.findMany({
        where: { timelineId: timelineId! },
        orderBy: { orderIndex: 'asc' },
      });
      let orderedAudioIds = allTracks.map((track) => track.audioId);
      const durationById = new Map(allTracks.map((track) => [track.audioId, track.durationMs]));
      for (const audio of audios) durationById.set(audio.id, audio.durationMs);

      if (beforeOrderIndex === undefined) {
        orderedAudioIds = [...orderedAudioIds, ...fresh];
      } else {
        const insertAt = Math.max(0, Math.min(beforeOrderIndex, orderedAudioIds.length));
        orderedAudioIds = [
          ...orderedAudioIds.slice(0, insertAt),
          ...fresh,
          ...orderedAudioIds.slice(insertAt),
        ];
      }

      await tx.timelineTrack.createMany({
        data: fresh.map((audioId) => ({
          id: newId(),
          timelineId: timelineId!,
          audioId,
          orderIndex: orderedAudioIds.indexOf(audioId),
          durationMs: durationById.get(audioId) ?? 0,
        })),
      });

      await persistOrder(tx, timelineId!, orderedAudioIds);
      await recomputeTracks(tx, timelineId!);
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline.track.add',
      entityType: 'audio_timeline',
      entityId: timelineId!,
      after: { addedAudioIds: fresh },
    });

    emitToWorkspace(access.workspaceId, 'timeline:updated', { timelineId });
    const { detail } = await buildTimelineDetail(timelineId!);
    send(res, detail);
  }),
);

timelineRouter.delete(
  '/timelines/:timelineId/tracks/:audioId',
  asyncHandler(async (req, res) => {
    const { timelineId, audioId } = req.params;
    const { timeline, access } = await assertTimelineAccess(req.auth!.userId, timelineId!, 'contributor');
    if (timeline.status === 'merged') {
      throw new ApiError('TIMELINE_INVALID_TRANSITION', '已定稿的时间轴请先"重开"，再调整口述段落');
    }

    await prisma.$transaction(async (tx) => {
      const deleted = await tx.timelineTrack.deleteMany({ where: { timelineId: timelineId!, audioId } });
      if (!deleted.count) throw notFound('时间轴上的口述段');
      await recomputeTracks(tx, timelineId!);
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline.track.remove',
      entityType: 'audio_timeline',
      entityId: timelineId!,
      after: { removedAudioId: audioId },
    });

    emitToWorkspace(access.workspaceId, 'timeline:updated', { timelineId });
    const { detail } = await buildTimelineDetail(timelineId!);
    send(res, detail);
  }),
);

timelineRouter.post(
  '/timelines/:timelineId/reorder',
  validateBody(reorderTimelineTracksSchema),
  asyncHandler(async (req, res) => {
    const { timelineId } = req.params;
    const { timeline, access } = await assertTimelineAccess(req.auth!.userId, timelineId!, 'contributor');
    if (timeline.status === 'merged') {
      throw new ApiError('TIMELINE_INVALID_TRANSITION', '已定稿的时间轴请先"重开"，再调整口述段落');
    }

    const { orderedAudioIds } = req.body as { orderedAudioIds: string[] };

    const tracks = await prisma.timelineTrack.findMany({
      where: { timelineId: timelineId! },
      select: { audioId: true },
    });
    const currentIds = new Set(tracks.map((track) => track.audioId));
    if (
      orderedAudioIds.length !== currentIds.size ||
      orderedAudioIds.some((id) => !currentIds.has(id))
    ) {
      throw new ApiError('VALIDATION_FAILED', '重排序列必须与时间轴上的口述段一一对应');
    }

    await prisma.$transaction(async (tx) => {
      await persistOrder(tx, timelineId!, orderedAudioIds);
      await recomputeTracks(tx, timelineId!);
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline.track.reorder',
      entityType: 'audio_timeline',
      entityId: timelineId!,
      after: { orderedAudioIds },
    });

    emitToWorkspace(access.workspaceId, 'timeline:updated', { timelineId });
    const { detail } = await buildTimelineDetail(timelineId!);
    send(res, detail);
  }),
);

/** 重排时把 orderIndex 全量写回（偏移由 recomputeTracks 统一算）。 */
async function persistOrder(tx: Prisma.TransactionClient, timelineId: string, orderedAudioIds: string[]) {
  for (const [index, audioId] of orderedAudioIds.entries()) {
    await tx.timelineTrack.updateMany({
      where: { timelineId, audioId },
      data: { orderIndex: index },
    });
  }
}

/* ------------------------------------------------------------------ */
/* 自动标出重复表述                                                    */
/* ------------------------------------------------------------------ */

timelineRouter.post(
  '/timelines/:timelineId/scan-duplicates',
  validateBody(scanTimelineSchema),
  asyncHandler(async (req, res) => {
    const { timelineId } = req.params;
    const { timeline, access } = await assertTimelineAccess(req.auth!.userId, timelineId!, 'contributor');

    const { threshold, replacePending = true } = req.body as {
      threshold?: number;
      replacePending?: boolean;
    };

    const tracks = await prisma.timelineTrack.findMany({
      where: { timelineId: timelineId! },
      orderBy: { orderIndex: 'asc' },
      include: {
        audio: { select: { id: true, transcript: true, transcriptStatus: true } },
      },
    });
    if (tracks.length < 2) {
      throw new ApiError('VALIDATION_FAILED', '时间轴上至少要有两段口述，才谈得上"合并"');
    }

    const untranscribed = tracks.filter(
      (track) => track.audio.transcriptStatus !== 'done' || !(track.audio.transcript ?? '').trim(),
    );

    const groups = scanTracksForDuplicates(
      tracks.map((track) => track.audio),
      threshold,
    );

    const result = await prisma.$transaction(async (tx) => {
      if (replacePending) {
        await tx.timelineDuplicateGroup.deleteMany({
          where: { timelineId: timelineId!, status: 'pending' },
        });
      }

      if (groups.length) {
        await tx.timelineDuplicateGroup.createMany({
          data: groups.map((group) => ({
            id: newId(),
            timelineId: timelineId!,
            members: stringifyJson(group.members) ?? '[]',
            score: group.score,
            status: 'pending',
          })),
        });
      }

      // 只要生成了待确认组，进入 reviewing；一条都没有时保持 building，
      // 允许之后直接合并（没有重复要确认，闸门自然放行）。
      return tx.audioTimeline.update({
        where: { id: timelineId! },
        data: { status: groups.length ? 'reviewing' : timeline.status === 'merged' ? 'merged' : 'building' },
      });
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline.duplicate.scan',
      entityType: 'audio_timeline',
      entityId: timelineId!,
      after: {
        detectedGroups: groups.length,
        untranscribedAudioIds: untranscribed.map((track) => track.audio.id),
        threshold: threshold ?? null,
      },
    });

    emitToWorkspace(access.workspaceId, 'timeline:updated', { timelineId });
    const { detail } = await buildTimelineDetail(timelineId!);
    send(res, {
      ...detail,
      // 明确告知"哪些段没转写、没参与比对"，避免静默漏检
      untranscribedAudioIds: untranscribed.map((track) => track.audio.id),
      scannedAt: result.updatedAt.toISOString(),
    });
  }),
);

/* ------------------------------------------------------------------ */
/* 人工逐组裁定                                                        */
/* ------------------------------------------------------------------ */

timelineRouter.post(
  '/timelines/:timelineId/duplicates/:groupId/review',
  validateBody(reviewDuplicateSchema),
  asyncHandler(async (req, res) => {
    const { timelineId, groupId } = req.params;
    const { access } = await assertTimelineAccess(req.auth!.userId, timelineId!, 'editor');

    const group = await prisma.timelineDuplicateGroup.findUnique({ where: { id: groupId! } });
    if (!group || group.timelineId !== timelineId) throw notFound('重复表述组');

    const body = req.body as {
      status: 'duplicate' | 'distinct';
      keepAudioId?: string | null;
      note?: string | null;
      expectedUpdatedAt?: string;
    };

    assertNotStale(group.updatedAt, body.expectedUpdatedAt, {
      current: toDuplicateGroupDto(group),
    });

    let keepAudioId: string | null = null;
    if (body.status === 'duplicate') {
      const members = parseJson<{ audioId: string }[]>(group.members, []);
      const memberAudioIds = new Set(members.map((member) => member.audioId));
      if (!body.keepAudioId || !memberAudioIds.has(body.keepAudioId)) {
        throw new ApiError(
          'VALIDATION_FAILED',
          '确认重复时，必须指定组内哪一句作为保留表述',
          { memberAudioIds: [...memberAudioIds] },
        );
      }
      keepAudioId = body.keepAudioId;
    }

    const updated = await prisma.timelineDuplicateGroup.update({
      where: { id: groupId! },
      data: {
        status: body.status,
        keepAudioId,
        reviewNote: body.note ?? null,
        reviewedBy: req.auth!.userId,
        reviewedAt: new Date(),
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline.duplicate.review',
      entityType: 'timeline_duplicate_group',
      entityId: group.id,
      before: { status: group.status },
      after: { status: updated.status, keepAudioId, note: updated.reviewNote },
    });

    emitToWorkspace(access.workspaceId, 'timeline:updated', { timelineId });
    const { detail } = await buildTimelineDetail(timelineId!);
    send(res, detail);
  }),
);

/* ------------------------------------------------------------------ */
/* 合并定稿 / 重开                                                     */
/* ------------------------------------------------------------------ */

timelineRouter.post(
  '/timelines/:timelineId/merge',
  validateBody(mergeTimelineSchema),
  asyncHandler(async (req, res) => {
    const { timelineId } = req.params;
    const { timeline, access } = await assertTimelineAccess(req.auth!.userId, timelineId!, 'editor');

    const body = req.body as { changeNote: string; expectedUpdatedAt?: string };
    assertNotStale(timeline.updatedAt, body.expectedUpdatedAt, {
      current: toTimelineDto(timeline),
    });

    const tracks = await prisma.timelineTrack.findMany({
      where: { timelineId: timelineId! },
      orderBy: { orderIndex: 'asc' },
      include: { audio: { select: { id: true, transcript: true } } },
    });
    if (tracks.length < 2) {
      throw new ApiError('VALIDATION_FAILED', '至少两段口述才能合并');
    }

    const groups = await prisma.timelineDuplicateGroup.findMany({ where: { timelineId: timelineId! } });
    const pending = groups.filter((group) => group.status === 'pending');
    if (pending.length) {
      // 闸门：机器标了但人还没逐组看过 —— 绝不替人做取舍
      throw new ApiError(
        'TIMELINE_HAS_PENDING_REVIEW',
        `还有 ${pending.length} 组疑似重复没有人工确认，请逐组标记"确认重复"或"不是重复"后再合并`,
        { pendingGroupIds: pending.map((group) => group.id) },
      );
    }

    const transcriptById = new Map(tracks.map((track) => [track.audioId, track.audio.transcript]));
    const mergedTranscript = composeMergedTranscript({
      orderedAudioIds: tracks.map((track) => track.audioId),
      transcripts: transcriptById,
      reviewedGroups: groups.map((group) => ({
        members: group.members,
        status: group.status,
        keepAudioId: group.keepAudioId,
      })),
    });

    const { totalDurationMs } = computeOffsets(
      tracks.map((track) => ({
        audioId: track.audioId,
        durationMs: track.durationMs,
        orderIndex: track.orderIndex,
      })),
    );

    const updated = await prisma.audioTimeline.update({
      where: { id: timelineId! },
      data: {
        status: 'merged',
        mergedTranscript,
        totalDurationMs,
        mergedBy: req.auth!.userId,
        mergedAt: new Date(),
        changeNote: body.changeNote,
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline.merge',
      entityType: 'audio_timeline',
      entityId: timelineId!,
      before: { status: timeline.status },
      after: {
        status: 'merged',
        trackCount: tracks.length,
        duplicateGroups: groups.length,
        changeNote: body.changeNote,
      },
    });

    emitToWorkspace(access.workspaceId, 'timeline:merged', {
      recipeId: timeline.recipeId,
      timelineId,
    });
    const { detail } = await buildTimelineDetail(timelineId!);
    send(res, { ...detail, mergedAt: updated.mergedAt?.toISOString() });
  }),
);

timelineRouter.post(
  '/timelines/:timelineId/reopen',
  validateBody(reopenTimelineSchema),
  asyncHandler(async (req, res) => {
    const { timelineId } = req.params;
    const { timeline, access } = await assertTimelineAccess(req.auth!.userId, timelineId!, 'editor');

    const { reason } = req.body as { reason: string };

    const updated = await prisma.audioTimeline.update({
      where: { id: timelineId! },
      data: {
        status: 'building',
        mergedTranscript: null,
        mergedAt: null,
        mergedBy: null,
        // 历史裁定组保留：人已经做过的判断不需要重看；想重扫会显式清 pending
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline.reopen',
      entityType: 'audio_timeline',
      entityId: timelineId!,
      before: { status: timeline.status },
      after: { status: updated.status, reason },
    });

    emitToWorkspace(access.workspaceId, 'timeline:updated', { timelineId });
    const { detail } = await buildTimelineDetail(timelineId!);
    send(res, detail);
  }),
);
