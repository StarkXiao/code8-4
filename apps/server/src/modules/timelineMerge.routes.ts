import { Router } from 'express';
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import {
  createTimelineMergeSchema,
  detectDuplicatePhrases,
  layoutTimelineItems,
  updateTimelineMergeItemSchema,
} from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';
import { asyncHandler, created, send } from '../lib/http';
import { newId } from '../lib/ids';
import { stringifyJson } from '../lib/json';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import {
  assertRecipeRole,
  assertTimelineDuplicateRole,
  assertTimelineMergeItemRole,
  assertTimelineMergeRole,
} from '../services/access';
import { logActivity } from '../services/activity';
import { toTimelineMergeDto, toTimelineMergeItemDto } from '../services/serialize';
import { emitToWorkspace } from '../realtime/hub';

export const timelineMergeRouter: Router = Router();

timelineMergeRouter.use(requireAuth);

const MERGE_INCLUDE = {
  items: { include: { audio: true }, orderBy: [{ offsetMs: 'asc' }, { orderIndex: 'asc' }] },
  duplicates: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.TimelineMergeInclude;

async function loadMergeDetail(mergeId: string) {
  const merge = await prisma.timelineMerge.findUnique({
    where: { id: mergeId },
    include: MERGE_INCLUDE,
  });
  if (!merge) throw notFound('合并提案');
  return merge;
}

/* ------------------------------------------------------------------ */
/* 创建合并提案：自动标出重复表述，等待人工确认                            */
/* ------------------------------------------------------------------ */

/**
 * 把同一道菜的多段口述摆到同一条时间轴上。
 *
 * 这里只生成"提案"：
 * - 各段口述默认按给定顺序首尾相接（offsetMs 可之后再调）；
 * - 系统自动检测重复表述并全部标为 pending；
 * - 在人工逐条确认/驳回之前，不允许执行合并（见 /merge 端点的闸门）。
 */
timelineMergeRouter.post(
  '/recipes/:recipeId/timeline-merges',
  validateBody(createTimelineMergeSchema),
  asyncHandler(async (req, res) => {
    const { recipeId } = req.params;
    const access = await assertRecipeRole(req.auth!.userId, recipeId!, 'editor');

    const reviewing = await prisma.timelineMerge.findFirst({
      where: { recipeId: recipeId!, status: 'reviewing' },
      select: { id: true },
    });
    if (reviewing) {
      throw new ApiError(
        'TIMELINE_MERGE_REVIEW_PENDING',
        '已有一个待确认的合并提案，请先完成或放弃它',
        { mergeId: reviewing.id },
      );
    }

    const { audioIds } = req.body as { audioIds: string[] };
    const uniqueAudioIds = [...new Set(audioIds)];
    if (uniqueAudioIds.length < 2) {
      throw new ApiError('VALIDATION_FAILED', '至少选择两段不同的口述才能合并');
    }

    // 关键校验：凡是接受 id 的写接口，都必须确认那个 id 属于这张食谱 ——
    // 否则知道别人的 audio id 就能把别家的口述拉进自己的合并提案（跨空间泄漏）。
    const audios = await prisma.audioAttachment.findMany({
      where: { id: { in: uniqueAudioIds }, recipeId: recipeId!, deletedAt: null },
    });
    if (audios.length !== uniqueAudioIds.length) {
      throw new ApiError('VALIDATION_FAILED', '只能选择这张食谱里、未被删除的语音');
    }

    const byId = new Map(audios.map((audio) => [audio.id, audio]));
    const ordered = uniqueAudioIds.map((id) => byId.get(id)!);
    const layout = layoutTimelineItems(ordered.map((audio) => ({ id: audio.id, durationMs: audio.durationMs })));

    // 没有转写的段落不参与比对（没有文本可比），但仍正常进入时间轴
    const candidates = detectDuplicatePhrases(
      ordered.map((audio) => ({
        audioId: audio.id,
        transcript: audio.transcript,
        durationMs: audio.durationMs,
      })),
    );

    const mergeId = newId();
    await prisma.$transaction(async (tx) => {
      await tx.timelineMerge.create({
        data: { id: mergeId, recipeId: recipeId!, createdBy: req.auth!.userId },
      });
      await tx.timelineMergeItem.createMany({
        data: layout.map((item) => ({
          id: newId(),
          mergeId,
          audioId: item.audioId,
          orderIndex: item.orderIndex,
          offsetMs: item.offsetMs,
        })),
      });
      if (candidates.length) {
        await tx.timelineDuplicate.createMany({
          data: candidates.map((candidate) => ({
            id: newId(),
            mergeId,
            normalizedText: candidate.normalizedText,
            displayText: candidate.displayText,
            occurrences: stringifyJson(candidate.occurrences) ?? '[]',
          })),
        });
      }
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline_merge.create',
      entityType: 'timeline_merge',
      entityId: mergeId,
      after: { audioIds: uniqueAudioIds, duplicates: candidates.length },
    });

    emitToWorkspace(access.workspaceId, 'timeline_merge:created', { recipeId, mergeId });
    created(res, toTimelineMergeDto(await loadMergeDetail(mergeId)));
  }),
);

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

timelineMergeRouter.get(
  '/recipes/:recipeId/timeline-merges',
  asyncHandler(async (req, res) => {
    const { recipeId } = req.params;
    await assertRecipeRole(req.auth!.userId, recipeId!, 'viewer');

    const merges = await prisma.timelineMerge.findMany({
      where: { recipeId: recipeId! },
      include: MERGE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    send(res, merges.map(toTimelineMergeDto));
  }),
);

timelineMergeRouter.get(
  '/timeline-merges/:mergeId',
  asyncHandler(async (req, res) => {
    const { mergeId } = req.params;
    await assertTimelineMergeRole(req.auth!.userId, mergeId!, 'viewer');
    send(res, toTimelineMergeDto(await loadMergeDetail(mergeId!)));
  }),
);

/* ------------------------------------------------------------------ */
/* 调整时间轴布局（仅待确认状态可改）                                      */
/* ------------------------------------------------------------------ */

timelineMergeRouter.patch(
  '/timeline-merge-items/:itemId',
  validateBody(updateTimelineMergeItemSchema),
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const access = await assertTimelineMergeItemRole(req.auth!.userId, itemId!, 'editor');
    if (access.mergeStatus !== 'reviewing') {
      throw new ApiError('TIMELINE_MERGE_INVALID_TRANSITION', '只有待确认的合并提案可以调整');
    }

    const { offsetMs } = req.body as { offsetMs: number };
    const item = await prisma.timelineMergeItem.update({
      where: { id: itemId! },
      data: { offsetMs },
      include: { audio: true },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline_merge.moveItem',
      entityType: 'timeline_merge',
      entityId: access.mergeId,
      after: { itemId, audioId: item.audioId, offsetMs },
    });

    send(res, toTimelineMergeItemDto(item));
  }),
);

/* ------------------------------------------------------------------ */
/* 人工确认 / 驳回重复表述                                                */
/* ------------------------------------------------------------------ */

/**
 * 确认与驳回共用一个处理函数：两者都只是"人对机器标的重复表个态"，
 * 在提案仍处于待确认状态时允许反复改主意（点错了能改回来）。
 */
async function resolveDuplicate(
  req: Request,
  duplicateId: string,
  status: 'confirmed' | 'dismissed',
) {
  const access = await assertTimelineDuplicateRole(req.auth!.userId, duplicateId, 'editor');
  if (access.mergeStatus !== 'reviewing') {
    throw new ApiError('TIMELINE_MERGE_INVALID_TRANSITION', '合并已执行或已放弃，不能再改动标记');
  }

  const duplicate = await prisma.timelineDuplicate.update({
    where: { id: duplicateId },
    data: { status, resolvedBy: req.auth!.userId, resolvedAt: new Date() },
  });

  await logActivity({
    workspaceId: access.workspaceId,
    actorId: req.auth!.userId,
    action: `timeline_duplicate.${status === 'confirmed' ? 'confirm' : 'dismiss'}`,
    entityType: 'timeline_duplicate',
    entityId: duplicateId,
    after: { mergeId: access.mergeId, status, normalizedText: duplicate.normalizedText },
  });

  emitToWorkspace(access.workspaceId, 'timeline_merge:updated', { mergeId: access.mergeId });
  return duplicate;
}

timelineMergeRouter.post(
  '/timeline-duplicates/:duplicateId/confirm',
  asyncHandler(async (req, res) => {
    const duplicate = await resolveDuplicate(req, req.params.duplicateId!, 'confirmed');
    send(res, toTimelineMergeDto(await loadMergeDetail(duplicate.mergeId)));
  }),
);

timelineMergeRouter.post(
  '/timeline-duplicates/:duplicateId/dismiss',
  asyncHandler(async (req, res) => {
    const duplicate = await resolveDuplicate(req, req.params.duplicateId!, 'dismissed');
    send(res, toTimelineMergeDto(await loadMergeDetail(duplicate.mergeId)));
  }),
);

/* ------------------------------------------------------------------ */
/* 执行合并 / 放弃                                                       */
/* ------------------------------------------------------------------ */

/**
 * 执行合并。
 *
 * 闸门：只要还有一条重复表述是 pending，就不允许合并 ——
 * 机器标出来的东西必须被人逐条看过，这条与"暂定结论不允许发布"是同一原则。
 */
timelineMergeRouter.post(
  '/timeline-merges/:mergeId/merge',
  asyncHandler(async (req, res) => {
    const { mergeId } = req.params;
    const access = await assertTimelineMergeRole(req.auth!.userId, mergeId!, 'editor');
    if (access.mergeStatus !== 'reviewing') {
      throw new ApiError('TIMELINE_MERGE_INVALID_TRANSITION', '该提案已经合并或已放弃');
    }

    const pending = await prisma.timelineDuplicate.count({
      where: { mergeId: mergeId!, status: 'pending' },
    });
    if (pending > 0) {
      throw new ApiError(
        'TIMELINE_DUPLICATES_PENDING',
        `还有 ${pending} 条重复表述待确认，逐条确认或驳回后才能合并`,
        { pending },
      );
    }

    await prisma.timelineMerge.update({
      where: { id: mergeId! },
      data: { status: 'merged', mergedAt: new Date() },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline_merge.merge',
      entityType: 'timeline_merge',
      entityId: mergeId!,
    });

    emitToWorkspace(access.workspaceId, 'timeline_merge:updated', { mergeId });
    send(res, toTimelineMergeDto(await loadMergeDetail(mergeId!)));
  }),
);

timelineMergeRouter.post(
  '/timeline-merges/:mergeId/discard',
  asyncHandler(async (req, res) => {
    const { mergeId } = req.params;
    const access = await assertTimelineMergeRole(req.auth!.userId, mergeId!, 'editor');
    if (access.mergeStatus !== 'reviewing') {
      throw new ApiError('TIMELINE_MERGE_INVALID_TRANSITION', '该提案已经合并或已放弃');
    }

    await prisma.timelineMerge.update({
      where: { id: mergeId! },
      data: { status: 'discarded' },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'timeline_merge.discard',
      entityType: 'timeline_merge',
      entityId: mergeId!,
    });

    emitToWorkspace(access.workspaceId, 'timeline_merge:updated', { mergeId });
    send(res, toTimelineMergeDto(await loadMergeDetail(mergeId!)));
  }),
);
