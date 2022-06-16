// this bit is just to make ngl happy
// Files system from node
const fs = require('fs');
// This is a special type used to send search parameters to web pages
const { URLSearchParams } = require('url');
// Allows to call a function in a version that returns promises
const { promisify } = require('util');
// A function for just wait
const { sleep } = require('timing-functions');
// 30 seconds more or less 10 second
const waitTime = () => (30 + 20 * (Math.random() - 0.5)) * 1000;
// 60 minutes
const MAX_TIME = 60 * 60 * 1000;
// Retry allows a function to be recalled multiple times when it fails
const retry = require('../../../utils/retry');
// Optional retry options
// - maxRetires: Number of tries before give up
// - delay: Time to wait after a failure before trying again
// - backoff: true: the delay time is increased with every failure // false: it remains the same
// - revertFunction: A function which is called after every failure
const retryOptions = { maxRetries: 5, delay: waitTime(), backoff: true };
// This utility displays in console a dynamic loading status
const getSpinner = require('../../../utils/get-spinner');
// This is not the original NGL library, but a script which returns the original NGL library
// This script executes a few logic before returning the library
const ngl = require('../../../utils/ngl');
// Plural returns a single string which pluralizes a word when the numeric argument is bigger than 1
// Optionally it can also display the number (e.g. "1 unicorn", "2 unicorns", "unicorns")
const plural = require('../../../utils/plural');
// It is like the normal node fetch function but with an extra logic to send an error when fails
// Fetch is used to retrieve data from web pages
const fetchAndFail = require('../../../utils/fetch-and-fail');
// These 2 are just URLs
const { interProScanURL, hmmerURL } = require('../../../constants');

// See InterProScan and HMMER Web documentations for expected objects from
// these external APIs

// Returns a file content in a promise format
const readFile = promisify(fs.readFile);

// InterProScan doesn't accept too small sequences
const MIN_SEQUENCE_SIZE = 11;

// Sends an error message if it takes too much time to perform this whole script
const timeOut = async (time, warningMessage) => {
  await sleep(time); // Usually 40 minutes
  if (warningMessage) console.warn(warningMessage);
  //throw new Error('Timeout, spent too much time waiting for results');
};

// Try to save the previous search results from the IPS web page as text
const retrieveIPS = async jobID => {
  let status;
  while (status !== 'FINISHED') {
    // if status is defined, means we already tried so we wait a bit
    if (status) await sleep(waitTime());
    status = await retry(
      () =>
        fetchAndFail(`${interProScanURL}/status/${jobID}`).then(r => r.text()),
      retryOptions, // maxRetries: 3, delay: waitTime(), backoff: true
    );
    // In case of error, send feedback
    if (status !== 'RUNNING' && status !== 'FINISHED') {
      console.warn(
        `Something is strange, got status "${status}" for job "${jobID}`,
      );
    }
  }
  // When Status is FINISHED we are ready to get all data
  return retry(
    () =>
      fetchAndFail(`${interProScanURL}/result/${jobID}/json`).then(r =>
        r.json(),
      ),
    retryOptions,
  );
};

// Try to save the previous search results from the HMMER web page as json
const retrieveHMMER = async job => {
  // stayed interactive, so we can return the result directly
  if (job.status !== 'PEND') return job;
  // switched to batch job, so we have to poll the results
  let status;
  while (status !== 'DONE') {
    // if status is defined, means we already tried so we wait a bit
    if (status) await sleep(waitTime());
    status = (await retry(
      () =>
        fetchAndFail(`${hmmerURL}/results/${job.uuid}`, {
          headers: { Accept: 'application/json' },
        }),
      retryOptions,
    )).status;
  }
  // When Status is DONE we are ready to get all data
  return retry(
    () =>
      fetchAndFail(`${hmmerURL}/results/${job.uuid}.1`, {
        headers: { Accept: 'application/json' },
      }).then(r => r.json()),
    retryOptions,
  );
};

