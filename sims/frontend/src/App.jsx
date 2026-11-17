import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { AppShell } from './layout';
import { Spinner } from './ui';
import { Forgot, HOME, Login, Reset, Signup } from './pages/auth';
import { JoinGate, NotificationsPage } from './pages/common';
import { ClassArea } from './pages/class/ClassContext';
import { CollegeArea } from './pages/college/CollegeArea';

// student pages are code-split (recharts is heavy)
const Dashboard = lazy(() => import('./pages/student/Dashboard'));
const Profile = lazy(() => import('./pages/student/Profile'));
const Attendance = lazy(() => import('./pages/student/Attendance'));
const Academics = lazy(() => import('./pages/student/Academics'));
const Certificates = lazy(() => import('./pages/student/Certificates'));
const Portfolio = lazy(() => import('./pages/student/Portfolio'));
const Resume = lazy(() => import('./pages/student/Resume'));
const SkillGap = lazy(() => import('./pages/student/SkillGap'));
const Planner = lazy(() => import('./pages/student/Planner'));
const Achievements = lazy(() => import('./pages/student/Achievements'));
const Activities = lazy(() => import('./pages/student/Activities'));
const Verification = lazy(() => import('./pages/student/Verification'));
// instructor pages (ClassArea itself is tiny: it only provides the selected-class context)
const ClassOverview = lazy(() => import('./pages/class/Overview'));
const ClassVerification = lazy(() => import('./pages/class/Verification'));
const ClassStudents = lazy(() => import('./pages/class/Students'));
const ClassStudentDetail = lazy(() => import('./pages/class/StudentDetail'));
const ClassDataEntry = lazy(() => import('./pages/class/DataEntry'));
const ClassAnalytics = lazy(() => import('./pages/class/Analytics'));
const ClassLeaderboard = lazy(() => import('./pages/class/Leaderboard'));
const ClassLife = lazy(() => import('./pages/class/Life'));
const ClassSetup = lazy(() => import('./pages/class/Setup'));
const ClassRequests = lazy(() => import('./pages/class/Requests'));
const ClassAudit = lazy(() => import('./pages/class/Audit'));
// college admin pages (code-split: the charts pull in recharts)
const CollegeOverview = lazy(() => import('./pages/college/Overview'));
const CollegeDepartments = lazy(() => import('./pages/college/Departments'));
const CollegeDepartmentDetail = lazy(() => import('./pages/college/DepartmentDetail'));
const CollegeAnalytics = lazy(() => import('./pages/college/Analytics'));
const CollegeLeaderboard = lazy(() => import('./pages/college/Leaderboard'));
const CollegeInstructors = lazy(() => import('./pages/college/Instructors'));
const CollegeAlerts = lazy(() => import('./pages/college/Alerts'));
const CollegeEvents = lazy(() => import('./pages/college/Events'));
const CollegeReports = lazy(() => import('./pages/college/Reports'));
const CollegeSettings = lazy(() => import('./pages/college/Settings'));
// university head pages
const UniOverview = lazy(() => import('./pages/university/Overview'));
const UniColleges = lazy(() => import('./pages/university/Colleges'));
const UniCollegeDetail = lazy(() => import('./pages/university/CollegeDetail'));
const UniLeaderboard = lazy(() => import('./pages/university/Leaderboard'));
const UniAnalytics = lazy(() => import('./pages/university/Analytics'));
const UniAlerts = lazy(() => import('./pages/university/Alerts'));
const UniAnnouncements = lazy(() => import('./pages/university/Announcements'));
const UniReports = lazy(() => import('./pages/university/Reports'));
const UniSettings = lazy(() => import('./pages/university/Settings'));
const VerifyCertificate = lazy(() => import('./pages/VerifyCertificate'));

/** Signed-in users only; optionally one role. */
function Protected({ role }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner label="Signing you in" />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (role && user.role !== role) return <Navigate to={HOME[user.role]} replace />;
  return <Outlet />;
}

/** Student features need an APPROVED class membership; otherwise show the join / waiting screen. */
function ApprovedStudent() {
  const { context } = useAuth();
  return context?.status === 'approved' ? <Outlet /> : <JoinGate />;
}

export default function App() {
  const { user } = useAuth();
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<Forgot />} />
        <Route path="/reset-password" element={<Reset />} />
        <Route path="/verify/:code" element={<VerifyCertificate />} />   {/* public: certificate QR target */}

        <Route element={<Protected />}>
          <Route element={<AppShell />}>
            <Route path="/notifications" element={<NotificationsPage />} />

            <Route element={<Protected role="student" />}>
              <Route path="/student/profile" element={<Profile />} />
              <Route element={<ApprovedStudent />}>
                <Route path="/student" element={<Dashboard />} />
                <Route path="/student/attendance" element={<Attendance />} />
                <Route path="/student/academics" element={<Academics />} />
                <Route path="/student/certificates" element={<Certificates />} />
                <Route path="/student/portfolio" element={<Portfolio />} />
                <Route path="/student/resume" element={<Resume />} />
                <Route path="/student/skills" element={<SkillGap />} />
                <Route path="/student/skill-gap" element={<SkillGap />} />   {/* links emitted by the API's suggestions */}
                <Route path="/student/planner" element={<Planner />} />
                <Route path="/student/achievements" element={<Achievements />} />
                <Route path="/student/activities" element={<Activities />} />
                <Route path="/student/verification" element={<Verification />} />
              </Route>
            </Route>

            <Route element={<Protected role="instructor" />}>
              <Route path="/class" element={<ClassArea />}>
                <Route index element={<ClassOverview />} />
                <Route path="verification" element={<ClassVerification />} />
                <Route path="students" element={<ClassStudents />} />
                <Route path="students/:sid" element={<ClassStudentDetail />} />
                <Route path="entry" element={<ClassDataEntry />} />
                <Route path="analytics" element={<ClassAnalytics />} />
                <Route path="leaderboard" element={<ClassLeaderboard />} />
                <Route path="life" element={<ClassLife />} />
                <Route path="setup" element={<ClassSetup />} />
                <Route path="requests" element={<ClassRequests />} />
                <Route path="audit" element={<ClassAudit />} />
              </Route>
            </Route>
            <Route element={<Protected role="college_admin" />}>
              <Route path="/college" element={<CollegeArea />}>
                <Route index element={<CollegeOverview />} />
                <Route path="departments" element={<CollegeDepartments />} />
                <Route path="departments/:id" element={<CollegeDepartmentDetail />} />
                <Route path="analytics" element={<CollegeAnalytics />} />
                <Route path="leaderboard" element={<CollegeLeaderboard />} />
                <Route path="instructors" element={<CollegeInstructors />} />
                <Route path="alerts" element={<CollegeAlerts />} />
                <Route path="events" element={<CollegeEvents />} />
                <Route path="reports" element={<CollegeReports />} />
                <Route path="settings" element={<CollegeSettings />} />
              </Route>
            </Route>
            <Route element={<Protected role="university_head" />}>
              <Route path="/university">
                <Route index element={<UniOverview />} />
                <Route path="colleges" element={<UniColleges />} />
                <Route path="colleges/:id" element={<UniCollegeDetail />} />
                <Route path="leaderboard" element={<UniLeaderboard />} />
                <Route path="analytics" element={<UniAnalytics />} />
                <Route path="alerts" element={<UniAlerts />} />
                <Route path="announcements" element={<UniAnnouncements />} />
                <Route path="reports" element={<UniReports />} />
                <Route path="settings" element={<UniSettings />} />
              </Route>
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to={user ? HOME[user.role] : '/login'} replace />} />
      </Routes>
    </Suspense>
  );
}
