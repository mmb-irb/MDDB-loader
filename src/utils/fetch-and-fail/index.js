const fetch = require('node-fetch');

// fails if response is not OK
const fetchAndFail = async (...args) => {
  const response = await fetch(...args);

  if (!response.ok) throw new Error(response.statusText);

  return response;
};

module.exports = fetchAndFail;
