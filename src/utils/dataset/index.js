/**
 * Dataset utility for tracking project load status in SQLite.
 * This mirrors the functionality of the Python Dataset class in mddb_workflow.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// State enumeration for load/upload status tracking
const State = {
  LOAD: 'loading',
  LOADERR: 'loaderr',
  LOADED: 'loaded'
};

/**
 * Directory-based locking for SQLite database access on distributed filesystems.
 * 
 * Uses fs.mkdirSync() which is atomic across distributed filesystems like NFS and BeeGFS.
 * This provides reliable locking where file-based locks fail on network filesystems.
 * 
 * Note: This implementation uses exclusive locking for both read and write operations
 * to ensure consistency on distributed filesystems. While this is more conservative
 * than true reader-writer locks, it guarantees correctness across all nodes.
 */
class DatabaseLock {
  /**
   * Initialize the database lock.
   * @param {string} dbPath - Path to the SQLite database file.
   * @param {number} [timeout=30.0] - Maximum time to wait for lock acquisition (seconds).
   * @param {number} [retryInterval=0.1] - Time between lock acquisition attempts (seconds).
   * @param {boolean} [debug=false] - Enable debug logging.
   */
  constructor(dbPath, timeout = 30.0, retryInterval = 0.1, debug = false) {
    this.dbPath = path.resolve(dbPath);
    const parsed = path.parse(this.dbPath);
    this.lockDir = path.join(parsed.dir, `.lock_${parsed.base}`);
    this.timeout = timeout;
    this.retryInterval = retryInterval;
    this.debug = debug;
    this._lockCount = 0; // For reentrant locking
  }

  /**
   * Acquire the database lock synchronously using atomic directory creation.
   * @returns {boolean} True if lock was acquired.
   * @throws {Error} If lock cannot be acquired within timeout.
   */
  acquire() {
    // Handle reentrant locking
    if (this._lockCount > 0) {
      this._lockCount++;
      return true;
    }

    const startTime = Date.now();
    while (true) {
      try {
        // fs.mkdirSync is atomic across distributed filesystems
        fs.mkdirSync(this.lockDir);
        this._lockCount = 1;
        return true;
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Lock directory already exists, another process holds the lock
          if ((Date.now() - startTime) / 1000 >= this.timeout) {
            throw new Error(`Could not acquire lock on ${this.lockDir} within ${this.timeout} seconds`);
          }
          // Synchronous sleep using a busy wait (not ideal but necessary for sync version)
          const waitUntil = Date.now() + this.retryInterval * 1000;
          while (Date.now() < waitUntil) {
            // Busy wait
          }
        } else {
          // Handle other OS errors (permission denied, etc.)
          throw new Error(`Failed to acquire lock: ${err.message}`);
        }
      }
    }
  }

  /**
   * Release the database lock by removing the lock directory.
   */
  release() {
    if (this._lockCount > 0) {
      this._lockCount--;
      if (this._lockCount === 0) {
        try {
          fs.rmdirSync(this.lockDir);
        } catch (err) {
          if (err.code !== 'ENOENT') {
            // Log warning but don't throw - lock file might be stale
            console.warn(`Failed to release lock directory ${this.lockDir}: ${err.message}`);
          }
        }
      }
    }
  }

  /**
   * Force release the lock, useful for cleaning up stale locks.
   * Use with caution - only call this if you're sure no other process holds the lock.
   */
  forceRelease() {
    try {
      fs.rmdirSync(this.lockDir);
    } catch (err) {
      // Ignore errors
    }
    this._lockCount = 0;
  }

  /**
   * Check if the lock is currently held by any process.
   * @returns {boolean} True if the lock directory exists.
   */
  isLocked() {
    return fs.existsSync(this.lockDir);
  }

  /**
   * Release any held locks.
   */
  close() {
    while (this._lockCount > 0) {
      this.release();
    }
  }

  /**
   * Execute a function while holding the lock.
   * @param {Function} fn - The function to execute while holding the lock.
   * @returns {*} The result of the function.
   */
  withLock(fn) {
    this.acquire();
    if (this.debug) console.log(`Acquired lock on ${this.lockDir}`);
    try {
      return fn();
    } finally {
      this.release();
      if (this.debug) console.log(`Released lock on ${this.lockDir}`);
    }
  }
}

/**
 * Dataset class for managing project/MD status in SQLite.
 */
