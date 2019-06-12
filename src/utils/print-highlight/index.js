const chalk = require('chalk');

const printHighlight = content => {
  const cyanMargin = chalk.bgCyan(' '.repeat(content.toString().length + 4));
  console.log(
    `\n    ${cyanMargin}\n    ${chalk.bgCyan(
      `  ${content}  `,
    )}\n    ${cyanMargin}\n`,
  );
};

module.exports = printHighlight;
