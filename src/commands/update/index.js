const { addTotals } = require('./add_totals');
const latestVersion = 1

function updateDatabaseVersion(db, newVersion) {
    return db.collection('sys_metadata').updateOne(
        { _id: "global_schema_state" },
        { $set: { currentVersion: newVersion, lastUpdated: new Date() } },
        { upsert: true }
    );
}

async function update({ force, verbose }, database) {
    const db = database.db
    // Create sys_metadata collection if it doesn't exist
    const collections = await db.listCollections({ name: 'sys_metadata' }).toArray();
    if (collections.length === 0) {
        await db.createCollection('sys_metadata');
    }

    // Get the current database version
    const meta = await db.collection('sys_metadata').findOne({ _id: "global_schema_state" });
    const dbVersion = meta ? meta.currentVersion : 0;

    if (dbVersion == latestVersion && !force) {
        console.log(`Database version (${dbVersion}) is up to date. No upgrade needed.`);
        return;
    }

    // If the DB is outdated, upgrade it before allowing the upload
    if (!force)
        console.log(`Database version (${dbVersion}) is older than uploaded data (${latestVersion}). Upgrading...`);
    else
        console.log(`Force upgrade requested. Upgrading database from version ${dbVersion} to ${latestVersion}...`);

    if (dbVersion < 1 || force) {
        console.log(`Applying version 0 to version 1...`);
        await addTotals(database, verbose);
        // Update the global version tracker
        await updateDatabaseVersion(db, latestVersion);
    }

    // Example:
    // if (dbVersion < 2) {
    //     console.log(`Upgrading database from version ${dbVersion} to version 2...`);
    //     await someOtherUpgradeFunction({ db });
    //     await updateDatabaseVersion(db, 2);
    // }

    console.log(`Database upgrade complete. Current version is now ${latestVersion}.`);
}

module.exports = update;