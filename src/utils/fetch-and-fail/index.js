const fetch = require('node-fetch');

// augment default behaviour of fetch to fail if response is not OK
const fetchAndFail = async (...args) => {
  const response = await fetch(...args);

  if (!response.ok) throw new Error(response.statusText);

  return response;
};

module.exports = fetchAndFail;
