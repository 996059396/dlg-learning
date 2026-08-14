import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { GameProvider } from './context/GameContext';
import AuthGate from './components/AuthGate';
import Layout from './components/Layout';
import Home from './pages/Home';
import CourseTree from './pages/CourseTree';
import LessonPlayer from './pages/LessonPlayer';
import Shop from './pages/Shop';
import Leaderboard from './pages/Leaderboard';
import Profile from './pages/Profile';
import MistakeReview from './pages/MistakeReview';
import MockExam from './pages/MockExam';

export default function App() {
  return (
    <BrowserRouter>
      <GameProvider>
        <AuthGate>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Home />} />
              <Route path="/course/:courseId" element={<CourseTree />} />
              <Route path="/course/:courseId/unit/:unitId/lesson/:lessonId" element={<LessonPlayer />} />
              <Route path="/shop" element={<Shop />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/review" element={<MistakeReview />} />
              <Route path="/exam" element={<MockExam />} />
            </Route>
          </Routes>
        </AuthGate>
      </GameProvider>
    </BrowserRouter>
  );
}
