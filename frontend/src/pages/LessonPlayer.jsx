import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { enqueueOfflineCompletion } from '../utils/offlineQueue';
import { useGame } from '../context/GameContext';
import MultimeterChallenge from '../components/multimeter/MultimeterChallenge';
import AnswerFeedback from '../components/AnswerFeedback';

// ── Helper: shuffle array ──
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Helper: extract correct answer text from any node type ──
function extractCorrectAnswer(node) {
  if (!node) return '';
  switch (node.type) {
    case 'multiple_choice':
      return node.options?.find(o => o.is_correct)?.text || '';
    case 'true_false':
      if (node.correct_answer === true) return '正确';
      if (node.correct_answer === false) return '错误';
      return String(node.correct_answer ?? '');
    case 'fill_blank':
      return node.answer || node.acceptable_answers?.[0] || '';
    case 'simulation_dial': {
      const correctOpt = node.dial_options?.find(o => o.is_correct);
      return correctOpt?.label || '';
    }
    case 'simulation_probe': {
      if (node.correct_probes) {
        const r = node.correct_probes.red || '?';
        const b = node.correct_probes.black || '?';
        const rh = node.hotspots?.[r]?.label || r;
        const bh = node.hotspots?.[b]?.label || b;
        return `红表笔→${rh}, 黑表笔→${bh}`;
      }
      return '';
    }
    case 'simulation_danger':
      return '安全操作（先换表笔再测量）';
    case 'multimeter_challenge': {
      const c = node.correct_setup || {};
      const ts = node.target?.hotspots || {};
      const rt = ts[c.red_touch]?.label || c.red_touch || '?';
      const bt = ts[c.black_touch]?.label || c.black_touch || '?';
      // Match the challenge component's serialization exactly (see MultimeterChallenge.jsx)
      // so the displayed answer equals what a correct submission actually is.
      return `档位:${c.dial}, 红:${c.red_port}→${rt}, 黑:${c.black_port || 'COM'}→${bt}`;
    }
    case 'sort': {
      if (node.correct_order && node.items) {
        return node.correct_order
          .map(id => node.items.find(i => i.id === id)?.text)
          .filter(Boolean)
          .join(' → ');
      }
      return '';
    }
    case 'drag_drop':
      return node.target_zone?.label || '';
    case 'match': {
      if (node.pairs) {
        return node.pairs.map(p => `${p.left} = ${p.right}`).join(', ');
      }
      return '';
    }
    default:
      return '';
  }
}

// ── Question Node Components ──

function InfoNode({ node, onNext }) {
  return (
    <div className="question-node" style={{ justifyContent: 'center' }}>
      {node.style === 'danger' && (
        <div style={{ fontSize: 48, textAlign: 'center', marginBottom: 16 }}>⚠️</div>
      )}
      <div style={{
        fontSize: 20,
        fontWeight: 800,
        marginBottom: 12,
        color: node.style === 'danger' ? 'var(--danger)' : 'var(--text)',
      }}>
        {node.title}
      </div>
      <div style={{ fontSize: 16, lineHeight: 1.8, color: 'var(--text-secondary)', marginBottom: 24 }}>
        {node.content}
      </div>
      {node.image && (
        <div className="sim-image-area" style={{ height: 160, marginBottom: 24 }}>
          {node.image === 'multimeter_overview' && '📟🔘🔌'}
          {node.image === 'dc_vs_ac' && '🔋⚡'}
          {node.image === 'safety_warning' && '⚠️🔥'}
          {node.image === 'resistance_intro' && 'Ω📏'}
        </div>
      )}
      <button className="btn btn-primary btn-block" onClick={onNext}>
        继续 →
      </button>
    </div>
  );
}

function MultipleChoice({ node, onAnswer }) {
  const [selected, setSelected] = useState(null);
  const [answered, setAnswered] = useState(false);

  const handleSelect = (opt) => {
    if (answered) return;
    setSelected(opt.id);
    setAnswered(true);
    setTimeout(() => onAnswer(opt.is_correct, opt.text), 600);
  };

  const selectedOpt = node.options.find(o => o.id === selected);
  const correctOpt = node.options.find(o => o.is_correct);
  const isCorrect = selectedOpt?.is_correct === true;

  return (
    <div className="question-node">
      <div className="question-text">{node.question}</div>
      {node.instruction && <div className="question-instruction">{node.instruction}</div>}
      <div className="options-list">
        {node.options.map(opt => (
          <button
            key={opt.id}
            disabled={answered}
            className={`option-btn ${
              answered
                ? opt.is_correct
                  ? 'correct'
                  : opt.id === selected
                  ? 'wrong'
                  : ''
                : ''
            }`}
            onClick={() => handleSelect(opt)}
          >
            <span className="option-letter">{opt.id}</span>
            <span>{opt.text}</span>
          </button>
        ))}
      </div>
      {answered && (
        <AnswerFeedback
          isCorrect={isCorrect}
          successMsg={node.success_msg}
          failMsg={node.fail_msg}
          explanation={node.explanation}
          correctAnswer={correctOpt?.text}
        />
      )}
    </div>
  );
}

function TrueFalse({ node, onAnswer }) {
  const [answered, setAnswered] = useState(false);
  const [selected, setSelected] = useState(null);

  const handleAnswer = (userAnswer) => {
    if (answered) return;
    setSelected(userAnswer);
    setAnswered(true);
    const correct = userAnswer === node.correct_answer;
    setTimeout(() => onAnswer(correct, userAnswer ? '正确' : '错误'), 600);
  };

  // For each button, determine its visual state:
  // - If user picked it → green if correct answer, red if wrong answer
  // - If user picked the OTHER button and got it wrong → highlight this one as green (the correct one)
  // - Otherwise → neutral (no color)
  const buttonClass = (myValue) => {
    if (!answered) return '';
    if (selected === myValue) {
      // This is the button the user clicked
      return myValue === node.correct_answer ? 'correct' : 'wrong';
    }
    // User clicked the other one; if user was wrong, highlight this (the correct one)
    if (selected !== node.correct_answer && myValue === node.correct_answer) {
      return 'correct';
    }
    return '';
  };

  return (
    <div className="question-node">
      <div className="question-text">{node.question}</div>
      <div className="options-list" style={{ marginTop: 20 }}>
        <button
          className={`option-btn ${buttonClass(true)}`}
          onClick={() => handleAnswer(true)}
          disabled={answered}
        >
          <span className="option-letter">✓</span>
          <span>正确</span>
        </button>
        <button
          className={`option-btn ${buttonClass(false)}`}
          onClick={() => handleAnswer(false)}
          disabled={answered}
        >
          <span className="option-letter">✗</span>
          <span>错误</span>
        </button>
      </div>
      {answered && (
        <AnswerFeedback
          isCorrect={selected === node.correct_answer}
          successMsg={node.success_msg}
          failMsg={node.fail_msg}
          explanation={node.explanation}
          correctAnswer={node.correct_answer === true ? '正确' : '错误'}
        />
      )}
    </div>
  );
}