class Dataset {
  /**
   * Create a new Dataset instance.
   * @param {string} datasetPath - Path to the SQLite database file.
   * @param {number} [lockTimeout=30.0] - Maximum time to wait for database lock (seconds).
   * @param {boolean} [debug=false] - Enable debug logging.
   */
  constructor(datasetPath, lockTimeout = 30.0, debug = false) {
    this.datasetPath = path.resolve(datasetPath);
    this.debug = debug;
    this.rootPath = path.dirname(this.datasetPath);
    this._lock = new DatabaseLock(this.datasetPath, lockTimeout);
    this.db = new Database(this.datasetPath);
    // Enable foreign key constraints
    this.db.pragma('foreign_keys = ON');
    this._ensureTables();
  }

  /**
   * Execute a function while holding the database lock.
   * Use this for any database operations that need to be atomic across processes.
   * @param {Function} fn - The function to execute while holding the lock.
   * @returns {*} The result of the function.
   */
  withLockedStorage(fn) {
    return this._lock.withLock(fn);
  }

  /**
   * Convert absolute path to relative path from rootPath.
   * @param {string} absPath - Absolute path.
   * @returns {string} Relative path.
   */
  _absToRel(absPath) {
    return path.relative(this.rootPath, path.resolve(absPath));
  }

