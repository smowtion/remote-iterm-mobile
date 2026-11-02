import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';
import { Plus, X, Send, Clock, ChevronUp, ChevronDown, CornerDownLeft, Trash2, Keyboard, Terminal, Lock, Unlock, Radio, Bell, Clipboard, Copy, WifiOff, Columns2 } from 'lucide-react';

// --- Types ---
interface Session { id: string; name: string; }
interface Tab { index: number; id: string; isSelected: boolean; sessions: Session[]; }
interface Bounds { x: number; y: number; w: number; h: number; }
interface WindowState { id: string; isFront: boolean; tabs: Tab[]; bounds?: Bounds; }
interface ScreenSize { width: number; height: number; }

interface ColoredLine {
  text: string;
  color: string;
  bold: boolean;
}

interface HistoryView {
  pane: 'primary' | 'split';
  sessionId: string;
  content: string;
}

const ACCENT = '#10b981';
const BROADCAST_COLOR = '#818cf8';
const GLOW = 'rgba(16,185,129,0.25)';

const SOCKET_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:7291'
  : `http://${window.location.hostname}:7291`;

const HISTORY_KEY = 'iterm-cmd-history';
const FONT_SIZES = [12, 13, 14, 16, 18];
const MAX_HISTORY = 100;

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveHistory(h: string[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-MAX_HISTORY)));
}
function getSelectedTab(win?: WindowState): Tab | undefined {
  return win?.tabs.find(t => t.isSelected) || win?.tabs[0];
}

