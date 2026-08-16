import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useGame } from '../context/GameContext';
import MultimeterChallenge from '../components/multimeter/MultimeterChallenge';

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
  const [msSelected, setMsSelected] = useState([]); // multi-select card: selected option ids
  const [isCorrect, setIsCorrect] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [lastSchedule, setLastSchedule] = useState(null);
  const cardStartRef = useRef(Date.now()); // 当前卡开始时间（responseTimeMs 遥测）
  const [grade, setGrade] = useState('good'); // 难度自评：hard/good/easy（判对时激活 easiness）
  // Server-revealed review outcome. GET /mistakes ships SANITIZED cards (no
  // answer keys) so a script can't read the answer and replay it to mint coins
  // (crosscheck3 P26/P31 P1). The correct answer + verdict are returned by the
  // review call, AFTER the user commits — the result phase reads them from here.
  const [reveal, setReveal] = useState(null);
  // B58 A4 in-session retry: a failed recall re-enters the session for immediate
  // relearning (SM-2 canonical step 7 / Anki relearn — the "几分钟内再提取" window
  // is the highest-value memory repair). Failed cards re-queue at the tail, up
  // to MAX_SESSION_RETRIES, so a correct recall exits the card this session.
  const MAX_SESSION_RETRIES = 2;
  const [retryCounts, setRetryCounts] = useState({}); // { [mistakeId]: retries used }

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
    setMsSelected([]);
    setIsCorrect(null);
    setSubmitted(false);
    setLastSchedule(null);
    setReveal(null);
    setGrade('good');
    cardStartRef.current = Date.now(); // 计时起点（供 responseTimeMs 遥测）
  }, [currentIndex]);

  const handleSubmitAnswer = useCallback(async () => {
    const current = mistakes[currentIndex];
    const isMs = current?.original_node?.type === 'multi_select';
    if (submitted || (isMs ? msSelected.length === 0 : !userReanswer.trim())) return;
    setSubmitted(true);

    // multi_select: submit the JSON array of option ids the server grades by
    // (gradeNode requires a JSON array string, not joined texts).
    const answerStr = isMs ? JSON.stringify(msSelected) : userReanswer;

    // The verdict AND the correct answer come back from the server's review
    // call — GET /mistakes no longer ships answer keys (crosscheck3 P26/P31 P1),
    // so there is nothing to compare against locally. The server verdict is
    // authoritative for SM-2 scheduling and practice-heal credit.
    if (user?.id && user.id !== 'demo' && current?.id) {
      try {
        const res = await api.reviewMistake(current.id, answerStr, { responseTimeMs: Date.now() - cardStartRef.current, grade });
        setReveal({ correct: res?.correct === true, correctAnswer: res?.correctAnswer ?? null });
        setIsCorrect(res?.correct === true);
        if (res?.mistake) setLastSchedule(res.mistake);
      } catch {
        // Backend unreachable — show the result phase with no revealed answer.
        setReveal(null);
        setIsCorrect(null);
      }
    } else {
      // Demo/guest users have no stored mistakes (empty state), so this branch
      // is unreachable in practice — keep it harmless.
      setReveal(null);
      setIsCorrect(null);
    }
    setPhase('result');
  }, [submitted, userReanswer, msSelected, mistakes, currentIndex, user]);

  const handleNext = useCallback(async () => {
    const current = mistakes[currentIndex];
    const newReviewed = reviewed + 1;
    setReviewed(newReviewed);

    // B58 A4: wrong recall → don't advance past the card; re-queue it at the
    // tail of this session so the user re-learns it NOW (bound: 2 retries).
    const failed = isCorrect === false;
    const retried = retryCounts[current?.id] || 0;
    if (failed && retried < MAX_SESSION_RETRIES) {
      setRetryCounts(prev => ({ ...prev, [current.id]: retried + 1 }));
      setMistakes(prev => [...prev, current]);
      setCurrentIndex(currentIndex + 1);
      return;
    }

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
  }, [currentIndex, reviewed, mistakes, retryCounts, isCorrect, user, gameState, showToast, navigate, setGameState]);

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
  const correctAnswer = reveal?.correctAnswer; // revealed only after a committed attempt
  const hasCorrectAnswer = correctAnswer && String(correctAnswer).trim() !== '';

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
          background: 'var(--tint-danger)',
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
                    // SM-2 scheduling + verdict come from the server re-grade;
                    // the challenge's local `correct` gives instant meter
                    // feedback only (mirror of handleSubmitAnswer).
                    if (user?.id && user.id !== 'demo' && current?.id) {
                      api.reviewMistake(current.id, setupStr || '已操作')
                        .then(res => {
                          if (res?.mistake) setLastSchedule(res.mistake);
                          setReveal({ correct: res?.correct === true, correctAnswer: res?.correctAnswer ?? null });
                          setIsCorrect(res?.correct === true);
                        })
                        .catch(() => setReveal(null));
                    }
                    setPhase('result');
                  }
                }}
              />
            </div>
          ) : current?.original_node?.type === 'multi_select' ? (
            <div className="options-list">
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>多选题：点击选项可多选</div>
              {current.original_node.options.map(opt => {
                const sel = msSelected.includes(opt.id);
                const isCorrectOpt = phase === 'result' &&
                  String(correctAnswer || '').split('、').map(s => s.trim()).includes(opt.text);
                return (
                  <button
                    key={opt.id}
                    className={`option-btn ${sel ? 'selected' : ''} ${phase === 'result' && isCorrectOpt ? 'correct' : ''}`}
                    style={{
                      backgroundColor: phase === 'answer' && sel ? 'var(--tint-info)' : undefined,
                      borderColor: phase === 'answer' && sel ? 'var(--blue)' : undefined,
                    }}
                    onClick={() => {
                      if (phase === 'answer') {
                        setMsSelected(prev => prev.includes(opt.id) ? prev.filter(x => x !== opt.id) : [...prev, opt.id]);
                      }
                    }}
                    disabled={phase === 'result'}
                  >
                    <span className="option-letter">{sel ? '☑' : '☐'}</span>
                    <span>{opt.text}</span>
                  </button>
                );
              })}
            </div>
          ) : current?.original_node?.options ? (
            <div className="options-list">
              {current.original_node.options.map(opt => (
                <button
                  key={opt.id}
                  className={`option-btn ${
                    phase === 'answer' && userReanswer === opt.text
                      ? 'selected'
                      : phase === 'result' && opt.text === correctAnswer
                      ? 'correct'
                      : phase === 'result' && userReanswer === opt.text && userReanswer !== correctAnswer
                      ? 'wrong'
                      : ''
                  }`}
                  style={{
                    backgroundColor: phase === 'answer' && userReanswer === opt.text ? 'var(--tint-info)' : undefined,
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
                    backgroundColor: phase === 'answer' && userReanswer === '正确' ? 'var(--tint-info)' : phase === 'result' && correctAnswer === '正确' ? 'var(--tint-success-2)' : phase === 'result' && userReanswer === '正确' ? 'var(--tint-danger-2)' : undefined,
                    borderColor: phase === 'answer' && userReanswer === '正确' ? 'var(--blue)' : phase === 'result' && correctAnswer === '正确' ? 'var(--primary)' : phase === 'result' && userReanswer === '正确' ? 'var(--danger)' : undefined,
                  }}
                  onClick={() => { if (phase === 'answer') setUserReanswer('正确'); }}
                  disabled={phase === 'result'}
                >
                  <span className="option-letter">✓</span><span>正确</span>
                </button>
                <button
                  className={`option-btn`}
                   style={{
                    backgroundColor: phase === 'answer' && userReanswer === '错误' ? 'var(--tint-info)' : phase === 'result' && correctAnswer === '错误' ? 'var(--tint-success-2)' : phase === 'result' && userReanswer === '错误' ? 'var(--tint-danger-2)' : undefined,
                    borderColor: phase === 'answer' && userReanswer === '错误' ? 'var(--blue)' : phase === 'result' && correctAnswer === '错误' ? 'var(--primary)' : phase === 'result' && userReanswer === '错误' ? 'var(--danger)' : undefined,
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
                    backgroundColor: phase === 'answer' && userReanswer === opt.label ? 'var(--tint-info)' : phase === 'result' && opt.label === correctAnswer ? 'var(--tint-success-2)' : phase === 'result' && userReanswer === opt.label && userReanswer !== correctAnswer ? 'var(--tint-danger-2)' : undefined,
                    borderColor: phase === 'answer' && userReanswer === opt.label ? 'var(--blue)' : phase === 'result' && opt.label === correctAnswer ? 'var(--primary)' : phase === 'result' && userReanswer === opt.label && userReanswer !== correctAnswer ? 'var(--danger)' : undefined,
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
                    backgroundColor: phase === 'answer' && userReanswer === opt.label ? 'var(--tint-info)' : phase === 'result' && opt.label === correctAnswer ? 'var(--tint-success-2)' : phase === 'result' && userReanswer === opt.label && userReanswer !== correctAnswer ? 'var(--tint-danger-2)' : undefined,
                    borderColor: phase === 'answer' && userReanswer === opt.label ? 'var(--blue)' : phase === 'result' && opt.label === correctAnswer ? 'var(--primary)' : phase === 'result' && userReanswer === opt.label && userReanswer !== correctAnswer ? 'var(--danger)' : undefined,
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
                // IME 组合态 Enter 是「确认候选字」不是「提交答案」，isComposing 时忽略。
                if (e.key === 'Enter' && phase === 'answer' && !e.nativeEvent.isComposing) handleSubmitAnswer();
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
              background: isCorrect ? 'var(--tint-success)' : 'var(--tint-danger)',
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
                background: 'var(--tint-success)',
                borderRadius: 'var(--radius-xs)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>正确答案：</div>
                <div style={{ fontWeight: 600, color: 'var(--primary)', fontSize: 15 }}>
                  {correctAnswer}
                </div>
              </div>
            ) : (
              <div style={{
                padding: 12,
                background: 'var(--tint-warning)',
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
                background: lastSchedule.mastered ? 'var(--tint-success)' : 'var(--tint-info)',
                borderRadius: 'var(--radius-xs)',
                fontSize: 13,
              }}>
                {lastSchedule.mastered ? (
                  <span>🏅 <strong>已掌握这道题！</strong>（间隔 {lastSchedule.interval_days} 天）</span>
                ) : (
                  <span>
                    {isCorrect
                      ? <>📅 <strong>记住了！</strong>{lastSchedule.interval_days <= 1 ? '明天' : `${lastSchedule.interval_days} 天后`}再复习这道题</>
                      : <>🔁 <strong>这次没答对</strong>，{(retryCounts[current.id] || 0) < MAX_SESSION_RETRIES ? '稍后本会话会再问一次，答对才算过' : '已重试多次，明天再来复习它'}</>}
                  </span>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* ── Action buttons ── */}
      {/* 难度自评（compare60 C03/C07）：判对时按此分档激活 SM-2 easiness */}
      {phase === 'answer' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>这题感觉：</span>
          {[['hard', '偏难'], ['good', '一般'], ['easy', '偏易']].map(([g, label]) => (
            <button key={g} onClick={() => setGrade(g)} style={{
              flex: 1, padding: '7px 0', fontSize: 13, borderRadius: 'var(--radius-xs)', cursor: 'pointer',
              border: `1.5px solid ${grade === g ? 'var(--blue)' : 'var(--border)'}`,
              background: grade === g ? 'rgba(28,176,246,0.1)' : 'var(--bg-secondary)',
              color: grade === g ? 'var(--blue)' : 'var(--text-secondary)',
            }}>{label}</button>
          ))}
        </div>
      )}
      {phase === 'answer' ? (
        <button
          className="btn btn-primary btn-block btn-lg"
          onClick={handleSubmitAnswer}
          disabled={current?.original_node?.type === 'multi_select' ? msSelected.length === 0 : !userReanswer.trim()}
          style={{ opacity: current?.original_node?.type === 'multi_select' ? (msSelected.length ? 1 : 0.5) : (userReanswer.trim() ? 1 : 0.5) }}
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
        background: 'var(--tint-warning)',
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
