// Warn when the database gets locked for writing while a command runs
// The MDDB backup service (mongo-backup) locks the database (db.fsyncLock) while it dumps it
// Writes made meanwhile do not fail: they wait until the lock is released, which may take hours
// Without a warning the command just looks frozen, and people kill it
// Note that a write already sent is applied anyway when the lock is released, even if the loader is gone
// This is why we tell the user to keep waiting
const chalk = require('chalk');

// How often we check whether the database is locked
const CHECK_INTERVAL = 60 * 1000;
// How often we remind the user that the database is still locked
const REMINDER_INTERVAL = 30 * 60 * 1000;

// Format a duration in hours and minutes (e.g. 3720000 -> 1h 2m)
const formatDuration = ms => {
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    if (minutes < 1) return 'less than 1m';
    return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

// Set a watcher which checks whether the database is locked every CHECK_INTERVAL
// isWriteLocked - async function returning true when the database is locked for writing
// print - function which prints a message to the user
// now - function returning the current time in ms (it may be replaced in tests)
const createWriteLockWatcher = ({ isWriteLocked, print, now = Date.now }) => {
    // Time when we first saw the database locked, or null when it is not locked
    let lockedSince = null;
    // Time of the last message about the lock
    let lastWarning = null;
    // Do not start a check while the previous one is still running
    let checking = false;
    // Check the lock and warn the user when it changes
    // Errors are not caught: if we can not check the lock something is wrong with the connection
    const check = async () => {
        if (checking) return;
        checking = true;
        let locked;
        try {
            locked = await isWriteLocked();
        } finally {
            checking = false;
        }
        const time = now();
        if (locked && lockedSince === null) {
            lockedSince = time;
            lastWarning = time;
            print(chalk.yellow(
                '⏸  The database is locked for writing.\n' +
                '   This is most likely because the backup service (mongo-backup) is dumping the database,\n' +
                '   which keeps it read-only until the dump ends (this may take hours on large databases).\n' +
                '   Writes from this command wait until then, and then the command continues by itself.\n' +
                '   Please do not cancel it: writes already sent are applied anyway when the lock is released,\n' +
                '   and reverting the changes after cancelling needs to write too, so it would wait as well.'
            ));
        }
        else if (locked && time - lastWarning >= REMINDER_INTERVAL) {
            lastWarning = time;
            print(chalk.yellow(
                `⏸  The database is still locked for writing (for ${formatDuration(time - lockedSince)} at least).` +
                ' The command will continue when the backup ends.'
            ));
        }
        else if (!locked && lockedSince !== null) {
            print(chalk.green(
                `▶  The database is no longer locked for writing (it was for ${formatDuration(time - lockedSince)} at least).` +
                ' Continuing.'
            ));
            lockedSince = null;
            lastWarning = null;
        }
    };
    // Start checking every CHECK_INTERVAL
    // A failed check rejects inside the timer, which makes node exit with the error
    let timer = null;
    const start = () => {
        timer = setInterval(check, CHECK_INTERVAL);
        // Do not keep the process alive just because of this timer
        timer.unref();
    };
    const stop = () => {
        if (timer) clearInterval(timer);
        timer = null;
    };
    return { check, start, stop };
};

module.exports = { createWriteLockWatcher, CHECK_INTERVAL, REMINDER_INTERVAL };
