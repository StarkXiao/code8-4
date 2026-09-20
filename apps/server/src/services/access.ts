import type { WorkspaceRole } from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';

/** 角色权重：数值越大权限越高 */
const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  contributor: 1,
  editor: 2,
  owner: 3,
};

export function roleAtLeast(role: WorkspaceRole, required: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export interface MembershipContext {
  workspaceId: string;
  role: WorkspaceRole;
  ownerId: string;
  name: string;
}

export async function getMembership(userId: string, workspaceId: string): Promise<MembershipContext> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    include: { workspace: { select: { id: true, ownerId: true, name: true } } },
  });
  if (!member) throw new ApiError('WORKSPACE_NOT_MEMBER');
  return {
    workspaceId: member.workspace.id,
    role: member.role as WorkspaceRole,
    ownerId: member.workspace.ownerId,
    name: member.workspace.name,
  };
}

export async function assertWorkspaceRole(
  userId: string,
  workspaceId: string,
  required: WorkspaceRole,
): Promise<MembershipContext> {
  const membership = await getMembership(userId, workspaceId);
  if (!roleAtLeast(membership.role, required)) throw new ApiError('AUTH_FORBIDDEN');
  return membership;
}

export interface RecipeAccess {
  recipeId: string;
  workspaceId: string;
  role: WorkspaceRole;
  ownerId: string;
}

export async function assertRecipeRole(
  userId: string,
  recipeId: string,
  required: WorkspaceRole,
): Promise<RecipeAccess> {
  const recipe = await prisma.recipe.findUnique({
    where: { id: recipeId },
    select: { id: true, workspaceId: true },
  });
  if (!recipe) throw notFound('食谱');
  const membership = await getMembership(userId, recipe.workspaceId);
  if (!roleAtLeast(membership.role, required)) throw new ApiError('AUTH_FORBIDDEN');
  return {
    recipeId: recipe.id,
    workspaceId: recipe.workspaceId,
    role: membership.role,
    ownerId: membership.ownerId,
  };
}

export async function assertVersionRole(
  userId: string,
  versionId: string,
  required: WorkspaceRole,
): Promise<RecipeAccess & { versionStatus: string }> {
  const version = await prisma.recipeVersion.findUnique({
    where: { id: versionId },
    select: { id: true, recipeId: true, status: true },
  });
  if (!version) throw notFound('版本');
  const access = await assertRecipeRole(userId, version.recipeId, required);
  return { ...access, versionStatus: version.status };
}

export async function assertStepRole(
  userId: string,
  stepId: string,
  required: WorkspaceRole,
): Promise<RecipeAccess & { versionId: string; versionStatus: string }> {
  const step = await prisma.step.findUnique({
    where: { id: stepId },
    select: { id: true, versionId: true, version: { select: { recipeId: true, status: true } } },
  });
  if (!step) throw notFound('步骤');
  const access = await assertRecipeRole(userId, step.version.recipeId, required);
  return { ...access, versionId: step.versionId, versionStatus: step.version.status };
}

export async function assertIngredientRole(
  userId: string,
  ingredientId: string,
  required: WorkspaceRole,
): Promise<RecipeAccess & { versionId: string; versionStatus: string }> {
  const ingredient = await prisma.ingredient.findUnique({
    where: { id: ingredientId },
    select: { id: true, versionId: true, version: { select: { recipeId: true, status: true } } },
  });
  if (!ingredient) throw notFound('用量');
  const access = await assertRecipeRole(userId, ingredient.version.recipeId, required);
  return { ...access, versionId: ingredient.versionId, versionStatus: ingredient.version.status };
}

export async function assertVagueItemRole(
  userId: string,
  vagueItemId: string,
  required: WorkspaceRole,
) {
  const item = await prisma.vagueItem.findUnique({
    where: { id: vagueItemId },
    select: { id: true, recipeId: true, status: true, createdBy: true },
  });
  if (!item) throw notFound('待澄清条目');
  const access = await assertRecipeRole(userId, item.recipeId, required);
  return { ...access, status: item.status, createdBy: item.createdBy };
}

export async function assertAudioRole(userId: string, audioId: string, required: WorkspaceRole) {
  const audio = await prisma.audioAttachment.findUnique({
    where: { id: audioId },
    select: { id: true, recipeId: true, ownerId: true, deletedAt: true },
  });
  // 注意：这里**不**因为 deletedAt 而拒绝。
  // 软删除的语义是"从语音库里隐藏"，不是"销毁证据" ——
  // 已经挂在结论上的原声必须仍然能回放，否则"结论永远可追溯到原声"就是空话。
  if (!audio) throw new ApiError('AUDIO_NOT_FOUND');
  const access = await assertRecipeRole(userId, audio.recipeId, required);
  return { ...access, ownerId: audio.ownerId, deletedAt: audio.deletedAt };
}

export async function assertClipRole(userId: string, clipId: string, required: WorkspaceRole) {
  const clip = await prisma.audioClip.findUnique({
    where: { id: clipId },
    select: { id: true, audio: { select: { recipeId: true } } },
  });
  if (!clip) throw notFound('音频片段');
  const access = await assertRecipeRole(userId, clip.audio.recipeId, required);
  return { ...access, clipId: clip.id };
}

