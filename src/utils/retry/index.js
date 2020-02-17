// Function fo just waiting
const { sleep } = require('timing-functions');

// abstraction for a retry logic for any pro
const retry = async (
  // The function to retry
  fun,
  // Optional retry options
  // - maxRetires: Number of tries before give up
  // - delay: Time to wait after a failure before trying again
  // - backoff: true: the delay time is increased with every failure // false: it remains the same
  // - revertFunction: A function which is called after every failure
  { maxRetries = 5, delay = 1000, backoff = false, revertFunction } = {},
) => {
  // Check that the maxRetries option is integer and positive
  if (!(Number.isInteger(maxRetries) && maxRetries >= 0)) {
    throw new Error('The number of retries needs to be a positive integer');
  }
  // Track the number of failed tries
  let errorCount = 0;
  // Avoid ESLint complains about the "while(true)"
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
      if (errorCount >= maxRetries) {
        console.error(`Failed after ${maxRetries} retries: `);
        throw error;
      }
      // wait a bit before retrying
      // if backoff flag is on, wait more and more with every error
      await sleep((backoff ? errorCount : 1) * delay);
    }
  }
};

module.exports = retry;
