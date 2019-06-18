// this bit is just to make ngl happy
const fs = require('fs');
const { URLSearchParams } = require('url');
const { promisify } = require('util');
const { sleep } = require('timing-functions');

const retry = require('../../../utils/retry');
const getSpinner = require('../../../utils/get-spinner');
const ngl = require('../../../utils/ngl');
const plural = require('../../../utils/plural');
const fetchAndFail = require('../../../utils/fetch-and-fail');
const { interProScanURL, hmmerURL } = require('../../../constants');

// See InterProScan and HMMER Web documentations for expected objects from
// these external APIs

const readFile = promisify(fs.readFile);

// InterProScan doesn't accept too small sequences
const MIN_SEQUENCE_SIZE = 11;

// 30 seconds more or less 10 second
const waitTime = () => (30 + 20 * (Math.random() - 0.5)) * 1000;
const MAX_TIME = 40 * 60 * 1000; // 40 minutes

const retryOptions = { maxRetries: 3, delay: waitTime(), backoff: true };

const timeOut = async (time, warningMessage) => {
  await sleep(time);
  if (warningMessage) console.warn(warningMessage);
  throw new Error('Timeout, spent too much time waiting for results');
};

const retrieveIPS = async jobID => {
  let status;
  while (status !== 'FINISHED') {
    // if status is defined, means we already tried so we wait a bit
    if (status) await sleep(waitTime());
    status = await retry(
      () =>
        fetchAndFail(`${interProScanURL}/status/${jobID}`).then(r => r.text()),
      retryOptions,
    );
    if (status !== 'RUNNING' && status !== 'FINISHED') {
      console.warn(
        `Something is strange, got status "${status}" for job "${jobID}`,
      );
    }
  }

  return retry(
    () =>
      fetchAndFail(`${interProScanURL}/result/${jobID}/json`).then(r =>
        r.json(),
      ),
    retryOptions,
  );
};

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

  return retry(
    () =>
      fetchAndFail(`${hmmerURL}/results/${job.uuid}.1`, {
        headers: { Accept: 'application/json' },
      }).then(r => r.json()),
    retryOptions,
  );
};

const analyseProtein = async (chain, sequence) => {
  if (sequence.length < MIN_SEQUENCE_SIZE) {
    // the sequence is too small to analyse
    return [chain, Promise.resolve({ sequence })];
  }

  const seq = `>chain ${chain}\n${sequence}`;

  const IPSJobID = await retry(
    () =>
      fetchAndFail(`${interProScanURL}/run`, {
        method: 'POST',
        body: new URLSearchParams({
          email: 'aurelien.luciani@irbbarcelona.org',
          title: `chain ${chain}`,
          sequence: seq,
        }),
      }).then(r => r.text()),
    retryOptions,
  );
  const HMMERJob = await retry(
    () =>
      fetchAndFail(`${hmmerURL}/search/phmmer`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({ seqdb: 'pdb', seq }),
      }).then(r => r.json()),
    retryOptions,
  );

  const retrieve = Promise.all([
    retrieveIPS(IPSJobID),
    retrieveHMMER(HMMERJob),
  ]).then(([interproscan, hmmer]) => ({ interproscan, hmmer, sequence }));

  // we don't await here, it's on purpose!
  const retrievalTask = Promise.race([
    retrieve,
    timeOut(
      MAX_TIME,
      // warning message in case we timeout
      `Failed to retrieve either ${IPSJobID} ${
        HMMERJob.uuid ? `and or ${HMMERJob.uuid} ` : ''
      } in time`,
    ),
  ]);

  // just pass the task so that we can await for it later
  return [chain, retrievalTask];
};

const analyzeProteins = async (folder, pdbFile, spinnerRef) => {
  spinnerRef.current = getSpinner().start(
    'Submitting sequences to InterProScan and HMMER',
  );

  const fileContent = await readFile(`${folder}/${pdbFile}`, 'utf8');
  const blob = new global.Blob([fileContent], { type: 'text/plain' });
  const structure = await ngl.autoLoad(blob, { ext: 'pdb' });

  const chains = new Map();

  // for each chain
  structure.eachChain(chain => {
    // build the sequence string
    let sequence = '';
    // by concatenating the 1-letter code for each residue in the chain
    chain.eachResidue(residue => (sequence += residue.getResname1()));

    // if we have a chain and a valid sequence, we will process afterwards
    if (chain.chainname && sequence && sequence !== 'X') {
      chains.set(chain.chainname, sequence);
    }
  });

  spinnerRef.current.text = `Processed 0 sequence out of ${chains.size}, including submission to InterProScan and HMMER`;

  let i = 0;
  const jobs = await Promise.all(
    Array.from(chains.entries()).map(([chain, sequence]) =>
      analyseProtein(chain, sequence).then(output => {
        spinnerRef.current.text = `Processed ${plural(
          'sequence',
          ++i,
          true,
        )} out of ${
          chains.size
        }, including submission to InterProScan and HMMER`;
        return output;
      }),
    ),
  );

  spinnerRef.current.succeed(
    `Processed ${plural('sequence', i, true)} out of ${
      chains.size
    }, including submission to InterProScan and HMMER`,
  );

  return jobs;
};

module.exports = analyzeProteins;
