// Crea as many empty projects as the input count to book their accessions
const book = async (
    // Command additional arguments
    { count },
    // Database handler
    database,
  ) => {
    // Keep trak of the new booked accessions for the final log
    const bookedAccessions = [];
    // Iterate the count
    for (let i = 0; i < count; i++) {
        // Create the new project
        const newProject = await database.createProject();
        // Mark the new project as booked
        newProject.data.booked = true;
        await newProject.updateRemote();
        // Save the accession
        bookedAccessions.push(newProject.accession);
    }
    // Log the finally booked accessions
    const log = bookedAccessions.join(', ');
    console.log(`Booked ${count} new project accessions: ${log}`);
  };
  
  module.exports = book;