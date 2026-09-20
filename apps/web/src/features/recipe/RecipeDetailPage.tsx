import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Descriptions, Empty, Space, Spin, Tag, Typography } from 'antd';
import { FileTextOutlined, MergeCellsOutlined, PlusOutlined, SoundOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONFIDENCE_LABELS,
  HEAT_LEVEL_LABELS,
  VAGUE_CATEGORY_LABELS,
  VAGUE_STATUS_LABELS,
  VERSION_STATUS_LABELS,
  formatSpecSummary,
} from '@froa/shared';
import { audioApi, recipeApi, versionApi, vagueItemApi } from '../../api/endpoints';
import { tokenStore } from '../../api/client';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';

/**
 * 食谱详情。
 *
 * 展示"当前已发布版本"（没有就展示草稿）的完整内容，
 * 并把三个后续动作放在最显眼的位置：录音、追问台、发起复做验证。
 */
export function RecipeDetailPage() {
  const { workspaceId, recipeId } = useParams<{ workspaceId: string; recipeId: string }>();
  const queryClient = useQueryClient();
  const { playAudio } = useAudioPlayback();

  const recipe = useQuery({
    queryKey: ['recipe', recipeId],
    queryFn: () => recipeApi.get(recipeId!),
    enabled: Boolean(recipeId),
  });

  const versions = useQuery({
    queryKey: ['versions', recipeId],
    queryFn: () => versionApi.list(recipeId!),
    enabled: Boolean(recipeId),
  });

  const items = useQuery({
    queryKey: ['vague-items', recipeId, 'all-detail'],
    queryFn: () => vagueItemApi.list(recipeId!, { pageSize: 200 }),
    enabled: Boolean(recipeId),
  });

  const audios = useQuery({
    queryKey: ['audio', recipeId],
    queryFn: () => audioApi.list({ recipeId: recipeId! }),
    enabled: Boolean(recipeId),
  });

  const currentVersion =
    versions.data?.find((v) => v.status === 'published') ?? versions.data?.find((v) => v.status === 'draft');

  const versionDetail = useQuery({
    queryKey: ['version-detail', currentVersion?.id],
    queryFn: () => versionApi.get(currentVersion!.id),
    enabled: Boolean(currentVersion?.id),
  });

  const forkMutation = useMutation({
    mutationFn: () => versionApi.fork(recipeId!, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['versions', recipeId] });
      void queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] });
    },
  });

  if (recipe.isLoading) return <Spin size="large" />;

  const counters = recipe.data?.counters;
  const detail = versionDetail.data;
  const specItems = (items.data ?? []).filter((item) => item.resolvedSpec);

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>{recipe.data?.title}</h1>
          <div className="froa-hint">
            {recipe.data?.dishCategory ? `${recipe.data.dishCategory} ｜ ` : ''}
            我的角色：{recipe.data?.myRole}
          </div>
        </div>
        <Space wrap>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}/record`}>
            <Button type="primary" icon={<SoundOutlined />}>
              录音
            </Button>
          </Link>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}/merge`}>
            <Button icon={<MergeCellsOutlined />}>多段口述合并</Button>
          </Link>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}/inbox`}>
            <Button>
              追问台
              {counters && counters.openVagueItems + counters.askedVagueItems > 0
                ? `（${counters.openVagueItems + counters.askedVagueItems}）`
                : ''}
            </Button>
          </Link>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}/edit`}>
            <Button>编辑草稿</Button>
          </Link>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}/verify`}>
            <Button type="dashed">发起复做验证</Button>
          </Link>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}/versions`}>
            <Button icon={<FileTextOutlined />}>版本</Button>
          </Link>
        </Space>
      </div>

      {counters?.pendingTranscriptCount ? (
        <Alert
          type="info"
          showIcon
          message={`还有 ${counters.pendingTranscriptCount} 段语音没有转写`}
          description="没有转写就找不到「哪句说不清」。到录音工作台补上文字。"
          action={
            <Link to={`/w/${workspaceId}/recipes/${recipeId}/record`}>
              <Button size="small">去处理</Button>
            </Link>
          }
        />
      ) : null}

      {counters && counters.unresolvableVagueItems > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${counters.unresolvableVagueItems} 条被标记为「口语留白」`}
          description="这些描述确实说不清了，已经作为合法结论记录下来，不会再挂着当待办。"
        />
      ) : null}

      <div className="froa-card">
        <div className="froa-row" style={{ justifyContent: 'space-between' }}>
          <h3 className="froa-card-title" style={{ margin: 0 }}>
            当前版本
          </h3>
          {currentVersion && (
            <Tag color={currentVersion.status === 'published' ? 'green' : 'gold'}>
              v{currentVersion.versionNo} · {VERSION_STATUS_LABELS[currentVersion.status]}
            </Tag>
          )}
        </div>

        {!currentVersion ? (
          <Empty description="还没有版本" />
        ) : (
          <>
            {currentVersion.status === 'published' && (
              <Space style={{ marginTop: 12 }}>
                <Button onClick={() => forkMutation.mutate()} loading={forkMutation.isPending} icon={<PlusOutlined />}>
                  以这版为基础新建草稿
                </Button>
                <a href={versionApi.exportUrl(currentVersion.id, 'md')} target="_blank" rel="noreferrer">
                  <Button>导出 Markdown 食谱</Button>
                </a>
              </Space>
            )}

            {detail?.changeNote && (
              <Descriptions size="small" column={1} style={{ marginTop: 12 }}>
                <Descriptions.Item label="本次变更说明">{detail.changeNote}</Descriptions.Item>
              </Descriptions>
            )}

            <h4 style={{ marginTop: 16 }}>用量</h4>
            {!detail?.ingredients?.length ? (
              <Typography.Text type="secondary">还没有记录用量</Typography.Text>
            ) : (
              <ul>
                {detail.ingredients.map((ingredient) => (
                  <li key={ingredient.id}>
                    {ingredient.name}{' '}
                    {ingredient.amountValue !== null
                      ? `${ingredient.amountValue}${ingredient.amountUnit ?? ''}`
                      : ingredient.amountMin !== null || ingredient.amountMax !== null
                        ? `${ingredient.amountMin ?? '?'}-${ingredient.amountMax ?? '?'}${ingredient.amountUnit ?? ''}`
                        : (ingredient.amountText ?? '适量')}
                    {ingredient.isVague && <Tag style={{ marginLeft: 8 }}>由模糊口述整理</Tag>}
                    {ingredient.note && <span className="froa-hint">（{ingredient.note}）</span>}
                  </li>
                ))}
              </ul>
            )}

            <h4 style={{ marginTop: 16 }}>步骤</h4>
            {!detail?.steps?.length ? (
              <Typography.Text type="secondary">还没有步骤</Typography.Text>
            ) : (
              <div className="froa-stack">
                {detail.steps.map((step, index) => (
                  <div key={step.id} className="froa-step-card">
                    <div className="froa-row">
                      <span className="froa-step-index">{index + 1}</span>
                      <strong>{step.title}</strong>
                      {step.heatLevel && <Tag>{HEAT_LEVEL_LABELS[step.heatLevel]}</Tag>}
                      {step.heatText && <Tag>{step.heatText}</Tag>}
                      {step.durationSecondsMin !== null && (
                        <Tag>时长 {step.durationSecondsMin}-{step.durationSecondsMax ?? step.durationSecondsMin} 秒</Tag>
                      )}
                    </div>
                    <p style={{ margin: '0.5rem 0 0' }}>{step.instruction}</p>
                    {step.sensoryCues.length > 0 && (
                      <div className="froa-hint">判断标准：{step.sensoryCues.join('、')}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="froa-card">
        <h3 className="froa-card-title">口述整理记录（{specItems.length}）</h3>
        <Typography.Paragraph type="secondary">
          这些是原本说不清的话，以及最后整理出来的结论。每条都能点"听原声"回到当时那句话。
        </Typography.Paragraph>

        {specItems.length === 0 ? (
          <Empty description="还没有整理出结论" />
        ) : (
          <div className="froa-stack">
            {specItems.map((item) => (
              <div key={item.id} className="froa-step-card">
                <div className="froa-item-meta">
                  <span className={`froa-tag-cat cat-${item.category}`}>
                    {VAGUE_CATEGORY_LABELS[item.category]}
                  </span>
                  <Tag>{VAGUE_STATUS_LABELS[item.status]}</Tag>
                  {item.resolvedSpec && <Tag>{CONFIDENCE_LABELS[item.resolvedSpec.confidence]}</Tag>}
                </div>
                <div className="froa-item-raw">「{item.rawPhrase}」</div>
                <div>{formatSpecSummary(item.resolvedSpec)}</div>
                <Space style={{ marginTop: 8 }}>
                  {item.clip && item.clipAudio && (
                    <Button
                      size="small"
                      icon={<SoundOutlined />}
                      onClick={() =>
                        playAudio(item.clipAudio, {
                          startMs: item.clip!.startMs,
                          endMs: item.clip!.endMs,
                          label: item.rawPhrase,
                        })
                      }
                    >
                      听原声
                    </Button>
                  )}
                  <Link to={`/w/${workspaceId}/recipes/${recipeId}/inbox`}>
                    <Button size="small" type="link">
                      在追问台打开
                    </Button>
                  </Link>
                </Space>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="froa-card">
        <h3 className="froa-card-title">原始语音（{audios.data?.length ?? 0}）</h3>
        <Typography.Paragraph type="secondary">
          音频只增不删。即使食谱改了很多版，当时那句话永远还在这里。
        </Typography.Paragraph>
        {(audios.data ?? []).map((audio) => (
          <div key={audio.id} className="froa-row" style={{ justifyContent: 'space-between' }}>
            <span>
              {audio.createdAt.slice(0, 16).replace('T', ' ')} ｜ {Math.round(audio.durationMs / 1000)} 秒 ｜{' '}
              {audio.transcriptStatus === 'done' ? '已转写' : '待转写'}
            </span>
            <Button size="small" onClick={() => playAudio(audio)}>
              播放
            </Button>
          </div>
        ))}
      </div>

      <Typography.Paragraph type="secondary" style={{ fontSize: '0.8rem' }}>
        导出链接带有登录态校验，请在已登录的浏览器中打开。
        {tokenStore.access ? '' : '（当前似乎没有登录态，导出可能失败）'}
      </Typography.Paragraph>
    </div>
  );
}
