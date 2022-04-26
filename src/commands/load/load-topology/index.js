const fs = require('fs');
const readline = require('readline');

// Read a pdb file and return database standard formated topology
// DEPRECATED: This is now done by the workflow
const loadTopology = async path => {
  // If there is no path then stop here
  if (!path) return;

  // Read the pdb file line by line
  const fileStream = fs.createReadStream(path);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity, // recognize all instances of CR LF ('\r\n') as a single line break
  });
  // Mine all atoms
  const chains = [];
  const residues = [];
  const atoms = [];
  let currentAtomIndex = -1;
  for await (const line of rl) {
    // Skip lines which do not start by ATOM or HETATOM
    const start = line.slice(0, 6);
    const isAtom = start === 'ATOM  ' || start === 'HETATM';
    if (!isAtom) continue;
    // Mine atom data
    const atomName = line.slice(11, 15).trim();
    const residueName = line.slice(17, 21).trim();
    const chain = line.slice(21, 22);
    const residueNumber = +line.slice(22, 26);
    let insertionCode = line.slice(26, 27);
    if (insertionCode === ' ') insertionCode = undefined;
    const element = line.slice(77, 79).trim();
    // Set the current atom and update the current atom index
    const currentAtom = { name: atomName };
    if (element) currentAtom.elem = element;
    currentAtomIndex += 1;
    // Push the current atom to the list
    atoms.push(currentAtom);
    // Find the current standard formated chain, in case it exists already
    let currentChain = chains.find(c => c.name === chain);
    // If it does not exist yet then create it and push it to the list
    if (!currentChain) {
      currentChain = { name: chain, residues: [] };
      chains.push(currentChain);
    }
    // Find the current standard formated residue, in case it exists already
    let currentResidueIndex = 0;
    let currentResidue = currentChain.residues
      .map(i => residues[i])
      .find(r => r.num === residueNumber && r.icode === insertionCode);
    // If it does not exist yet then create it and push it to the list
    if (!currentResidue) {
      currentResidueIndex = residues.length;
      currentResidue = { num: residueNumber, name: residueName, atoms: [] };
      if (insertionCode) currentResidue.icode = insertionCode;
      residues.push(currentResidue);
      // Update the current chain residue indices
      currentChain.residues.push(currentResidueIndex);
    } else currentResidueIndex = residues.indexOf(currentResidue);
    // Update current residue atom indices
    currentResidue.atoms.push(currentAtomIndex);
  }
  const topology = { chains, residues, atoms };
  return topology;
};

module.exports = loadTopology;
