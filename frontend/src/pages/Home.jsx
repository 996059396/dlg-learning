import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useGame } from '../context/GameContext';

export default function Home() {
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { gameState, checkIn, showToast, checkedInToday } = useGame();

  useEffect(() => {
    api.getCourses()
      .then(data => setCourses(data))
      .catch(() => {
        setCourses([{
          id: 'electrician_basics', title: '初级电工理论',
          description: '从零开始学习电工基础知识，掌握安全操作规范和常用工具使用',
          icon: '⚡', color: '#FF6B35',
          units: [{
            id: 'u1_meter_basics', title: '单元一：验电设备的使用——万用表',
            description: '掌握万用表基础测量与安全禁忌', lesson_count: 4, estimated_total_time: '12分钟',
          }],
        }]);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleCheckIn = () => {
    checkIn();
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 40 }}>加载中...</div>;
  }

  return (
    <div>
      {/* Streak / Check-in banner */}
      <div
        style={{
          background: checkedInToday
            ? 'linear-gradient(135deg, var(--primary), #338300)'
            : 'linear-gradient(135deg, #FF6B35, #FF8C42)',
          borderRadius: 'var(--radius)',
          padding: '20px',
          color: 'white',
          marginBottom: 20,
          cursor: checkedInToday ? 'default' : 'pointer',
        }}
        onClick={handleCheckIn}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, opacity: 0.9, marginBottom: 4 }}>🔥 学习连胜</div>
            <div style={{ fontSize: 36, fontWeight: 800 }}>{gameState?.streak || 0} 天</div>
          </div>
          <div style={{ fontSize: 48 }}>🔥</div>
        </div>
        {checkedInToday ? (
          <div style={{
            marginTop: 8, padding: '8px 16px',
            background: 'rgba(255,255,255,0.3)', borderRadius: 20,
            textAlign: 'center', fontWeight: 700, fontSize: 14,
          }}>
            ✅ 今日已签到
          </div>
        ) : (
          <div style={{
            marginTop: 8, padding: '8px 16px',
            background: 'rgba(255,255,255,0.2)', borderRadius: 20,
            textAlign: 'center', fontWeight: 700, fontSize: 14,
          }}>
            点击签到领取今日奖励
          </div>
        )}
      </div>

      {/* XP Boost banner */}
      {gameState?.xp_boost_until && new Date(gameState.xp_boost_until) > new Date() && (
        <div style={{
          background: 'linear-gradient(135deg, #7B2FF7, #9D4EDD)',
          borderRadius: 'var(--radius)', padding: '16px 20px',
          color: 'white', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 32 }}>⚡</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{gameState.xp_boost_multiplier}x 经验加成中！</div>
            <div style={{ fontSize: 13, opacity: 0.9 }}>
              剩余 {Math.ceil((new Date(gameState.xp_boost_until) - new Date()) / 60000)} 分钟
            </div>
          </div>
        </div>
      )}

      {/* Mock Exam entry (P1 value anchor) */}
      <div onClick={() => navigate('/exam')}
        style={{
          background: 'linear-gradient(135deg, #1A73E8, #0D47A1)',
          borderRadius: 'var(--radius)', padding: '18px 20px', marginBottom: 20,
          color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          cursor: 'pointer',
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 32 }}>🧯</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17 }}>全真模拟考</div>
            <div style={{ fontSize: 13, opacity: 0.9 }}>100 题 · 45 分钟 · 80 分及格</div>
          </div>
        </div>
        <span style={{ fontSize: 22 }}>→</span>
      </div>

      {/* Course List */}
      <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 16 }}>📚 我的课程</h2>

      {courses.map(course => (
        <div key={course.id} className="course-card"
          onClick={() => navigate(`/course/${course.id}`)}
          style={{ marginBottom: 16 }}>
          <div className="course-card-header" style={{ background: course.color }}>
            <span style={{ fontSize: 28 }}>{course.icon}</span>
            <div>
              <div>{course.title}</div>
              <div style={{ fontSize: 13, fontWeight: 400, opacity: 0.9, marginTop: 4 }}>
                {course.description}
              </div>
            </div>
          </div>
          <div className="course-card-body">
            {course.units.map(unit => (
              <div key={unit.id} className="unit-item">
                <div className="unit-icon" style={{ background: `${course.color}15`, color: course.color }}>🔬</div>
                <div className="unit-info">
                  <div className="unit-title">{unit.title}</div>
                  <div className="unit-meta">{unit.lesson_count} 小节 · 约{unit.estimated_total_time}</div>
                </div>
                <div className="unit-arrow">→</div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Medical Kit shortcut */}
      <div style={{
        marginTop: 24, padding: 16, background: '#FFF5F5',
        borderRadius: 'var(--radius)', display: 'flex',
        alignItems: 'center', gap: 12, cursor: 'pointer',
      }} onClick={() => navigate('/review')}>
        <span style={{ fontSize: 36 }}>🏥</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>错题医疗包</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            复习错题，恢复红心 ❤️ + 赚取金币 🪙
          </div>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 20 }}>→</div>
      </div>
    </div>
  );
}
