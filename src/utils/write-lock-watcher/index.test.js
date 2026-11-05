const { createWriteLockWatcher, REMINDER_INTERVAL } = require('./index');

describe('write lock watcher', () => {
    // Build a watcher whose lock state and time are set by the test
    const setup = () => {
        const state = { locked: false, time: 0 };
        const messages = [];
        const watcher = createWriteLockWatcher({
            isWriteLocked: async () => state.locked,
            print: message => messages.push(message),
            now: () => state.time,
        });
        return { state, messages, watcher };
    };

    it('says nothing while the database is not locked', async () => {
        const { messages, watcher } = setup();
        await watcher.check();
        await watcher.check();
        expect(messages).toEqual([]);
    });

    it('warns once when the database gets locked, reminds and tells when it is released', async () => {
        const { state, messages, watcher } = setup();
        state.locked = true;
        state.time = 1000;
        await watcher.check();
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(/locked for writing/);
        expect(messages[0]).toMatch(/do not cancel/);
        // No new message until the reminder is due
        state.time = 1000 + REMINDER_INTERVAL - 1;
        await watcher.check();
        expect(messages).toHaveLength(1);
        state.time = 1000 + REMINDER_INTERVAL;
        await watcher.check();
        expect(messages).toHaveLength(2);
        expect(messages[1]).toMatch(/still locked for writing \(for 30m/);
        // Released
        state.locked = false;
        state.time = 1000 + 2 * 60 * 60 * 1000;
        await watcher.check();
        expect(messages).toHaveLength(3);
        expect(messages[2]).toMatch(/no longer locked for writing \(it was for 2h/);
        // Nothing more while it stays unlocked
        await watcher.check();
        expect(messages).toHaveLength(3);
        // A new lock warns again
        state.locked = true;
        await watcher.check();
        expect(messages).toHaveLength(4);
        expect(messages[3]).toMatch(/do not cancel/);
    });

    it('does not start a check while the previous one is running', async () => {
        let calls = 0;
        let resolve;
        const watcher = createWriteLockWatcher({
            isWriteLocked: () => { calls += 1; return new Promise(r => { resolve = r; }); },
            print: () => {},
        });
        const first = watcher.check();
        await watcher.check();
        expect(calls).toBe(1);
        resolve(false);
        await first;
        const next = watcher.check();
        resolve(false);
        await next;
        expect(calls).toBe(2);
    });

    it('lets a failed check fail', async () => {
        const watcher = createWriteLockWatcher({
            isWriteLocked: async () => { throw new Error('connection lost'); },
            print: () => {},
        });
        await expect(watcher.check()).rejects.toThrow('connection lost');
    });
});