// Stack repeated chains (i.e. with the same sequence) in a single key instead of independent keys
// The repeated sequence key is modified by adding all the corresponding chainnames
const addRepeatedChain = (chainname, sequence, chainsmap) => {
  for (const [key, value] of chainsmap) {
    if (value === sequence) {
      chainsmap.set(key + ', ' + chainname, value);
      chainsmap.delete(key);
      return true;
    }
  }
  return false;
};

// Send an analysis request to EBI webpages
// This is called once for each chain in the protein
// Results are not awaited, but the code keeps running
const analyseProtein = async (chain, sequence, db) => {
  // If the sequence is too small to analyse return here
  if (sequence.length < MIN_SEQUENCE_SIZE) {
    return [chain, Promise.resolve({ sequence })];
  }
  // Find out if there is a chain analysis with this identical sequence in the database already
  // If so, copy the analaysis for this chain so we skip to repeat it
  // DANI: Esto lo hice en un acto de desesperación por lo mal que funciona el tema de las chains normalmente
  const repeatedChain = await db.collection('chains').findOne(
    // WARNING: Remove the internal id in order to avoid a further duplicated id mongo error
    // WARNING: Remove also the name to avoid further conflicts (experimentally tested)
    { sequence: sequence },
    { projection: { _id: false, name: false } },
  );
  // Return the chain analysis as is inside a Promise, just to make it compatible with the canonical path
  if (repeatedChain) return [chain, Promise.resolve(repeatedChain)];
  // Create a unique string from chain number and sequence
  // "/n" stands for break line
  const seq = `>chain ${chain}\n${sequence}`;
  // Try to connect to the IPS webpage and perform a specific search.
  // In case of failure, retry up to 3 times
  // In case of seccess, save returned data
  const IPSJobID = await retry(
    () =>
      // Try to fetch a search result from the web page
      // If fail then throw an error (this logic is inside the "fetchAndFail" function)
      fetchAndFail(`${interProScanURL}/run`, {
        method: 'POST',
        body: new URLSearchParams({
          //email: 'aurelien.luciani@irbbarcelona.org',
          email: 'daniel.beltran@irbbarcelona.org',
          title: `chain ${chain}`,
          sequence: seq,
        }),
      }).then(r => r.text()), // The response is returned as text
    retryOptions, // maxRetries: 3, delay: waitTime(), backoff: true
  );
  // Same as before but with the HMMER web page and different search parameters
  const HMMERJob = await retry(
    () =>
      fetchAndFail(`${hmmerURL}/search/phmmer`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({ seqdb: 'pdb', seq }),
      }).then(r => r.json()), // The response is returned as json
    retryOptions,
  );

  // Retrieve all data from the previous search in bot web pages
  // Save results in an object with the corresponding sequence
  const retrieve = Promise.all([
    retrieveIPS(IPSJobID),
    retrieveHMMER(HMMERJob),
  ]).then(([interproscan, hmmer]) => ({ interproscan, hmmer, sequence }));

  // we don't await here, it's on purpose!
  // Promise.race accepts multiple promises and returns only the first promise to be resolved
  // If the "retrieve" promise is not completed before the "timeOut" then send a fail message
  const retrievalTask = Promise.race([
    retrieve,
    timeOut(
      MAX_TIME,
      // warning message in case we timeout
      `\nFailed to retrieve either ${IPSJobID} ${
        HMMERJob.uuid ? `and or ${HMMERJob.uuid} ` : ''
      } in time`,
    ),
  ]);

  // just pass the task so that we can await for it later
  return [chain, retrievalTask];
};