// Mirrors backend/lib/grading.js _normalize so local (demo-mode) grading agrees
// with server truth: full-width → half-width (５Ｖ == 5V), Ω shielded through
// toLowerCase so it stays distinct from ω, then ALL whitespace stripped
// (full-width space from a Chinese IME included). Keeps "本地判对=服务端判对".
const _halfWidth = (s) => String(s)
  .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/　/g, ' ');
const _fbNormalize = (s) => {
  const half = _halfWidth(String(s || '').trim());
  // Mirror backend grading.js: shield mega-Ω AND uppercase-M SI prefixes (MΩ/MA)
  // so 'MΩ' != 'mΩ' — keeps 本地判对=服务端判对 (crosscheck4 C08).
  const mShielded = half.replace(/M(?=[A-Za-zΩω])/g, '');
  const shielded = mShielded.replace(/Ω/g, '');
  return shielded.toLowerCase().replace(//g, 'M').replace(//g, 'Ω').replace(/\s+/g, '');
};function FillBlank({ node, onAnswer }) {
  const [value, setValue] = useState('');
  const [answered, setAnswered] = useState(false);
  const [isCorrect, setIsCorrect] = useState(false);
  const [showHint, setShowHint] = useState(false);

  const handleSubmit = () => {
    if (answered || !value.trim()) return;
    const correct = (node.acceptable_answers || []).some(
      a => _fbNormalize(a) === _fbNormalize(value)
    );
    setIsCorrect(correct);
    setAnswered(true);
    setTimeout(() => onAnswer(correct, value.trim()), 600);
  };

  return (
    <div className="question-node">
      <div className="question-text">{node.question}</div>
      {node.instruction && <div className="question-instruction">{node.instruction}</div>}
      <div style={{ marginTop: 20 }}>
        <input
          className="fill-blank-input"
          type="text"
          value={value}
          onChange={e => !answered && setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          onFocus={(e) => {
            // iOS software keyboard shrinks the visual viewport and covers the
            // confirm button below the input. Nudge the confirm button into view
            // once the keyboard has settled (visualViewport stops shrinking).
            if (!window.visualViewport) return;
            let lastH = window.visualViewport.height;
            const deadline = Date.now() + 800;
            const tick = () => {
              const vv = window.visualViewport;
              if (!vv) return;
              if (vv.height < lastH - 1 && Date.now() < deadline) {
                lastH = vv.height;
                requestAnimationFrame(tick);
                return;
              }
              if (vv.height < window.innerHeight * 0.85) {
                const btn = e.target.closest('.question-node')?.querySelector('.fill-confirm-btn');
                btn?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }
            };
            requestAnimationFrame(tick);
          }}
          placeholder="输入答案..."
          autoFocus
          disabled={answered}
          style={answered ? {
            borderColor: isCorrect ? '#58CC02' : '#FF4B4B',
            background: isCorrect ? '#F0FFF0' : '#FFF5F5',
            color: isCorrect ? '#3C8500' : '#C42626',
            fontWeight: 700,
          } : undefined}
        />
      </div>
      {!answered && (
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn btn-primary btn-block fill-confirm-btn" onClick={handleSubmit}>
            确认答案
          </button>
          {!showHint && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setShowHint(true)}
              style={{ flexShrink: 0 }}
            >
              💡
            </button>
          )}
        </div>
      )}
      {showHint && !answered && (
        <div style={{
          marginTop: 12,
          padding: 12,
          background: '#FFF8E1',
          borderRadius: 'var(--radius-xs)',
          fontSize: 13,
          color: '#666',
        }}>
          💡 提示：这个知识点将在后续课程中详细介绍。试试填入你理解的内容吧！
        </div>
      )}
      {answered && (
        <AnswerFeedback
          isCorrect={isCorrect}
          successMsg={node.success_msg}
          failMsg={node.fail_msg}
          explanation={node.explanation}
          correctAnswer={node.answer || node.acceptable_answers?.[0]}
        />
      )}
    </div>
  );
}

