import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from './api';
import { useAuth, useTheme } from './auth';
import { Icon } from './icons';
import { fmtDateTime } from './ui';

const NAV = {
  student: [
    { to: '/student', label: 'Dashboard', icon: 'home', end: true },
    { to: '/student/attendance', label: 'Attendance', icon: 'calendar' },
    { to: '/student/academics', label: 'Academics', icon: 'book' },
    { to: '/student/certificates', label: 'Certificates', icon: 'award' },
    { to: '/student/portfolio', label: 'Projects & Portfolio', icon: 'folder' },
    { to: '/student/resume', label: 'Resume Builder', icon: 'file' },
    { to: '/student/skills', label: 'Skill Gap', icon: 'target' },
    { to: '/student/planner', label: 'Planner', icon: 'list' },
    { to: '/student/achievements', label: 'Achievements', icon: 'trophy' },
    { to: '/student/activities', label: 'Activities', icon: 'flag' },
    { to: '/student/verification', label: 'Verification', icon: 'shield' },
    { to: '/student/profile', label: 'Profile', icon: 'user' },
  ],
  instructor: [
    { to: '/class', label: 'Dashboard', icon: 'home', end: true },
    { to: '/class/verification', label: 'Verification', icon: 'shield' },
    { to: '/class/students', label: 'Students', icon: 'user' },
    { to: '/class/entry', label: 'Data entry', icon: 'upload' },
    { to: '/class/analytics', label: 'Analytics', icon: 'target' },
    { to: '/class/leaderboard', label: 'Leaderboard', icon: 'trophy' },
    { to: '/class/life', label: 'Class life', icon: 'flag' },
    { to: '/class/setup', label: 'Setup', icon: 'book' },
    { to: '/class/requests', label: 'Join requests', icon: 'list' },
    { to: '/class/audit', label: 'Audit log', icon: 'file' },
  ],
  college_admin: [
    { to: '/college', label: 'Dashboard', icon: 'home', end: true },
    { to: '/college/departments', label: 'Departments', icon: 'folder' },
    { to: '/college/analytics', label: 'Analytics', icon: 'target' },
    { to: '/college/leaderboard', label: 'Leaderboards', icon: 'trophy' },
    { to: '/college/instructors', label: 'Instructors', icon: 'user' },
    { to: '/college/alerts', label: 'Alerts & insights', icon: 'bell' },
    { to: '/college/events', label: 'Events & announcements', icon: 'calendar' },
    { to: '/college/reports', label: 'Reports & audit', icon: 'file' },
    { to: '/college/settings', label: 'College settings', icon: 'school' },
  ],
  university_head: [
    { to: '/university', label: 'Dashboard', icon: 'home', end: true },
    { to: '/university/colleges', label: 'Colleges', icon: 'school' },
    { to: '/university/leaderboard', label: 'Leaderboards', icon: 'trophy' },
    { to: '/university/analytics', label: 'Analytics', icon: 'target' },
    { to: '/university/alerts', label: 'Alerts & insights', icon: 'bell' },
    { to: '/university/announcements', label: 'Announcements', icon: 'flag' },
    { to: '/university/reports', label: 'Reports & audit', icon: 'file' },
    { to: '/university/settings', label: 'University settings', icon: 'shield' },
  ],
};
const ROLE_LABEL = { student: 'Student', instructor: 'Class Instructor', college_admin: 'College Admin', university_head: 'University Head' };

function Bell() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ unread: 0, notifications: [] });
  const box = useRef(null);

  const load = async () => { try { setData(await api.get('/notifications?limit=8')); } catch { /* offline: keep old */ } };
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);                     // cheap, indexed query
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const openOne = async (n) => {
    setOpen(false);
    if (!n.read) { try { await api.post(`/notifications/${n.id}/read`); } catch { /* ignore */ } load(); }
    if (n.link) nav(n.link);
  };
  const readAll = async () => { await api.post('/notifications/read-all'); load(); };

  return (
    <div className="relative" ref={box}>
      <button onClick={() => { setOpen((o) => !o); if (!open) load(); }} className="relative rounded-xl p-2 text-muted hover:bg-surface-2 hover:text-ink" aria-label={`Notifications${data.unread ? `, ${data.unread} unread` : ''}`}>
        <Icon name="bell" />
        {data.unread > 0 && <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-bad text-[10px] font-semibold text-white">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(92vw,22rem)] overflow-hidden rounded-2xl border border-line bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-sm font-semibold">Notifications</span>
            {data.unread > 0 && <button onClick={readAll} className="text-xs font-medium text-brand hover:underline">Mark all read</button>}
          </div>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {data.notifications.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted">You're all caught up.</li>}
            {data.notifications.map((n) => (
              <li key={n.id}>
                <button onClick={() => openOne(n)} className={`block w-full px-4 py-3 text-left hover:bg-surface-2 ${n.read ? '' : 'bg-brand-soft/50'}`}>
                  <span className="flex items-start gap-2">
                    {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" />}
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{n.title}</span>
                      {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{n.body}</span>}
                      <span className="mt-1 block text-[11px] text-muted">{fmtDateTime(n.createdAt)}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => { setOpen(false); nav('/notifications'); }} className="block w-full border-t border-line px-4 py-2.5 text-center text-xs font-medium text-brand hover:bg-surface-2">View all</button>
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const { user, context, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const nav = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const items = NAV[user.role] || [];
  // context.college / context.university are strings for students and instructors but {id, name} objects for admins
  const label = (v) => (v && typeof v === 'object' ? v.name : v);
  const place = context?.class?.name || label(context?.college) || context?.name || label(context?.university);

  const Links = ({ onNavigate }) => (
    <nav className="flex flex-col gap-0.5 p-3" aria-label="Main">
      {items.map((it) => (
        <NavLink key={it.to} to={it.to} end={it.end} onClick={onNavigate}
          className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition ${isActive ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2 hover:text-ink'}`}>
          <Icon name={it.icon} className="size-[18px]" />{it.label}
        </NavLink>
      ))}
    </nav>
  );
  const Brand = () => (
    <div className="flex items-center gap-2.5 px-5 py-4">
      <span className="flex size-8 items-center justify-center rounded-lg bg-brand text-brand-ink"><Icon name="school" className="size-[18px]" /></span>
      <div className="leading-tight"><div className="text-sm font-semibold">SIMS</div><div className="text-[11px] text-muted">{ROLE_LABEL[user.role]}</div></div>
    </div>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col overflow-y-auto border-r border-line bg-surface lg:flex"><Brand /><Links /></aside>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <aside className="absolute inset-y-0 left-0 w-64 overflow-y-auto bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}><Brand /><Links onNavigate={() => setDrawer(false)} /></aside>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface/90 px-4 backdrop-blur sm:px-6">
          <button onClick={() => setDrawer(true)} className="rounded-xl p-2 text-muted hover:bg-surface-2 lg:hidden" aria-label="Open menu"><Icon name="menu" /></button>
          <div className="min-w-0 flex-1 truncate text-sm text-muted">{place}</div>
          <button onClick={toggle} className="rounded-xl p-2 text-muted hover:bg-surface-2 hover:text-ink" aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}><Icon name={dark ? 'sun' : 'moon'} /></button>
          <Bell />
          <div className="ml-1 hidden text-right text-xs leading-tight sm:block"><div className="font-medium">{user.fullName}</div><div className="text-muted">{user.email}</div></div>
          <button onClick={async () => { await logout(); nav('/login'); }} className="rounded-xl p-2 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Sign out" title="Sign out"><Icon name="logout" /></button>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8"><Outlet /></main>
      </div>
    </div>
  );
}