export async function assertTimelineMergeRole(userId: string, mergeId: string, required: WorkspaceRole) {
  const merge = await prisma.timelineMerge.findUnique({
    where: { id: mergeId },
    select: { id: true, recipeId: true, status: true },
  });
  if (!merge) throw notFound('合并提案');
  const access = await assertRecipeRole(userId, merge.recipeId, required);
  return { ...access, mergeId: merge.id, mergeStatus: merge.status };
}

export async function assertTimelineDuplicateRole(
  userId: string,
  duplicateId: string,
  required: WorkspaceRole,
) {
  const duplicate = await prisma.timelineDuplicate.findUnique({
    where: { id: duplicateId },
    select: { id: true, merge: { select: { id: true, recipeId: true, status: true } } },
  });
  if (!duplicate) throw notFound('重复表述');
  const access = await assertRecipeRole(userId, duplicate.merge.recipeId, required);
  return { ...access, mergeId: duplicate.merge.id, mergeStatus: duplicate.merge.status };
}

export async function assertTimelineMergeItemRole(
  userId: string,
  itemId: string,
  required: WorkspaceRole,
) {
  const item = await prisma.timelineMergeItem.findUnique({
    where: { id: itemId },
    select: { id: true, merge: { select: { id: true, recipeId: true, status: true } } },
  });
  if (!item) throw notFound('时间轴条目');
  const access = await assertRecipeRole(userId, item.merge.recipeId, required);
  return { ...access, mergeId: item.merge.id, mergeStatus: item.merge.status };
}

/** 版本可编辑性守卫：只有 draft 可以改 */
export function assertVersionEditable(status: string) {
  if (status !== 'draft') throw new ApiError('VERSION_NOT_EDITABLE');
}

/**
 * 校验一串用户都是该空间的成员。
 *
 * 用途：追问对象、@提醒对象。不校验的话，只要知道别人的 user id，
 * 就能借"通知"把本家庭的菜谱内容和问题推送给非成员。
 */
export async function assertUsersInWorkspace(
  workspaceId: string,
  userIds: string[],
): Promise<void> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (!unique.length) return;

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId, userId: { in: unique } },
    select: { userId: true },
  });

  const memberIds = new Set(members.map((member) => member.userId));
  const outsiders = unique.filter((id) => !memberIds.has(id));
  if (outsiders.length) {
    throw new ApiError('VALIDATION_FAILED', '只能指派 / 提醒该家庭空间里的成员', { outsiders });
  }
}

/**
 * 校验一个步骤确实属于某张食谱。
 * 防止把 A 菜的步骤挂到 B 菜的条目上，破坏证据链。
 */
export async function assertStepInRecipe(
  userId: string,
  stepId: string,
  recipeId: string,
): Promise<void> {
  const step = await prisma.step.findUnique({
    where: { id: stepId },
    select: { version: { select: { recipeId: true } } },
  });
  if (!step) throw notFound('步骤');
  if (step.version.recipeId !== recipeId) {
    throw new ApiError('VALIDATION_FAILED', '该步骤不属于这张食谱');
  }
  await assertRecipeRole(userId, recipeId, 'viewer');
}

/** 校验一个版本确实属于某张食谱 */
export async function assertVersionInRecipe(versionId: string, recipeId: string): Promise<void> {
  const version = await prisma.recipeVersion.findUnique({
    where: { id: versionId },
    select: { recipeId: true },
  });
  if (!version) throw notFound('版本');
  if (version.recipeId !== recipeId) {
    throw new ApiError('VALIDATION_FAILED', '该版本不属于这张食谱');
  }
}

/** 校验一个音频片段属于某张食谱（顺带完成鉴权） */
export async function assertClipInRecipe(
  userId: string,
  clipId: string,
  recipeId: string,
): Promise<void> {
  const clip = await prisma.audioClip.findUnique({
    where: { id: clipId },
    select: { audio: { select: { recipeId: true } } },
  });
  if (!clip) throw notFound('音频片段');
  if (clip.audio.recipeId !== recipeId) {
    throw new ApiError('VALIDATION_FAILED', '该音频片段不属于这张食谱');
  }
  await assertRecipeRole(userId, recipeId, 'viewer');
}

/** 校验一条待澄清条目属于某张食谱（顺带完成鉴权） */
export async function assertVagueItemInRecipe(
  userId: string,
  vagueItemId: string,
  recipeId: string,
): Promise<void> {
  const item = await prisma.vagueItem.findUnique({
    where: { id: vagueItemId },
    select: { recipeId: true },
  });
  if (!item) throw notFound('待澄清条目');
  if (item.recipeId !== recipeId) {
    throw new ApiError('VALIDATION_FAILED', '该条目不属于这张食谱');
  }
  await assertRecipeRole(userId, recipeId, 'viewer');
}

/**
 * 校验一条用量属于某张食谱。
 *
 * 少了这一步，整理者就能把"结论"写进别的家庭空间里的用量记录 ——
 * 只凭一个 id 就能改别人的数据，是跨空间越权写入。
 */
export async function assertIngredientInRecipe(
  userId: string,
  ingredientId: string,
  recipeId: string,
): Promise<void> {
  const ingredient = await prisma.ingredient.findUnique({
    where: { id: ingredientId },
    select: { version: { select: { recipeId: true } } },
  });
  if (!ingredient) throw notFound('用量');
  if (ingredient.version.recipeId !== recipeId) {
    throw new ApiError('VALIDATION_FAILED', '该用量不属于这张食谱');
  }
  await assertRecipeRole(userId, recipeId, 'viewer');
}