// --- Precompiled regex patterns for line colorizer ---
const RE_PROMPT_1 = /^.*[@:].*[\$%#>]\s/;
const RE_PROMPT_2 = /^[\$%#>]\s/;
const RE_PROMPT_3 = /^\(.*\)\s*[\$%#>]\s/;
const RE_ERROR = /\b(error|ERR!?|FAIL(ED)?|fatal|FATAL|panic|denied|not found|No such file|ENOENT|EACCES|exception|crash)\b/i;
const RE_WARN = /\b(warn(ing)?|WARN(ING)?|deprecated|DEPRECATED|caution)\b/i;
const RE_SUCCESS = /\b(success|SUCCESS|✓|passed|PASSED|done|DONE|compiled|built|complete[d]?|installed|ok\b|OK\b)/i;
const RE_PATH = /^(\/|~\/|\.\/|\.\.\/)/;
const RE_TREE = /^\s*(├|└|│|─)/;
const RE_DIFF_ADD = /^\+[^+]/;
const RE_DIFF_DEL = /^-[^-]/;
const RE_COMMENT = /^\s*#(?!\!)/;

// --- Terminal line colorizer ---
function colorizeLines(content: string): ColoredLine[] {
  const lines = content.split('\n');
  const result: ColoredLine[] = [];
  const lastIdx = lines.length - 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Current prompt (last non-empty line) — bright white
    if (i === lastIdx && trimmed) {
      result.push({ text: line, color: '#f5f5f5', bold: true });
      continue;
    }

    // Prompt lines: user@host, ends with $ or %, starts with $ % # >
    if (RE_PROMPT_1.test(trimmed) || RE_PROMPT_2.test(trimmed) || RE_PROMPT_3.test(trimmed)) {
      result.push({ text: line, color: '#22d3ee', bold: true }); // cyan
      continue;
    }

    // Error / failure lines
    if (RE_ERROR.test(line)) {
      result.push({ text: line, color: '#f87171', bold: false }); // red
      continue;
    }

    // Warning lines
    if (RE_WARN.test(line)) {
      result.push({ text: line, color: '#fbbf24', bold: false }); // amber
      continue;
    }

    // Success / positive lines
    if (RE_SUCCESS.test(line)) {
      result.push({ text: line, color: '#34d399', bold: false }); // green
      continue;
    }

    // File paths
    if (RE_PATH.test(trimmed) || RE_TREE.test(line)) {
      result.push({ text: line, color: '#818cf8', bold: false }); // indigo
      continue;
    }

    // Git diff + / -
    if (RE_DIFF_ADD.test(trimmed)) {
      result.push({ text: line, color: '#4ade80', bold: false });
      continue;
    }
    if (RE_DIFF_DEL.test(trimmed)) {
      result.push({ text: line, color: '#fb7185', bold: false });
      continue;
    }

    // Comments
    if (RE_COMMENT.test(line)) {
      result.push({ text: line, color: '#52525b', bold: false });
      continue;
    }

    // Default — light gray
    result.push({ text: line, color: '#d4d4d8', bold: false });
  }

  return result;
}

// Strip OpenCode TUI chrome (progress bars, footer/status lines) so the
// terminal is easier to read on a phone. Text content is kept.
const OC_BAR_CHARS = /[▀▁▂▃▄▅▆▇█░▒▓━─═╭╮╰╯┃│╹╻]/g;

function cleanOpenCodeOutput(text: string): string {
  if (!text) return text;

  // Remove ANSI escapes / carriage returns and collapse the huge column gaps
  // produced by the TUI. This is what makes the text wrap cleanly on a phone.
  text = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]{8,}/g, '   ');

  const out: string[] = [];
  let lastBlank = false;

  for (const rawLine of text.split('\n')) {
    let line = rawLine.replace(/[ \t]+$/, '');

    // Inline chrome: keyboard hints and timing badges.
    line = line.replace(/\s*Press\s+(?:ctrl|cmd|shift|alt|option)\+[a-z0-9]+(?:\s+to\s+[^.\n]+)?\.?/gi, '');
    line = line.replace(/\s*(?:Background\s*\+\s*)?Thought\s*·\s*\d+(?:\.\d+)?\s*(?:ms|s)\b/g, '');

    // Drop TUI side borders and spinner glyphs.
    line = line
      .replace(/[┃│]/g, '')
      .replace(/^[ \t]*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏][ \t]?/, '')
      .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '');

    // Split the TUI row into columns. Drop chrome-only columns, then join the
    // useful text with a single space instead of a wide visual gap.
    const columns = line
      .split(/[ \t]{2,}/)
      .map((c) => c.trim())
      .filter(Boolean)
      .filter((c) => !/^(?:Build(?:\s+auto)?\s*·|Thought\s*·|Shell\s+(?:finished|started)\b|Background\b|esc\s+(?:to\s+)?interrupt\b|ctrl\+p commands)/i.test(c));

    if (columns.length > 1) {
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const c of columns) {
        if (!seen.has(c)) {
          seen.add(c);
          unique.push(c);
        }
      }
      line = unique.join(' ');
    } else if (columns.length === 0) {
      line = '';
    }

    line = line.replace(/[ \t]+$/, '');
    const trimmed = line.trim();

    if (!trimmed) {
      if (!lastBlank) out.push('');
      lastBlank = true;
      continue;
    }
    lastBlank = false;

    // OpenCode chrome / hints that deserve to disappear completely.
    if (/^[•·\-–—|.\s]+$/.test(trimmed)) continue;
    if (/^Press\s+(?:ctrl|cmd|shift|alt|option)\+/i.test(trimmed)) continue;
    if (/^(?:↳\s*)?Shell\s+(?:finished|started)\b/i.test(trimmed)) continue;
    if (/^(?:Background|Thought)\b/i.test(trimmed)) continue;
    if (/esc\s+(?:to\s+)?interrupt\b/i.test(trimmed)) continue;
    if (/ctrl\+p commands/i.test(trimmed)) continue;
    if (/shell\s*·.*\(\d+%\)/i.test(trimmed)) continue;
    if (/\d+(?:\.\d+)?[KM]?\s*\(\d+%\).*·\s*\$\d/.test(trimmed)) continue;

    // Shell / token / cost footer
    if (/^shell\s*·/i.test(trimmed)) continue;
    if (/^~\/.*\(\d+%\).*\$\d/.test(trimmed)) continue;

    // Model/build status line (keep longer lines that contain real text)
    if (/^Build(?:\s+auto)?\s*·/.test(trimmed) && trimmed.length < 160) continue;

    // Lines that are mostly progress-bar or box-drawing characters
    const nonSpace = trimmed.replace(/\s/g, '');
    const bars = (nonSpace.match(OC_BAR_CHARS) || []).length;
    if (nonSpace.length >= 6 && bars / nonSpace.length >= 0.6) continue;

    // Pure borders / spinner-only lines
    if (/^[┃│╭╮╰╯─━═╹╻\s]+$/.test(trimmed)) continue;
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+$/.test(trimmed)) continue;

    out.push(line);
  }

  // Trim leading/trailing blank lines.
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();

  return out.join('\n');
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<WindowState[]>([]);
  const [screenSize, setScreenSize] = useState<ScreenSize | null>(null);
  const [content, setContent] = useState<string>('');
  const [command, setCommand] = useState('');
  const [selectedWinId, setSelectedWinId] = useState<string | null>(null);
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [keyboardMode, setKeyboardMode] = useState(false);
  const [scrollLocked, setScrollLocked] = useState(false);
  const scrollLockedRef = useRef(false);
  const lastPrimaryScrollRef = useRef(0);
  const lastSplitScrollRef = useRef(0);
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = Number(localStorage.getItem('iterm-font-size'));
    return Number.isFinite(saved) && saved >= 11 && saved <= 20 ? saved : 13;
  });
  const [cleanOpenCode, setCleanOpenCode] = useState<boolean>(
    () => localStorage.getItem('iterm-clean-oc') !== '0'
  );
  const [wrapLines, setWrapLines] = useState<boolean>(
    () => localStorage.getItem('iterm-wrap') !== '0'
  );
  const [broadcastMode, setBroadcastMode] = useState(false);
  const [broadcastTargets, setBroadcastTargets] = useState<Set<string>>(new Set());
  const [alertDone, setAlertDone] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [isLandscape, setIsLandscape] = useState(window.matchMedia('(orientation: landscape)').matches);
  const [splitMode, setSplitMode] = useState(false);
  const [splitSessionId, setSplitSessionId] = useState<string | null>(null);
  const [splitContent, setSplitContent] = useState<string>('');
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [focusedPane, setFocusedPane] = useState<'primary' | 'split'>('primary');
  const [splitWinId, setSplitWinId] = useState<string | null>(null);
  const [splitTabId, setSplitTabId] = useState<string | null>(null);
  const [showSplitMap, setShowSplitMap] = useState(false);
  const [historyView, setHistoryView] = useState<HistoryView | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const splitContentRef = useRef<HTMLDivElement>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const winIdRef = useRef(selectedWinId);
  const tabIdRef = useRef(selectedTabId);
  const prevFrontRef = useRef<string | null>(null);
  const historyRef = useRef<string[]>(loadHistory());
  const historyIdxRef = useRef(-1);
  const savedCommandRef = useRef('');
  const lastContentTimeRef = useRef(0);
  const contentChangingRef = useRef(false);
  const alertTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const contentCacheRef = useRef<Map<string, string>>(new Map());
  const lastBgFetchRef = useRef(0);
  const splitSessionIdRef = useRef(splitSessionId);
  const focusedPaneRef = useRef(focusedPane);
  const splitWinIdRef = useRef(splitWinId);
  const splitTabIdRef = useRef(splitTabId);
  // Scrollback / remote paging state
  const historyViewRef = useRef<HistoryView | null>(null);
  const historyLoadingRef = useRef(false);
  const historyAnchorRef = useRef<{ pane: 'primary' | 'split'; scrollTop: number; scrollHeight: number } | null>(null);
  const remotePageRef = useRef<{ primary: number; split: number }>({ primary: 0, split: 0 });
  // Pane waiting for a history probe: if it returns no extra scrollback, the
  // app is full-screen and the probe turns into a remote PageUp.
  const pageUpPendingRef = useRef<'primary' | 'split' | null>(null);
  const touchRef = useRef<{ pane: 'primary' | 'split'; lastY: number } | null>(null);
  const lastPageKeyRef = useRef(0);
  const liveContentRef = useRef('');
  const liveSplitContentRef = useRef('');

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { winIdRef.current = selectedWinId; }, [selectedWinId]);
  useEffect(() => { tabIdRef.current = selectedTabId; }, [selectedTabId]);
  useEffect(() => { splitSessionIdRef.current = splitSessionId; }, [splitSessionId]);
  useEffect(() => { focusedPaneRef.current = focusedPane; }, [focusedPane]);
  useEffect(() => { splitWinIdRef.current = splitWinId; }, [splitWinId]);
  useEffect(() => { splitTabIdRef.current = splitTabId; }, [splitTabId]);
  useEffect(() => { historyViewRef.current = historyView; }, [historyView]);
  useEffect(() => { liveContentRef.current = content; }, [content]);
  useEffect(() => { liveSplitContentRef.current = splitContent; }, [splitContent]);
  // Leaving a tab/session discards the frozen scrollback view and page counter.
  useEffect(() => {
    setHistoryView(null);
    remotePageRef.current = { primary: 0, split: 0 };
  }, [selectedWinId, selectedTabId, splitSessionId]);
  useEffect(() => { localStorage.setItem('iterm-font-size', String(fontSize)); }, [fontSize]);
  useEffect(() => { localStorage.setItem('iterm-clean-oc', cleanOpenCode ? '1' : '0'); }, [cleanOpenCode]);
  useEffect(() => { localStorage.setItem('iterm-wrap', wrapLines ? '1' : '0'); }, [wrapLines]);

  // Colorized terminal lines (memoized).
  // When scrolled into history, the frozen buffer replaces the live tail.
  const primarySource = historyView?.pane === 'primary' ? historyView.content : content;
  const splitSource = historyView?.pane === 'split' ? historyView.content : splitContent;
  const displayContent = useMemo(
    () => cleanOpenCode ? cleanOpenCodeOutput(primarySource) : primarySource,
    [primarySource, cleanOpenCode]
  );
  const displaySplitContent = useMemo(
    () => cleanOpenCode ? cleanOpenCodeOutput(splitSource) : splitSource,
    [splitSource, cleanOpenCode]
  );
  const coloredLines = useMemo(() => colorizeLines(displayContent), [displayContent]);
  const splitColoredLines = useMemo(() => colorizeLines(displaySplitContent), [displaySplitContent]);

  // --- Socket init ---
  useEffect(() => {
    const s = io(SOCKET_URL, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    socketRef.current = s;

    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));

    // Measure latency every 5s (+ immediately on connect)
    let pingInterval: ReturnType<typeof setInterval>;
    const doPing = () => {
      const start = Date.now();
      s.volatile.emit('ping', () => setLatency(Date.now() - start));
    };
    s.on('connect', () => {
      doPing();
      pingInterval = setInterval(doPing, 5000);
    });
    s.on('disconnect', () => clearInterval(pingInterval));
    s.on('screenSize', (size: ScreenSize) => setScreenSize(size));

    s.on('state', (newState: WindowState[]) => {
      setState(newState);
      if (newState.length === 0) return;

      const frontWin = newState.find(w => w.isFront);

      // First load — pick front window
      if (!winIdRef.current) {
        const win = frontWin || newState[0];
        setSelectedWinId(win.id);
        const tab = getSelectedTab(win);
        if (tab) setSelectedTabId(tab.id);
        prevFrontRef.current = frontWin?.id || null;
      }
      // Front window changed on Mac — follow it
      else if (frontWin && frontWin.id !== prevFrontRef.current) {
        prevFrontRef.current = frontWin.id;
        setSelectedWinId(frontWin.id);
        const tab = getSelectedTab(frontWin);
        if (tab) setSelectedTabId(tab.id);
      }
      // Same window — sync tab if Mac switched it
      else {
        const win = newState.find(w => w.id === winIdRef.current);
        if (win) {
          const macTab = win.tabs.find(t => t.isSelected);
          if (macTab && macTab.id !== tabIdRef.current) {
            setSelectedTabId(macTab.id);
          }
          if (!win.tabs.find(t => t.id === tabIdRef.current)) {
            const fb = getSelectedTab(win);
            if (fb) setSelectedTabId(fb.id);
          }
        }
      }

      // Refresh content for ALL background sessions across ALL windows (throttled to every 3s)
      if (Date.now() - lastBgFetchRef.current > 3000) {
        const activeTab = (newState.find(w => w.id === winIdRef.current) || newState[0])
          ?.tabs.find(t => t.id === tabIdRef.current);
        const activeSid = activeTab?.sessions[0]?.id;
        const bgIds = newState
          .flatMap(w => w.tabs.map(t => t.sessions[0]?.id))
          .filter((sid): sid is string => !!sid && sid !== activeSid);
        if (bgIds.length > 0) {
          lastBgFetchRef.current = Date.now();
          s.emit('getAllContent', { sessionIds: bgIds });
        }
      }
    });

    s.on('content', (data: { sessionId?: string; content: string }) => {
      if (data.sessionId) {
        contentCacheRef.current.set(data.sessionId, data.content);
        // Update split pane if this is the split session
        if (data.sessionId === splitSessionIdRef.current) {
          setSplitContent(data.content);
        }
        // Only update main content if this is for the active session
        const activeWin = stateRef.current.find(w => w.id === winIdRef.current);
        const activeTab = activeWin?.tabs.find(t => t.id === tabIdRef.current);
        const activeSid = activeTab?.sessions[0]?.id;
        if (data.sessionId !== activeSid) return;
      }
      setContent(data.content);
      // Track content changes for long-running command alerts
      lastContentTimeRef.current = Date.now();
      contentChangingRef.current = true;
    });

    // Full scrollback, requested when the user scrolls up past the live tail.
    s.on('history', (data: { sessionId?: string; content: string }) => {
      historyLoadingRef.current = false;
      if (!data.sessionId || !data.content) return;

      const activeWin = stateRef.current.find(w => w.id === winIdRef.current);
      const activeTab = activeWin?.tabs.find(t => t.id === tabIdRef.current);
      const primarySid = activeTab?.sessions[0]?.id;
      const pane: 'primary' | 'split' | null =
        data.sessionId === primarySid ? 'primary'
          : data.sessionId === splitSessionIdRef.current ? 'split'
            : null;
      if (!pane) return;

      const live = pane === 'primary' ? liveContentRef.current : liveSplitContentRef.current;
      // Full-screen TUIs have no scrollback, so this returns the same screen.
      // In that case page the app itself (PageUp) instead of freezing the view,
      // because the redraw of the older page must stay visible.
      if (data.content.length < live.length + 400) {
        if (pageUpPendingRef.current === pane) {
          pageUpPendingRef.current = null;
          pageRemote(pane, 'up');
        }
        return;
      }
      pageUpPendingRef.current = null;

      const el = pane === 'primary' ? contentRef.current : splitContentRef.current;
      historyAnchorRef.current = el
        ? { pane, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
        : null;
      setHistoryView({ pane, sessionId: data.sessionId, content: data.content });
    });

    return () => { s.disconnect(); };
  }, []);

  // Keep screen awake
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    const request = async () => {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
    };
    request();
    const onVisibility = () => { if (document.visibilityState === 'visible') request(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      wakeLock?.release();
    };
  }, []);

  // Track orientation
  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape)');
    const handler = (e: MediaQueryListEvent) => setIsLandscape(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Auto-scroll terminal to bottom (unless scroll-locked or browsing history).
  // Update the last-known scroll position so the next scroll event can tell
  // an auto-scroll (down) from a real user drag (up).
  useEffect(() => {
    if (scrollLockedRef.current || historyViewRef.current) return;
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
      lastPrimaryScrollRef.current = contentRef.current.scrollTop;
    }
    if (splitContentRef.current) {
      splitContentRef.current.scrollTop = splitContentRef.current.scrollHeight;
      lastSplitScrollRef.current = splitContentRef.current.scrollTop;
    }
  }, [content, splitContent, scrollLocked, historyView]);

  // Keep the viewport steady when older scrollback is prepended.
  useLayoutEffect(() => {
    if (!historyView) return;
    const anchor = historyAnchorRef.current;
    if (!anchor || anchor.pane !== historyView.pane) return;
    const el = historyView.pane === 'primary' ? contentRef.current : splitContentRef.current;
    if (el) el.scrollTop = el.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
    historyAnchorRef.current = null;
  }, [historyView]);

  // Pause auto-scroll as soon as the user drags up; resume when back at the bottom.
  const handleTerminalScroll = (pane: 'primary' | 'split') => {
    const el = pane === 'primary' ? contentRef.current : splitContentRef.current;
    if (!el) return;
    const lastRef = pane === 'primary' ? lastPrimaryScrollRef : lastSplitScrollRef;
    const scrollTop = el.scrollTop;
    const delta = scrollTop - lastRef.current;
    lastRef.current = scrollTop;
    const distanceFromBottom = el.scrollHeight - scrollTop - el.clientHeight;
    let next = scrollLockedRef.current;
    if (delta < -2 && distanceFromBottom > 24) next = true;
    else if (distanceFromBottom < 8 && delta > 0) next = false;

    // Reaching the bottom of a frozen history view resumes the live tail.
    if (distanceFromBottom < 8 && delta > 0 && historyViewRef.current) {
      historyViewRef.current = null;
      setHistoryView(null);
    }

    if (next !== scrollLockedRef.current) {
      scrollLockedRef.current = next;
      setScrollLocked(next);
    }
  };

  // Long-running command alert: if content was changing and stops for 4s, vibrate
  useEffect(() => {
    if (!alertDone) return;
    if (alertTimerRef.current) clearInterval(alertTimerRef.current);

    alertTimerRef.current = setInterval(() => {
      if (contentChangingRef.current && Date.now() - lastContentTimeRef.current > 4000) {
        contentChangingRef.current = false;
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      }
    }, 1000);

    return () => { if (alertTimerRef.current) clearInterval(alertTimerRef.current); };
  }, [alertDone]);

  // --- Helpers ---
  const getPrimarySessionId = () => {
    const win = stateRef.current.find(w => w.id === winIdRef.current);
    const tab = win?.tabs.find(t => t.id === tabIdRef.current);
    return tab?.sessions[0]?.id;
  };

  const getActiveSessionId = () => {
    if (focusedPaneRef.current === 'split' && splitSessionIdRef.current) {
      return splitSessionIdRef.current;
    }
    return getPrimarySessionId();
  };

  // Fetch the full scrollback buffer for a pane. Only applied when it actually
  // adds older lines (regular shells); full-screen TUIs return the live screen.
  // `probe` means "if there is no scrollback, page the app itself instead".
  const requestHistory = (pane: 'primary' | 'split', probe = false) => {
    if (historyLoadingRef.current) return;
    const sid = pane === 'primary' ? getPrimarySessionId() : splitSessionIdRef.current;
    if (!sid) return;
    historyLoadingRef.current = true;
    pageUpPendingRef.current = probe ? pane : null;
    socketRef.current?.emit('getHistory', { sessionId: sid });
    // Never leave the loader stuck if the server does not answer.
    setTimeout(() => { historyLoadingRef.current = false; }, 5000);
  };

  // Send PageUp/PageDown to the session itself. This is what makes old
  // messages reachable inside full-screen apps (OpenCode, vim, less, tmux)
  // which draw their own viewport and have no terminal scrollback.
  const pageRemote = (pane: 'primary' | 'split', dir: 'up' | 'down', count = 1) => {
    const sid = pane === 'primary' ? getPrimarySessionId() : splitSessionIdRef.current;
    if (!sid || !socketRef.current) return;
    const keys = dir === 'up' ? '\\x1b[5~' : '\\x1b[6~';
    socketRef.current.emit('sendControl', { sessionId: sid, keys, repeat: count });

    const pages = remotePageRef.current;
    pages[pane] = dir === 'up'
      ? Math.min(pages[pane] + count, 200)
      : Math.max(0, pages[pane] - count);

    if (dir === 'up') {
      // Keep the newly revealed page in place instead of snapping to bottom.
      scrollLockedRef.current = true;
      setScrollLocked(true);
    } else if (pages[pane] === 0) {
      scrollLockedRef.current = false;
      setScrollLocked(false);
    }
  };

  // Swipe down at the top = older messages; swipe up at the bottom = newer.
  const handlePaneTouchStart = (pane: 'primary' | 'split', e: React.TouchEvent) => {
    touchRef.current = { pane, lastY: e.touches[0].clientY };
  };

  const handlePaneTouchMove = (pane: 'primary' | 'split', e: React.TouchEvent) => {
    const ref = touchRef.current;
    if (!ref || ref.pane !== pane) return;
    const y = e.touches[0].clientY;
    const dy = y - ref.lastY;
    if (Math.abs(dy) < 8) return;
    ref.lastY = y;

    const el = pane === 'primary' ? contentRef.current : splitContentRef.current;
    if (!el) return;

    const atTop = el.scrollTop <= 2;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    const now = Date.now();

    if (dy > 0 && atTop) {
      // Dragging down past the top: load local scrollback. If the session has
      // none (full-screen TUI), the same probe pages the app instead.
      if (!historyViewRef.current && now - lastPageKeyRef.current > 220) {
        lastPageKeyRef.current = now;
        requestHistory(pane, true);
      }
    } else if (dy < 0 && atBottom) {
      // Only page down when we actually paged up, so shells never see stray keys.
      if (remotePageRef.current[pane] > 0 && now - lastPageKeyRef.current > 220) {
        lastPageKeyRef.current = now;
        pageRemote(pane, 'down');
      }
    }
  };

  // --- Handlers ---
  const handleSend = () => {
    if (!command.trim() || !socketRef.current) return;
    // Save to history
    const h = historyRef.current;
    if (h[h.length - 1] !== command.trim()) h.push(command.trim());
    saveHistory(h);
    historyIdxRef.current = -1;
    savedCommandRef.current = '';

    if (broadcastMode && broadcastTargets.size > 0) {
      // Broadcast to all selected windows' active sessions
      const sessionIds: string[] = [];
      for (const winId of broadcastTargets) {
        const win = stateRef.current.find(w => w.id === winId);
        const tab = getSelectedTab(win);
        const sid = tab?.sessions[0]?.id;
        if (sid) sessionIds.push(sid);
      }
      socketRef.current.emit('broadcast', { command, sessionIds });
    } else {
      socketRef.current.emit('execute', { sessionId: getActiveSessionId(), command });
    }
    // Mark content as "about to change" for alert detection
    contentChangingRef.current = true;
    lastContentTimeRef.current = Date.now();
    setCommand('');
  };

  const handleHistoryNav = (dir: 'up' | 'down') => {
    const h = historyRef.current;
    if (h.length === 0) return;
    if (dir === 'up') {
      if (historyIdxRef.current === -1) savedCommandRef.current = command;
      const next = historyIdxRef.current === -1 ? h.length - 1 : Math.max(0, historyIdxRef.current - 1);
      historyIdxRef.current = next;
      setCommand(h[next]);
    } else {
      if (historyIdxRef.current === -1) return;
      const next = historyIdxRef.current + 1;
      if (next >= h.length) {
        historyIdxRef.current = -1;
        setCommand(savedCommandRef.current);
      } else {
        historyIdxRef.current = next;
        setCommand(h[next]);
      }
    }
  };

  const toggleBroadcastTarget = (winId: string) => {
    setBroadcastTargets(prev => {
      const next = new Set(prev);
      if (next.has(winId)) next.delete(winId); else next.add(winId);
      return next;
    });
  };

  const handleTabClick = (winId: string, tab: Tab) => {
    if (focusedPane === 'split') {
      setSplitWinId(winId);
      setSplitTabId(tab.id);
      const sid = tab.sessions[0]?.id;
      if (sid) {
        setSplitSessionId(sid);
        const cached = contentCacheRef.current.get(sid);
        if (cached) setSplitContent(cached);
        socketRef.current?.emit('getContent', { sessionId: sid });
      }
    } else {
      setSelectedWinId(winId);
      setSelectedTabId(tab.id);
      const sid = tab.sessions[0]?.id;
      if (sid) {
        const cached = contentCacheRef.current.get(sid);
        if (cached) setContent(cached);
        socketRef.current?.emit('getContent', { sessionId: sid });
      }
      socketRef.current?.emit('focus', { windowId: winId, tabIndex: tab.index });
    }
  };

  const handleWindowChange = (winId: string) => {
    if (focusedPane === 'split') {
      setSplitWinId(winId);
      setShowMap(false);
      const win = state.find(w => w.id === winId);
      const tab = getSelectedTab(win);
      if (tab) {
        setSplitTabId(tab.id);
        const sid = tab.sessions[0]?.id;
        if (sid) {
          setSplitSessionId(sid);
          const cached = contentCacheRef.current.get(sid);
          if (cached) setSplitContent(cached);
          socketRef.current?.emit('getContent', { sessionId: sid });
        }
      }
    } else {
      setSelectedWinId(winId);
      setShowMap(false);
      const win = state.find(w => w.id === winId);
      const tab = getSelectedTab(win);
      if (tab) {
        setSelectedTabId(tab.id);
        const sid = tab.sessions[0]?.id;
        if (sid) {
          const cached = contentCacheRef.current.get(sid);
          if (cached) setContent(cached);
          socketRef.current?.emit('getContent', { sessionId: sid });
        }
        socketRef.current?.emit('focus', { windowId: winId, tabIndex: tab.index });
      }
    }
  };

  const handleNewTab = () => socketRef.current?.emit('newTab');
  const handleCloseTab = () => socketRef.current?.emit('closeTab');

  const handleSplitWindowChange = (winId: string) => {
    setSplitWinId(winId);
    setShowSplitMap(false);
    const win = state.find(w => w.id === winId);
    const tab = getSelectedTab(win);
    if (tab) {
      setSplitTabId(tab.id);
      const sid = tab.sessions[0]?.id;
      if (sid) {
        setSplitSessionId(sid);
        setSplitContent(contentCacheRef.current.get(sid) || '');
        socketRef.current?.emit('getContent', { sessionId: sid });
      }
    }
    setFocusedPane('split');
  };

  const handleSplitTabClick = (tab: Tab) => {
    setSplitTabId(tab.id);
    const sid = tab.sessions[0]?.id;
    if (sid) {
      setSplitSessionId(sid);
      const cached = contentCacheRef.current.get(sid);
      if (cached) setSplitContent(cached);
      socketRef.current?.emit('getContent', { sessionId: sid });
    }
    setFocusedPane('split');
  };

  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleTabLongPress = (tab: Tab) => {
    const sid = tab.sessions[0]?.id;
    if (!sid) return;
    const name = prompt('Rename tab:', tab.sessions[0]?.name || '');
    if (name !== null && name.trim()) {
      socketRef.current?.emit('renameSession', { sessionId: sid, name: name.trim() });
    }
  };

  const sendSpecialKey = (keys: string) => {
    // Control keys must reach the pty as real bytes ("\x1b", "\x03", ...),
    // not as literal backslash text; the server decodes the escapes.
    socketRef.current?.emit('sendControl', { sessionId: getActiveSessionId(), keys });
  };

  const cycleFontSize = () => {
    const idx = FONT_SIZES.indexOf(fontSize);
    setFontSize(FONT_SIZES[(idx + 1) % FONT_SIZES.length]);
  };

  const jumpToBottom = () => {
    // Return paginated TUIs to their latest page in one round-trip.
    const pane = focusedPaneRef.current;
    const pending = remotePageRef.current[pane];
    if (pending > 0) {
      pageRemote(pane, 'down', pending);
    }
    remotePageRef.current[pane] = 0;
    historyViewRef.current = null;
    setHistoryView(null);
    scrollLockedRef.current = false;
    setScrollLocked(false);
    if (contentRef.current) contentRef.current.scrollTop = contentRef.current.scrollHeight;
    if (splitContentRef.current) splitContentRef.current.scrollTop = splitContentRef.current.scrollHeight;
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) socketRef.current?.emit('sendKeys', { sessionId: getActiveSessionId(), keys: text });
    } catch {}
  };

  const handleSplitDrag = (e: React.TouchEvent) => {
    const container = splitContainerRef.current;
    if (!container) return;
    const touch = e.touches[0];
    const rect = container.getBoundingClientRect();
    let ratio: number;
    if (isLandscape) {
      ratio = (touch.clientX - rect.left) / rect.width;
    } else {
      ratio = (touch.clientY - rect.top) / rect.height;
    }
    setSplitRatio(Math.min(0.8, Math.max(0.2, ratio)));
  };

  const handleCopy = async () => {
    try {
      const text = focusedPane === 'split' ? displaySplitContent : displayContent;
      await navigator.clipboard.writeText(text);
    } catch {}
  };

  const activeWindow = state.find(w => w.id === selectedWinId);
  const splitWindow = state.find(w => w.id === splitWinId);
  const tabBarWindow = (splitMode && focusedPane === 'split') ? splitWindow : activeWindow;
  const tabBarSelectedTabId = (splitMode && focusedPane === 'split') ? splitTabId : selectedTabId;
  const tabCount = tabBarWindow?.tabs.length || 0;
  const splitTabCount = splitWindow?.tabs.length || 0;

  // All other sessions for split picker (exclude current active)
  const allSessions = useMemo(() => {
    const activeTab = activeWindow?.tabs.find(t => t.id === selectedTabId);
    const activeSid = activeTab?.sessions[0]?.id;
    return state.flatMap(w => w.tabs.map(t => ({
      sessionId: t.sessions[0]?.id,
      name: t.sessions[0]?.name || `Tab ${t.index}`,
    }))).filter(s => s.sessionId && s.sessionId !== activeSid);
  }, [state, activeWindow, selectedTabId]);

  return (
    <div className="flex flex-col bg-[#0a0a0a] font-mono overflow-hidden select-none relative pt-safe pb-safe-root pl-safe pr-safe" style={{ height: '100dvh' }}>

      {/* ── Reconnect Overlay ── */}
      {!connected && (
        <div
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3"
          style={{ backgroundColor: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        >
          <WifiOff className="w-8 h-8 text-red-400 animate-pulse" />
          <span className="text-[13px] font-bold tracking-[0.15em] text-zinc-400">RECONNECTING</span>
          <div className="flex gap-1 mt-1">
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        </div>
      )}

      {/* ── Top Bar ── */}
      <div className={`flex items-center justify-between bg-zinc-900/80 border-b border-zinc-800 z-50 flex-shrink-0 ${isLandscape ? 'px-2 h-8' : 'px-4 h-11'}`}>
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: connected ? '#34d399' : '#ef4444' }}
            />
            {connected && (
              <div className="absolute inset-0 w-2 h-2 rounded-full bg-emerald-400 animate-ping opacity-25" />
            )}
          </div>
          <span className="text-[11px] font-bold tracking-[0.2em] text-zinc-500">iTERM</span>
          {connected && latency !== null && (
            <span
              className="text-[10px] font-bold tabular-nums"
              style={{ color: latency < 50 ? '#34d399' : latency < 150 ? '#fbbf24' : '#f87171' }}
            >
              {latency}ms
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Alert toggle */}
          <button
            onClick={() => setAlertDone(!alertDone)}
            className={`flex flex-col items-center gap-0.5 rounded-md border transition-all active:scale-95 ${isLandscape ? 'p-1' : 'p-1.5'}`}
            style={{
              color: alertDone ? '#fbbf24' : '#52525b',
              borderColor: alertDone ? '#fbbf2440' : '#3f3f46',
              backgroundColor: alertDone ? '#fbbf2415' : 'transparent',
            }}
          >
            <Bell className={isLandscape ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
            {!isLandscape && alertDone && <span className="text-[7px] font-bold leading-none tracking-wider">ALERT</span>}
          </button>
          {/* Scroll lock */}
          <button
            onClick={() => {
              const next = !scrollLockedRef.current;
              scrollLockedRef.current = next;
              setScrollLocked(next);
            }}
            className={`flex flex-col items-center gap-0.5 rounded-md border transition-all active:scale-95 ${isLandscape ? 'p-1' : 'p-1.5'}`}
            style={{
              color: scrollLocked ? '#f87171' : '#52525b',
              borderColor: scrollLocked ? '#f8717140' : '#3f3f46',
              backgroundColor: scrollLocked ? '#f8717115' : 'transparent',
            }}
          >
            {scrollLocked ? <Lock className={isLandscape ? 'w-3 h-3' : 'w-3.5 h-3.5'} /> : <Unlock className={isLandscape ? 'w-3 h-3' : 'w-3.5 h-3.5'} />}
            {!isLandscape && scrollLocked && <span className="text-[7px] font-bold leading-none tracking-wider">SCROLL</span>}
          </button>
          {/* Broadcast mode */}
          <button
            onClick={() => {
              if (broadcastMode) { setBroadcastMode(false); setBroadcastTargets(new Set()); }
              else { setBroadcastMode(true); setBroadcastTargets(new Set(state.map(w => w.id))); }
            }}
            className={`flex flex-col items-center gap-0.5 rounded-md border transition-all active:scale-95 ${isLandscape ? 'p-1' : 'p-1.5'}`}
            style={{
              color: broadcastMode ? BROADCAST_COLOR : '#52525b',
              borderColor: broadcastMode ? BROADCAST_COLOR + '50' : '#3f3f46',
              backgroundColor: broadcastMode ? BROADCAST_COLOR + '15' : 'transparent',
            }}
          >
            <Radio className={isLandscape ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
            {!isLandscape && broadcastMode && <span className="text-[7px] font-bold leading-none tracking-wider">CAST</span>}
          </button>
          {/* Split pane toggle */}
          <button
            onClick={() => {
              if (splitMode) { setSplitMode(false); setSplitSessionId(null); setSplitContent(''); setFocusedPane('primary'); setSplitWinId(null); setSplitTabId(null); }
              else if (allSessions.length > 0) {
                // Find the first session that's not the primary active one
                const firstOther = allSessions[0];
                const sid = firstOther.sessionId!;
                // Find which window/tab owns this session
                let foundWin: string | null = null;
                let foundTab: string | null = null;
                for (const w of state) {
                  for (const t of w.tabs) {
                    if (t.sessions[0]?.id === sid) { foundWin = w.id; foundTab = t.id; break; }
                  }
                  if (foundWin) break;
                }
                setSplitMode(true);
                setSplitSessionId(sid);
                setSplitWinId(foundWin);
                setSplitTabId(foundTab);
                setSplitContent(contentCacheRef.current.get(sid) || '');
                socketRef.current?.emit('getContent', { sessionId: sid });
              }
            }}
            className={`flex flex-col items-center gap-0.5 rounded-md border transition-all active:scale-95 ${isLandscape ? 'p-1' : 'p-1.5'}`}
            style={{
              color: splitMode ? '#38bdf8' : '#52525b',
              borderColor: splitMode ? '#38bdf840' : '#3f3f46',
              backgroundColor: splitMode ? '#38bdf815' : 'transparent',
              opacity: allSessions.length === 0 && !splitMode ? 0.3 : 1,
            }}
          >
            <Columns2 className={isLandscape ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
            {!isLandscape && splitMode && <span className="text-[7px] font-bold leading-none tracking-wider">SPLIT</span>}
          </button>
          <button
            onClick={() => state.length > 1 && screenSize && setShowMap(!showMap)}
            className="text-[10px] font-bold tracking-wide px-2.5 py-1 rounded-md border transition-all active:scale-95"
            style={{
              color: showMap ? '#000' : '#71717a',
              backgroundColor: showMap ? ACCENT : 'transparent',
              borderColor: showMap ? ACCENT : '#3f3f46',
              opacity: state.length <= 1 ? 0.3 : 1,
            }}
          >
            {state.length} win
          </button>
        </div>
      </div>

      {/* ── Window Map (fullscreen overlay) ── */}
      {showMap && state.length > 1 && screenSize && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center"
          onClick={() => setShowMap(false)}
          style={{ backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
        >
          <span className="text-[11px] font-bold tracking-[0.2em] text-zinc-500 mb-4">
            {broadcastMode ? 'SELECT BROADCAST TARGETS' : 'SELECT WINDOW'}
          </span>
          <div
            className="relative rounded-xl bg-zinc-800/20 border border-zinc-700/30 overflow-hidden w-[85vw]"
            onClick={(e) => e.stopPropagation()}
            style={{
              aspectRatio: `${screenSize.width} / ${screenSize.height}`,
              maxHeight: '45vh',
            }}
          >
            {state.map((win, idx) => {
              if (!win.bounds) return null;
              const isSelected = broadcastMode ? broadcastTargets.has(win.id) : win.id === selectedWinId;
              return (
                <button
                  key={win.id}
                  onClick={() => broadcastMode ? toggleBroadcastTarget(win.id) : handleWindowChange(win.id)}
                  className="absolute rounded-[4px] border transition-all active:opacity-70 flex items-center justify-center"
                  style={{
                    left: `${(win.bounds.x / screenSize.width) * 100}%`,
                    top: `${(win.bounds.y / screenSize.height) * 100}%`,
                    width: `${(win.bounds.w / screenSize.width) * 100}%`,
                    height: `${(win.bounds.h / screenSize.height) * 100}%`,
                    backgroundColor: isSelected ? (broadcastMode ? BROADCAST_COLOR + '25' : ACCENT + '25') : 'rgba(39,39,42,0.5)',
                    borderColor: isSelected ? (broadcastMode ? BROADCAST_COLOR : ACCENT) : '#3f3f46',
                    borderWidth: isSelected ? '2px' : '1px',
                    boxShadow: isSelected ? `0 0 16px ${broadcastMode ? 'rgba(129,140,248,0.25)' : GLOW}` : 'none',
                  }}
                >
                  <span
                    className="font-bold leading-none"
                    style={{ color: isSelected ? (broadcastMode ? BROADCAST_COLOR : ACCENT) : '#71717a', fontSize: '14px' }}
                  >
                    {idx + 1}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Split Window Map (fullscreen overlay) ── */}
      {showSplitMap && state.length > 1 && screenSize && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center"
          onClick={() => setShowSplitMap(false)}
          style={{ backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
        >
          <span className="text-[11px] font-bold tracking-[0.2em] text-zinc-500 mb-4">
            SELECT SPLIT WINDOW
          </span>
          <div
            className="relative rounded-xl bg-zinc-800/20 border border-zinc-700/30 overflow-hidden w-[85vw]"
            onClick={(e) => e.stopPropagation()}
            style={{
              aspectRatio: `${screenSize.width} / ${screenSize.height}`,
              maxHeight: '45vh',
            }}
          >
            {state.map((win, idx) => {
              if (!win.bounds) return null;
              const isSelected = win.id === splitWinId;
              return (
                <button
                  key={win.id}
                  onClick={() => handleSplitWindowChange(win.id)}
                  className="absolute rounded-[4px] border transition-all active:opacity-70 flex items-center justify-center"
                  style={{
                    left: `${(win.bounds.x / screenSize.width) * 100}%`,
                    top: `${(win.bounds.y / screenSize.height) * 100}%`,
                    width: `${(win.bounds.w / screenSize.width) * 100}%`,
                    height: `${(win.bounds.h / screenSize.height) * 100}%`,
                    backgroundColor: isSelected ? '#38bdf825' : 'rgba(39,39,42,0.5)',
                    borderColor: isSelected ? '#38bdf8' : '#3f3f46',
                    borderWidth: isSelected ? '2px' : '1px',
                    boxShadow: isSelected ? '0 0 16px rgba(56,189,248,0.25)' : 'none',
                  }}
                >
                  <span
                    className="font-bold leading-none"
                    style={{ color: isSelected ? '#38bdf8' : '#71717a', fontSize: '14px' }}
                  >
                    {idx + 1}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Tab Bar ── */}
      <div className="flex items-center bg-[#0f0f0f] border-b border-zinc-800/60 flex-shrink-0">
        <div className="flex items-center flex-1 min-w-0 overflow-x-auto no-scrollbar">
        {tabBarWindow?.tabs.map((tab) => {
          const isActive = tabBarSelectedTabId === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tabBarWindow.id, tab)}
              onTouchStart={() => { longPressRef.current = setTimeout(() => handleTabLongPress(tab), 500); }}
              onTouchEnd={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
              onTouchMove={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
              className={`flex items-center gap-2 text-[11px] tracking-wider transition-all relative flex-shrink-0 active:opacity-70 ${isLandscape ? 'px-3 min-h-[32px]' : 'px-5 min-h-[44px]'}`}
              style={{
                color: isActive ? (splitMode && focusedPane === 'split' ? '#38bdf8' : ACCENT) : '#52525b',
                backgroundColor: isActive ? (splitMode && focusedPane === 'split' ? '#38bdf810' : ACCENT + '10') : 'transparent',
              }}
            >
              {isActive && (
                <div
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: splitMode && focusedPane === 'split' ? '#38bdf8' : ACCENT }}
                />
              )}
              <span
                className="font-semibold whitespace-nowrap max-w-[120px] truncate"
                title={tab.sessions[0]?.name || `Tab ${tab.index}`}
              >
                {tab.sessions[0]?.name || `Tab ${tab.index}`}
              </span>
              {isActive && (
                <div
                  className="absolute bottom-0 left-3 right-3 h-[2px] rounded-full"
                  style={{ backgroundColor: splitMode && focusedPane === 'split' ? '#38bdf8' : ACCENT }}
                />
              )}
            </button>
          );
        })}
        </div>

        <div className="flex items-center flex-shrink-0 border-l border-zinc-800/60">
          <span className="text-[10px] text-zinc-600 font-bold px-2.5 tabular-nums">
            {tabCount}
          </span>
          <button
            onClick={handleCloseTab}
            disabled={tabCount <= 1}
            className={`flex items-center justify-center w-11 text-zinc-600 active:text-red-400 transition-colors disabled:opacity-20 ${isLandscape ? 'min-h-[32px]' : 'min-h-[44px]'}`}
          >
            <X className="w-4 h-4" />
          </button>
          <button
            onClick={handleNewTab}
            className={`flex items-center justify-center w-11 text-zinc-600 active:text-zinc-400 transition-colors ${isLandscape ? 'min-h-[32px]' : 'min-h-[44px]'}`}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Broadcast indicator ── */}
      {broadcastMode && (
        <div
          className="flex items-center gap-2 px-4 py-1.5 flex-shrink-0"
          style={{ backgroundColor: BROADCAST_COLOR + '10', borderBottom: `1px solid ${BROADCAST_COLOR}30` }}
        >
          <Radio className="w-3 h-3 text-indigo-400" />
          <span className="text-[10px] text-indigo-400 font-bold tracking-wider">
            BROADCAST TO {broadcastTargets.size} WINDOW{broadcastTargets.size !== 1 ? 'S' : ''}
          </span>
          <button
            onClick={() => setShowMap(true)}
            className="text-[10px] text-indigo-300/60 font-bold ml-auto active:text-indigo-300"
          >
            EDIT
          </button>
        </div>
      )}

      {/* ── Terminal Content (colorized) ── */}
      <div
        ref={splitContainerRef}
        className={`flex-1 overflow-hidden flex min-h-0 min-w-0 ${splitMode ? (isLandscape ? 'flex-row' : 'flex-col') : 'flex-col'}`}
      >
        {/* Primary pane */}
        <div
          ref={contentRef}
          className="overflow-auto relative min-h-0 min-w-0"
          onClick={() => splitMode && setFocusedPane('primary')}
          onScroll={() => handleTerminalScroll('primary')}
          onTouchStart={(e) => handlePaneTouchStart('primary', e)}
          onTouchMove={(e) => handlePaneTouchMove('primary', e)}
          style={{
            WebkitOverflowScrolling: 'touch',
            touchAction: wrapLines ? 'pan-y' : 'pan-x pan-y',
            overscrollBehavior: 'contain',
            borderLeft: `3px solid ${splitMode && focusedPane === 'primary' ? ACCENT : ACCENT + '30'}`,
            ...(splitMode
              ? isLandscape
                ? { width: `${splitRatio * 100}%`, flexShrink: 0 }
                : { height: `${splitRatio * 100}%`, flexShrink: 0 }
              : { flex: 1 }),
          }}
        >
          {displayContent ? (
            <pre
  className={`p-3 ${wrapLines ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}
  style={{
    fontSize: `${fontSize}px`,
    lineHeight: 1.6,
    ...(wrapLines ? {} : { minWidth: 'max-content' }),
  }}
>
              {coloredLines.map((line, i) => (
                <span key={i}>
                  <span style={{ color: line.color, fontWeight: line.bold ? 600 : 400 }}>
                    {line.text}
                  </span>
                  {i < coloredLines.length - 1 ? '\n' : ''}
                </span>
              ))}
              {focusedPane === 'primary' && <span className="cursor-blink" style={{ color: ACCENT }}>█</span>}
            </pre>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <Clock className="w-5 h-5 text-zinc-700 animate-pulse" />
              <span className="text-[11px] text-zinc-700 tracking-wider">WAITING FOR OUTPUT</span>
            </div>
          )}
        </div>

        {/* Drag divider */}
        {splitMode && (
          <div
            className={`flex-shrink-0 flex items-center justify-center touch-none ${isLandscape ? 'w-3 cursor-col-resize' : 'h-3 cursor-row-resize'}`}
            style={{ backgroundColor: '#18181b' }}
            onTouchMove={handleSplitDrag}
          >
            <div
              className={`rounded-full bg-zinc-600 ${isLandscape ? 'w-1 h-8' : 'h-1 w-8'}`}
            />
          </div>
        )}

        {/* Split pane */}
        {splitMode && (
          <div
            className="flex-1 flex flex-col min-h-0 min-w-0"
            onClick={() => setFocusedPane('split')}
          >
            {/* Split pane tab bar */}
            <div className="flex items-center bg-[#0f0f0f] border-b border-zinc-800/60 flex-shrink-0">
              <div className="flex items-center flex-1 min-w-0 overflow-x-auto no-scrollbar">
              {splitWindow?.tabs.map((tab) => {
                const isActive = splitTabId === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={(e) => { e.stopPropagation(); handleSplitTabClick(tab); }}
                    onTouchStart={() => { longPressRef.current = setTimeout(() => handleTabLongPress(tab), 500); }}
                    onTouchEnd={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
                    onTouchMove={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
                    className={`flex items-center gap-2 text-[10px] tracking-wider transition-all relative flex-shrink-0 active:opacity-70 px-3 min-h-[30px]`}
                    style={{
                      color: isActive ? '#38bdf8' : '#52525b',
                      backgroundColor: isActive ? '#38bdf810' : 'transparent',
                    }}
                  >
                    {isActive && (
                      <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: '#38bdf8' }} />
                    )}
                    <span
                      className="font-semibold whitespace-nowrap max-w-[100px] truncate"
                      title={tab.sessions[0]?.name || `Tab ${tab.index}`}
                    >
                      {tab.sessions[0]?.name || `Tab ${tab.index}`}
                    </span>
                    {isActive && (
                      <div className="absolute bottom-0 left-3 right-3 h-[2px] rounded-full" style={{ backgroundColor: '#38bdf8' }} />
                    )}
                  </button>
                );
              })}
              </div>
              <div className="flex items-center flex-shrink-0 border-l border-zinc-800/60">
                <span className="text-[10px] text-zinc-600 font-bold px-2 tabular-nums">{splitTabCount}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); socketRef.current?.emit('closeTab'); }}
                  disabled={splitTabCount <= 1}
                  className="flex items-center justify-center w-8 min-h-[30px] text-zinc-600 active:text-red-400 transition-colors disabled:opacity-20"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); socketRef.current?.emit('newTab'); }}
                  className="flex items-center justify-center w-8 min-h-[30px] text-zinc-600 active:text-zinc-400 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                {state.length > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowSplitMap(!showSplitMap); }}
                    className="text-[9px] font-bold tracking-wide px-2 py-0.5 rounded-md border transition-all active:scale-95 mr-1"
                    style={{
                      color: '#38bdf8',
                      backgroundColor: 'transparent',
                      borderColor: '#38bdf840',
                    }}
                  >
                    {state.length} win
                  </button>
                )}
              </div>
            </div>
            <div
              ref={splitContentRef}
              className="flex-1 overflow-auto relative min-h-0 min-w-0"
              onScroll={() => handleTerminalScroll('split')}
              onTouchStart={(e) => handlePaneTouchStart('split', e)}
              onTouchMove={(e) => handlePaneTouchMove('split', e)}
              style={{
                WebkitOverflowScrolling: 'touch',
                touchAction: wrapLines ? 'pan-y' : 'pan-x pan-y',
                overscrollBehavior: 'contain',
                borderLeft: `3px solid ${focusedPane === 'split' ? '#38bdf8' : '#38bdf830'}`,
              }}
            >
              {displaySplitContent ? (
                <pre
  className={`p-3 ${wrapLines ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}
  style={{
    fontSize: `${fontSize}px`,
    lineHeight: 1.6,
    ...(wrapLines ? {} : { minWidth: 'max-content' }),
  }}
>
                  {splitColoredLines.map((line, i) => (
                    <span key={i}>
                      <span style={{ color: line.color, fontWeight: line.bold ? 600 : 400 }}>
                        {line.text}
                      </span>
                      {i < splitColoredLines.length - 1 ? '\n' : ''}
                    </span>
                  ))}
                  {focusedPane === 'split' && <span className="cursor-blink" style={{ color: '#38bdf8' }}>█</span>}
                </pre>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-3">
                  <span className="text-[11px] text-zinc-700 tracking-wider">SELECT A SESSION</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Jump to latest output (shown only when scrolled up) */}
      {(scrollLocked || !!historyView) && (
        <button
          onClick={jumpToBottom}
          aria-label="Jump to latest output"
          className="absolute right-4 z-40 w-11 h-11 rounded-full flex items-center justify-center border shadow-lg active:scale-90 transition-transform"
          style={{
            bottom: isLandscape ? 96 : 126,
            backgroundColor: 'rgba(24,24,27,0.95)',
            borderColor: '#34d39960',
            color: '#34d399',
          }}
        >
          <ChevronDown className="w-5 h-5" />
        </button>
      )}

      {/* ── Quick Actions ── */}
      <div className={`flex items-center gap-1.5 bg-zinc-950/60 border-t border-zinc-800/40 flex-shrink-0 overflow-x-auto no-scrollbar ${isLandscape ? 'px-2 py-1' : 'px-3 py-2'}`}>
        <QuickBtn label={`Aa${fontSize}`} onClick={cycleFontSize} color="#e4e4e7" />
        <QuickBtn label={cleanOpenCode ? 'OC✓' : 'OC'} onClick={() => setCleanOpenCode(v => !v)} color={cleanOpenCode ? '#34d399' : '#71717a'} />
        <QuickBtn label="Wrap" onClick={() => setWrapLines(v => !v)} color={wrapLines ? '#34d399' : '#71717a'} />
        <div className="w-px h-5 bg-zinc-800 mx-1 flex-shrink-0" />
        <QuickBtn label="ESC" onClick={() => sendSpecialKey('\\x1b')} color="#f87171" />
        <QuickBtn label="^C" onClick={() => sendSpecialKey('\\x03')} color="#f87171" />
        <QuickBtn label="^D" onClick={() => sendSpecialKey('\\x04')} color="#fbbf24" />
        <QuickBtn label="^Z" onClick={() => sendSpecialKey('\\x1a')} color="#fbbf24" />
        <QuickBtn label="^L" onClick={() => sendSpecialKey('\\x0c')} color="#38bdf8" />
        <div className="w-px h-5 bg-zinc-800 mx-1 flex-shrink-0" />
        <QuickBtn icon={<ChevronUp className="w-3.5 h-3.5" />} onClick={() => sendSpecialKey('\\x1b[A')} color="#a78bfa" />
        <QuickBtn icon={<ChevronDown className="w-3.5 h-3.5" />} onClick={() => sendSpecialKey('\\x1b[B')} color="#a78bfa" />
        <QuickBtn label="PgUp" onClick={() => pageRemote(focusedPane, 'up')} color="#22d3ee" />
        <QuickBtn label="PgDn" onClick={() => pageRemote(focusedPane, 'down')} color="#22d3ee" />
        <QuickBtn label="TAB" onClick={() => sendSpecialKey('\\t')} color="#818cf8" />
        <QuickBtn icon={<CornerDownLeft className="w-3.5 h-3.5" />} onClick={() => sendSpecialKey('\\n')} color="#34d399" />
        <div className="w-px h-5 bg-zinc-800 mx-1 flex-shrink-0" />
        <QuickBtn icon={<Clipboard className="w-3.5 h-3.5" />} onClick={handlePaste} color="#38bdf8" />
        <QuickBtn icon={<Copy className="w-3.5 h-3.5" />} onClick={handleCopy} color="#71717a" />
        <QuickBtn icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => sendSpecialKey('\\x15')} color="#fb7185" />
      </div>

      {/* ── Command Input / Virtual Keyboard ── */}
      <div className={`bg-zinc-950/90 border-t border-zinc-800/60 flex-shrink-0 ${isLandscape ? 'p-1.5' : 'p-3'}`}>
        {keyboardMode ? (
          <VirtualKeyboard
            onKey={(key) => sendSpecialKey(key)}
            onExit={() => setKeyboardMode(false)}
          />
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setKeyboardMode(true)}
              className="w-10 h-10 flex items-center justify-center rounded-xl border border-zinc-700/50 transition-all active:scale-90 flex-shrink-0"
              style={{ color: '#a78bfa', backgroundColor: '#a78bfa10' }}
            >
              <Keyboard className="w-4 h-4" />
            </button>
            <div
              className="flex-1 flex items-center gap-2 bg-zinc-900/60 border rounded-2xl pl-4 pr-1.5 py-1 transition-colors"
              style={{ borderColor: broadcastMode ? BROADCAST_COLOR + '50' : command.trim() ? ACCENT + '50' : '#27272a' }}
            >
              <span className="text-[14px] font-bold flex-shrink-0" style={{ color: broadcastMode ? BROADCAST_COLOR : ACCENT }}>
                {broadcastMode ? '>' : '$'}
              </span>
              <input
                type="text"
                className="flex-1 bg-transparent border-none outline-none text-[14px] text-zinc-100 placeholder:text-zinc-700 font-mono min-h-[42px]"
                placeholder={broadcastMode ? `broadcast to ${broadcastTargets.size}...` : 'command...'}
                value={command}
                onChange={(e) => { setCommand(e.target.value); historyIdxRef.current = -1; }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSend();
                  else if (e.key === 'ArrowUp') { e.preventDefault(); handleHistoryNav('up'); }
                  else if (e.key === 'ArrowDown') { e.preventDefault(); handleHistoryNav('down'); }
                }}
                enterKeyHint="send"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button
                onClick={handleSend}
                disabled={!command.trim() || !connected}
                className="w-10 h-10 flex items-center justify-center rounded-xl transition-all active:scale-90 disabled:opacity-20 flex-shrink-0"
                style={{
                  backgroundColor: command.trim() ? (broadcastMode ? BROADCAST_COLOR : ACCENT) : '#27272a',
                  color: command.trim() ? '#000' : '#52525b',
                  boxShadow: command.trim() ? `0 4px 20px ${broadcastMode ? 'rgba(129,140,248,0.25)' : GLOW}` : 'none',
                }}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      <style>{`
        .pt-safe { padding-top: env(safe-area-inset-top); }
        .pb-safe-root { padding-bottom: max(12px, env(safe-area-inset-bottom, 34px)); }
        .pl-safe { padding-left: env(safe-area-inset-left); }
        .pr-safe { padding-right: env(safe-area-inset-right); }
        @supports (padding: max(0px)) {
          .pl-safe { padding-left: max(0px, env(safe-area-inset-left)); }
          .pr-safe { padding-right: max(0px, env(safe-area-inset-right)); }
        }
        .cursor-blink { animation: blink 1s step-end infinite; }
        @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #27272a; border-radius: 2px; }
      `}</style>
    </div>
  );
}

// --- Quick Action Button ---
function QuickBtn({ label, icon, onClick, color }: {
  label?: string;
  icon?: React.ReactNode;
  onClick: () => void;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center min-w-[40px] h-[36px] px-2.5 rounded-lg border transition-all active:scale-90 flex-shrink-0"
      style={{
        borderColor: color + '30',
        backgroundColor: color + '10',
        color,
      }}
    >
      {icon || <span className="text-[11px] font-bold tracking-wide">{label}</span>}
    </button>
  );
}

// --- Virtual Keyboard ---
const KB_ALPHA = [
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l'],
  ['z','x','c','v','b','n','m'],
];
// Terminal essentials: numbers, paths, pipes, flags, redirects
const KB_SYM = [
  ['1','2','3','4','5','6','7','8','9','0'],
  ['-','/','.','_','~','*','$','|','>','<'],
  ['&',';','=','"',"'",'\\','`','#'],
];
// Brackets, operators, extras
const KB_SYM2 = [
  ['!','@','%','^','+','=','?',':'],
  ['(',')','[',']','{','}','<','>'],
  [',',';','"',"'",'`','~','\\','_'],
];

function VirtualKeyboard({ onKey, onExit }: { onKey: (key: string) => void; onExit: () => void }) {
  const [shift, setShift] = useState(false);
  const [mode, setMode] = useState<'abc' | 'sym' | 'sym2'>('abc');

  const rows = mode === 'abc' ? KB_ALPHA : mode === 'sym' ? KB_SYM : KB_SYM2;

  const send = (ch: string) => {
    if (mode === 'abc') {
      onKey(shift ? ch.toUpperCase() : ch);
      if (shift) setShift(false);
    } else {
      onKey(ch);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row, ri) => (
        <div key={ri} className="flex justify-center gap-1">
          {ri === 2 && mode === 'abc' && (
            <button
              onClick={() => setShift(!shift)}
              className="flex items-center justify-center h-[38px] px-3 rounded-md border text-[11px] font-bold transition-all active:scale-90"
              style={{
                borderColor: shift ? ACCENT : '#3f3f46',
                backgroundColor: shift ? ACCENT + '25' : '#27272a',
                color: shift ? ACCENT : '#a1a1aa',
              }}
            >
              SHIFT
            </button>
          )}
          {ri === 2 && mode !== 'abc' && (
            <button
              onClick={() => setMode(mode === 'sym' ? 'sym2' : 'sym')}
              className="flex items-center justify-center h-[38px] px-2.5 rounded-md border border-zinc-700/50 bg-zinc-800/60 text-[10px] font-bold text-zinc-400 transition-all active:scale-90"
            >
              {mode === 'sym' ? '#+=' : '123'}
            </button>
          )}
          {row.map((ch, ci) => (
            <button
              key={`${ri}-${ci}`}
              onClick={() => send(ch)}
              className="flex items-center justify-center w-[30px] h-[38px] rounded-md border border-zinc-700/50 bg-zinc-800/60 text-[13px] font-semibold text-zinc-200 transition-all active:scale-90 active:bg-zinc-700"
            >
              {mode === 'abc' && shift ? ch.toUpperCase() : ch}
            </button>
          ))}
          {ri === 2 && (
            <button
              onClick={() => onKey('\\x7f')}
              className="flex items-center justify-center h-[38px] px-3 rounded-md border border-zinc-700/50 bg-zinc-800/60 text-[11px] font-bold text-zinc-400 transition-all active:scale-90 active:bg-zinc-700"
            >
              DEL
            </button>
          )}
        </div>
      ))}
      <div className="flex justify-center gap-1">
        <button
          onClick={onExit}
          className="flex items-center justify-center h-[38px] px-3 rounded-md border border-zinc-700/50 bg-zinc-800/60 transition-all active:scale-90"
          style={{ color: '#a78bfa' }}
        >
          <Terminal className="w-4 h-4" />
        </button>
        <button
          onClick={() => { setMode(mode === 'abc' ? 'sym' : 'abc'); setShift(false); }}
          className="flex items-center justify-center h-[38px] px-3 rounded-md border text-[11px] font-bold transition-all active:scale-90"
          style={{
            borderColor: mode !== 'abc' ? '#818cf8' + '50' : '#3f3f46',
            backgroundColor: mode !== 'abc' ? '#818cf8' + '15' : '#27272a',
            color: mode !== 'abc' ? '#818cf8' : '#a1a1aa',
          }}
        >
          {mode === 'abc' ? '123' : 'ABC'}
        </button>
        <button
          onClick={() => onKey('-')}
          className="flex items-center justify-center w-[30px] h-[38px] rounded-md border border-zinc-700/50 bg-zinc-800/60 text-[13px] font-semibold text-zinc-200 transition-all active:scale-90"
        >-</button>
        <button
          onClick={() => onKey(' ')}
          className="flex-1 flex items-center justify-center h-[38px] rounded-md border border-zinc-700/50 bg-zinc-800/60 text-[11px] font-bold text-zinc-400 transition-all active:scale-90"
        >
          SPACE
        </button>
        <button
          onClick={() => onKey('.')}
          className="flex items-center justify-center w-[30px] h-[38px] rounded-md border border-zinc-700/50 bg-zinc-800/60 text-[13px] font-semibold text-zinc-200 transition-all active:scale-90"
        >.</button>
        <button
          onClick={() => onKey('\\n')}
          className="flex items-center justify-center h-[38px] px-3 rounded-md border transition-all active:scale-90"
          style={{ borderColor: ACCENT + '50', backgroundColor: ACCENT + '15', color: ACCENT }}
        >
          <CornerDownLeft className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
