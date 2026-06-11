const Table = require('cli-table3');
const chalk = require('chalk');
const { format } = require('timeago.js');

const truncateText = (text, maxLength) => {
  if (!text) return chalk.gray('null');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
};

const list = async ({ limit }, { db }) => {
  const cursor = db.collection('projects').find(
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

  if (limit !== null && limit !== undefined) cursor.sort({ _id: -1 }).limit(limit);


  const table = new Table({
    head: ['ID', 'accession', 'name', 'published', 'status', 'created'],
  });

  while (await cursor.hasNext()) {
    const { _id, accession, published, metadata } = await cursor.next();
    table.push([
      _id.toString(),
      accession ? chalk.bgBlue(accession) : chalk.gray('null'),
      truncateText(metadata && metadata.NAME, 30),
      published ? chalk.green('✔') : chalk.red('✘'),
      metadata ? chalk.green('valid') : chalk.red('invalid'),
      format(_id.getTimestamp()),
    ]);
  }

  console.log(table.toString());
};

module.exports = list;
