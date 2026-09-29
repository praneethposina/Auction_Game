import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomView, SessionInfo } from '../../shared/types.ts';
import { loadSession, request, saveSession, socket } from './socket.ts';

export interface RoomState {
  view: RoomView | null;
  connected: boolean;
  resuming: boolean;
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
  const offsets = useRef<number[]>([]);

  useEffect(() => {
    const resume = async () => {
      const s = loadSession();
      if (!s) {
        setResuming(false);
        return;
      }
      const r = await request<SessionInfo>('room:resume', s);
      if (!r.ok) {
        saveSession(null);
        setView(null);
      }
      setResuming(false);
    };
    const onConnect = () => {
      setConnected(true);
      void resume();
    };
    const onDisconnect = () => setConnected(false);
    const onState = (v: RoomView) => {
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
    if (socket.connected) void resume();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room:state', onState);
    };
  }, []);

  const enter = useCallback(async (event: 'room:create' | 'room:join', payload: unknown) => {
    const r = await request<SessionInfo>(event, payload);
    if (!r.ok || !r.data) return r.error ?? 'Something went wrong.';
    saveSession({ code: r.data.code, token: r.data.token });
    return null;
  }, []);

  const leave = useCallback(() => {
    socket.emit('room:leave');
    saveSession(null);
    setView(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState(null, '', url);
  }, []);

  return { view, connected, resuming, clockOffset, enter, leave };
}