const analyzeProteins = async (folder, pdbFile, spinnerRef, abort, db) => {
  // Displays in console the start of this process
  spinnerRef.current = getSpinner().start(
    'Submitting sequences to InterProScan and HMMER',
  );

  // Read and save the content of the .pdb file
  const fileContent = await readFile(`${folder}/${pdbFile}`, 'utf8');
  // Conver it into Blob format (Binary)
  // Type attribute of "text/plain" stands for encoding using UTF-8
  const blob = new global.Blob([fileContent], { type: 'text/plain' });
  // Load the binary data in NGL
  const structure = await ngl.autoLoad(blob, { ext: 'pdb' });
  // for each chain

  // Here we will store the residues sequence of each chain
  const chains = new Map();

  // This is an alternative way for selecting the correct chains through the residues
  // It may succeed when the classical way fails, but it may be not the solution
  // If the chain selection fails here it will fail in the client NGL viewer
  /*
  // Keep track of the current chain and resno all the time
  let previous;
  
  // Iterate over each residue
  structure.eachResidue(residue => {
    // Get chain name and resno
    const chain = residue.chainname;
    const resno = residue.resno;
    // If this is the same residue as before, skip it
    if (chain + resno === previous) return;
    // Get the residue type
    const type = residue.getResname1();
    // Add the residue to the chains list
    // Add a new entrie for the chain if it does not exist
    const chainSeq = chains.get(chain);
    if (chainSeq) {
      chains.set(chain, chains.get(chain) + type);
    } else {
      chains.set(chain, type);
    }
    previous = chain + resno;
  });

  // Delete chains whose sequence is just 'X' (e.g. ligands)
  chains.forEach((sequence, chain) => {
    if (sequence === 'X') chains.delete(chain);
  });
  */

  structure.eachChain(chain => {
    // build the sequence string
    let sequence = '';
    // by concatenating the 1-letter code for each residue in the chain
    chain.eachResidue(residue => {
      // Get the number of heavy atoms in each residue
      let heavyAtoms = 0;
      residue.eachAtom(atom => {
        if (atom.element === 'H') heavyAtoms += 1;
      });
      // Discard residues with only hydrogens
      // This may happen in some topologies where hydrogen are placed at the end in independent residues
      if (heavyAtoms > 0) sequence += residue.getResname1();
    });

    //console.log(chain.chainname + ' (' + chain.chainid + ')' + ' -> ' + sequence);

    // if we have a chain and a valid sequence, we will process afterwards
    // Check if sequence is X or all X. In these cases we skip the analysis
    if (
      chain.chainname &&
      sequence &&
      sequence !== 'X' &&
      sequence.split('').some(c => c !== 'X')
    ) {
      if (addRepeatedChain(chain.chainname, sequence, chains) === false) {
        chains.set(chain.chainname, sequence);
      }
    }
  });

  // Change the spinner text to display in console
  spinnerRef.current.text = `Processed 0 sequence out of ${chains.size}, including submission to InterProScan and HMMER`;

  let i = 0;
  // Done is true when the 'jobs' promise is returned and aborted is used to store a promise
  let done = false;
  let aborted;
  const jobs = await Promise.race([
    Promise.all(
      // Make an array from chains sequences saving also the keys or indexes (chain)
      Array.from(chains.entries()).map(([chain, sequence]) =>
        // For each row perform an analysis (function is declared above) and then report the progress
        analyseProtein(chain, sequence, db).then(output => {
          // Change the spinner text to display in console:
          // - Keep track of the current processing sequence
          // Plural returns a single string which contains the number "i++" and the word "sequence"
          // The word is pluralized when i++ is bigger than 1 (e.g. "1 sequence", "2 sequences")
          spinnerRef.current.text = `Processed ${plural(
            'sequence',
            ++i,
            true, // true stands for displaying also the number
          )} out of ${
            chains.size
          }, including submission to InterProScan and HMMER`;
          return output;
        }),
      ), // End of the map
    ),
    // Alternative promise for the Promise.race: A vigilant abort promise
    // Check if the load has been aborted once per second
    (aborted = new Promise(async resolve => {
      // Stay vigilant until the 'jobs' promise is resolved
      while (!done) {
        await sleep(1000);
        if (await abort()) return resolve('abort');
      }
      resolve();
    })),
  ]);
  // The 'done' / 'aborted' workaround is useful to manage some situations
  // e.g. The user has canceled the load during the last promise but not answered to confirm
  done = true;
  // Check if the load has been aborted
  if ((await aborted) === 'abort') return 'abort';
  // Finish the spinner process as succeed
  spinnerRef.current.succeed(
    `Processed ${plural('sequence', i, true)} out of ${
      chains.size
    }, including submission to InterProScan and HMMER`,
  );

  return jobs;
};

module.exports = analyzeProteins;
