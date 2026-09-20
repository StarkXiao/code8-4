import { useState } from 'react';
import { App as AntApp, Button, Space, Tag, Typography } from 'antd';
import { CheckCircleOutlined, SoundOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DUPLICATE_REVIEW_LABELS,
  type AudioAttachmentDto,
  type TimelineDuplicateGroupDto,
} from '@froa/shared';
import { timelineApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { formatMs } from '../../components/Waveform';

interface DuplicateReviewPanelProps {
  group: TimelineDuplicateGroupDto;
  timelineId: string;
  /** 时间轴已定稿：只展示，不允许再改 */
  locked: boolean;
  expectedUpdatedAt: string;
  onPlayTrack: (audio: AudioAttachmentDto, localMs: number) => void;
}

/**
 * 一组疑似重复表述的人工确认卡片。
 *
 * 机器只负责把组摆出来；这里必须由人做两件事之一：
 * - 确认重复：选定保留哪一句（合并文稿里其余同组句不重复出现）；
 * - 不是重复：两句都保留。
 * 音频一律不动，任何时候都能点"听原声"回到那句话。
 */
export function DuplicateReviewPanel({
  group,
  timelineId,
  locked,
  expectedUpdatedAt,
  onPlayTrack,
}: DuplicateReviewPanelProps) {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [keepAudioId, setKeepAudioId] = useState<string | null>(group.keepAudioId);
  const [note, setNote] = useState(group.reviewNote ?? '');

  const reviewMutation = useMutation({
    mutationFn: (input: { status: 'duplicate' | 'distinct'; keep?: string | null }) =>
      timelineApi.review(timelineId, group.id, {
        status: input.status,
        keepAudioId: input.status === 'duplicate' ? input.keep ?? keepAudioId : null,
        note: note.trim() || null,
        expectedUpdatedAt,
      }),
    onSuccess: (_data, variables) => {
      message.success(variables.status === 'duplicate' ? '已标记为重复' : '已标记为不是重复');
      void queryClient.invalidateQueries({ queryKey: ['timeline'] });
      void queryClient.invalidateQueries({ queryKey: ['timelines'] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const statusTag = {
    pending: <Tag color="orange">{DUPLICATE_REVIEW_LABELS.pending}</Tag>,
    duplicate: <Tag color="green">{DUPLICATE_REVIEW_LABELS.duplicate}</Tag>,
    distinct: <Tag color="blue">{DUPLICATE_REVIEW_LABELS.distinct}</Tag>,
  }[group.status];

  return (
    <div className="froa-step-card" data-status={group.status}>
      <div className="froa-row" style={{ justifyContent: 'space-between' }}>
        <Space>
          {statusTag}
          <span className="froa-hint">相似度 {Math.round(group.score * 100)}%（仅供参考）</span>
        </Space>
        {group.reviewNote && <span className="froa-hint">备注：{group.reviewNote}</span>}
      </div>

      <div className="froa-stack" style={{ marginTop: 8 }}>
        {group.members.map((member, index) => {
          const audio = member.audio;
          const checked = group.status === 'duplicate' && group.keepAudioId === member.audioId;
          return (
            <div
              key={`${member.audioId}-${index}`}
              className="froa-dup-member"
              data-kept={checked || undefined}
            >
              <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
                <Space>
                  {!locked && (
                    <input
                      type="radio"
                      name={`keep-${group.id}`}
                      checked={keepAudioId === member.audioId}
                      onChange={() => setKeepAudioId(member.audioId)}
                      aria-label="保留这一句"
                    />
                  )}
                  {checked && <CheckCircleOutlined style={{ color: '#52a447' }} />}
                  <Typography.Text strong>
                    {index + 1}. 「{member.sentence}」
                  </Typography.Text>
                  <span className="froa-hint">
                    {audio ? `${audio.createdAt.slice(5, 16).replace('T', ' ')} 录 · ${formatMs(audio.durationMs)}` : '音频已不在时间轴'}
                  </span>
                </Space>
                {audio && (
                  <Button
                    size="small"
                    icon={<SoundOutlined />}
                    onClick={() => onPlayTrack(audio, 0)}
                  >
                    听这句原声
                  </Button>
                )}
              </Space>
            </div>
          );
        })}
      </div>

      {!locked && (
        <div style={{ marginTop: 10 }}>
          <Space wrap style={{ marginBottom: 8 }}>
            <Button
              type="primary"
              ghost
              disabled={!keepAudioId}
              loading={reviewMutation.isPending}
              onClick={() => reviewMutation.mutate({ status: 'duplicate', keep: keepAudioId })}
            >
              确认重复（保留选中的一句）
            </Button>
            <Button
              loading={reviewMutation.isPending}
              onClick={() => reviewMutation.mutate({ status: 'distinct' })}
            >
              不是重复（两句都保留）
            </Button>
          </Space>
          <input
            className="froa-note-input"
            placeholder="可补一句为什么（留空也行）"
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      )}
    </div>
  );
}
