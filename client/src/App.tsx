import { useEffect, useState } from 'react';
import { Game } from './screens/Game.tsx';
import { Home } from './screens/Home.tsx';
import { Lobby } from './screens/Lobby.tsx';
import { useRoom } from './useRoom.ts';

export function App() {
  const room = useRoom();
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  let screen;
  if (room.resuming && !room.view) {
    screen = <div className="center-screen">Reconnecting…</div>;
  } else if (!room.view) {
    screen = <Home enter={room.enter} />;
  } else if (room.view.status === 'lobby' || !room.view.game) {
    screen = <Lobby view={room.view} onLeave={room.leave} onError={setToast} />;
  } else {
    screen = <Game view={room.view} clockOffset={room.clockOffset} onLeave={room.leave} onError={setToast} />;
  }

  return (
    <>
      {!room.connected && <div className="banner">Connection lost. Reconnecting…</div>}
      {screen}
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </>
  );
}
