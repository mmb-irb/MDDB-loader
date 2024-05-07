// Run the database setup only
const setup = async ({}, database) => {
    await database.setup();
    console.log('Database has been setup successfully');
};


module.exports = setup;