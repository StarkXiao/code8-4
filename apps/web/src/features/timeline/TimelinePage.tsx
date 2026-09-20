import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  App as AntApp,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  MergeCellsOutlined,
  PlusOutlined,
  RedoOutlined,
  SoundOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DUPLICATE_REVIEW_LABELS,
  TIMELINE_STATUS_LABELS,
  type AudioTimelineDto,
} from '@froa/shared';
import { audioApi, recipeApi, timelineApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';
import { usePlayerStore } from '../../store/player';
import { formatMs } from '../../components/Waveform';
import { TimelineWave } from '../../components/TimelineWave';
import { DuplicateReviewPanel } from './DuplicateReviewPanel';

const KIND_LABELS: Record<string, string> = {
  recipe_voice: '长辈口述',
  answer_voice: '回答追问',
  verification_voice: '复做反馈',
  note_voice: '补充备注',
};

/**
 * 口述时间轴页。
 *
 * 一条时间轴承载"同一道菜的多段口述 -> 自动标出重复 -> 人工逐组确认 -> 合并"全过程：
 * - 时间轴只是**整理层**，不会拼接或删除任何音频，每段原声始终可独立回放；
 * - 机器只负责标"疑似重复"，必须逐组经人确认，有任何一组没看就不允许合并。
 */
export function TimelinePage() {
  const { workspaceId, recipeId } = useParams<{ workspaceId: string; recipeId: string }>();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const { playAudio } = useAudioPlayback();
  const currentAudioId = usePlayerStore((s) => s.request?.audioId ?? null);
  const currentMs = usePlayerStore((s) => s.currentMs);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<{ title: string; audioIds?: string[] }>();
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeForm] = Form.useForm<{ changeNote: string }>();
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenForm] = Form.useForm<{ reason: string }>();

  const recipe = useQuery({
    queryKey: ['recipe', recipeId],
    queryFn: () => recipeApi.get(recipeId!),
    enabled: Boolean(recipeId),
  });

  const timelines = useQuery({
    queryKey: ['timelines', recipeId],
    queryFn: () => timelineApi.list(recipeId!),
    enabled: Boolean(recipeId),
  });

  const audios = useQuery({
    queryKey: ['audio', recipeId],
    queryFn: () => audioApi.list({ recipeId: recipeId! }),
    enabled: Boolean(recipeId),
  });

  // 同一道菜可能多次整理：取最近更新的一条作为"当前时间轴"
  const activeTimeline = timelines.data?.[0] ?? null;

  const detail = useQuery({
    queryKey: ['timeline', activeTimeline?.id],
    queryFn: () => timelineApi.get(activeTimeline!.id),
    enabled: Boolean(activeTimeline?.id),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['timelines', recipeId] });
    void queryClient.invalidateQueries({ queryKey: ['timeline'] });
  };

  const createMutation = useMutation({
    mutationFn: (values: { title: string; audioIds: string[] }) =>
      timelineApi.create(recipeId!, values),
    onSuccess: () => {
      setCreateOpen(false);
      message.success('时间轴已创建');
      invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const addTracksMutation = useMutation({
    mutationFn: (audioIds: string[]) => timelineApi.addTracks(activeTimeline!.id, { audioIds }),
    onSuccess: () => {
      setAddOpen(false);
      setSelected([]);
      message.success('已加入时间轴');
      invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const removeTrackMutation = useMutation({
    mutationFn: (audioId: string) => timelineApi.removeTrack(activeTimeline!.id, audioId),
    onSuccess: () => {
      message.success('已从时间轴移除（音频本身保留）');
      invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const reorderMutation = useMutation({
    mutationFn: (orderedAudioIds: string[]) => timelineApi.reorder(activeTimeline!.id, orderedAudioIds),
    onSuccess: invalidate,
    onError: (error) => message.error(errorMessage(error)),
  });

  const scanMutation = useMutation({
    mutationFn: () => timelineApi.scan(activeTimeline!.id, { replacePending: true }),
    onSuccess: (result) => {
      invalidate();
      const count = result.duplicateGroups?.filter((group) => group.status === 'pending').length ?? 0;
      if (count === 0) {
        message.info('没有发现跨段落的疑似重复表述。');
      } else {
        message.warning(`自动标出 ${count} 组疑似重复，请逐组确认后再合并。`);
      }
      if (result.untranscribedAudioIds?.length) {
        message.warning(`有 ${result.untranscribedAudioIds.length} 段还没转写，没有参与比对。`);
      }
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const mergeMutation = useMutation({
    mutationFn: (values: { changeNote: string }) =>
      timelineApi.merge(activeTimeline!.id, {
        changeNote: values.changeNote,
        expectedUpdatedAt: detail.data?.updatedAt,
      }),
    onSuccess: () => {
      setMergeOpen(false);
      mergeForm.resetFields();
      message.success('时间轴已合并定稿');
      invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const reopenMutation = useMutation({
    mutationFn: (reason: string) => timelineApi.reopen(activeTimeline!.id, reason),
    onSuccess: () => {
      setReopenOpen(false);
      reopenForm.resetFields();
      message.success('已重新打开，可以继续调整');
      invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const tracks = detail.data?.tracks ?? [];
  const groups = detail.data?.duplicateGroups ?? [];
  const pendingCount = detail.data?.pendingReviewCount ?? 0;
  const locked = detail.data?.status === 'merged';

  const trackAudioIds = useMemo(() => new Set(tracks.map((track) => track.audioId)), [tracks]);
  const availableAudios = (audios.data ?? []).filter((audio) => !trackAudioIds.has(audio.id));

  if (recipe.isLoading || timelines.isLoading) return <Spin size="large" />;

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= tracks.length) return;
    const ordered = tracks.map((track) => track.audioId);
    [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
    reorderMutation.mutate(ordered);
  };

  const statusColor = { building: 'gold', reviewing: 'orange', merged: 'green' } as const;

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>口述时间轴 · {recipe.data?.title}</h1>
          <div className="froa-hint">
            把同一道菜的多段口述排在同一条时间轴上，重复的说法自动标出，经你逐组确认后再合并。音频永远保留。
          </div>
        </div>
        <Space wrap>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}/record`}>
            <Button icon={<SoundOutlined />}>去录音</Button>
          </Link>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}`}>
            <Button>返回食谱</Button>
          </Link>
          {!activeTimeline && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建时间轴
            </Button>
          )}
        </Space>
      </div>

      {!activeTimeline ? (
        <div className="froa-card">
          <Empty description="还没有时间轴">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              把已录的口述排到一条时间轴上
            </Button>
          </Empty>
        </div>
      ) : (
        <TimelineBody
          timeline={detail.data ?? null}
          loading={detail.isLoading}
          locked={locked}
          pendingCount={pendingCount}
          currentAudioId={currentAudioId}
          currentMs={currentMs}
          statusColor={statusColor[detail.data?.status ?? 'building']}
          statusLabel={TIMELINE_STATUS_LABELS[detail.data?.status ?? 'building']}
          tracks={tracks}
          groups={groups}
          onPlayTrack={(audio, localMs) =>
            playAudio(audio, { startMs: localMs, label: `时间轴 · ${KIND_LABELS[audio.kind] ?? audio.kind}` })
          }
          onMove={move}
          onRemove={(audioId) => removeTrackMutation.mutate(audioId)}
          onAdd={() => {
            setSelected([]);
            setAddOpen(true);
          }}
          onScan={() => scanMutation.mutate()}
          onMerge={() => setMergeOpen(true)}
          onReopen={() => setReopenOpen(true)}
          scanning={scanMutation.isPending}
          reordering={reorderMutation.isPending}
        />
      )}

      {/* 新建时间轴 */}
      <Modal
        open={createOpen}
        title="新建口述时间轴"
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={createMutation.isPending}
        okText="创建"
        cancelText="取消"
        destroyOnClose
      >
        <Form
          form={createForm}
          layout="vertical"
          initialValues={{ audioIds: [] }}
          onFinish={(values) =>
            createMutation.mutate({ title: values.title, audioIds: values.audioIds ?? [] })
          }
        >
          <Form.Item label="时间轴名称" name="title" rules={[{ required: true, message: '请填写名称' }]}>
            <Input placeholder="例如：外婆 9 月两次口述合并" />
          </Form.Item>
          <Form.Item label="先选入口述段（按住 Ctrl 多选；也可以建好后再加）" name="audioIds">
            <select multiple className="froa-multi-select">
              {(audios.data ?? []).map((audio) => (
                <option key={audio.id} value={audio.id}>
                  {KIND_LABELS[audio.kind] ?? audio.kind} · {formatMs(audio.durationMs)} ·{' '}
                  {audio.transcriptStatus === 'done' ? '已转写' : '待转写'}
                </option>
              ))}
            </select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 加入口述段 */}
      <Modal
        open={addOpen}
        title="把口述段加入时间轴"
        onCancel={() => setAddOpen(false)}
        onOk={() => selected.length && addTracksMutation.mutate(selected)}
        okButtonProps={{ disabled: !selected.length }}
        confirmLoading={addTracksMutation.isPending}
        okText="加入"
        cancelText="取消"
      >
        {availableAudios.length === 0 ? (
          <Empty description="没有可加入的口述段，先去录音吧" />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            {availableAudios.map((audio) => (
              <label key={audio.id} className="froa-check-row">
                <input
                  type="checkbox"
                  checked={selected.includes(audio.id)}
                  onChange={(event) =>
                    setSelected((prev) =>
                      event.target.checked ? [...prev, audio.id] : prev.filter((id) => id !== audio.id),
                    )
                  }
                />
                <span>
                  {KIND_LABELS[audio.kind] ?? audio.kind} · {formatMs(audio.durationMs)} ·{' '}
                  {audio.transcriptStatus === 'done' ? '已转写' : '待转写'}
                  {(audio.transcript ?? '').slice(0, 30) ? ` 「${(audio.transcript ?? '').slice(0, 30)}…」` : ''}
                </span>
              </label>
            ))}
          </Space>
        )}
      </Modal>

      {/* 合并定稿 */}
      <Modal
        open={mergeOpen}
        title="合并时间轴"
        onCancel={() => setMergeOpen(false)}
        onOk={() => mergeForm.submit()}
        confirmLoading={mergeMutation.isPending}
        okText="确认合并"
        cancelText="取消"
      >
        {pendingCount > 0 && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={`还有 ${pendingCount} 组疑似重复没有确认`}
            description="必须逐组标记「确认重复」或「不是重复」之后，才能合并。"
          />
        )}
        <Typography.Paragraph type="secondary">
          合并只会把转写文本按时间顺序拼成一份定稿文稿（重复句按你的取舍只保留首选句）；
          <strong>不会拼接或删除任何音频</strong>，每段原声仍可独立回放。
        </Typography.Paragraph>
        <Form form={mergeForm} layout="vertical" onFinish={(values) => mergeMutation.mutate(values)}>
          <Form.Item
            label="合并说明（这些重复表述是怎么取舍的）"
            name="changeNote"
            rules={[{ required: true, min: 5, message: '至少写 5 个字，日后才知道当时为什么这么并' }]}
          >
            <Input.TextArea rows={3} placeholder="例如：糖的用量两句重复，保留第一次口述；其余按时间顺序拼接。" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 重开 */}
      <Modal
        open={reopenOpen}
        title="重新打开时间轴"
        onCancel={() => setReopenOpen(false)}
        onOk={() => reopenForm.submit()}
        confirmLoading={reopenMutation.isPending}
        okText="重新打开"
        cancelText="取消"
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          已有的人工裁定会保留；定稿文稿会清空，调整后需要重新扫描 / 合并。
        </Typography.Paragraph>
        <Form
          form={reopenForm}
          layout="vertical"
          onFinish={(values) => reopenMutation.mutate(values.reason)}
        >
          <Form.Item
            name="reason"
            rules={[{ required: true, min: 2, message: '请说明为什么重新整理（至少 2 个字）' }]}
          >
            <Input.TextArea rows={2} placeholder="例如：外婆又补录了一段，得并进去。" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 时间轴主体：拼接波形 + 轨道列表 + 重复确认                           */
/* ------------------------------------------------------------------ */

interface TimelineBodyProps {
  timeline: AudioTimelineDto | null;
  loading: boolean;
  locked: boolean;
  pendingCount: number;
  currentAudioId: string | null;
  currentMs: number;
  statusColor: string;
  statusLabel: string;
  tracks: NonNullable<AudioTimelineDto['tracks']>;
  groups: NonNullable<AudioTimelineDto['duplicateGroups']>;
  onPlayTrack: (audio: NonNullable<NonNullable<AudioTimelineDto['tracks']>[number]['audio']>, localMs: number) => void;
  onMove: (index: number, delta: number) => void;
  onRemove: (audioId: string) => void;
  onAdd: () => void;
  onScan: () => void;
  onMerge: () => void;
  onReopen: () => void;
  scanning: boolean;
  reordering: boolean;
}

function TimelineBody(props: TimelineBodyProps) {
  const {
    timeline,
    loading,
    locked,
    pendingCount,
    currentAudioId,
    currentMs,
    statusColor,
    statusLabel,
    tracks,
    groups,
    onPlayTrack,
    onMove,
    onRemove,
    onAdd,
    onScan,
    onMerge,
    onReopen,
    scanning,
    reordering,
  } = props;

  if (loading || !timeline) return <Spin size="large" />;

  const totalDuration = tracks.length
    ? tracks[tracks.length - 1]!.offsetMs + tracks[tracks.length - 1]!.durationMs
    : 0;

  return (
    <>
      <div className="froa-card">
        <div className="froa-row" style={{ justifyContent: 'space-between' }}>
          <Space>
            <h3 className="froa-card-title" style={{ margin: 0 }}>
              {timeline.title ?? '未命名时间轴'}
            </h3>
            <Tag color={statusColor}>{statusLabel}</Tag>
            <span className="froa-hint">
              {tracks.length} 段口述 · 全长 {formatMs(totalDuration)}
            </span>
          </Space>
          <Space>
            {locked ? (
              <Button icon={<RedoOutlined />} onClick={onReopen}>
                重新打开
              </Button>
            ) : (
              <>
                <Button icon={<PlusOutlined />} onClick={onAdd}>
                  加入口述段
                </Button>
                <Button
                  type="primary"
                  ghost
                  icon={<ThunderboltOutlined />}
                  loading={scanning}
                  disabled={tracks.length < 2}
                  onClick={onScan}
                >
                  扫描重复表述
                </Button>
                <Button
                  type="primary"
                  icon={<MergeCellsOutlined />}
                  disabled={tracks.length < 2}
                  onClick={onMerge}
                >
                  合并
                </Button>
              </>
            )}
          </Space>
        </div>

        {tracks.length === 0 ? (
          <Empty style={{ marginTop: 24 }} description="时间轴上还没有口述段" />
        ) : (
          <>
            <div style={{ marginTop: 16 }}>
              <TimelineWave
                tracks={tracks}
                totalDurationMs={totalDuration}
                activeAudioId={currentAudioId}
                activeMs={currentMs}
                onSeekTrack={(audioId, localMs) => {
                  const track = tracks.find((item) => item.audioId === audioId);
                  if (track?.audio) onPlayTrack(track.audio, localMs);
                }}
              />
            </div>

            <div className="froa-stack" style={{ marginTop: 12 }}>
              {tracks.map((track, index) => (
                <div key={track.id} className="froa-step-card">
                  <div className="froa-row" style={{ justifyContent: 'space-between' }}>
                    <Space wrap>
                      <span className="froa-step-index">{index + 1}</span>
                      <Tag>{KIND_LABELS[track.audio?.kind ?? ''] ?? track.audio?.kind}</Tag>
                      <strong>
                        轴上 {formatMs(track.offsetMs)} – {formatMs(track.offsetMs + track.durationMs)}
                      </strong>
                      <span className="froa-hint">（本段 {formatMs(track.durationMs)}）</span>
                      {track.audio?.transcriptStatus !== 'done' && <Tag color="red">未转写</Tag>}
                    </Space>
                    <Space>
                      <Button
                        size="small"
                        icon={<SoundOutlined />}
                        disabled={!track.audio}
                        onClick={() => track.audio && onPlayTrack(track.audio, 0)}
                      >
                        听原声
                      </Button>
                      {!locked && (
                        <>
                          <Button
                            size="small"
                            icon={<ArrowUpOutlined />}
                            disabled={index === 0 || reordering}
                            onClick={() => onMove(index, -1)}
                            aria-label="前移"
                          />
                          <Button
                            size="small"
                            icon={<ArrowDownOutlined />}
                            disabled={index === tracks.length - 1 || reordering}
                            onClick={() => onMove(index, 1)}
                            aria-label="后移"
                          />
                          <Popconfirm
                            title="从时间轴移除这段？"
                            description="只是移出整理顺序，原始音频与转写都会保留。"
                            onConfirm={() => onRemove(track.audioId)}
                            okText="移除"
                            cancelText="取消"
                          >
                            <Button size="small" danger>
                              移除
                            </Button>
                          </Popconfirm>
                        </>
                      )}
                    </Space>
                  </div>
                  {track.audio?.transcript && (
                    <Typography.Paragraph
                      type="secondary"
                      ellipsis={{ rows: 2 }}
                      style={{ marginTop: 8, marginBottom: 0 }}
                    >
                      {track.audio.transcript}
                    </Typography.Paragraph>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 重复表述人工确认 */}
      {groups.length > 0 && (
        <div className="froa-card">
          <div className="froa-row" style={{ justifyContent: 'space-between' }}>
            <h3 className="froa-card-title" style={{ margin: 0 }}>
              疑似重复的表述（{groups.length}）
            </h3>
            <Space>
              <Tag color={pendingCount ? 'orange' : 'green'}>
                {pendingCount ? `${pendingCount} 组待确认` : '全部已确认'}
              </Tag>
            </Space>
          </div>
          <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
            这些是机器按转写文本自动找出的"车轱辘话"，<strong>只作建议</strong>。
            每组都要由你听过原声后裁定：确实重复就选定保留哪一句；不是重复就都保留。
          </Typography.Paragraph>
          <div className="froa-stack">
            {groups.map((group) => (
              <DuplicateReviewPanel
                key={group.id}
                group={group}
                timelineId={timeline.id}
                locked={locked}
                expectedUpdatedAt={group.updatedAt}
                onPlayTrack={onPlayTrack}
              />
            ))}
          </div>
        </div>
      )}

      {/* 定稿文稿 */}
      {locked && timeline.mergedTranscript && (
        <div className="froa-card">
          <h3 className="froa-card-title">合并后的口述文稿</h3>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
            {timeline.mergedTranscript}
          </Typography.Paragraph>
        </div>
      )}
    </>
  );
}
