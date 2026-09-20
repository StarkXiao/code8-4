import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Collapse,
  Empty,
  InputNumber,
  List,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  MergeCellsOutlined,
  PlayCircleOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TIMELINE_DUPLICATE_STATUS_LABELS,
  TIMELINE_MERGE_STATUS_LABELS,
  type AudioAttachmentDto,
  type TimelineMergeDto,
  type TimelineMergeItemDto,
} from '@froa/shared';
import { audioApi, recipeApi, timelineApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { MergedTimeline } from '../../components/MergedTimeline';
import { formatMs } from '../../components/Waveform';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';
import { usePlayerStore } from '../../store/player';

const KIND_LABELS: Record<string, string> = {
  recipe_voice: '长辈口述',
  answer_voice: '回答追问',
  verification_voice: '复做语音',
  note_voice: '补充备注',
};

const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

const audioTitle = (audio: AudioAttachmentDto) =>
  `${kindLabel(audio.kind)} · ${formatMs(audio.durationMs)} · ${audio.createdAt.slice(0, 16).replace('T', ' ')}`;

/**
 * 连播整条合并时间轴。
 *
 * 全局播放器同一时刻只播一段音频，"连播"是这样实现的：
 * 播完一段（自然结束，而非手动暂停）后自动接下一段。
 * 判断依据是停下时的位置是否已接近该段末尾 —— 用户中途暂停不会触发连播。
 */
function useMergedPlayback(items: TimelineMergeItemDto[]) {
  const { playAudio } = useAudioPlayback();
  const request = usePlayerStore((s) => s.request);
  const playing = usePlayerStore((s) => s.playing);
  const currentMs = usePlayerStore((s) => s.currentMs);
  const chainIndexRef = useRef<number | null>(null);

  const playItemAt = (index: number, startMs = 0) => {
    const item = items[index];
    if (!item?.audio) return;
    chainIndexRef.current = index;
    playAudio(item.audio, {
      startMs,
      label: `合并时间轴 · 第 ${index + 1} 段（共 ${items.length} 段）`,
    });
  };

  /** 从头开始连播整条时间轴 */
  const playAll = () => playItemAt(0);

  /** 从时间轴上任意位置开始播（找到该位置落在哪一段里） */
  const playFrom = (ms: number) => {
    const index = items.findIndex(
      (item) => item.audio && ms >= item.offsetMs && ms < item.offsetMs + item.audio.durationMs,
    );
    if (index < 0) return;
    const item = items[index]!;
    playItemAt(index, Math.max(0, ms - item.offsetMs));
  };

  /** 播单个出现位置（重复表述的估算区间），不打断连播状态 */
  const playRange = (audio: AudioAttachmentDto, startMs: number, endMs: number, label: string) => {
    chainIndexRef.current = null;
    playAudio(audio, { startMs, endMs, label });
  };

  useEffect(() => {
    if (chainIndexRef.current === null) return;
    if (!request) {
      chainIndexRef.current = null;
      return;
    }
    if (playing) return;
    const index = chainIndexRef.current;
    const item = items[index];
    if (!item?.audio || request.audioId !== item.audio.id) {
      chainIndexRef.current = null;
      return;
    }
    if (currentMs >= item.audio.durationMs - 150) {
      if (index + 1 < items.length) playItemAt(index + 1);
      else chainIndexRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, currentMs, request, items]);

  /** 当前播放位置换算到合并时间轴上（不在播这些音频时为 undefined） */
  const playheadMs = useMemo(() => {
    if (!request) return undefined;
    const item = items.find((candidate) => candidate.audio?.id === request.audioId);
    if (!item) return undefined;
    return item.offsetMs + currentMs;
  }, [request, items, currentMs]);

  return { playAll, playFrom, playRange, playheadMs };
}

/**
 * 多段口述合并 —— 把同一道菜的几段口述摆到同一条时间轴上。
 *
 * 流程：勾选口述 -> 创建提案（系统自动标出重复表述）
 *      -> 人工逐条确认/驳回 -> 确认完毕才允许执行合并。
 */
export function MergePage() {
  const { workspaceId, recipeId } = useParams<{ workspaceId: string; recipeId: string }>();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [selectedAudioIds, setSelectedAudioIds] = useState<string[]>([]);

  const recipe = useQuery({
    queryKey: ['recipe', recipeId],
    queryFn: () => recipeApi.get(recipeId!),
    enabled: Boolean(recipeId),
  });

  const audios = useQuery({
    queryKey: ['audio', recipeId],
    queryFn: () => audioApi.list({ recipeId: recipeId! }),
    enabled: Boolean(recipeId),
  });

  const merges = useQuery({
    queryKey: ['timeline-merges', recipeId],
    queryFn: () => timelineApi.list(recipeId!),
    enabled: Boolean(recipeId),
  });

  const invalidateMerges = () => {
    void queryClient.invalidateQueries({ queryKey: ['timeline-merges', recipeId] });
  };

  const createMutation = useMutation({
    mutationFn: () => timelineApi.create(recipeId!, selectedAudioIds),
    onSuccess: (merge) => {
      setSelectedAudioIds([]);
      const pending = merge.counts?.pendingDuplicates ?? 0;
      message.success(
        pending > 0
          ? `已生成合并提案，自动标出 ${pending} 处重复表述，请逐条确认`
          : '已生成合并提案，没有发现明显的重复表述',
      );
      invalidateMerges();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ duplicateId, action }: { duplicateId: string; action: 'confirm' | 'dismiss' }) =>
      action === 'confirm'
        ? timelineApi.confirmDuplicate(duplicateId)
        : timelineApi.dismissDuplicate(duplicateId),
    onSuccess: () => invalidateMerges(),
    onError: (error) => message.error(errorMessage(error)),
  });

  const offsetMutation = useMutation({
    mutationFn: ({ itemId, offsetMs }: { itemId: string; offsetMs: number }) =>
      timelineApi.updateItemOffset(itemId, offsetMs),
    onSuccess: () => invalidateMerges(),
    onError: (error) => message.error(errorMessage(error)),
  });

  const mergeMutation = useMutation({
    mutationFn: (mergeId: string) => timelineApi.merge(mergeId),
    onSuccess: () => {
      message.success('已合并：多段口述现在共用同一条时间轴');
      invalidateMerges();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const discardMutation = useMutation({
    mutationFn: (mergeId: string) => timelineApi.discard(mergeId),
    onSuccess: () => {
      message.info('已放弃这次合并提案');
      invalidateMerges();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const reviewingMerge = merges.data?.find((merge) => merge.status === 'reviewing') ?? null;
  const historyMerges = merges.data?.filter((merge) => merge.status !== 'reviewing') ?? [];
  // 与服务端一致：确认重复、调整位置、执行合并都是整理者及以上的动作，
  // 贡献者/旁观者只能看（服务端仍会再拦一道，这里只是不给出会失败的按钮）
  const myRole = recipe.data?.myRole;
  const canEdit = myRole === 'owner' || myRole === 'editor';

  if (recipe.isLoading || merges.isLoading) return <Spin size="large" />;

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>多段口述合并 · {recipe.data?.title}</h1>
          <div className="froa-hint">
            把同一道菜分几次说的口述摆到同一条时间轴上。重复说的内容会被自动标出来，
            由你逐条确认之后才真的合并 —— 原始语音永远原样保留。
          </div>
        </div>
        <Space wrap>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}/record`}>
            <Button>录音工作台</Button>
          </Link>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}`}>
            <Button type="primary">查看食谱</Button>
          </Link>
        </Space>
      </div>

      {reviewingMerge ? (
        <ReviewingMergeCard
          merge={reviewingMerge}
          canEdit={canEdit}
          onResolve={(duplicateId, action) => resolveMutation.mutate({ duplicateId, action })}
          resolving={resolveMutation.isPending}
          onMoveItem={(itemId, offsetMs) => offsetMutation.mutate({ itemId, offsetMs })}
          onMerge={() => mergeMutation.mutate(reviewingMerge.id)}
          merging={mergeMutation.isPending}
          onDiscard={() => discardMutation.mutate(reviewingMerge.id)}
          discarding={discardMutation.isPending}
        />
      ) : (
        <div className="froa-card">
          <h3 className="froa-card-title">选择要合并的口述</h3>
          {(audios.data ?? []).length < 2 ? (
            <Empty
              description={
                <>
                  这张食谱还不足两段语音。
                  <br />
                  先到录音工作台录几段口述，再回来合并。
                </>
              }
            />
          ) : !canEdit ? (
            <>
              <Typography.Paragraph type="secondary">
                当前还没有待确认的合并提案。创建提案需要整理者操作，你可以查看已有的合并记录。
              </Typography.Paragraph>
              <List
                size="small"
                dataSource={audios.data ?? []}
                renderItem={(audio) => (
                  <List.Item>
                    <List.Item.Meta
                      title={audioTitle(audio)}
                      description={audio.transcriptStatus === 'done' ? '已转写' : '未转写'}
                    />
                  </List.Item>
                )}
              />
            </>
          ) : (
            <>
              <Typography.Paragraph type="secondary">
                勾选同一道菜分几次录的口述（至少两段）。有转写文本的段落才会参与重复表述检测；
                还没转写的可以先去录音工作台补上。
              </Typography.Paragraph>
              <Checkbox.Group
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                value={selectedAudioIds}
                onChange={(values) => setSelectedAudioIds(values as string[])}
                options={(audios.data ?? []).map((audio) => ({
                  value: audio.id,
                  label: `${audioTitle(audio)} · ${audio.transcriptStatus === 'done' ? '已转写' : '未转写'}`,
                }))}
              />
              <div className="froa-row" style={{ marginTop: '1rem' }}>
                <Button
                  type="primary"
                  icon={<MergeCellsOutlined />}
                  disabled={selectedAudioIds.length < 2}
                  loading={createMutation.isPending}
                  onClick={() => createMutation.mutate()}
                >
                  生成合并提案（{selectedAudioIds.length} 段）
                </Button>
                <span className="froa-hint">重复表述只会被标出来，不会自动删改任何内容</span>
              </div>
            </>
          )}
        </div>
      )}

      {historyMerges.length > 0 && (
        <div className="froa-card">
          <h3 className="froa-card-title">合并记录（{historyMerges.length}）</h3>
          <Collapse
            items={historyMerges.map((merge) => ({
              key: merge.id,
              label: (
                <Space>
                  <Tag color={merge.status === 'merged' ? 'green' : 'default'}>
                    {TIMELINE_MERGE_STATUS_LABELS[merge.status]}
                  </Tag>
                  <span>
                    {merge.counts?.items ?? 0} 段 · 总时长 {formatMs(merge.totalDurationMs)} ·{' '}
                    {merge.createdAt.slice(0, 16).replace('T', ' ')}
                  </span>
                </Space>
              ),
              children: <MergedMergeView merge={merge} />,
            }))}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 待确认的合并提案                                                      */
/* ------------------------------------------------------------------ */

function ReviewingMergeCard({
  merge,
  canEdit,
  onResolve,
  resolving,
  onMoveItem,
  onMerge,
  merging,
  onDiscard,
  discarding,
}: {
  merge: TimelineMergeDto;
  canEdit: boolean;
  onResolve: (duplicateId: string, action: 'confirm' | 'dismiss') => void;
  resolving: boolean;
  onMoveItem: (itemId: string, offsetMs: number) => void;
  onMerge: () => void;
  merging: boolean;
  onDiscard: () => void;
  discarding: boolean;
}) {
  const items = useMemo(
    () => (merge.items ?? []).filter((item) => item.audio),
    [merge.items],
  );
  const duplicates = merge.duplicates ?? [];
  const pendingCount = merge.counts?.pendingDuplicates ?? 0;
  const { playAll, playFrom, playRange, playheadMs } = useMergedPlayback(items);

  return (
    <>
      <Alert
        type="info"
        showIcon
        message={
          pendingCount > 0
            ? `系统自动标出 ${pendingCount} 处待确认的重复表述，逐条确认或驳回后才能合并`
            : '重复表述都处理完了，可以执行合并'
        }
      />

      <div className="froa-card">
        <div className="froa-row" style={{ justifyContent: 'space-between' }}>
          <h3 className="froa-card-title" style={{ margin: 0 }}>
            合并时间轴（{items.length} 段 · 共 {formatMs(merge.totalDurationMs)}）
          </h3>
          <Button icon={<PlayCircleOutlined />} onClick={playAll}>
            从头连播
          </Button>
        </div>

        <MergedTimeline
          items={items.map((item) => ({ audio: item.audio!, offsetMs: item.offsetMs }))}
          totalDurationMs={merge.totalDurationMs}
          duplicates={duplicates}
          playheadMs={playheadMs}
          onSeek={playFrom}
        />
        <div className="froa-hint" style={{ marginTop: 4 }}>
          点击时间轴可从该位置开始播放。橙色块 = 待确认的重复表述，绿色块 = 已确认重复；
          高亮位置是按文字比例估算的。
        </div>

        <List
          size="small"
          style={{ marginTop: '1rem' }}
          header={canEdit ? '各段在时间轴上的位置（秒，可微调）' : '各段在时间轴上的位置（秒）'}
          dataSource={items}
          renderItem={(item, index) => (
            <List.Item
              actions={
                canEdit
                  ? [
                      <InputNumber
                        key={`${item.id}:${item.offsetMs}`}
                        size="small"
                        min={0}
                        step={1}
                        defaultValue={Math.round(item.offsetMs / 1000)}
                        onBlur={(event) => {
                          const seconds = Number((event.target as HTMLInputElement).value);
                          if (Number.isFinite(seconds) && seconds >= 0 && seconds * 1000 !== item.offsetMs) {
                            onMoveItem(item.id, Math.round(seconds * 1000));
                          }
                        }}
                        onPressEnter={(event) => {
                          const seconds = Number((event.target as HTMLInputElement).value);
                          if (Number.isFinite(seconds) && seconds >= 0 && seconds * 1000 !== item.offsetMs) {
                            onMoveItem(item.id, Math.round(seconds * 1000));
                          }
                        }}
                      />,
                    ]
                  : [<span key="offset">{Math.round(item.offsetMs / 1000)}</span>]
              }
            >
              <List.Item.Meta
                title={`第 ${index + 1} 段 · ${item.audio ? kindLabel(item.audio.kind) : ''}`}
                description={`时长 ${formatMs(item.audio?.durationMs ?? 0)} · ${item.audio?.transcriptStatus === 'done' ? '已转写' : '未转写'}`}
              />
            </List.Item>
          )}
        />
      </div>

      <div className="froa-card">
        <h3 className="froa-card-title">重复表述（{duplicates.length}）</h3>
        {duplicates.length === 0 ? (
          <Typography.Text type="secondary">
            没有发现跨段重复的表述。如果几段口述内容完全不同，可以直接合并。
          </Typography.Text>
        ) : (
          <List
            dataSource={duplicates}
            renderItem={(duplicate) => (
              <List.Item
                actions={
                  canEdit
                    ? [
                        <Button
                          key="confirm"
                          size="small"
                          type={duplicate.status === 'confirmed' ? 'primary' : 'default'}
                          icon={<CheckOutlined />}
                          disabled={resolving}
                          onClick={() => onResolve(duplicate.id, 'confirm')}
                        >
                          是重复
                        </Button>,
                        <Button
                          key="dismiss"
                          size="small"
                          type={duplicate.status === 'dismissed' ? 'primary' : 'default'}
                          icon={<CloseOutlined />}
                          disabled={resolving}
                          onClick={() => onResolve(duplicate.id, 'dismiss')}
                        >
                          各自保留
                        </Button>,
                      ]
                    : []
                }
              >
                <List.Item.Meta
                  title={
                    <Space wrap>
                      <span>「{duplicate.displayText}」</span>
                      <Tag
                        color={
                          duplicate.status === 'pending'
                            ? 'orange'
                            : duplicate.status === 'confirmed'
                              ? 'green'
                              : 'default'
                        }
                      >
                        {TIMELINE_DUPLICATE_STATUS_LABELS[duplicate.status]}
                      </Tag>
                    </Space>
                  }
                  description={
                    <div className="froa-stack" style={{ gap: 4 }}>
                      {duplicate.occurrences.map((occurrence, occurrenceIndex) => {
                        const segmentIndex = items.findIndex(
                          (item) => item.audio?.id === occurrence.audioId,
                        );
                        const audio = items[segmentIndex]?.audio;
                        return (
                          <div key={occurrenceIndex} className="froa-row">
                            <span>
                              第 {segmentIndex + 1} 段 · 约 {formatMs(occurrence.estimatedStartMs)}
                            </span>
                            {audio && (
                              <Button
                                size="small"
                                type="link"
                                icon={<SoundOutlined />}
                                onClick={() =>
                                  playRange(
                                    audio,
                                    occurrence.estimatedStartMs,
                                    occurrence.estimatedEndMs,
                                    `重复表述：${duplicate.displayText}`,
                                  )
                                }
                              >
                                听这句
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  }
                />
              </List.Item>
            )}
          />
        )}

        {canEdit && (
          <div className="froa-row" style={{ marginTop: '1rem' }}>
            <Tooltip title={pendingCount > 0 ? `还有 ${pendingCount} 条重复表述待确认` : undefined}>
              <Button type="primary" icon={<MergeCellsOutlined />} disabled={pendingCount > 0} loading={merging} onClick={onMerge}>
                确认合并
              </Button>
            </Tooltip>
            <Popconfirm
              title="放弃这次合并提案？"
              description="已做的确认标记会一并丢弃，原始语音不受影响。"
              okText="放弃提案"
              cancelText="再想想"
              onConfirm={onDiscard}
            >
              <Button danger loading={discarding}>
                放弃合并
              </Button>
            </Popconfirm>
            <span className="froa-hint">合并不会改动任何原始音频，只是固定下这条共用时间轴</span>
          </div>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 已合并 / 已放弃的只读视图                                              */
/* ------------------------------------------------------------------ */

function MergedMergeView({ merge }: { merge: TimelineMergeDto }) {
  const items = useMemo(
    () => (merge.items ?? []).filter((item) => item.audio),
    [merge.items],
  );
  const { playAll, playFrom, playRange, playheadMs } = useMergedPlayback(items);
  const confirmed = (merge.duplicates ?? []).filter((d) => d.status === 'confirmed');

  return (
    <div className="froa-stack">
      <div className="froa-row" style={{ justifyContent: 'space-between' }}>
        <span className="froa-hint">
          {merge.status === 'merged'
            ? `已于 ${merge.mergedAt?.slice(0, 16).replace('T', ' ')} 合并`
            : '该提案已放弃，仅留档'}
          {confirmed.length > 0 ? ` · 确认过 ${confirmed.length} 处重复` : ''}
        </span>
        {merge.status === 'merged' && (
          <Button size="small" icon={<PlayCircleOutlined />} onClick={playAll}>
            从头连播
          </Button>
        )}
      </div>
      <MergedTimeline
        items={items.map((item) => ({ audio: item.audio!, offsetMs: item.offsetMs }))}
        totalDurationMs={merge.totalDurationMs}
        duplicates={merge.status === 'merged' ? (merge.duplicates ?? []) : []}
        playheadMs={playheadMs}
        onSeek={merge.status === 'merged' ? playFrom : undefined}
      />
      {confirmed.length > 0 && (
        <List
          size="small"
          dataSource={confirmed}
          renderItem={(duplicate) => (
            <List.Item
              actions={duplicate.occurrences.slice(0, 1).map((occurrence, index) => {
                const audio = items.find((item) => item.audio?.id === occurrence.audioId)?.audio;
                return audio ? (
                  <Button
                    key={index}
                    size="small"
                    type="link"
                    icon={<SoundOutlined />}
                    onClick={() =>
                      playRange(audio, occurrence.estimatedStartMs, occurrence.estimatedEndMs, duplicate.displayText)
                    }
                  >
                    听
                  </Button>
                ) : null;
              })}
            >
              <List.Item.Meta title={`「${duplicate.displayText}」重复 ${duplicate.occurrences.length} 次`} />
            </List.Item>
          )}
        />
      )}
    </div>
  );
}
