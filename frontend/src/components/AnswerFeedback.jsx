import React from 'react';

/**
 * 统一答题反馈横幅
 *
 * Props:
 *  - isCorrect: boolean      是否答对
 *  - successMsg: string      答对时的解析（可选）
 *  - failMsg: string         答错时的解析（可选）
 *  - explanation: string     兜底/补充说明（可选，对错都显示在最下方）
 *  - correctAnswer: string   答错时显示的正确答案（可选）
 */
const AnswerFeedback = ({
  isCorrect,
  successMsg,
  failMsg,
  explanation,
  correctAnswer,
}) => {
  const palette = isCorrect
    ? {
        bg: '#E5F6D0',
        border: '#58CC02',
        text: '#3C8500',
        emoji: '🎉',
        title: '答对了！',
      }
    : {
        bg: '#FFE5E5',
        border: '#FF4B4B',
        text: '#C0392B',
        emoji: '😞',
        title: '答错了',
      };

  // 主解析文案（区分对错）
  const primaryMsg = isCorrect ? successMsg : failMsg;

  // 如果用户只传了 explanation 而没传对应的 success/fail，
  // 就把 explanation 作为主解析显示，避免出现"应改为..."这种暗示错误的兜底文案。
  const showExplanationAsPrimary = !primaryMsg && !!explanation;

  // explanation 只在它和主解析不重复时，作为额外补充显示在底部
  const showExplanationFooter =
    !!explanation && !showExplanationAsPrimary && explanation !== primaryMsg;

  return (
    <>
      <style>{`
        @keyframes answerFeedbackFadeIn {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div
        role="status"
        aria-live="polite"
        style={{
          background: palette.bg,
          border: `2px solid ${palette.border}`,
          borderRadius: 'var(--radius-sm)',
          padding: '14px',
          marginTop: '12px',
          animation: 'answerFeedbackFadeIn 0.3s ease-out',
          color: palette.text,
        }}
      >
        {/* 顶部：emoji + 标题 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}
        >
          <span style={{ fontSize: '24px', lineHeight: 1 }}>
            {palette.emoji}
          </span>
          <span
            style={{
              fontSize: '16px',
              fontWeight: 700,
              color: palette.border,
            }}
          >
            {palette.title}
          </span>
        </div>

        {/* 答错时：显示正确答案 */}
        {!isCorrect && correctAnswer && (
          <div
            style={{
              marginTop: '10px',
              fontSize: '14px',
              fontWeight: 600,
              color: palette.text,
            }}
          >
            正确答案：<span style={{ fontWeight: 700 }}>{correctAnswer}</span>
          </div>
        )}

        {/* 主解析 */}
        {(primaryMsg || showExplanationAsPrimary) && (
          <div
            style={{
              marginTop: '8px',
              fontSize: '14px',
              lineHeight: 1.6,
              color: palette.text,
            }}
          >
            {primaryMsg || explanation}
          </div>
        )}

        {/* 额外补充（兜底 explanation） */}
        {showExplanationFooter && (
          <div
            style={{
              marginTop: '10px',
              paddingTop: '10px',
              borderTop: `1px dashed ${palette.border}`,
              fontSize: '13px',
              lineHeight: 1.6,
              color: '#666',
              fontWeight: 400,
            }}
          >
            {explanation}
          </div>
        )}
      </div>
    </>
  );
};

export default AnswerFeedback;
