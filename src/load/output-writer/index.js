const { promisify } = require('util');
const fs = require('fs');
const chalk = require('yellow');

const stat = promisify(fs.stat);
const open = promisify(fs.open);
const write = promisify(fs.write);
const close = promisify(fs.close);

const outputWriter = async outputFile => {
  // just checking if we're not overwriting important stuff
  let fileStats;
  try {
    fileStats = await stat(outputFile);
  } catch (_) {
    /* */
  }
  if (fileStats) {
    if (fileStats.isDirectory()) {
      throw new Error(
        `output file ${outputFile} is actually an existing folder`,
      );
    } else if (fileStats.size) {
      console.log(
        chalk.yellow(
          'It looks like this file already exists, are you sure you want to overwrite it?',
        ),
      );
      const prompt = require('prompt');
      prompt.start();
      const get = promisify(prompt.get);
      const { confirmation } = await get({
        name: 'confirmation',
        description: 'Are you sure you want to overwrite it? [y/N]',
        pattern: /^[YN]?$/i,
        message: 'You must reply either Y for "yes", or N for "no"',
        before: value => value.toUpperCase() || 'N',
      });
      if (confirmation === 'N') {
        throw new Error('OK, bailing now!');
      } else {
        console.log(chalk.yellow('OK, will overwrite output file.'));
        console.log(
          chalk.yellow('moving on in 5 seconds, last chance to cancel!'),
        );
        await require('timing-functions').sleep(5000);
      }
    }
  }
  // Ok, we're good to go
  return {
    fileDescriptor: null,
    async writeToOutput(...outputContents) {
      const stringifiedContent = JSON.stringify(outputContents, null, 2);
      if (!this.fileDescriptor) {
        this.fileDescriptor = await open(outputFile, 'w');
        await write(this.fileDescriptor, '[');
      } else {
        await write(this.fileDescriptor, ',\n');
      }
      await write(this.fileDescriptor, stringifiedContent);
    },
    async closeOutput() {
      if (!this.fileDescriptor) return;
      await write(this.fileDescriptor, ']');
      await close(this.fileDescriptor);
    },
  };
};

module.exports = outputWriter;
