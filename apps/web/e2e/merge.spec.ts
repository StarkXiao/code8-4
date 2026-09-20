import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * 多段口述合并的 UI 闭环：
 *   录两段有重复内容的口述 -> 在合并页生成提案 -> 系统标出重复表述
 *   -> 人工确认 -> 执行合并 -> 合并记录里能看到已合并的时间轴。
 *
 * 数据通过接口准备（与 all-pages 同一套思路），浏览器只负责验证页面行为。
 */

const button = (label: string) =>
  new RegExp(label.split('').map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'));

function makeWav(): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * 2;
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

async function uploadWithTranscript(
  request: APIRequestContext,
  token: string,
  recipeId: string,
  durationMs: number,
  transcript: string,
) {
  const uploaded = await request.post('/api/audio', {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      recipeId,
      kind: 'recipe_voice',
      durationMs: String(durationMs),
      file: { name: 'voice.wav', mimeType: 'audio/wav', buffer: makeWav() },
    },
  });
  expect(uploaded.ok()).toBeTruthy();
  const audio = (await uploaded.json()).data as { id: string };
  const patched = await request.patch(`/api/audio/${audio.id}/transcript`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { transcript },
  });
  expect(patched.ok()).toBeTruthy();
}

test('多段口述合并：标出重复 -> 人工确认 -> 合并', async ({ page, request }) => {
  const stamp = Date.now();
  const registered = await request.post('/api/auth/register', {
    data: { email: `merge-${stamp}@e2e.test`, password: 'froa12345', displayName: '整理者' },
  });
  const { tokens } = (await registered.json()).data;

  const workspace = await (
    await request.post('/api/workspaces', {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      data: { name: '合并厨房' },
    })
  ).json();
  const recipe = await (
    await request.post('/api/recipes', {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      data: { workspaceId: workspace.data.id, title: '合并红烧肉' },
    })
  ).json();
  const recipeId = recipe.data.id as string;

  // 两段口述都说了"放一点糖就行"
  await uploadWithTranscript(request, tokens.accessToken, recipeId, 30_000, '先炒糖色，放一点糖就行。中火炒到收汁。');
  await uploadWithTranscript(request, tokens.accessToken, recipeId, 45_000, '肉先焯水。放一点糖就行。炖到筷子能戳透。');

  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('froa.accessToken', access as string);
      localStorage.setItem('froa.refreshToken', refresh as string);
    },
    [tokens.accessToken, tokens.refreshToken],
  );

  // 1. 打开合并页，勾选两段口述，生成提案
  await page.goto(`/w/${workspace.data.id}/recipes/${recipeId}/merge`);
  await expect(page.getByRole('heading', { name: /多段口述合并/ })).toBeVisible();
  await page.getByRole('checkbox').nth(0).check();
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('button', { name: button('生成合并提案') }).click();

  // 2. 系统标出的重复表述出现在页面上，合并按钮此时不可点
  await expect(page.getByText(/放一点糖就行/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/待确认/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: button('确认合并') })).toBeDisabled();

  // 3. 人工确认这是重复之后，合并按钮放行
  await page.getByRole('button', { name: button('是重复') }).click();
  await expect(page.getByRole('button', { name: button('确认合并') })).toBeEnabled();

  // 4. 执行合并，合并记录里出现"已合并"
  await page.getByRole('button', { name: button('确认合并') }).click();
  await expect(page.getByText('已合并').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/合并记录/)).toBeVisible();
});
