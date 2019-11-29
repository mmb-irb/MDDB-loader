// Fetch is used to retrieve data from web pages
const fetch = require('node-fetch');

// augment default behaviour of fetch to fail if response is not OK
// It is like the normal node fetch function but with an extra logic to send an error when fails
const fetchAndFail = async (...args) => {
  const response = await fetch(...args);
  // When response is not OK throw an error
  if (!response.ok) throw new Error(response.statusText);
  return response;
};

module.exports = fetchAndFail;
