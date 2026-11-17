import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, refreshSession, setAccessToken, setSessionLostHandler } from './api';

/* ---------------------------------------------------------------- theme */
const ThemeCtx = createContext({ dark: false, toggle() {} });
export const useTheme = () => useContext(ThemeCtx);

export function ThemeProvider({ children }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = useCallback(() => {
    setDark((d) => {
      const next = !d;
      document.documentElement.classList.toggle('dark', next);
      try { localStorage.setItem('sims-theme', next ? 'dark' : 'light'); } catch { /* private mode */ }
      return next;
    });
  }, []);
  return <ThemeCtx.Provider value={useMemo(() => ({ dark, toggle }), [dark, toggle])}>{children}</ThemeCtx.Provider>;
}

/* ---------------------------------------------------------------- session */
const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, context: null });

  const loadMe = useCallback(async () => {
    const me = await api.get('/me');
    setState({ loading: false, user: me.user, context: me.context });
    return me;
  }, []);

  // on first load: try to resume the session from the refresh cookie
  useEffect(() => {
    setSessionLostHandler(() => { setAccessToken(null); setState({ loading: false, user: null, context: null }); });
    (async () => {
      const s = await refreshSession();
      if (!s) return setState({ loading: false, user: null, context: null });
      try { await loadMe(); } catch { setState({ loading: false, user: null, context: null }); }
    })();
  }, [loadMe]);

  const start = useCallback(async (session) => {            // after login / signup
    setAccessToken(session.accessToken);
    await loadMe();
    return session;
  }, [loadMe]);

  const value = useMemo(() => ({
    ...state,
    refresh: loadMe,
    login: async (email, password) => start(await api.post('/auth/login', { email, password })),
    signup: async (kind, body) => start(await api.post(`/auth/signup/${kind}`, body)),
    logout: async () => {
      try { await api.post('/auth/logout'); } catch { /* already gone */ }
      setAccessToken(null);
      setState({ loading: false, user: null, context: null });
    },
  }), [state, loadMe, start]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
