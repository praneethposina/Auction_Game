import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomView, SessionInfo } from '../../shared/types.ts';
import { loadSession, request, saveSession, socket } from './socket.ts';

export interface RoomState {
  view: RoomView | null;
  connected: boolean;
  resuming: boolean;
  /** The server said it is restarting (a deploy); the game resumes once it's back. */
  restarting: boolean;
  /** Milliseconds to add to Date.now() to get server time. */
  clockOffset: number;
  enter: (event: 'room:create' | 'room:join', payload: unknown) => Promise<string | null>;
  leave: () => void;
}

export function useRoom(): RoomState {
  const [view, setView] = useState<RoomView | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [resuming, setResuming] = useState(() => loadSession() !== null);
  const [clockOffset, setClockOffset] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const offsets = useRef<number[]>([]);
  const viewRef = useRef<RoomView | null>(null);
  /** Seats we left. A state update already in flight when we left must not pull us back in. */
  const leftSeats = useRef(new Set<string>());

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const resume = async () => {
      clearTimeout(retryTimer);
      const s = loadSession();
      if (!s) {
        setResuming(false);
        return;
      }
      const r = await request<SessionInfo>('room:resume', s);
      if (!r.ok && (r.retry || !socket.connected) && attempts++ < 60) {
        // The old server is still handing the game over (or the connection dropped again):
        // keep the seat and try again shortly.
        setRestarting(true);
        retryTimer = setTimeout(() => void resume(), 1500);
        return;
      }
      attempts = 0;
      setRestarting(false);
      if (!r.ok) {
        saveSession(null);
        viewRef.current = null;
        setView(null);
      }
      setResuming(false);
    };
    const onConnect = () => {
      setConnected(true);
      void resume();
    };
    const onDisconnect = (reason: string) => {
      setConnected(false);
      // A server-side disconnect doesn't auto-reconnect; the game is still there, so do it.
      if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 500);
    };
    const onRestarting = () => setRestarting(true);
    const onState = (v: RoomView) => {
      if (leftSeats.current.has(`${v.code}:${v.meId}`)) return;
      setRestarting(false);
      viewRef.current = v;
      if (v.game) {
        // Keep a short rolling window and use the max: the smallest network delay wins.
        offsets.current = [...offsets.current.slice(-9), v.game.serverNow - Date.now()];
        setClockOffset(Math.max(...offsets.current));
      }
      setView(v);
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room:state', onState);
    socket.on('server:restarting', onRestarting);
    if (socket.connected) void resume();
    return () => {
      clearTimeout(retryTimer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room:state', onState);
      socket.off('server:restarting', onRestarting);
    };
  }, []);

  const enter = useCallback(async (event: 'room:create' | 'room:join', payload: unknown) => {
    const r = await request<SessionInfo>(event, payload);
    if (!r.ok || !r.data) return r.error ?? 'Something went wrong.';
    saveSession({ code: r.data.code, token: r.data.token });
    return null;
  }, []);

  const leave = useCallback(() => {
    const current = viewRef.current;
    if (current) leftSeats.current.add(`${current.code}:${current.meId}`);
    viewRef.current = null;
    socket.emit('room:leave');
    saveSession(null);
    setView(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState(null, '', url);
  }, []);

  return { view, connected, resuming, restarting, clockOffset, enter, leave };
}
