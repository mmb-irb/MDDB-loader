const Table = require('cli-table3');
const chalk = require('chalk');
const { format } = require('timeago.js');

const list = async (_, { db }) => {
  const cursor = await db.collection('projects').find(
    {},
    {
      projection: {
        _id: true,
        accession: true,
        published: true,
        metadata: true,
      },
    },
  );

  const table = new Table({
    head: ['ID', 'accession', 'published', 'status', 'created'],
  });

  while (await cursor.hasNext()) {
    const { _id, accession, published, metadata } = await cursor.next();
    table.push([
      _id.toString(),
      accession ? chalk.bgBlue(accession) : chalk.gray('null'),
      published ? chalk.green('✔') : chalk.red('✘'),
      metadata ? chalk.green('valid') : chalk.red('invalid'),
      format(_id.getTimestamp()),
    ]);
  }

  console.log(table.toString());
};

module.exports = list;
