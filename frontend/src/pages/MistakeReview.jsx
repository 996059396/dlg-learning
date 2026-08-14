import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useGame } from '../context/GameContext';
import MultimeterChallenge from '../components/multimeter/MultimeterChallenge';

// ── Helper: fuzzy case-insensitive answer check ──
function answersMatch(userAnswer, correctAnswer) {
  if (!userAnswer || !correctAnswer) return false;
  const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalize(userAnswer) === normalize(correctAnswer);
}

export default function MistakeReview() {
  const navigate = useNavigate();
  const { user, gameState, showToast, setGameState } = useGame();

  const [mistakes, setMistakes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [reviewed, setReviewed] = useState(0);

  // Two-phase: 'answer' => user re-answers, 'result' => shows correct/incorrect
  const [phase, setPhase] = useState('answer');
  const [userReanswer, setUserReanswer] = useState('');
  const [isCorrect, setIsCorrect] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [lastSchedule, setLastSchedule] = useState(null);

  // Load mistakes from API (no demo fallback)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    if (user?.id && user.id !== 'demo') {
      api.getMistakes()
        .then(data => {
          if (!cancelled) {
            setMistakes(Array.isArray(data?.mistakes) ? data.mistakes : []);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setMistakes([]);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } else {
      // Demo/guest users have no stored mistakes; show empty state
      setMistakes([]);
      setLoading(false);
    }
  }, [user]);

  // Reset phase when moving to a new mistake
  useEffect(() => {
    setPhase('answer');
    setUserReanswer('');
    setIsCorrect(null);
    setSubmitted(false);
    setLastSchedule(null);
  }, [currentIndex]);

  const handleSubmitAnswer = useCallback(async () => {
    if (submitted || !userReanswer.trim()) return;
    setSubmitted(true);

    const current = mistakes[currentIndex];
    const correct = answersMatch(userReanswer, current?.correct_answer || '');
    setIsCorrect(correct);
    setPhase('result');

    // Record the recall outcome for SM-2 scheduling (server returns the next
    // review). The server RE-GRADES userReanswer against the stored node, so
    // the boolean sent here is informational only — no client-claimed outcome
    // ever earns practice-heal credit.
    if (user?.id && user.id !== 'demo' && current?.id) {
      try {
        const res = await api.reviewMistake(current.id, correct, userReanswer);
        if (res?.mistake) setLastSchedule(res.mistake);
      } catch {
        // continue even if backend call fails
      }
    }
  }, [submitted, userReanswer, mistakes, currentIndex, user]);

  const handleNext = useCallback(async () => {
    const current = mistakes[currentIndex];
    const newReviewed = reviewed + 1;
    setReviewed(newReviewed);

    // SM-2 outcome was already recorded at submit time (handleSubmitAnswer).

    if (currentIndex < mistakes.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      // All done — grant healing rewards
      const maxHearts = gameState?.max_hearts || 5;
      const currentHearts = gameState?.hearts || 0;
      const healAmount = Math.min(newReviewed, maxHearts - currentHearts);

      if (user?.id && user.id !== 'demo') {
        try {
          // Server grants hearts + coins and returns the authoritative game state.
          const res = await api.practiceHeal(newReviewed);
          if (res && setGameState) setGameState(res);
          if (res && typeof res.coinsEarned === 'number') {
            showToast(
              `复习完成！恢复 ${res.heartsRestored || 0} 颗红心 + ${res.coinsEarned} 金币`,
              'success'
            );
            navigate('/');
            return;
          }
        } catch {
          // continue
        }
      }

      showToast(
        `复习完成！恢复 ${healAmount > 0 ? healAmount : 0} 颗红心 + ${newReviewed * 10} 金币`,
        'success'
      );
      navigate('/');
    }
  }, [currentIndex, reviewed, mistakes, user, gameState, showToast, navigate, setGameState]);

  // ── Loading state ──
  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-secondary)' }}>加载中...</div>
      </div>
    );
  }

  // ── Empty state (no mistakes to review) ──
  if (mistakes.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px' }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}></div>
        <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>没有待复习的错题</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
          你还没有做错过题目，或者已经复习完了所有错题。
        </p>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 24 }}>
          完成课程后，做错的题目会出现在这里供你重新练习。
        </p>
        <button className="btn btn-primary btn-lg" onClick={() => navigate('/')}>
          返回学习
        </button>
      </div>
    );
  }

  const current = mistakes[currentIndex];
  const hasCorrectAnswer = current?.correct_answer && current.correct_answer.trim() !== '';

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}>
          <h1 style={{ fontSize: 24, fontWeight: 800 }}>错题医疗包</h1>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', fontWeight: 600 }}>
            {currentIndex + 1} / {mistakes.length}
          </div>
        </div>
        <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
          重新回答错题可以恢复红心 和赚取金币
        </div>
      </div>

      {/* ── Progress bar ── */}
      <div style={{
        height: 6,
        background: 'var(--border)',
        borderRadius: 3,
        marginBottom: 24,
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          background: 'var(--primary)',
          width: `${((currentIndex) / Math.max(mistakes.length, 1)) * 100}%`,
          borderRadius: 3,
          transition: 'width 0.3s',
        }} />
      </div>

      {/* ── Question card ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        {/* Original wrong answer banner */}
        <div style={{
          fontSize: 13,
          color: 'var(--danger)',
          fontWeight: 700,
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <span>之前答错了</span>
        </div>

        {/* Question text */}
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>
          {current?.question_text || '(题目加载失败)'}
        </div>

        {/* Show original wrong answer (collapsed) */}
        <div style={{
          padding: 10,
          background: '#FFF5F5',
          borderRadius: 'var(--radius-xs)',
          marginBottom: 16,
          fontSize: 13,
        }}>
          <span style={{ color: 'var(--text-secondary)' }}>你上次的回答：</span>
          <span style={{ fontWeight: 600, color: 'var(--danger)', marginLeft: 4 }}>
            {current?.user_answer || '(空)'}
          </span>
        </div>

        {/* ── Re-answer input / options ── */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: 'var(--text)' }}>
            现在重新回答：
          </div>

          {current?.original_node?.type === 'multimeter_challenge' ? (
            <div style={{ marginTop: 8 }}>
              <MultimeterChallenge
                key={current.id}
                node={current.original_node}
                onAnswer={(correct, setupStr) => {
                  if (phase === 'answer') {
                    setUserReanswer(setupStr || '已操作');
                    setIsCorrect(correct);
                    setSubmitted(true);
                    setPhase('result');
                  }
                }}
              />
            </div>
          ) : current?.original_node?.options ? (
            <div className="options-list">
              {current.original_node.options.map(opt => (
                <button
                  key={opt.id}
                  className={`option-btn ${
                    phase === 'answer' && userReanswer === opt.text
                      ? 'selected'
                      : phase === 'result' && opt.text === current.correct_answer
                      ? 'correct'
                      : phase === 'result' && userReanswer === opt.text && userReanswer !== current.correct_answer
                      ? 'wrong'
                      : ''
                  }`}
                  style={{
                    backgroundColor: phase === 'answer' && userReanswer === opt.text ? '#F0F8FF' : undefined,
                    borderColor: phase === 'answer' && userReanswer === opt.text ? 'var(--blue)' : undefined,
                  }}
                  onClick={() => {
                    if (phase === 'answer') setUserReanswer(opt.text);
                  }}
                  disabled={phase === 'result'}
                >
                  <span className="option-letter">{opt.id}</span>
                  <span>{opt.text}</span>
                </button>
              ))}
            </div>
          ) : current?.original_node?.type === 'true_false' ? (
            <div className="options-list">
               <button
                  className={`option-btn`}
                  style={{
                    backgroundColor: phase === 'answer' && userReanswer === '正确' ? '#F0F8FF' : phase === 'result' && current.correct_answer === '正确' ? '#E5F6D0' : phase === 'result' && userReanswer === '正确' ? '#FFE5E5' : undefined,
                    borderColor: phase === 'answer' && userReanswer === '正确' ? 'var(--blue)' : phase === 'result' && current.correct_answer === '正确' ? 'var(--primary)' : phase === 'result' && userReanswer === '正确' ? 'var(--danger)' : undefined,
                  }}
                  onClick={() => { if (phase === 'answer') setUserReanswer('正确'); }}
                  disabled={phase === 'result'}
                >
                  <span className="option-letter">✓</span><span>正确</span>
                </button>
                <button
                  className={`option-btn`}
                   style={{
                    backgroundColor: phase === 'answer' && userReanswer === '错误' ? '#F0F8FF' : phase === 'result' && current.correct_answer === '错误' ? '#E5F6D0' : phase === 'result' && userReanswer === '错误' ? '#FFE5E5' : undefined,
                    borderColor: phase === 'answer' && userReanswer === '错误' ? 'var(--blue)' : phase === 'result' && current.correct_answer === '错误' ? 'var(--primary)' : phase === 'result' && userReanswer === '错误' ? 'var(--danger)' : undefined,
                  }}
                  onClick={() => { if (phase === 'answer') setUserReanswer('错误'); }}
                  disabled={phase === 'result'}
                >
                  <span className="option-letter">✗</span><span>错误</span>
                </button>
            </div>
          ) : current?.original_node?.distractors ? (
            <div className="options-list">
              {(() => {
                // Combine distractors + target_zone, dedupe by id
                const combined = [...(current.original_node.distractors || [])];
                const tz = current.original_node.target_zone;
                if (tz && !combined.find(o => o.id === tz.id)) {
                  combined.push(tz);
                }
                return combined;
              })().map((opt, i) => (
                <button
                  key={i}
                  className="option-btn"
                  style={{
                    backgroundColor: phase === 'answer' && userReanswer === opt.label ? '#F0F8FF' : phase === 'result' && opt.label === current.correct_answer ? '#E5F6D0' : phase === 'result' && userReanswer === opt.label && userReanswer !== current.correct_answer ? '#FFE5E5' : undefined,
                    borderColor: phase === 'answer' && userReanswer === opt.label ? 'var(--blue)' : phase === 'result' && opt.label === current.correct_answer ? 'var(--primary)' : phase === 'result' && userReanswer === opt.label && userReanswer !== current.correct_answer ? 'var(--danger)' : undefined,
                  }}
                  onClick={() => { if (phase === 'answer') setUserReanswer(opt.label); }}
                  disabled={phase === 'result'}
                >
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          ) : current?.original_node?.dial_options ? (
             <div className="options-list">
              {current.original_node.dial_options.filter(o => o.label !== 'OFF').map((opt, i) => (
                <button
                  key={i}
                  className="option-btn"
                   style={{
                    backgroundColor: phase === 'answer' && userReanswer === opt.label ? '#F0F8FF' : phase === 'result' && opt.label === current.correct_answer ? '#E5F6D0' : phase === 'result' && userReanswer === opt.label && userReanswer !== current.correct_answer ? '#FFE5E5' : undefined,
                    borderColor: phase === 'answer' && userReanswer === opt.label ? 'var(--blue)' : phase === 'result' && opt.label === current.correct_answer ? 'var(--primary)' : phase === 'result' && userReanswer === opt.label && userReanswer !== current.correct_answer ? 'var(--danger)' : undefined,
                  }}
                  onClick={() => { if (phase === 'answer') setUserReanswer(opt.label); }}
                  disabled={phase === 'result'}
                >
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <input
              className="fill-blank-input"
              type="text"
              value={userReanswer}
              onChange={e => {
                if (phase === 'answer') setUserReanswer(e.target.value);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && phase === 'answer') handleSubmitAnswer();
              }}
              placeholder="输入你的新答案..."
              disabled={phase === 'result'}
              autoFocus
            />
          )}
        </div>

        {/* ── Result feedback (phase 2) ── */}
        {phase === 'result' && (
          <div style={{ animation: 'fadeIn 0.3s ease' }}>
            {/* User's new answer feedback */}
            <div style={{
              padding: 12,
              background: isCorrect ? '#E8F5E9' : '#FFF5F5',
              borderRadius: 'var(--radius-xs)',
              marginBottom: 12,
            }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
                {isCorrect ? '这次答对了！' : '还是不对，继续加油！'}
              </div>
              <div style={{ fontSize: 14 }}>
                你的新答案：<strong style={{ color: isCorrect ? 'var(--primary)' : 'var(--danger)' }}>
                  {userReanswer || '(空)'}
                </strong>
              </div>
            </div>

            {/* Correct answer */}
            {hasCorrectAnswer ? (
              <div style={{
                padding: 12,
                background: '#E8F5E9',
                borderRadius: 'var(--radius-xs)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>正确答案：</div>
                <div style={{ fontWeight: 600, color: 'var(--primary)', fontSize: 15 }}>
                  {current.correct_answer}
                </div>
              </div>
            ) : (
              <div style={{
                padding: 12,
                background: '#FFF8E1',
                borderRadius: 'var(--radius-xs)',
                fontSize: 13,
                color: '#666',
              }}>
                该题目暂无参考答案，系统已记录你的新答案。
              </div>
            )}

            {/* SM-2 schedule feedback */}
            {lastSchedule ? (
              <div style={{
                marginTop: 12,
                padding: 10,
                background: lastSchedule.mastered ? '#E8F5E9' : '#F0F8FF',
                borderRadius: 'var(--radius-xs)',
                fontSize: 13,
              }}>
                {lastSchedule.mastered ? (
                  <span>🏅 <strong>已掌握这道题！</strong>（间隔 {lastSchedule.interval_days} 天）</span>
                ) : (
                  <span>
                    {isCorrect
                      ? <>📅 <strong>记住了！</strong>{lastSchedule.interval_days <= 1 ? '明天' : `${lastSchedule.interval_days} 天后`}再复习这道题</>
                      : <>🔁 <strong>这次没答对</strong>，明天再来复习它</>}
                  </span>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* ── Action buttons ── */}
      {phase === 'answer' ? (
        <button
          className="btn btn-primary btn-block btn-lg"
          onClick={handleSubmitAnswer}
          disabled={!userReanswer.trim()}
          style={{ opacity: userReanswer.trim() ? 1 : 0.5 }}
        >
          确认新答案
        </button>
      ) : (
        <button
          className="btn btn-primary btn-block btn-lg"
          onClick={handleNext}
        >
          {currentIndex < mistakes.length - 1 ? '下一题 →' : '完成复习'}
        </button>
      )}

      {/* ── Footer info ── */}
      <div style={{
        marginTop: 16,
        padding: 12,
        background: '#FFF8E1',
        borderRadius: 'var(--radius-xs)',
        fontSize: 13,
        color: 'var(--text-secondary)',
        textAlign: 'center',
      }}>
        复习完所有错题后，将恢复红心 并获得金币 奖励。
        {gameState?.hearts !== undefined && gameState?.max_hearts !== undefined && (
          <span style={{ display: 'block', marginTop: 4, fontWeight: 600 }}>
            当前红心：{gameState.hearts}/{gameState.max_hearts}
          </span>
        )}
      </div>
    </div>
  );
}