  /**
   * Create tables if they do not exist.
   */
  _ensureTables() {
    // Create projects table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        uuid TEXT PRIMARY KEY NOT NULL,
        rel_path TEXT UNIQUE NOT NULL,
        num_mds INTEGER DEFAULT 0,
        state TEXT,
        message TEXT,
        last_modified TEXT
      )
    `);

    // Create mds table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mds (
        uuid TEXT PRIMARY KEY NOT NULL,
        project_uuid TEXT NOT NULL,
        rel_path TEXT UNIQUE NOT NULL,
        state TEXT,
        message TEXT,
        last_modified TEXT,
        FOREIGN KEY (project_uuid) REFERENCES projects(uuid) ON DELETE CASCADE
      )
    `);

    // Create triggers to automatically maintain num_mds count
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS increment_num_mds
      AFTER INSERT ON mds
      BEGIN
        UPDATE projects
        SET num_mds = num_mds + 1
        WHERE uuid = NEW.project_uuid;
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS decrement_num_mds
      AFTER DELETE ON mds
      BEGIN
        UPDATE projects
        SET num_mds = num_mds - 1
        WHERE uuid = OLD.project_uuid;
      END
    `);
  }

  /**
   * Get the current timestamp formatted for storage.
   * @returns {string} Formatted timestamp.
   */
  _getTimestamp() {
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ` +
           `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
  }

  /**
   * Get status for a project or MD by UUID.
   * @param {string} uuid - The UUID of the project or MD.
   * @param {string} [projectUuid] - If provided, this is an MD entry.
   * @returns {Object|null} The status object or null if not found.
   */
  getUuidStatus(uuid, projectUuid = null) {
    return this.withLockedStorage(() => {
      if (this.debug) console.log(`Fetching status for UUID: ${uuid}`);
      if (projectUuid) {
        // This is an MD entry
        const stmt = this.db.prepare('SELECT * FROM mds WHERE uuid = ?');
        const row = stmt.get(uuid);
        if (row) {
          return {
            uuid: row.uuid,
            projectUuid: row.project_uuid,
            relPath: row.rel_path,
            state: row.state,
            message: row.message,
            lastModified: row.last_modified
          };
        }
      } else {
        // This is a project entry
        const stmt = this.db.prepare('SELECT * FROM projects WHERE uuid = ?');
        const row = stmt.get(uuid);
        if (row) {
          return {
            uuid: row.uuid,
            relPath: row.rel_path,
            numMds: row.num_mds,
            state: row.state,
            message: row.message,
            lastModified: row.last_modified
          };
        }
      }
      return null;
    });
  }

  /**
   * Update or insert a project or MD's status in the database.
   * @param {string} uuid - UUID of the project or MD.
   * @param {string} state - State value (from State enum).
   * @param {string} message - Status message.
   * @param {string} [projectUuid] - If provided, this is an MD entry.
   * @param {string} [relPath] - Relative path to the directory (required for new entries).
   */
  updateStatus(uuid, state, message, projectUuid = null, relPath = null) {
    this.withLockedStorage(() => {
      if (this.debug) console.log(`Updating status for UUID: ${uuid}, State: ${state}, Message: ${message}`);
      const lastModified = this._getTimestamp();

      if (projectUuid) {
        // This is an MD entry
        if (relPath === null) {
          // Update existing entry
          const stmt = this.db.prepare(`
            UPDATE mds SET state = ?, message = ?, last_modified = ?
            WHERE uuid = ?
          `);
          stmt.run(state, message, lastModified, uuid);
        } else {
          // Insert or replace entry
          const stmt = this.db.prepare(`
            INSERT INTO mds (uuid, project_uuid, rel_path, state, message, last_modified)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(uuid) DO UPDATE SET
              state = excluded.state,
              message = excluded.message,
              last_modified = excluded.last_modified
          `);
          stmt.run(uuid, projectUuid, relPath, state, message, lastModified);
        }
      } else {
        // This is a project entry
        if (relPath === null) {
          // Update existing entry
          const stmt = this.db.prepare(`
            UPDATE projects SET state = ?, message = ?, last_modified = ?
            WHERE uuid = ?
          `);
          stmt.run(state, message, lastModified, uuid);
        } else {
          // Insert or replace entry
          const stmt = this.db.prepare(`
            INSERT INTO projects (uuid, rel_path, state, message, last_modified)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(uuid) DO UPDATE SET
              state = excluded.state,
              message = excluded.message,
              last_modified = excluded.last_modified
          `);
          stmt.run(uuid, relPath, state, message, lastModified);
        }
      }
    });
  }

  /**
   * Close the database connection and release locks.
   */
  close() {
    this._lock.close();
    if (this.db) {
      this.db.close();
    }
  }
}

/**
 * ErrorHandling class to manage error catching and status updates.
 * Similar to the Python ErrorHandling context manager.
 */
class ErrorHandling {
  /**
   * Create an ErrorHandling instance.
   * @param {Dataset|null} dataset - The dataset instance for status tracking.
   * @param {string} directory - Directory path to read UUID from cache.
   */
  constructor(dataset, directory) {
    this.dataset = dataset;
    const cacheData = readUuidFromCache(directory) || { uuid: null, projectUuid: null };
    this.uuid = cacheData.uuid;
    this.projectUuid = cacheData.projectUuid;
    this.relPath = dataset ? dataset._absToRel(directory) : null;
    this.scope = this.projectUuid ? 'MD' : 'Project';

    // Initialize status if dataset is available and we have a valid UUID
    if (this.dataset && this.uuid) {
      const status = this.dataset.getUuidStatus(this.uuid, this.projectUuid);
      if (!status) {
        // If no status is available, add a new entry with loading state
        this.dataset.updateStatus(
          this.uuid,
          State.LOAD,
          'Loading to database...',
          this.projectUuid,
          this.relPath
        );
      }
    }
  }

  /**
   * Update status to LOAD. Call this when starting the operation.
   */
  start() {
    if (this.dataset && this.uuid) {
      this.dataset.updateStatus(
        this.uuid,
        State.LOAD,
        'Loading to database...',
        this.projectUuid
      );
    }
  }

  /**
   * Update status to LOADED. Call this when the operation completes successfully.
   */
  success() {
    if (this.dataset && this.uuid) {
      this.dataset.updateStatus(
        this.uuid,
        State.LOADED,
        'Loading complete!',
        this.projectUuid
      );
    }
  }

  /**
   * Update status to LOADERR. Call this when an error occurs.
   * @param {Error} error - The error that occurred.
   */
  error(error) {
    if (this.dataset && this.uuid) {
      const errorMessage = `${error.name}: ${error.message}`;
      this.dataset.updateStatus(
        this.uuid,
        State.LOADERR,
        errorMessage,
        this.projectUuid
      );
    }
    // Re-throw the error after updating status
    throw error;
  }
}

/**
 * Read UUID from cache file in the given directory.
 * @param {string} directory - The directory path.
 * @returns {Object|null} Object with uuid and projectUuid, or null if not found.
 */
const readUuidFromCache = (directory) => {
  const cacheFilename = '.mwf_cache.json';
  const cachePath = path.join(directory, cacheFilename);

  if (!fs.existsSync(cachePath)) {
    throw new Error(`Cache file not found at ${cachePath}`);
  }
  
  const content = fs.readFileSync(cachePath, 'utf8');
  const cache = JSON.parse(content);
  return {
    uuid: cache.uuid || null,
    projectUuid: cache.project_uuid || null
  };
};

/**
 * Create a Dataset instance if a path is provided.
 * @param {string|null} datasetPath - Path to the SQLite database file.
 * @returns {Dataset|null} Dataset instance or null.
 */
const createDataset = (datasetPath) => {
  if (!datasetPath) {
    return null;
  }
  return new Dataset(datasetPath);
};

module.exports = {
  State,
  DatabaseLock,
  Dataset,
  ErrorHandling,
  readUuidFromCache,
  createDataset
};
