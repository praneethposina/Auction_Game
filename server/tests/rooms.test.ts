import { describe, expect, it } from 'vitest';
import { Room } from '../rooms.ts';

describe('room host hand-over', () => {
  it('passes host to an online human when the host leaves mid-game', () => {
    const room = new Room('ABCDE');
    const host = room.addHuman('Host');
    const friend = room.addHuman('Friend');
    if (!host.ok || !friend.ok) throw new Error('setup');
    room.attachSocket(host.data!.id, 's1');
    room.attachSocket(friend.data!.id, 's2');
    room.addAi(host.data!.id, { persona: 'tycoon' });
    expect(room.start(host.data!.id, 0)).toEqual({ ok: true });

    room.detachSocket(host.data!.id, 's1');
    room.leave(host.data!.id);
    expect(room.hostId).toBe(friend.data!.id);
    expect(room.game!.player(friend.data!.id)!.isHost).toBe(true);
    expect(room.game!.player(host.data!.id)!.isHost).toBe(false);
    // The old host's seat stays in the game (it owns companies), just offline.
    expect(room.players).toHaveLength(3);
    expect(room.player(host.data!.id)!.connected).toBe(false);
  });

  it('lets a new host control the room after the old host leaves the lobby', () => {
    const room = new Room('FGHJK');
    const host = room.addHuman('Host');
    const friend = room.addHuman('Friend');
    if (!host.ok || !friend.ok) throw new Error('setup');
    room.leave(host.data!.id);
    expect(room.hostId).toBe(friend.data!.id);
    expect(room.updateSettings(friend.data!.id, { soldSeconds: 9 })).toEqual({ ok: true });
    expect(room.settings.soldSeconds).toBe(9);
  });
});
