// Visual tool which allows to add colors in console
const chalk = require('chalk');

// List of recognized analyses
// If any of the patterns here match the analysis file, it won't be loaded
const acceptedAnalyses = [
  {
    name: 'dist-perres',
    pattern: /mda.dist_perres.json/,
  },
  {
    name: 'rgyr', // Name to be set in mongo for this file
    pattern: /mda.rgyr.json/, // Regular expression to match analysis files
  },
  {
    name: 'rmsds',
    pattern: /mda.rmsds.json/,
  },
  {
    name: 'tmscores',
    pattern: /mda.tmscores.json/,
  },
  {
    name: 'rmsd-perres',
    pattern: /mda.rmsd_perres.json/,
  },
  {
    name: 'rmsd-pairwise',
    pattern: /mda.rmsd_pairwise.json/,
  },
  {
    name: 'fluctuation',
    pattern: /mda.rmsf.json/,
  },
  {
    name: 'hbonds',
    pattern: /mda.hbonds.json/,
  },
  {
    name: 'energies',
    pattern: /mda.energies.json/,
  },
  {
    name: 'pockets',
    pattern: /mda.pockets.json/,
  },
  {
    name: 'sasa',
    pattern: /mda.sasa.json/,
  },
  {
    name: 'interactions',
    pattern: /mda.interactions.json/,
  },
  {
    name: 'pca',
    pattern: /mda.pca.json/,
  },
  {
    name: 'markov',
    pattern: /mda.markov.json/,
  },
];

// This function finds if a given filename matches a recognized type of analysis
// If it does, return the analysis type name. If it does not, send console error.
// This function expects to receive a single argument: the analysis filename
const nameAnalysis = analysisFile => {
  // Rest of analyses
  const analysis = acceptedAnalyses.find(({ pattern }) => pattern.test(analysisFile)) || {};
  // If any of the patterns match this file, "name" is undefined
  if (analysis.name) return analysis.name;
  console.error(chalk.red(`${analysisFile} has not been identified as any of the valid analysis`));
  return undefined;
};

module.exports = nameAnalysis;
