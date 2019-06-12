// this bit is just to make ngl happy
const fs = require('fs');
const { URLSearchParams } = require('url');
const { promisify } = require('util');
const { sleep } = require('timing-functions');

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

// 1 minute more or less 10 second
const waitTime = () => (60 + 20 * (Math.random() - 0.5)) * 1000;
const MAX_TIME = 60 * 60 * 1000; // 60 minutes

const timeOut = async time => {
  await sleep(time);
  throw new Error('Timeout, spent too much time waiting for results');
};

const retrieveIPS = async jobID => {
  let status;
  while (status !== 'FINISHED') {
    // if status is defined, means we already tried so we wait a bit
    if (status) await sleep(waitTime());
    status = await fetchAndFail(`${interProScanURL}/status/${jobID}`).then(r =>
      r.text(),
    );
    if (status !== 'RUNNING' && status !== 'FINISHED') {
      console.warn(
        `Something is strange, got status "${status}" for job "${jobID}`,
      );
    }
  }

  return fetchAndFail(`${interProScanURL}/result/${jobID}/json`).then(r =>
    r.json(),
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
    status = (await fetchAndFail(`${hmmerURL}/results/${job.uuid}`, {
      headers: { Accept: 'application/json' },
    })).status;
  }

  return fetchAndFail(`${hmmerURL}/results/${job.uuid}.1`, {
    headers: { Accept: 'application/json' },
  }).then(r => r.json());
};

const analyzeProteins = async (folder, pdbFile) => {
  const spinner = getSpinner().start(
    'Submitting sequences to InterProScan and HMMER',
  );

  const fileContent = await readFile(`${folder}/${pdbFile}`, 'utf8');
  const blob = new global.Blob([fileContent], { type: 'text/plain' });
  const structure = await ngl.autoLoad(blob, { ext: 'pdb' });

  const chains = new Map();

  structure.eachChain(chain => {
    let sequence = '';
    chain.eachResidue(residue => (sequence += residue.getResname1()));
    if (
      chain.chainname && // we have a chain
      sequence && // we have a sequence
      sequence.length >= MIN_SEQUENCE_SIZE // the sequence is not too small
    ) {
      chains.set(chain.chainname, sequence);
    }
  });

  spinner.text = `Submitted 0 sequence out of ${
    chains.size
  } to InterProScan and HMMER`;

  const jobs = new Map();

  let i = 0;
  for (const [chain, sequence] of chains.entries()) {
    const seq = `>chain ${chain}\n${sequence}`;

    const IPSJobID = await fetchAndFail(`${interProScanURL}/run`, {
      method: 'POST',
      body: new URLSearchParams({
        email: 'aurelien.luciani@irbbarcelona.org',
        title: `chain ${chain}`,
        sequence: seq,
      }),
    }).then(r => r.text());
    const HMMERJob = await fetchAndFail(`${hmmerURL}/search/phmmer`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({ seqdb: 'pdb', seq }),
    }).then(r => r.json());

    const retrieve = Promise.all([
      retrieveIPS(IPSJobID),
      retrieveHMMER(HMMERJob),
    ]).then(([interproscan, hmmer]) => ({ interproscan, hmmer, sequence }));

    // we don't await here, it's on purpose!
    const retrievalTask = Promise.race([retrieve, timeOut(MAX_TIME)]);

    // just pass the task so that we can await for it later
    jobs.set(chain, retrievalTask);

    spinner.text = `Submitted ${plural('sequence', ++i, true)} out of ${
      chains.size
    } to InterProScan and HMMER`;
  }

  spinner.succeed(`Submitted ${plural('sequence', i, true)} to InterProScan`);

  return jobs;
};

module.exports = analyzeProteins;
