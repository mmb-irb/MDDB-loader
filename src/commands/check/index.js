const check = async (argv, database) => {
    const count = await database.projects.countDocuments();
    console.log(count);
};

module.exports = check;
