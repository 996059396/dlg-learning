import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useGame } from '../context/GameContext';

export default function CourseTree() {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { user, gameState, useHeart, showToast } = useGame();
  const [course, setCourse] = useState(null);
  const [unitData, setUnitData] = useState([]);
  const [progress, setProgress] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const courses = await api.getCourses();
        const c = courses.find(x => x.id === courseId);
        setCourse(c);

        // Load all unit details
        const unitsWithLessons = await Promise.all(
          c.units.map(async u => {
            try {
              return await api.getUnit(courseId, u.id);
            } catch {
              return u;
            }
          })
        );
        setUnitData(unitsWithLessons);

        // Load progress if user exists
        if (user?.id && user.id !== 'demo') {
          try {
            const prog = await api.getProgress();            const map = {};
            (prog || []).forEach(p => {
              // Store under both raw lesson_id and composite key (defensive)
              map[p.lesson_id] = p;
              // If lesson_id is already composite (contains "/"), also extract bare id
              if (p.lesson_id && p.lesson_id.includes('/')) {
                const bare = p.lesson_id.split('/').pop();
                map[bare] = p;
              }
              // If lesson_id is bare, also store composite form using courseId
              else if (p.lesson_id) {
                map[`${courseId}/${p.unit_id || ''}/${p.lesson_id}`] = p;
              }
            });
            setProgress(map);
          } catch (err) {
            console.error("CourseTree progress load error:", err);
          }
        } else {
          const saved = localStorage.getItem('dlg_progress');
          if (saved) setProgress(JSON.parse(saved));
        }
      } catch (err) {
        console.error("CourseTree Error:", err);
        // Load offline progress anyway
        const saved = localStorage.getItem('dlg_progress');
        if (saved) setProgress(JSON.parse(saved));

        // Demo fallback
        setCourse({
          id: 'electrician_basics',
          title: '初级电工理论',
          icon: '⚡',
          color: '#FF6B35',
          units: [{
            id: 'u1_meter_basics',
            title: '单元一：验电设备的使用——万用表',
            lesson_count: 4,
            estimated_total_time: '12分钟',
          }],
        });
        setUnitData([{
          id: 'u1_meter_basics',
          title: '单元一：验电设备的使用——万用表',
          lessons: [
            { id: 'l1_intro', title: '初识万用表', description: '认识界面与插孔', estimated_time: '2分钟' },
            { id: 'l2_battery', title: '测一节电池', description: '直流电压档位与极性', estimated_time: '3分钟' },
            { id: 'l3_safety', title: '致命禁忌——安全第一', description: '防烧毁机制', estimated_time: '2分钟' },
            { id: 'l4_resistance', title: '测量电阻与通断', description: '电阻档和蜂鸣档', estimated_time: '3分钟' },
          ],
        }]);
      }
      setLoading(false);
    }
    load();
  }, [courseId, gameState]);

  const handleStartLesson = async (unitId, lessonId, isRetry = false) => {
    if (!isRetry && gameState.hearts <= 0) {
      showToast('❤️ 红心不足！去错题医疗包恢复红心吧', 'danger');
      return;
    }
    if (!isRetry) {
      const result = await useHeart();
      if (!result.success) {
        showToast('❤️ 红心不足！去错题医疗包恢复红心吧', 'danger');
        return;
      }
    }
    navigate(`/course/${courseId}/unit/${unitId}/lesson/${lessonId}`);
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 40 }}>加载中...</div>;
  }

  return (
    <div>
      {/* Course Header */}
      <div style={{
        background: course?.color || '#FF6B35',
        borderRadius: 'var(--radius)',
        padding: '24px 20px',
        color: 'white',
        marginBottom: 20,
      }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>{course?.icon || '⚡'}</div>
        <h1 style={{ fontSize: 22, fontWeight: 800 }}>{course?.title}</h1>
        <div style={{ fontSize: 14, opacity: 0.9, marginTop: 4 }}>
          完成所有单元，掌握电工核心技能
        </div>
      </div>

      {/* Units & Lessons */}
      {unitData.map((unit, uIdx) => (
        <div key={unit.id} style={{ marginBottom: 24 }}>
          <div style={{
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--text-secondary)',
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <span>📋</span>
            <span>单元 {uIdx + 1}：{unit.title?.replace(/^单元[一二三四五六七八九十]+[：:]?\s*/, '')}</span>
          </div>

          {unit.lessons?.map((lesson, lIdx) => {
            const isMockExam = courseId === 'electrician_exam' && unit.id === 's13_mock_exam' && lesson.id === 's13e_mock_test';
            const lessonKey = `${courseId}/${unit.id}/${lesson.id}`;
            const prog = progress[lessonKey];
            const isCompleted = prog?.completed;
            const isUnlocked = isMockExam || lIdx === 0 || progress[`${courseId}/${unit.id}/${unit.lessons[lIdx - 1].id}`]?.completed;

            return (
              <div
                key={lesson.id}
                onClick={() => {
                  if (isMockExam) { navigate('/exam'); return; }
                  if (isUnlocked) handleStartLesson(unit.id, lesson.id, isCompleted);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '14px 16px',
                  background: isMockExam ? '#EAF2FF' : isCompleted ? '#F0FFF0' : isUnlocked ? 'white' : '#F5F5F5',
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${isMockExam ? '#BBD3F5' : isCompleted ? '#C8E6C9' : 'var(--border)'}`,
                  marginBottom: 8,
                  cursor: isUnlocked ? 'pointer' : 'default',
                  opacity: isUnlocked ? 1 : 0.5,
                  transition: 'all 0.15s',
                }}
              >
                <div style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: isMockExam ? '#D8E8FF' : isCompleted ? '#E8F5E9' : isUnlocked ? '#FFF3E0' : '#EEE',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 20,
                  flexShrink: 0,
                }}>
                  {isMockExam ? '🧯' : isCompleted ? '✅' : isUnlocked ? '📖' : '🔒'}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>
                    {lesson.title}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    {isMockExam
                      ? '100 题 · 45 分钟 · 80 分及格 · 点击进入全真模拟考'
                      : (lesson.description || lesson.estimated_time)}
                  </div>
                </div>
                {isCompleted && (
                  <div style={{ fontSize: 13, color: 'var(--primary)', fontWeight: 700 }}>
                    {prog.accuracy}%
                  </div>
                )}
                {!isCompleted && isUnlocked && (
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    {lesson.estimated_time || lesson.node_count + '题'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
