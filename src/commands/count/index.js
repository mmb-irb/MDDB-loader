// Update the option counters from scratch
// This is useful after loading many projects with the --skip-counters flag
const count = async (argv, database) => {
    await database.updateOptionCounts();
};

module.exports = count;
