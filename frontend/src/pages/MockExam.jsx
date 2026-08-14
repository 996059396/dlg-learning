import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';

// 全真模拟考（P1 价值锚）：100 题（60 判断 + 30 单选 + 10 多选）/ 45 分钟 / 80 分及格。
// 服务端判卷（复用 grading.js），错答自动进入错题 SM-2 复习队列。
const EXAM_MINUTES = 45;
const TYPE_LABEL = { true_false: '判断', multiple_choice: '单选', multi_select: '多选' };

function fmt(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function MockExam() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState('intro'); // intro | active | result
  const [session, setSession] = useState(null);
  const [answers, setAnswers] = useState([]);
  const [remaining, setRemaining] = useState(EXAM_MINUTES * 60);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const timerRef = useRef(null);
  const submitRef = useRef(null);
  const [msOptions, setMsOptions] = useState({}); // { [questionIndex]: shuffled options }

  useEffect(() => {
    api.examHistory().then(h => setHistory(h?.sessions || [])).catch(() => setHistory([]));
  }, []);

  const start = async () => {
    setError('');
    try {
      const s = await api.startExam();
      setSession(s);
      setAnswers(new Array(s.total).fill(null));
      setPhase('active');
      setRemaining(Math.max(1, Math.round((new Date(s.expiresAt) - Date.now()) / 1000)));
      // Shuffle multi-select option DISPLAY order once per session (option ids
      // stay stable so server grading by id is unaffected). The pool's correct
      // answers all sit at A/B, so without this an examiner can blindly check
      // the first two boxes and score 10/10 on the multi-select section.
      const shuffle = (arr) => {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
      };
      const map = {};
      (s.questions || []).forEach(q => { if (q.type === 'multi_select') map[q.index] = shuffle(q.options); });
      setMsOptions(map);
    } catch (e) { setError(e.message); }
  };

  useEffect(() => {
    if (phase !== 'active' || !session) return;
    timerRef.current = setInterval(() => {
      setRemaining(prev => {
        const next = prev - 1;
        if (next <= 0) { clearInterval(timerRef.current); submitRef.current(true); return 0; }
        return next;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [phase, session]);

  const setAnswer = (idx, value) => {
    setAnswers(prev => { const c = [...prev]; c[idx] = value; return c; });
  };
  const toggleMs = (idx, opt) => {
    // Keep answers an ARRAY at all times. Spreading {...prev} over an array
    // turns it into a plain object ({0:…, 1:…, length:…}), which then throws
    // `TypeError: answers.filter is not a function` in answeredCount → the whole
    // exam white-screens the moment a multi-select option is toggled (critical,
    // every answer made so far is lost). Copy the array, mutate one slot, return
    // the same array type.
    setAnswers(prev => {
      const arr = [...prev];
      const cur = arr[idx] ? JSON.parse(arr[idx]) : [];
      const next = cur.includes(opt) ? cur.filter(x => x !== opt) : [...cur, opt];
      arr[idx] = next.length ? JSON.stringify(next) : null;
      return arr;
    });
  };

  const submit = async (timedOut = false) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const payload = session.questions
        .filter(q => answers[q.index] != null)
        .map(q => ({ index: q.index, userAnswer: answers[q.index] }));
      const r = await api.submitExam(session.sessionId, payload);
      setResult(r);
      setPhase('result');
    } catch (e) { setError(e.message); setSubmitting(false); }
  };

  // Keep the countdown interval's auto-submit pinned to the LATEST submit
  // closure. Without this, the interval captures the render where the exam
  // became 'active' (answers all null) and auto-submits an empty payload on
  // timeout, discarding every answered question.
  submitRef.current = submit;

  const answeredCount = answers.filter(a => a != null).length;

  if (phase === 'intro') {
    return (
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: 26, marginBottom: 12 }}>🧯 全真模拟考</h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 20 }}>
          按照低压电工考证真题格式组卷：<b>判断 60 + 单选 30 + 多选 10 = 100 题</b>，
          限时 <b>45 分钟</b>，<b>80 分及格</b>。交卷后立即显示成绩与逐题解析，错题自动加入「错题医疗箱」复习。
        </p>
        <div style={{ display: 'grid', gap: 10, marginBottom: 24 }}>
          {[
            ['📝', '判断 60 题', '正确 / 错误'],
            ['🔢', '单选 30 题', '四选一'],
            ['☑️', '多选 10 题', '漏选、错选均不得分'],
          ].map(([icon, t, d]) => (
            <div key={t} style={{ display: 'flex', gap: 12, alignItems: 'center', background: 'var(--bg-secondary)', padding: '12px 14px', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontSize: 22 }}>{icon}</span>
              <div><div style={{ fontWeight: 700 }}>{t}</div><div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{d}</div></div>
            </div>
          ))}
        </div>
        {error && <div style={{ color: 'var(--danger)', marginBottom: 12 }}>{error}</div>}
        <button onClick={start} style={{ width: '100%', background: 'var(--primary)', color: '#fff', padding: '14px', borderRadius: 'var(--radius)', fontSize: 16, fontWeight: 700, border: 'none', cursor: 'pointer' }}>
          开始模拟考
        </button>
        <button onClick={() => navigate('/')} style={{ width: '100%', marginTop: 10, padding: '12px', borderRadius: 'var(--radius)', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          返回首页
        </button>

        {history && history.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <button onClick={() => setShowHistory(s => !s)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-secondary)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>
              <span>📊 历史成绩（{history.length} 次）</span>
              <span>{showHistory ? '▲' : '▼'}</span>
            </button>
            {showHistory && (
              <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                {history.map(h => (
                  <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 20 }}>{h.passed ? '✅' : '❌'}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700 }}>{h.score} 分 / {h.total} 分 {h.passed ? '· 通过' : '· 未达标'}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {new Date(h.started_at).toLocaleString('zh-CN', { hour12: false })}
                        {h.status === 'expired' ? ' · ⏰ 超时' : ''}
                      </div>
                    </div>
                    <span style={{ fontSize: 18, color: h.passed ? '#58CC02' : 'var(--danger)' }}>{h.passed ? '+' : ''}{h.score}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (phase === 'result' && result) {
    const passColor = result.passed ? '#58CC02' : 'var(--danger)';
    return (
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '0 16px' }}>
        <div style={{ textAlign: 'center', margin: '20px 0 24px' }}>
          <div style={{ fontSize: 56, fontWeight: 800, color: passColor }}>{result.score}</div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>分 / {result.total} 分</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: passColor, marginBottom: 6 }}>
            {result.passed ? '🎉 通过（≥80 分）' : '未达标，再接再厉'}
          </div>
          {result.expired && <div style={{ color: 'var(--warning)' }}>⏰ 已超时，按已作答题目计分</div>}
          <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
            本次获得 +{result.xpEarned} XP{result.coinEarned ? ` · +${result.coinEarned} 币` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
          <button onClick={start} style={{ flex: 1, background: 'var(--primary)', color: '#fff', padding: '12px', borderRadius: 'var(--radius)', border: 'none', cursor: 'pointer', fontWeight: 700 }}>再来一次</button>
          <button onClick={() => navigate('/review')} style={{ flex: 1, background: 'var(--bg-secondary)', padding: '12px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', cursor: 'pointer', fontWeight: 700 }}>去复习错题</button>
        </div>
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>逐题解析</h2>
        <div style={{ display: 'grid', gap: 12 }}>
          {result.results.map((r, i) => (
            <div key={i} style={{ background: 'var(--bg-secondary)', padding: '12px 14px', borderRadius: 'var(--radius-sm)', borderLeft: `4px solid ${r.correct ? '#58CC02' : 'var(--danger)'}` }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                {i + 1} · {TYPE_LABEL[session.questions[i]?.type]} {r.correct ? '✅ 对' : '❌ 错'}
              </div>
              <div style={{ marginBottom: 6 }}>{session.questions[i]?.question}</div>
              {!r.correct && r.userAnswer && (
                <div style={{ fontSize: 13, color: 'var(--danger)' }}>你的答案：{r.userAnswer}</div>
              )}
              <div style={{ fontSize: 13, color: '#58CC02' }}>正确答案：{r.correctAnswer}</div>
              {session.questions[i]?.explanation ? (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{session.questions[i].explanation}</div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // active
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 16px' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 5, background: 'var(--bg)', padding: '10px 0', marginBottom: 12, borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            ⏱ <span style={{ color: remaining < 300 ? 'var(--danger)' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(remaining)}</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>已答 {answeredCount}/{session.total}</div>
          <button onClick={() => { if (window.confirm('确定交卷吗？未答题目按错处理。')) submit(); }} disabled={submitting} style={{ background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', padding: '8px 16px', cursor: 'pointer', fontWeight: 700 }}>
            {submitting ? '判卷中…' : '交卷'}
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 30px)', gap: 4, marginTop: 8, maxHeight: 88, overflowY: 'auto', scrollbarWidth: 'thin' }}>
          {session.questions.map((q) => (
            <button key={q.index} onClick={() => document.getElementById(`q${q.index}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
              style={{ height: 28, borderRadius: 6, border: '1px solid var(--border)', background: answers[q.index] != null ? 'var(--primary)' : 'transparent', color: answers[q.index] != null ? '#fff' : 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}>
              {q.index + 1}
            </button>
          ))}
        </div>
      </div>
      {error && <div style={{ color: 'var(--danger)', marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'grid', gap: 14 }}>
        {session.questions.map((q) => {
          const isMs = q.type === 'multi_select';
          const msVal = answers[q.index] ? JSON.parse(answers[q.index]) : [];
          const opts = isMs ? (msOptions[q.index] || q.options) : q.options;
          return (
            <div key={q.index} id={`q${q.index}`} style={{ background: 'var(--bg-secondary)', padding: '14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
                {q.index + 1} · {TYPE_LABEL[q.type]}{isMs ? '（多选）' : ''}
              </div>
              <div style={{ marginBottom: 10, lineHeight: 1.5 }}>{q.question}</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {q.type === 'true_false' ? (
                  ['正确', '错误'].map(v => (
                    <label key={v} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderRadius: 'var(--radius-xs)', background: answers[q.index] === v ? 'var(--primary)' : 'transparent', color: answers[q.index] === v ? '#fff' : 'var(--text)', cursor: 'pointer', border: answers[q.index] === v ? 'none' : '1px solid var(--border)' }}>
                      <input type="radio" name={`q${q.index}`} checked={answers[q.index] === v} onChange={() => setAnswer(q.index, v)} className="sr-only" />
                      {v}
                    </label>
                  ))
                ) : (
                  opts.map(o => (
                    <label key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 'var(--radius-xs)', background: isMs ? (msVal.includes(o.id) ? 'var(--primary)' : 'transparent') : (answers[q.index] === o.text ? 'var(--primary)' : 'transparent'), color: isMs ? (msVal.includes(o.id) ? '#fff' : 'var(--text)') : (answers[q.index] === o.text ? '#fff' : 'var(--text)'), cursor: 'pointer', border: isMs ? (msVal.includes(o.id) ? 'none' : '1px solid var(--border)') : (answers[q.index] === o.text ? 'none' : '1px solid var(--border)') }}>
                      <input type={isMs ? 'checkbox' : 'radio'} name={`q${q.index}`} checked={isMs ? msVal.includes(o.id) : answers[q.index] === o.text} onChange={() => isMs ? toggleMs(q.index, o.id) : setAnswer(q.index, o.text)} className="sr-only" />
                      <span style={{ fontWeight: 700, minWidth: 18 }}>{o.id}.</span>
                      <span>{o.text}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      <button onClick={() => { if (window.confirm('确定交卷吗？')) submit(); }} disabled={submitting} style={{ width: '100%', margin: '20px 0 40px', background: 'var(--primary)', color: '#fff', padding: '14px', borderRadius: 'var(--radius)', border: 'none', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>
        {submitting ? '判卷中…' : `交卷（已答 ${answeredCount}/${session.total}）`}
      </button>
    </div>
  );
}
