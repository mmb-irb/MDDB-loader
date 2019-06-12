const chalk = require('chalk');

const printHighlight = require('../../utils/print-highlight');

const getNextAccession = async counters => {
  const result = await counters.findOneAndUpdate(
    { name: 'identifier' },
    { $inc: { count: 1 } },
    {
      projection: { _id: false, count: true },
      // return the new document with the new counter for the custom identifier
      returnOriginal: false,
    },
  );
  return `MCNS${result.value.count.toString().padStart(5, '0')}`;
};

const publish = async ({ id: idOrAccession }, { db }, unpublish = false) => {
  const isId = typeof idOrAccession !== 'string';

  // try to find the project to modify
  const result = await db
    .collection('projects')
    .findOne(isId ? idOrAccession : { accession: idOrAccession });
  // nothing found? => Bail!
  if (!result || !result._id) {
    throw new Error(
      `No project found for ${isId ? 'ID' : 'accession'} '${idOrAccession}'`,
    );
  }

  // get existing accession
  let accession = result.accession;
  // or if we're gonna publish and we don't have any accession
  if (!accession && !unpublish) {
    // generate a new unique accession for this project
    accession = await getNextAccession(db.collection('counters'));
  }

  // warn if re-publishing uselessly
  if (!unpublish && result.published) {
    console.warn(chalk.yellow('This project was already published'));
  }

  // update project in database with this accession and set published flag
  await db.collection('projects').findOneAndUpdate(
    { _id: result._id }, // filter
    { $set: { accession, published: !unpublish } }, // update
  );

  if (unpublish) {
    console.log(
      chalk.cyan(
        `== finished unpublishing project with accession '${accession}' and id '${
          result._id
        }'`,
      ),
    );
  } else {
    console.log(
      chalk.cyan(`== finished publishing project with id '${result._id}' as:`),
    );
    printHighlight(accession);
  }
};

module.exports = publish;
