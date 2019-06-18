const { sleep } = require('timing-functions');

// abstraction for a retry logic for any pro
const retry = async (
  fun,
  { maxRetries = 1, delay = 1000, backoff = false, revertFunction } = {},
) => {
  if (!(Number.isInteger(maxRetries) && maxRetries >= 0)) {
    throw new Error('The number of retries needs to be a positive integer');
  }

  let errorCount = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // try to run the provided function
      return await fun();
    } catch (error) {
      // something bad happened, increment error counter
      errorCount++;
      // if a revert function was provided, run it
      if (revertFunction) await revertFunction();
      // if we failed too many times, abort
      if (errorCount >= maxRetries) throw error;
      // wait a bit before retrying
      // if backoff flag is on, wait more and more with every error
      await sleep((backoff ? errorCount : 1) * delay);
    }
  }
};

module.exports = retry;