// ── SimulationDial: click-to-select redesign ──
function SimulationDial({ node, onAnswer }) {
  const [selected, setSelected] = useState(null);
  const [answered, setAnswered] = useState(false);
  const options = node.dial_options || [];

  const handleClick = (opt) => {
    if (answered) return;
    setSelected(opt);
  };

  const handleConfirm = () => {
    if (answered || !selected) return;
    setAnswered(true);
    const correct = selected.is_correct === true;
    setTimeout(() => onAnswer(correct, selected.label), 600);
  };

  // Position options around a circle
  const centerPct = 50;
  const radiusPct = 38;

  return (
    <div className="question-node">
      <div className="question-text">{node.question}</div>
      <div className="question-instruction">{node.instruction}</div>

      <div style={{
        position: 'relative',
        width: 220,
        height: 220,
        margin: '16px auto',
      }}>
        {/* Dial body */}
        <div style={{
          position: 'absolute',
          inset: 10,
          borderRadius: '50%',
          background: 'conic-gradient(from 0deg, #444 0deg, #555 90deg, #444 180deg, #555 270deg, #444 360deg)',
          boxShadow: '0 6px 20px rgba(0,0,0,0.35), inset 0 2px 4px rgba(255,255,255,0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          {/* Inner circle */}
          <div style={{
            width: 60,
            height: 60,
            borderRadius: '50%',
            background: '#3a3a3a',
            boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <div style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#999',
            }} />
          </div>
        </div>

        {/* Clickable option markers around the dial */}
        {options.map((opt, i) => {
          // Start from top (-90°) and distribute clockwise
          const angleDeg = (i / options.length) * 360 - 90;
          const rad = angleDeg * (Math.PI / 180);
          const left = centerPct + Math.cos(rad) * radiusPct;
          const top = centerPct + Math.sin(rad) * radiusPct;
          const isSelected = selected?.label === opt.label;
          const isCorrectOpt = opt.is_correct === true;

          return (
            <button
              key={opt.label}
              onClick={() => handleClick(opt)}
              disabled={answered}
              style={{
                position: 'absolute',
                left: `${left}%`,
                top: `${top}%`,
                transform: 'translate(-50%, -50%)',
                padding: '6px 10px',
                border: isSelected
                  ? '3px solid var(--blue)'
                  : answered && isCorrectOpt
                  ? '3px solid var(--primary)'
                  : '2px solid #777',
                borderRadius: 16,
                background: isSelected
                  ? 'var(--blue)'
                  : answered && isCorrectOpt
                  ? 'var(--primary)'
                  : '#555',
                color: 'white',
                fontSize: 11,
                fontWeight: 700,
                cursor: answered ? 'default' : 'pointer',
                fontFamily: 'var(--font)',
                whiteSpace: 'nowrap',
                zIndex: 2,
                boxShadow: isSelected ? '0 0 8px rgba(28,176,246,0.5)' : '0 2px 4px rgba(0,0,0,0.3)',
                transition: 'all 0.15s',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
        👆 点击选择正确的档位
      </div>

      {!answered && (
        <button
          className="btn btn-primary btn-block"
          onClick={handleConfirm}
          disabled={!selected}
          style={{ opacity: selected ? 1 : 0.5 }}
        >
          确认档位
        </button>
      )}

      {answered && (
        <div style={{
          marginTop: 12,
          padding: 14,
          background: selected?.is_correct ? '#E8F5E9' : '#FFF5F5',
          borderRadius: 'var(--radius-xs)',
          fontSize: 14,
          fontWeight: 600,
        }}>
          {selected?.is_correct
            ? `✅ ${node.success_msg || '正确！'}`
            : `❌ ${node.fail_msg || '不正确，请再想想'}`}
        </div>
      )}
    </div>
  );
}

// ── SimulationProbe ──
function SimulationProbe({ node, onAnswer }) {
  const [phase, setPhase] = useState('place_red');
  const [redPlaced, setRedPlaced] = useState(null);
  const [blackPlaced, setBlackPlaced] = useState(null);
  const [answered, setAnswered] = useState(false);
  const [isCorrect, setIsCorrect] = useState(null);

  // Hotspot coordinates are authored in a 400×300 design space (matches the
  // .sim-image-area's fixed 300px height and max x≈320 across the corpus).
  // Absolute px placed on a 320px phone overflowed (wire_end_b x=320 → button
  // 285–355px, clipped to 3px). Percentage positioning scales the scene to any
  // viewport, keeping hotspots inside the container.
  const REF_W = 400, REF_H = 300;
  const pct = (v, ref) => `${(v / ref) * 100}%`;

  const hotspots = node.hotspots || {};
  const hsEntries = Object.entries(hotspots);

  const handleHotspotClick = (key) => {
    if (answered) return;

    if (node.action === 'swap_probes') {
      setAnswered(true);
      setTimeout(() => onAnswer(true, '已交换表笔'), 600);
      return;
    }

    if (phase === 'place_red') {
      setRedPlaced(key);
      setPhase('place_black');
    } else if (phase === 'place_black') {
      if (key === redPlaced) return; // must pick different spot
      setBlackPlaced(key);
      setAnswered(true);

      let correct;
      if (node.allow_swap) {
        const correctRed = node.correct_probes?.red;
        const correctBlack = node.correct_probes?.black;
        correct =
          (redPlaced === correctRed && key === correctBlack) ||
          (redPlaced === correctBlack && key === correctRed);
      } else if (node.correct_probes) {
        correct = redPlaced === node.correct_probes.red && key === node.correct_probes.black;
      } else {
        correct = true;
      }

      setIsCorrect(correct);
      setTimeout(() => onAnswer(correct, `红:${redPlaced},黑:${key}`), 800);
    }
  };

  return (
    <div className="question-node">
      <div className="question-text">{node.question}</div>
      <div className="question-instruction">{node.instruction}</div>

      <div className="sim-image-area" style={{ position: 'relative', height: 300 }}>
        <div style={{ textAlign: 'center', fontSize: 14, color: 'var(--text-secondary)', marginBottom: 12 }}>
          {node.image === 'battery_measure' && '🔋 1.5V 电池'}
          {node.image === 'battery_measure_reversed' && '🔋 1.5V 电池（表笔反接）'}
          {node.image === 'resistor_measure' && '📏 待测电阻'}
          {node.image === 'wire_continuity' && '🔌 待测导线'}
        </div>

        {hsEntries.map(([key, hs]) => (
          <button
            key={key}
            className={`sim-hotspot ${redPlaced === key || blackPlaced === key ? 'active' : ''}`}
            style={{
              left: pct(hs.x, REF_W),
              top: pct(hs.y, REF_H),
              width: 70,
              height: 70,
              transform: 'translate(-50%, -50%)',
              opacity: answered ? 0.6 : 1,
            }}
            onClick={() => handleHotspotClick(key)}
            disabled={answered}
          >
            {hs.label}
          </button>
        ))}

        {redPlaced && (
          <div style={{
            position: 'absolute',
            left: pct(hotspots[redPlaced]?.x, REF_W),
            top: pct(hotspots[redPlaced]?.y, REF_H),
            transform: 'translate(-50%, -110%)',
            fontSize: 24,
            pointerEvents: 'none',
            zIndex: 5,
          }}>
            🔴
          </div>
        )}
        {blackPlaced && (
          <div style={{
            position: 'absolute',
            left: pct(hotspots[blackPlaced]?.x, REF_W),
            top: pct(hotspots[blackPlaced]?.y, REF_H),
            transform: 'translate(-50%, -110%)',
            fontSize: 24,
            pointerEvents: 'none',
            zIndex: 5,
          }}>
            ⚫
          </div>
        )}

        <div style={{ position: 'absolute', bottom: 10, left: 0, right: 0, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>
          {!answered && phase === 'place_red' &&
            <span style={{ color: 'var(--danger)' }}>🔴 请放置红表笔</span>
          }
          {!answered && phase === 'place_black' &&
            <span style={{ color: '#333' }}>⚫ 请放置黑表笔</span>
          }
        </div>
      </div>

      {answered && node.feedback_display && (
        <div style={{
          textAlign: 'center',
          padding: 16,
          fontSize: 18,
          fontWeight: 700,
          color: isCorrect ? 'var(--primary)' : 'var(--danger)',
        }}>
          📟 万用表读数：{node.feedback_display}
        </div>
      )}

      {answered && (
        <div style={{
          marginTop: 12,
          padding: 12,
          background: isCorrect ? '#E8F5E9' : '#FFF5F5',
          borderRadius: 'var(--radius-xs)',
          fontSize: 14,
        }}>
          {isCorrect ? '✅ 测量正确！' : `❌ 不正确。红表笔应放在${hotspots[node.correct_probes?.red]?.label || '?'}，黑表笔应放在${hotspots[node.correct_probes?.black]?.label || '?'}`}
        </div>
      )}
    </div>
  );
}

// ── DangerSim ──
function dangerBtnLabel(action) {
  const map = {
    move_probe: '先把红表笔换到 V/Ω 孔',
    rotate_dial: '旋转挡位',
    switch_dial: '切换挡位',
    touch_phase: '测量相间电压',
    click_socket: '测量插座电压',
    test_socket_with_meter: '用万用表测量插座电压',
    use_test_pen_first: '先用试电笔验电',
  };
  return map[action] || action;
}

// Sequence-driven danger sim: reads node.correct_sequence and renders each
// scenario-specific action (move probe / rotate dial / use test pen / measure),
// so every simulation_danger node teaches its own correct order instead of a
// hardcoded two-step flow. Answer contract unchanged: completes → '安全操作'.
function DangerSim({ node, onAnswer }) {
  const sequence = Array.isArray(node.correct_sequence) && node.correct_sequence.length
    ? node.correct_sequence
    : [
        { action: 'move_probe', from: '20A', to: 'V/Ω' },
        { action: 'click_socket' },
      ];
  const dangerAction = node.danger_action || sequence[sequence.length - 1]?.action || 'click_socket';
  const [step, setStep] = useState(0);
  const [dangerShown, setDangerShown] = useState(false);
  const [dangerSeen, setDangerSeen] = useState(false);  // persistent record
  const [answered, setAnswered] = useState(false);

  const doAction = (action) => {
    if (answered) return;
    // Attempting the dangerous action while the probe is still misplaced → warning, no advance.
    if (step === 0 && action === dangerAction) {
      setDangerShown(true);
      setDangerSeen(true);
      setTimeout(() => setDangerShown(false), 2200);
      return;
    }
    const expected = sequence[step];
    if (expected && action === expected.action) {
      const next = step + 1;
      setStep(next);
      if (next >= sequence.length) {
        setAnswered(true);
        setTimeout(() => onAnswer(true, '安全操作'), 600);
      }
    }
  };

  const moveProbeIdx = sequence.findIndex(s => s.action === 'move_probe');
  const dialIdx = sequence.findIndex(s => s.action === 'rotate_dial' || s.action === 'switch_dial');
  const penIdx = sequence.findIndex(s => s.action === 'use_test_pen_first');
  const moveProbeDone = moveProbeIdx !== -1 && step > moveProbeIdx;
  const dialDone = dialIdx !== -1 && step > dialIdx;
  const penDone = penIdx !== -1 && step > penIdx;
  const initPort = node.initial_state?.red_probe_port || (moveProbeIdx !== -1 ? sequence[moveProbeIdx].from : null);
  const dialTo = dialIdx !== -1 ? (sequence[dialIdx].to || 'ACV 750') : null;

  return (
    <div className="question-node">
      <div className="question-text">{node.question}</div>
      <div className="question-instruction">{node.instruction}</div>

      {dangerShown && <div className="danger-overlay" />}

      <div className={`sim-image-area ${dangerShown ? 'danger-flash' : ''}`} style={{ position: 'relative', flexDirection: 'column', gap: 16, padding: '16px 0' }}>
        <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.6 }}>
          {step === 0 ? (
            <>🔌 {initPort ? `红表笔还在 ${initPort} 孔 ⚠️` : '表笔状态待确认'}</>
          ) : (
            <>
              {moveProbeDone ? '🔌 红表笔已换到 V/Ω 孔 ✅' : '🔌 表笔状态已更新'}
              {dialDone ? ` · 挡位已转到 ${dialTo} ✅` : ''}
              {penDone ? ' · 已用试电笔验电 ✅' : ''}
            </>
          )}
        </div>

        {!answered && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {step === 0 ? (
              <>
                <button className="btn btn-outline btn-sm" onClick={() => doAction(dangerAction)}>
                  ⚡ {dangerBtnLabel(dangerAction)}
                </button>
                <button className="btn btn-outline btn-sm" onClick={() => doAction(sequence[0]?.action)}>
                  🔧 {dangerBtnLabel(sequence[0]?.action)}
                </button>
              </>
            ) : (
              <button className="btn btn-outline btn-sm" onClick={() => doAction(sequence[step]?.action)}>
                🔧 {dangerBtnLabel(sequence[step]?.action)}
              </button>
            )}
          </div>
        )}
      </div>

      {(dangerShown || dangerSeen) && step < sequence.length && (
        <div style={{
          marginTop: 12,
          padding: 16,
          background: '#FFF5F5',
          border: '2px solid var(--danger)',
          borderRadius: 'var(--radius-sm)',
          animation: dangerShown ? 'pulse-danger 0.5s ease-in-out' : 'none',
        }}>
          <div style={{ fontWeight: 800, color: 'var(--danger)', fontSize: 16, marginBottom: 4 }}>
            ⚠️ {node.danger_response?.message || '危险操作！'}
          </div>
          <div style={{ fontSize: 13, color: '#888', marginTop: 6 }}>
            🔧 请按照正确步骤先纠正问题再继续。
          </div>
        </div>
      )}

      {answered && (
        <AnswerFeedback
          isCorrect={true}
          successMsg={node.success_msg || '安全操作！'}
          explanation={node.explanation || (dangerSeen ? '你成功避免了一次危险——记住，红表笔在 20A 孔时绝对不能去测电压。' : null)}
        />
      )}
    </div>
  );
}

// ── SortQuestion: randomized initial order ──
function SortQuestion({ node, onAnswer }) {
  const [available, setAvailable] = useState(() => shuffleArray(node.items));
  const [sorted, setSorted] = useState([]);
  const [answered, setAnswered] = useState(false);
  const [isCorrect, setIsCorrect] = useState(false);

  const handleSelect = (item) => {
    if (answered) return;
    setAvailable(prev => prev.filter(i => i.id !== item.id));
    setSorted(prev => [...prev, item]);
  };

  const handleUndo = (item) => {
    if (answered) return;
    setSorted(prev => prev.filter(i => i.id !== item.id));
    setAvailable(prev => shuffleArray([...prev, item]));
  };

  const handleConfirm = () => {
    if (sorted.length !== node.items.length) return;
    setAnswered(true);
    const correct = sorted.every((item, i) => item.id === node.correct_order[i]);
    setIsCorrect(correct);
    const answerText = sorted.map(s => s.text).join(',');
    setTimeout(() => onAnswer(correct, answerText), 600);
  };

  // Items still available to place
  const canUndo = sorted.length > 0 && !answered;

  return (
    <div className="question-node">
      <div className="question-text">{node.question}</div>
      <div className="question-instruction">{node.instruction}</div>

      {/* Sorted (placed) items */}
      {sorted.length > 0 && (
        <div className="sort-list" style={{ marginBottom: 16 }}>
          {sorted.map((item, i) => (
            <div
              key={item.id}
              className={`sort-item ${
                answered
                  ? item.id === node.correct_order[i]
                    ? 'sorted'
                    : 'wrong-order'
                  : 'sorted'
              }`}
              onClick={canUndo ? () => handleUndo(item) : undefined}
              style={canUndo ? { cursor: 'pointer' } : undefined}
            >
              <span style={{ marginRight: 8, fontWeight: 800 }}>{i + 1}.</span>
              {item.text}
              {canUndo && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-secondary)' }}>↩ 移除</span>}
            </div>
          ))}
        </div>
      )}

      {/* Available items */}
      {available.length > 0 && !answered && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {sorted.length === 0 ? '点击选择第一个步骤：' : '点击选择下一个步骤：'}
          </div>
          <div className="sort-list">
            {available.map(item => (
              <div
                key={item.id}
                className="sort-item"
                onClick={() => handleSelect(item)}
              >
                {item.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {sorted.length === node.items.length && !answered && (
        <button className="btn btn-primary btn-block" onClick={handleConfirm}>
          确认顺序
        </button>
      )}

      {answered && (
        <AnswerFeedback
          isCorrect={isCorrect}
          successMsg={node.success_msg}
          failMsg={node.fail_msg}
          explanation={node.explanation}
          correctAnswer={node.correct_order.map(id => node.items.find(i => i.id === id)?.text).filter(Boolean).join(' → ')}
        />
      )}
    </div>
  );
}

// ── DragDrop: click-to-select redesign ──
function DragDrop({ node, onAnswer }) {
  const [answered, setAnswered] = useState(false);
  const [selected, setSelected] = useState(null);

  // Combine target_zone with distractors and shuffle
  const [allOptions] = useState(() => {
    const opts = [...(node.distractors || [])];
    if (node.target_zone && !opts.find(o => o.id === node.target_zone.id)) {
      opts.push(node.target_zone);
    }
    return shuffleArray(opts);
  });

  const handleClick = (d) => {
    if (answered) return;
    setSelected(d.id);
    setAnswered(true);
    const correct = d.id === node.target_zone?.id;
    setTimeout(() => onAnswer(correct, d.label), 600);
  };

  return (
    <div className="question-node">
      <div className="question-text">{node.question}</div>
      {node.instruction && <div className="question-instruction">{node.instruction}</div>}

      <div className="options-list" style={{ marginTop: 20 }}>
        {allOptions.map(d => {
          const isCorrectZone = d.id === node.target_zone?.id;
          const isChosenWrong = answered && selected === d.id && !isCorrectZone;
          return (
            <button
              key={d.id}
              className={`option-btn ${
                answered
                  ? isCorrectZone
                    ? 'correct'
                    : isChosenWrong
                    ? 'wrong'
                    : ''
                  : ''
              }`}
              onClick={() => handleClick(d)}
            >
              <span className="option-letter">{d.id === node.target_zone?.id ? '★' : '○'}</span>
              <span>{d.label}</span>
            </button>
          );
        })}
      </div>

      {!answered && (
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14, marginTop: 16 }}>
          👆 点击正确的插孔放入表笔
        </div>
      )}

      {answered && (
        <AnswerFeedback
          isCorrect={selected === node.target_zone?.id}
          successMsg={node.success_msg}
          failMsg={node.fail_msg}
          explanation={node.explanation}
          correctAnswer={node.target_zone?.label || ''}
        />
      )}
    </div>
  );
}

// ── MatchQuestion ──
function MatchQuestion({ node, onAnswer }) {
  const [selectedLeft, setSelectedLeft] = useState(null);
  const [matches, setMatches] = useState({});
  const [answered, setAnswered] = useState(false);
  const [isCorrect, setIsCorrect] = useState(false);
  const pairs = node.pairs || [];

  const handleLeftClick = (idx) => {
    if (matches[idx] !== undefined || answered) return;
    setSelectedLeft(idx);
  };

  const handleRightClick = (text) => {
    if (selectedLeft === null || answered) return;
    const newMatches = { ...matches, [selectedLeft]: text };
    setMatches(newMatches);
    setSelectedLeft(null);

    if (Object.keys(newMatches).length === pairs.length) {
      setAnswered(true);
      const allCorrect = pairs.every((p, i) => newMatches[i] === p.right);
      setIsCorrect(allCorrect);
      const answerText = pairs.map((p, i) => `${p.left}=${newMatches[i] || '?'}`).join(', ');
      setTimeout(() => onAnswer(allCorrect, answerText), 600);
    }
  };

  return (
    <div className="question-node">
      <div className="question-text">{node.question}</div>
      <div className="question-instruction">{node.instruction}</div>

      <div className="match-container">
        <div className="match-column">
          {pairs.map((p, i) => (
            <div
              key={i}
              className={`match-item ${selectedLeft === i ? 'selected' : ''} ${matches[i] ? 'matched' : ''}`}
              onClick={() => handleLeftClick(i)}
            >
              {p.left}
            </div>
          ))}
        </div>
        <div className="match-column">
          {pairs.map((p, i) => (
            <div
              key={i}
              className={`match-item ${Object.values(matches).includes(p.right) ? 'matched' : ''}`}
              onClick={() => handleRightClick(p.right)}
            >
              {p.right}
            </div>
          ))}
        </div>
      </div>

      {selectedLeft !== null && (
        <div style={{ textAlign: 'center', marginTop: 12, fontSize: 13, color: 'var(--blue)', fontWeight: 600 }}>
          👆 现在点击右侧对应的名称
        </div>
      )}

      {answered && (
        <AnswerFeedback
          isCorrect={isCorrect}
          successMsg={node.success_msg}
          failMsg={node.fail_msg}
          explanation={node.explanation}
          correctAnswer={node.pairs.map(p => `${p.left} ↔ ${p.right}`).join('，')}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// ── Main LessonPlayer ──
// ═══════════════════════════════════════════

export default function LessonPlayer() {
  const { courseId, unitId, lessonId } = useParams();
  const navigate = useNavigate();
  const { user, gameState, applyRewards, showToast, setGameState } = useGame();

  const [lesson, setLesson] = useState(null);
  const [nodeIndex, setNodeIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState([]);
  const [finished, setFinished] = useState(false);
  const [rewards, setRewards] = useState(null);

  // Refs to avoid stale closure issues in callbacks
  const resultsRef = useRef([]);
  const lessonRef = useRef(null);
  const paramsRef = useRef({ courseId, unitId, lessonId });
  const gameRef = useRef({ user, gameState, applyRewards, showToast, setGameState });

  // Keep refs in sync with latest state
  useEffect(() => {
    lessonRef.current = lesson;
  }, [lesson]);

  useEffect(() => {
    paramsRef.current = { courseId, unitId, lessonId };
  }, [courseId, unitId, lessonId]);

  useEffect(() => {
    gameRef.current = { user, gameState, applyRewards, showToast, setGameState };
  }, [user, gameState, applyRewards, showToast, setGameState]);

  // Load lesson data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNodeIndex(0);
    setResults([]);
    resultsRef.current = [];
    setFinished(false);
    setRewards(null);

    api.getLesson(courseId, unitId, lessonId)
      .then(data => {
        if (!cancelled) setLesson(data);
      })
      .catch(() => {
        if (!cancelled) {
          const demoLesson = getDemoLesson(lessonId);
          setLesson(demoLesson);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [courseId, unitId, lessonId]);

  // ── handleAnswer: records result, advances to next node ──
  const handleAnswer = useCallback((correct, userAnswer) => {
    const les = lessonRef.current;
    const idx = nodeIndex; // use current state to compute, then advance
    const node = les?.nodes?.[idx];

    const currentResult = {
      nodeIndex: idx,
      nodeId: node?.id || '',
      correct,
      userAnswer,
      question: node?.question || '',
      correctAnswer: extractCorrectAnswer(node),
    };

    resultsRef.current = [...resultsRef.current, currentResult];
    setResults(resultsRef.current);

    if (idx < (les?.nodes?.length || 0) - 1) {
      setTimeout(() => setNodeIndex(idx + 1), 800);
    } else {
      setTimeout(() => finishLesson(resultsRef.current), 800);
    }
  }, [nodeIndex, courseId, unitId, lessonId]);

  // ── handleInfoNext: advance without recording a result ──
  const handleInfoNext = useCallback(() => {
    const les = lessonRef.current;
    const idx = nodeIndex;
    if (idx < (les?.nodes?.length || 0) - 1) {
      setNodeIndex(idx + 1);
    } else {
      finishLesson(resultsRef.current);
    }
  }, [nodeIndex]);

  // ── finishLesson: submit raw answers to backend, apply server-graded rewards ──
  const finishLesson = async (finalResults) => {
    setFinished(true);
    const les = lessonRef.current;
    const { courseId: cid, unitId: uid, lessonId: lid } = paramsRef.current;
    const { user: usr, applyRewards: ar, showToast: st, setGameState: sgs } = gameRef.current;

    // Count only question nodes (non-info) for total
    const questionNodes = les?.nodes?.filter(n => n.type !== 'info') || [];
    const totalQuestions = questionNodes.length || finalResults.length || 0;
    const correctCount = finalResults.filter(r => r.correct).length;
    const accuracy = totalQuestions > 0
      ? Math.round((correctCount / totalQuestions) * 100)
      : 100;
    const mistakes = finalResults.filter(r => !r.correct);

    // Show immediate local feedback (XP/coins not final until server confirms)
    const localRewards = {
      xpEarned: accuracy >= 100 ? 15 : accuracy >= 80 ? 12 : 10,
      coinsEarned: Math.round(5 + accuracy / 20),
      heartReturned: accuracy >= 80,
      xpBoostTriggered: accuracy >= 100 && Math.random() < 0.3,
      gradedServerSide: false,
    };
    setRewards(localRewards);

    // Submit to backend — server re-grades answers, persists rewards + game state.
    if (usr?.id && usr.id !== 'demo') {
      try {
        const res = await api.completeLesson(cid, uid, lid, {
          answers: finalResults.map(r => ({
            nodeId: r.nodeId,
            nodeIndex: r.nodeIndex,
            userAnswer: r.userAnswer,
            correct: r.correct,
          })),
        });
        // Server is source of truth: use its rewards + gameState.
        setRewards(res.rewards);
        if (res.gameState && sgs) sgs(res.gameState);
        if (ar) ar(res.rewards);
      } catch (e) {
        // X02: 网络失败（离线）→ 本地暂存 raw answers + client_request_id，联网后
        // 重放给服务端重新判分；服务端按 (user, key) 幂等，重放不二次铸币。
        // 判定「离线」：api 的网络错误没有 status（HTTP 错误一定带 status）。
        if (e && e.status == null) {
          console.warn('[offline] 提交失败，入队待同步:', e);
          enqueueOfflineCompletion({
            userId: usr.id,
            courseId: cid,
            unitId: uid,
            lessonId: lid,
            answers: finalResults.map(r => ({
              nodeId: r.nodeId,
              nodeIndex: r.nodeIndex,
              userAnswer: r.userAnswer,
              correct: r.correct,
            })),
            localRewards,
          });
          setRewards(localRewards);
          if (st) st('当前离线，成绩已本地暂存，联网后自动同步', 'info');
        } else {
          console.error('Failed to submit lesson:', e);
          if (st) st('提交失败，本课成绩未保存', 'error');
          if (ar) ar(null);
        }
      }
    } else {
      // Demo mode progress tracking (no server)
      try {
        const saved = JSON.parse(localStorage.getItem('dlg_progress') || '{}');
        const lessonKey = `${cid}/${uid}/${lid}`;
        saved[lessonKey] = {
          lesson_id: lessonKey,
          completed: true,
          score: correctCount,
          maxScore: totalQuestions,
          accuracy
        };
        localStorage.setItem('dlg_progress', JSON.stringify(saved));
      } catch (e) {
        console.error('Failed to save demo progress', e);
      }
    }

    if (st && mistakes.length > 0) {
      st(`有 ${mistakes.length} 题需要复习，可以去错题医疗包恢复红心`, 'info');
    }
  };

  // ── Loading state ──
  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-secondary)' }}>加载中...</div>
      </div>
    );
  }

  // ── Lesson not found ──
  if (!lesson) {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>📭</div>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>课程未找到</div>
        <button className="btn btn-outline" onClick={() => navigate(`/course/${courseId}`)}>
          返回课程
        </button>
      </div>
    );
  }

  // ── Finished / results screen ──
  if (finished) {
    const questionNodes = lesson.nodes?.filter(n => n.type !== 'info') || [];
    const totalQuestions = questionNodes.length || results.length;
    const correctCount = results.filter(r => r.correct).length;
    const accuracy = totalQuestions > 0
      ? Math.round((correctCount / totalQuestions) * 100)
      : 100;

    return (
      <div className="lesson-content">
        <div className="results-container">
          <div style={{ fontSize: 48, marginBottom: 8 }}>
            {accuracy >= 100 ? '🏆' : accuracy >= 80 ? '🎉' : '💪'}
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 800 }}>小节完成！</h1>
          <div className="results-score">{correctCount}/{totalQuestions}</div>

          <div className="results-stats">
            <div className="results-stat">
              <div className="results-stat-value">{accuracy}%</div>
              <div className="results-stat-label">正确率</div>
            </div>
            <div className="results-stat">
              <div className="results-stat-value">{totalQuestions}</div>
              <div className="results-stat-label">总题数</div>
            </div>
          </div>

          {rewards && (
            <div className="rewards-section">
              <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 8 }}>🎁 奖励</div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 20, flexWrap: 'wrap' }}>
                <div>⚡ +{rewards.xpEarned} XP</div>
                <div>🪙 +{rewards.coinsEarned} 金币</div>
                {rewards.heartReturned && <div>❤️ 返还1颗红心</div>}
              </div>
              {rewards.xpBoostTriggered && (
                <div style={{
                  marginTop: 12,
                  padding: '8px 16px',
                  background: 'rgba(255,255,255,0.3)',
                  borderRadius: 20,
                  fontWeight: 700,
                }}>
                  ⚡ 触发15分钟双倍经验加成！
                </div>
              )}
              {rewards.passed === false && (
                <div style={{
                  marginTop: 12,
                  padding: '8px 16px',
                  background: 'rgba(255,193,7,0.25)',
                  borderRadius: 20,
                  fontWeight: 700,
                  fontSize: 14,
                }}>
                  💪 正确率未达 80%，本次不计入完成奖励。重新挑战并达到 80% 仍可领取全额奖励！
                </div>
              )}
            </div>
          )}

          <button
            className="btn btn-primary btn-block btn-lg"
            onClick={() => navigate(`/course/${courseId}`)}
            style={{ marginTop: 16 }}
          >
            继续学习
          </button>

          {results.some(r => !r.correct) && (
            <button
              className="btn btn-outline btn-block"
              onClick={() => navigate('/review')}
              style={{ marginTop: 8 }}
            >
              去错题医疗包复习（恢复红心）
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Active question ──
  const node = lesson.nodes?.[nodeIndex];
  const progressPct = lesson.nodes?.length > 0
    ? ((nodeIndex) / lesson.nodes.length) * 100
    : 0;

  return (
    <div className="lesson-container">
      <div className="lesson-progress-bar">
        <div className="lesson-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>

      <div className="lesson-content">
        {/* Node indicator */}
        <div style={{
          textAlign: 'center',
          fontSize: 13,
          color: 'var(--text-secondary)',
          marginBottom: 16,
          fontWeight: 600,
        }}>
          第 {nodeIndex + 1} / {lesson.nodes?.length || 0} 题
        </div>

        {node?.type === 'info' && <InfoNode key={node.id || nodeIndex} node={node} onNext={handleInfoNext} />}
        {node?.type === 'multiple_choice' && <MultipleChoice key={node.id || nodeIndex} node={node} onAnswer={handleAnswer} />}
        {node?.type === 'true_false' && <TrueFalse key={node.id || nodeIndex} node={node} onAnswer={handleAnswer} />}
        {node?.type === 'fill_blank' && <FillBlank key={node.id || nodeIndex} node={node} onAnswer={handleAnswer} />}
        {node?.type === 'simulation_dial' && <SimulationDial key={node.id || nodeIndex} node={node} onAnswer={handleAnswer} />}
        {node?.type === 'simulation_probe' && <SimulationProbe key={node.id || nodeIndex} node={node} onAnswer={handleAnswer} />}
        {node?.type === 'multimeter_challenge' && <MultimeterChallenge key={node.id || nodeIndex} node={node} onAnswer={handleAnswer} />}
        {node?.type === 'simulation_danger' && <DangerSim key={node.id || nodeIndex} node={node} onAnswer={handleAnswer} />}
        {node?.type === 'sort' && <SortQuestion key={node.id || nodeIndex} node={node} onAnswer={handleAnswer} />}
        {node?.type === 'drag_drop' && <DragDrop key={node.id || nodeIndex} node={node} onAnswer={handleAnswer} />}
        {node?.type === 'match' && <MatchQuestion key={node.id || nodeIndex} node={node} onAnswer={handleAnswer} />}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// ── Demo lesson fallback data ──
// ═══════════════════════════════════════════

function getDemoLesson(lessonId) {
  const lessons = {
    l1_intro: {
      id: 'l1_intro',
      title: '初识万用表',
      nodes: [
        { type: 'info', title: '认识万用表', content: '万用表是电工最常用的测量工具，可以测量电压、电流、电阻等多种电学量。', image: 'multimeter_overview' },
        { type: 'multiple_choice', question: '黑色表笔应该插在哪个孔？', options: [
          { id: 'A', text: '红色的V孔', is_correct: false },
          { id: 'B', text: 'COM孔（公共端）', is_correct: true },
          { id: 'C', text: '20A孔', is_correct: false },
        ], explanation: '黑色表笔永远插在COM孔！' },
        { type: 'drag_drop', question: '请将黑表笔插入正确的插孔', instruction: '点击正确的插孔', target_zone: { id: 'com_port', label: 'COM孔（公共端）' }, distractors: [
          { id: 'com_port', label: 'COM孔（公共端）' },
          { id: 'v_port', label: 'V/Ω孔（红表笔）' },
          { id: 'a_port', label: '20A孔（大电流）' },
        ] },
        { type: 'multiple_choice', question: '测电压时，红表笔该插哪？', options: [
          { id: 'A', text: 'COM孔', is_correct: false },
          { id: 'B', text: '带有V字母的孔', is_correct: true },
        ], explanation: '红表笔随测量对象变化，测电压插V孔。' },
        { type: 'true_false', question: '不管测什么，黑表笔永远插在COM孔。', correct_answer: true, explanation: '正确！黑表笔始终在COM孔。' },
        { type: 'fill_blank', question: '万用表除了COM孔和V/Ω孔，还有____孔用于测大电流。', answer: '20A', acceptable_answers: ['20A', '20a'], explanation: '20A孔是专用大电流测量孔，需要小心使用。' },
      ],
    },
    l2_battery: {
      id: 'l2_battery',
      title: '测一节电池',
      nodes: [
        { type: 'info', title: '直流电与交流电', content: '电池是直流电（DC），符号V—。家用插座是交流电（AC），符号V~。', image: 'dc_vs_ac' },
        { type: 'multiple_choice', question: '5号电池是什么电？', options: [
          { id: 'A', text: '交流电（V~）', is_correct: false },
          { id: 'B', text: '直流电（V—）', is_correct: true },
        ], explanation: '电池是典型的直流电源。' },
        { type: 'simulation_dial', question: '请拨到测1.5V电池的档位', instruction: '点击旋钮上正确的档位', dial_options: [
          { label: 'OFF', angle: 0 },
          { label: 'ACV 750', angle: 30, is_wrong: true },
          { label: 'DCV 20', angle: 120, is_correct: true },
          { label: 'DCV 2', angle: 150, is_correct: true },
          { label: 'Ω 200', angle: 210, is_wrong: true },
        ], success_msg: '正确！DCV档可以测量。', fail_msg: '要选DCV档（V—）哦！' },
        { type: 'simulation_probe', question: '放置探针测量电池', instruction: '红笔点正极，黑笔点负极', image: 'battery_measure', hotspots: {
          positive: { label: '正极(+)', x: 200, y: 100, radius: 30 },
          negative: { label: '负极(-)', x: 200, y: 250, radius: 30 },
        }, correct_probes: { red: 'positive', black: 'negative' }, feedback_display: '1.50 V ✅' },
        { type: 'multiple_choice', question: '屏幕显示-1.50V说明什么？', options: [
          { id: 'A', text: '电池没电了', is_correct: false },
          { id: 'B', text: '表笔正负极接反了', is_correct: true },
          { id: 'C', text: '万用表坏了', is_correct: false },
        ], explanation: '直流有极性！接反了显示负号。' },
        { type: 'fill_blank', question: '测12V电瓶显示12.1V，说明电瓶容量____。', answer: '充足', acceptable_answers: ['充足'], explanation: '实际电压略高，状态良好。' },
      ],
    },
    l3_safety: {
      id: 'l3_safety',
      title: '致命禁忌——安全第一',
      nodes: [
        { type: 'info', title: '⚠️ 安全警告', content: '红表笔在A孔时测电压会短路烧毁万用表！这是最危险的操作错误。', image: 'safety_warning', style: 'danger' },
        { type: 'simulation_danger', question: '⚠️ 测一下插座电压', instruction: '注意表笔位置！', initial_state: { red_probe_port: '20A', dial_position: 'ACV 750' }, danger_action: 'click_socket', danger_response: { shake: true, flash_red: true, message: '警告！红表笔在电流孔！会短路烧毁！先换回V孔。' }, correct_sequence: [{ action: 'move_probe', from: '20A', to: 'V/Ω' }, { action: 'click_socket' }], success_msg: '安全第一！先换表笔再测量。' },
        { type: 'true_false', question: '测完电流后必须把红表笔插回V孔。', correct_answer: true, explanation: '养成好习惯，避免下次烧表。' },
        { type: 'multiple_choice', question: '以下哪个操作正确？', options: [
          { id: 'A', text: '红笔在A孔，旋钮在电压档去测电压', is_correct: false },
          { id: 'B', text: '测量前先检查表笔位置是否匹配', is_correct: true },
          { id: 'C', text: '测完电流不换表笔直接测电阻', is_correct: false },
        ], explanation: '每次测量前检查表笔位置！' },
        { type: 'sort', question: '排列万用表使用流程', instruction: '按正确顺序点击（顺序已打乱）', items: [
          { id: '1', text: '确认测量对象' },
          { id: '2', text: '检查表笔位置' },
          { id: '3', text: '拨到正确档位' },
          { id: '4', text: '探针接触测试点' },
          { id: '5', text: '测量完毕关闭' },
        ], correct_order: ['1', '2', '3', '4', '5'] },
      ],
    },
    l4_resistance: {
      id: 'l4_resistance',
      title: '测量电阻与通断',
      nodes: [
        { type: 'info', title: '电阻测量', content: '电阻单位是欧姆（Ω）。测量电阻时电路必须断电！蜂鸣档可快速判断通断。', image: 'resistance_intro' },
        { type: 'multiple_choice', question: '测量电阻时电路必须？', options: [
          { id: 'A', text: '通电状态', is_correct: false },
          { id: 'B', text: '断电状态', is_correct: true },
          { id: 'C', text: '无所谓', is_correct: false },
        ], explanation: '必须断电测量电阻！' },
        { type: 'simulation_dial', question: '请拨到电阻档', instruction: '点击旋钮上正确的档位', dial_options: [
          { label: 'OFF', angle: 0 },
          { label: 'ACV 750', angle: 30, is_wrong: true },
          { label: 'DCV 20', angle: 120, is_wrong: true },
          { label: 'Ω 200', angle: 210, is_correct: true },
          { label: '蜂鸣档', angle: 270, is_correct: true },
        ], success_msg: '正确！Ω区域就是电阻档。', fail_msg: '选Ω区域或蜂鸣档哦！' },
        { type: 'simulation_probe', question: '测量电阻的阻值', instruction: '表笔接触电阻两端', image: 'resistor_measure', hotspots: {
          left_lead: { label: '左引脚', x: 100, y: 175, radius: 25 },
          right_lead: { label: '右引脚', x: 300, y: 175, radius: 25 },
        }, correct_probes: { red: 'left_lead', black: 'right_lead' }, allow_swap: true, feedback_display: '1.00 kΩ' },
        { type: 'multiple_choice', question: '屏幕显示OL说明什么？', options: [
          { id: 'A', text: '电阻值为1Ω', is_correct: false },
          { id: 'B', text: '量程太小，需要换大档位', is_correct: true },
          { id: 'C', text: '电阻坏了', is_correct: false },
        ], explanation: 'OL (OverLoad) 表示超出量程。' },
        { type: 'simulation_probe', question: '用蜂鸣档测试导线通断', instruction: '表笔接触导线两端', image: 'wire_continuity', hotspots: {
          wire_end_a: { label: 'A端', x: 80, y: 175, radius: 25 },
          wire_end_b: { label: 'B端', x: 320, y: 175, radius: 25 },
        }, correct_probes: { red: 'wire_end_a', black: 'wire_end_b' }, allow_swap: true, feedback_display: '🔊 蜂鸣——通路！' },
        { type: 'fill_blank', question: '蜂鸣档用于快速判断线路是否____。', answer: '通断', acceptable_answers: ['通断', '通路', '导通'], explanation: '蜂鸣档是电工最常用的档位之一。' },
      ],
    },
  };
  return lessons[lessonId] || null;
}
